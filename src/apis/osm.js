import { parsePhoneNumberFromString } from "libphonenumber-js";

/*
  Overpass usage policy requires a descriptive User-Agent that carries a way to
  reach the operator. Without contact details the mirrors answer 406, which
  used to burn all six mirrors and return zero results. Keep this set.
*/
const OSM_USER_AGENT =
  process.env.OSM_USER_AGENT || "LeadmozLeadBot/1.0 (+https://leadmoz.com; support@leadmoz.com)";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
/*
  Mirror order is a latency decision, not a preference. Public Overpass
  instances go down independently and for long stretches, and the first mirror
  in this list is the one the first chunk of every search waits on, so the
  mirrors carrying world data are asked first and the ones that only answer
  errors or empty results follow. osm.ch is last on purpose: it is a
  Switzerland-only extract and answers an empty result to every non-Swiss
  bounding box (measured 2026-10-19: 1206 restaurants in Zurich, 0 in Fresno),
  so it is only useful as a genuine last try for Swiss searches.
*/
/*
  Mirror order, measured live from this host (2026-10-19).

  api.de, z and lz4 carry data outside Switzerland and answer correctly, just
  slowly: api.de 24.9s, z 31.3s, lz4 34.3s for the same 200-element Lahore
  query - though on 2026-10-19 all three sat in a 502/timeout storm for hours,
  which is why every mirror stays in the list and health-based ordering (not
  deletion) decides who is asked. maps.mail.ru carries full planet data (its
  Zurich count matches osm.ch to within one restaurant) but answers slowly.
  private.coffee and kumi answer 500 under sustained load, nchc has no DNS
  record and osm.jp's certificate has expired - all four fail fast and stay as
  last-resort candidates because a mirror that recovers mid-run must become
  usable without a restart. The working mirrors go first so a chunk does not
  burn two failed round trips before the only instances that can answer are
  asked.
*/
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
  "https://overpass.osm.ch/api/interpreter"
];

const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY || "US";

/*
  Mirror health, remembered across chunks and across jobs.

  A public Overpass instance that is down stays down for minutes to hours, but
  every chunk re-asked every mirror as if it were fresh, so one dead first
  mirror was retried on all twelve chunks of a search and again on the next job.
  This keeps a short blacklist: a mirror that failed drops to the back of the
  queue while it cools, and any mirror that answers moves back to the front.

  Cooling mirrors are demoted, never dropped. Excluding them outright handed a
  lone surviving mirror that answers empty the whole rotation hostage: on
  2026-10-19 every mirror carrying world data sat in a 5-15 minute cooldown
  that steady job traffic kept refreshing, osm.ch answered every US bounding
  box with a healthy 0-element response (Switzerland-only extract), and every
  US search reported "reachable but returned no matching places" while the
  planet mirrors were never asked at all. Asking cooling mirrors last keeps
  healthy-first ordering while still noticing one that recovered mid-run.
*/
const MIRROR_FAIL_COOLDOWN_MS = 5 * 60 * 1000;   // fast 406/429/5xx
const MIRROR_HANG_COOLDOWN_MS = 15 * 60 * 1000;  // hang or connection error
const mirrorHealth = new Map();                  // host -> { fails, until }

function mirrorHost(url) {
  try { return new URL(url).hostname; } catch { return String(url || ""); }
}

function noteOverpassSuccess(url) {
  mirrorHealth.delete(mirrorHost(url));
}

function noteOverpassFailure(url, { hang = false } = {}) {
  const host = mirrorHost(url);
  const prev = mirrorHealth.get(host) || { fails: 0, until: 0 };

  mirrorHealth.set(host, {
    fails: prev.fails + 1,
    until: Date.now() + (hang ? MIRROR_HANG_COOLDOWN_MS : MIRROR_FAIL_COOLDOWN_MS)
  });
}

function overpassMirrorOrder(preferred = -1) {
  const now = Date.now();
  const indexes = OVERPASS_URLS.map((_, i) => i);

  // The 1000+ penalty below sorts cooling mirrors to the back of the queue;
  // they are demoted rather than dropped (see the note above mirrorHealth).
  const pool = indexes;

  const penalty = i => {
    const health = mirrorHealth.get(mirrorHost(OVERPASS_URLS[i]));
    if (!health) return 0;
    return health.until > now ? 1000 + health.fails : health.fails;
  };

  pool.sort((a, b) => penalty(a) - penalty(b));

  // The preferred mirror only keeps the front slot while it is healthy; a
  // cooling one must not be able to hold it.
  if (preferred >= 0 && pool.includes(preferred)) {
    return [preferred, ...pool.filter(i => i !== preferred)];
  }

  return pool;
}

function clean(value = "") {
  return String(value || "").trim();
}

/*
  Strip diacritics before matching place names.

  "Türkiye" is how the country is actually written, and Nominatim resolves it,
  but every lookup table here is plain ASCII - so countryHint("Türkiye")
  returned "" and the job fell through to tiling the national centroid instead
  of asking the city list that already holds Istanbul and Ankara. The same
  miss hit "México", "Perú" and "São Paulo".
*/
function foldText(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function uniq(arr) {
  const seen = new Set();
  const out = [];

  for (const item of arr) {
    const key = String(item).toLowerCase();

    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function normalizePhone(candidate = "") {
  const raw = clean(candidate)
    .replace(/^tel:/i, "")
    .replace(/[^\d+().\-\s]/g, "")
    .trim();

  if (!raw) return "";

  const parsed = parsePhoneNumberFromString(raw, DEFAULT_COUNTRY);

  if (!parsed || !parsed.isValid()) return "";

  return parsed.formatNational();
}

function normalizeWebsite(value = "") {
  const v = clean(value);

  if (!v) return "";

  if (!/^https?:\/\//i.test(v)) {
    return "https://" + v.replace(/^\/+/, "");
  }

  return v;
}

function buildAddress(tags = {}) {
  return clean(
    [
      tags["addr:housenumber"],
      tags["addr:street"],
      tags["addr:unit"],
      tags["addr:city"],
      tags["addr:postcode"],
      tags["addr:state"],
      tags["addr:country"]
    ]
      .filter(Boolean)
      .join(", ")
  );
}

const NICHE_STOPWORDS = new Set([
  "the", "and", "for", "with", "in", "of", "on", "at", "to", "a", "an",
  "near", "me", "my", "company", "companies", "service", "services",
  "business", "businesses", "shop", "store", "inc", "llc", "ltd",
  "best", "top", "local", "pro", "pros", "professional", "contractor",
  "contractors", "expert", "experts", "solution", "solutions", "group",
  "team", "works", "center", "centre", "care", "all", "one", "plus",
  "brothers", "bros", "andson", "sons"
]);

function nicheWordList(niche = "") {
  const words = clean(niche)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(word => word.length >= 3 && !NICHE_STOPWORDS.has(word));

  return uniq(words);
}

const NICHE_TAGS = {
  plumber: ["craft=plumber"],
  plumbing: ["craft=plumber"],
  plumb: ["craft=plumber"],
  electrician: ["craft=electrician"],
  electric: ["craft=electrician"],
  electrical: ["craft=electrician"],
  mechanic: ["shop=car_repair", "shop=car_repair_2"],
  "auto repair": ["shop=car_repair", "shop=car_repair_2"],
  garage: ["shop=car_repair"],
  dent: ["amenity=dentist", "healthcare=dentist"],
  dental: ["amenity=dentist", "healthcare=dentist"],
  law: ["office=lawyer"],
  lawyer: ["office=lawyer"],
  attorney: ["office=lawyer"],
  cafe: ["amenity=cafe"],
  coffee: ["amenity=cafe"],
  restaurant: ["amenity=restaurant"],
  bar: ["amenity=bar"],
  salon: ["shop=hairdresser", "shop=beauty"],
  saloon: ["shop=hairdresser", "shop=beauty"],
  salons: ["shop=hairdresser", "shop=beauty"],
  saloons: ["shop=hairdresser", "shop=beauty"],
  hair: ["shop=hairdresser", "shop=barber"],
  barber: ["shop=barber"],
  clean: ["office=cleaning"],
  cleaning: ["office=cleaning"],
  hvac: ["craft=hvac"],
  heating: ["craft=hvac"],
  /*
    Tag coverage, not guesswork. Austin returned 12 elements for
    "craft=roofer" and 0 for "craft=roofing", so both spellings are real and
    neither is safe to drop. A niche tagged with a single variant silently
    loses every business recorded under the other one, which reads as "this
    city has no supply" when it does.
  */
  roof: ["craft=roofer", "craft=roofing", "shop=roofing", "office=roofing", "building=roofing"],
  roofing: ["craft=roofer", "craft=roofing", "shop=roofing", "office=roofing", "building=roofing"],
  roofer: ["craft=roofer", "craft=roofing", "shop=roofing"],
  paint: ["craft=painter"],
  painter: ["craft=painter"],
  pest: ["craft=pest_controller", "office=pest_control"],
  landscaping: ["craft=gardener"],
  landscaper: ["craft=gardener"],
  lawn: ["craft=gardener"],
  gym: ["leisure=fitness_centre"],
  fitness: ["leisure=fitness_centre"],
  pool: ["craft=pool_cleaner", "shop=pools"],
  contractor: ["craft=contractor", "office=construction"],
  builder: ["craft=contractor"],
  handyman: ["craft=handyman"],
  photography: ["craft=photographer"],
  "real estate": ["office=real_estate"],
  account: ["office=accountant"],
  accountant: ["office=accountant"],
  physician: ["healthcare=physician"],
  clinic: ["amenity=clinic", "healthcare=clinic"],
  doctor: ["healthcare=doctor", "amenity=doctors"],
  chiropractor: ["healthcare=chiropractor"],
  physiotherapy: ["healthcare=physiotherapist"],
  vet: ["amenity=veterinary"],
  bakery: ["shop=bakery"],
  florist: ["shop=florist"],
  pharmacy: ["shop=pharmacy", "amenity=pharmacy"],
  laundry: ["shop=laundry", "shop=dry_cleaning"],
  "car wash": ["shop=car_wash"],
  gymnasium: ["leisure=fitness_centre"],
  dealer: ["shop=car", "shop=car_dealer"],
  dealers: ["shop=car", "shop=car_dealer"],
  dealership: ["shop=car", "shop=car_dealer"],
  "car dealer": ["shop=car", "shop=car_dealer"],
  autos: ["shop=car", "shop=car_dealer"],
  "auto dealer": ["shop=car", "shop=car_dealer"],
  detail: ["shop=car_repair", "shop=car_wash", "service=vehicle_detailing"],
  detailing: ["shop=car_repair", "shop=car_wash", "service=vehicle_detailing"],
  detailer: ["shop=car_repair", "shop=car_wash", "service=vehicle_detailing"],
  solar: ["craft=solar_installer", "craft=solar_helper", "craft=renewable_energy", "office=energy"],
  "solar panel": ["craft=solar_installer", "craft=renewable_energy"],
  "solar panels": ["craft=solar_installer", "craft=renewable_energy"],
  "solar installer": ["craft=solar_installer"],
  panel: ["craft=solar_installer", "craft=renewable_energy"],
  electrician: ["craft=electrician", "office=electrical", "trade=electrician", "shop=electrical", "shop=electrician", "shop=electric", "office=electrician", "craft=electric", "craft=electrical"],
  electricians: ["craft=electrician", "office=electrical", "trade=electrician", "shop=electrical", "shop=electrician", "shop=electric", "office=electrician", "craft=electric", "craft=electrical"],
  electrical: ["craft=electrician", "office=electrical", "trade=electrician", "shop=electrical", "shop=electrician", "shop=electric", "office=electrician", "craft=electric", "craft=electrical"],
  electric: ["craft=electrician", "office=electrical", "trade=electrician", "shop=electrical", "shop=electrician", "shop=electric", "office=electrician", "craft=electric", "craft=electrical"],
  electrics: ["craft=electrician", "office=electrical", "trade=electrician", "shop=electrical", "shop=electrician", "shop=electric", "office=electrician", "craft=electric", "craft=electrical"],
  "electric company": ["craft=electrician", "office=electrical", "shop=electrical"],
  gunsmith: ["craft=gunsmith"],
  gunsmiths: ["craft=gunsmith"],
  plumber: ["craft=plumber", "office=plumber", "trade=plumber"],
  plumbers: ["craft=plumber", "office=plumber", "trade=plumber"],
  plumbing: ["craft=plumber", "office=plumber", "trade=plumber"],
  hvac: ["craft=hvac", "office=hvac", "trade=hvac", "shop=hvac"],
  roofer: ["craft=roofer", "trade=roofer"],
  roofers: ["craft=roofer", "trade=roofer"],
  roofing: ["craft=roofer", "trade=roofer"],
  carpenter: ["craft=carpenter", "trade=carpenter"],
  carpenters: ["craft=carpenter", "trade=carpenter"],
  painting: ["craft=painter", "trade=painter"],
  painters: ["craft=painter", "trade=painter"],
  "pest control": ["office=exterminator", "service=pest_control", "shop=pest_control"],
  landscaping: ["shop=landscaping", "office=landscaping", "craft=gardener"],
  landscaper: ["shop=landscaping", "office=landscaping", "craft=gardener"],
  landscapers: ["shop=landscaping", "office=landscaping", "craft=gardener"],
  handyman: ["craft=handyman", "office=handyman", "trade=handyman"],
  handymen: ["craft=handyman", "office=handyman", "trade=handyman"],
  cleaner: ["shop=cleaning_service", "office=cleaning", "craft=cleaning"],
  cleaning: ["shop=cleaning_service", "office=cleaning", "craft=cleaning"],
  "auto repair": ["shop=car_repair"],
  mechanic: ["shop=car_repair", "craft=mechanic", "office=mechanic"],
  mechanics: ["shop=car_repair", "craft=mechanic", "office=mechanic"],
  garage: ["shop=car_repair", "craft=mechanic"],
  "car repair": ["shop=car_repair"],
  "tire shop": ["shop=tyres"],
  tires: ["shop=tyres"],
  barber: ["shop=barber", "amenity=barber"],
  barbers: ["shop=barber", "amenity=barber"],
  barbershop: ["shop=barber", "amenity=barber"],
  salon: ["shop=hairdresser", "shop=beauty"],
  hairdresser: ["shop=hairdresser", "shop=beauty"],
  "hair salon": ["shop=hairdresser", "shop=beauty"],
  spa: ["leisure=spa", "amenity=spa", "shop=beauty", "office=beauty"],
  spas: ["leisure=spa", "amenity=spa", "shop=beauty", "office=beauty"],
  "day spa": ["leisure=spa", "amenity=spa"],
  "spa and salon": ["leisure=spa", "shop=beauty", "shop=hairdresser"],
  massage: ["office=beauty", "shop=beauty", "leisure=spa"],
  wellness: ["office=beauty", "leisure=spa", "shop=beauty"],
  nails: ["shop=beauty", "shop=cosmetics"],
  nail: ["shop=beauty", "shop=cosmetics"],
  manicure: ["shop=beauty"],
  dentistry: ["amenity=dentist", "healthcare=dentist", "office=health"],
  dentist: ["amenity=dentist", "healthcare=dentist", "office=health"],
  dentists: ["amenity=dentist", "healthcare=dentist", "office=health"],
  chiropractor: ["amenity=clinic", "healthcare=chiropractor", "office=health"],
  chiropractors: ["amenity=clinic", "healthcare=chiropractor", "office=health"],
  vet: ["amenity=veterinary", "office=veterinary"],
  vets: ["amenity=veterinary", "office=veterinary"],
  veterinary: ["amenity=veterinary", "office=veterinary"],
  "pet groomer": ["shop=pet_grooming"],
  grooming: ["shop=pet_grooming"],
  bakery: ["shop=bakery"],
  bakeries: ["shop=bakery"],
  restaurant: ["amenity=restaurant", "amenity=cafe", "amenity=fast_food"],
  restaurants: ["amenity=restaurant", "amenity=cafe", "amenity=fast_food"],
  cafe: ["amenity=cafe"],
  coffee: ["amenity=cafe", "shop=coffee"],
  "coffee shop": ["amenity=cafe", "shop=coffee"],
  "dry cleaner": ["shop=dry_cleaning", "shop=laundry"],
  laundry: ["shop=laundry", "shop=dry_cleaning"],
  gym: ["leisure=fitness_centre", "leisure=sports_centre", "sport=fitness"],
  gyms: ["leisure=fitness_centre", "leisure=sports_centre", "sport=fitness"],
  "auto body": ["shop=car_repair", "shop=car_parts"],
  "body shop": ["shop=car_repair"],
  "locksmith": ["shop=locksmith", "craft=locksmith"],
  locksmiths: ["shop=locksmith", "craft=locksmith"],
  pharmacy: ["amenity=pharmacy", "shop=chemist", "healthcare=pharmacy"],
  pharmacies: ["amenity=pharmacy", "shop=chemist", "healthcare=pharmacy"],
  "home inspector": ["office=surveyor"],
  inspector: ["office=surveyor"],
  "real estate": ["office=estate_agent"],
  "realtor": ["office=estate_agent"],
  realtors: ["office=estate_agent"],
  "property management": ["office=estate_agent"],
  insurance: ["office=insurance"],
  "insurance agency": ["office=insurance"],
  accounting: ["office=accountant"],
  accountant: ["office=accountant", "craft=accountant"],
  accountants: ["office=accountant", "craft=accountant"],
  lawyer: ["office=lawyer", "office=attorney"],
  lawyers: ["office=lawyer", "office=attorney"],
  attorney: ["office=lawyer", "office=attorney"],
  attornies: ["office=lawyer", "office=attorney"],
  attorneys: ["office=lawyer", "office=attorney"]
};

function singularizeWord(word) {
  const w = String(word).toLowerCase();
  // "bakeries" -> "bakery". Stripping only the "s" produced "bakerie", which
  // matched no key and sent the niche down the generic name-regex path.
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/*
  Bounded edit distance, used only to forgive a misspelled niche word.

  A customer typed "resturants" and the whole OSM source went silent: the tag
  map had no key for it, the food check did not recognise it as food, and the
  element matcher could not match "restaurant". Exact matching stays first
  everywhere; this only runs as a last resort, and only for words long enough
  (>= 6 chars) that a slip cannot collide with a different trade such as
  "car" -> "bar".
*/
function editDistance(a = "", b = "") {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        prev[j] + 1,
        next[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = next;
  }

  return prev[b.length];
}

function wordClose(a = "", b = "") {
  const x = singularizeWord(a).replace(/[^a-z0-9]/g, "");
  const y = singularizeWord(b).replace(/[^a-z0-9]/g, "");

  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 6 || y.length < 6) return false;

  const limit = Math.min(x.length, y.length) >= 9 ? 2 : 1;
  if (Math.abs(x.length - y.length) > limit) return false;

  return editDistance(x, y) <= limit;
}

export function tagFiltersForNiche(niche = "") {
  const n = clean(niche).toLowerCase();
  const tags = new Set();

  const words = n.split(/[^a-z]+/).filter(Boolean);
  const wordSet = new Set(words);
  const singularSet = new Set(words.map(singularizeWord));

  for (const key of Object.keys(NICHE_TAGS)) {
    const k = key.toLowerCase();

    /*
      Whole-word matching only. Substring matching made "barber" match the
      "bar" key, which queries amenity=bar (pubs) instead of shop=barber.
    */
    const hit = k.includes(" ")
      ? n.includes(k)
      : wordSet.has(k) || wordSet.has(`${k}s`) || singularSet.has(k)
        || words.some(word => wordClose(word, k));

    if (hit) {
      for (const tag of NICHE_TAGS[key]) tags.add(tag);
    }
  }

  return [...tags];
}

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stemVariants(word = "", synonyms = []) {
  const w = String(word).toLowerCase();
  const out = new Set([w]);

  if (w.length > 3 && w.endsWith("ing")) out.add(w.slice(0, -3));
  if (w.length > 3 && w.endsWith("ers")) out.add(w.slice(0, -3));
  if (w.length > 3 && w.endsWith("er")) out.add(w.slice(0, -2));
  if (w.length > 3 && w.endsWith("es")) out.add(w.slice(0, -2));
  if (w.length > 3 && w.endsWith("s")) out.add(w.slice(0, -1));

  const base = [...out].sort((a, b) => a.length - b.length)[0];

  out.add(base + "s");
  out.add(base + "ing");
  out.add(base + "er");
  out.add(base + "ers");
  out.add(base + "ed");

  for (const syn of synonyms) out.add(syn);

  return [...out].filter(v => v.length >= 3 && !NICHE_STOPWORDS.has(v));
}

function keywordSynonyms() {
  return {
    groomer: ["groom", "grooming", "pet groom", "dog grooming"],
    groom: ["grooming", "groomer"],
    groomers: ["grooming", "groomer"],
    moving: ["movers", "move", "relocation", "van lines"],
    mover: ["moving", "movers", "relocation"],
    movers: ["moving", "relocation", "van lines"],
    photograph: ["photo", "photography", "photographer"],
    photographers: ["photography", "photo"],
    photography: ["photo", "photographer"],
    photographer: ["photo", "photography"],
    massage: ["spa", "bodywork"],
    therapist: ["therapy", "therapeutic"],
    therapy: ["therapeutic", "therapist"],
    spa: ["massage", "wellness", "day spa"],
    "real estate": ["realtor", "property"],
    realtor: ["real estate", "property"],
    auto: ["car", "vehicle"],
    car: ["auto", "vehicle"],
    detailer: ["detailing", "detail", "car wash"],
    detailing: ["detail", "car wash"],
    detail: ["detailing"],
    plumber: ["plumbing"],
    plumbing: ["plumber"],
    electrician: ["electrical", "electric"],
    electricians: ["electrical", "electric"],
    electric: ["electrical"],
    land: ["landscaping", "lawn"],
    landscaping: ["landscape", "lawn", "gardener"],
    cleaning: ["cleaners", "cleaning service", "janitorial"],
    cleaner: ["cleaning", "cleaners"],
    cleaners: ["cleaning"],
    "air conditioning": ["hvac", "heating and cooling", "ac repair"],
    hvac: ["heating", "air conditioning", "furnace"],
    heating: ["hvac", "air conditioning"],
    roofing: ["roof", "roofer"],
    roofer: ["roofing", "roof"],
    roofing: ["roofer"],
    painting: ["paint", "painter"],
    painter: ["paint", "painters"],
    painters: ["paint", "painter"],
    pest: ["exterminator", "exterminating", "bug control"],
    exterminator: ["pest", "exterminating"],
    lawn: ["landscaping", "gardener", "lawn care"],
    garden: ["landscaping", "gardener", "nursery"],
    gym: ["fitness", "training", "gymnasium"],
    fitness: ["gym", "training"],
    "pool": ["swimming pool", "pool service", "pool cleaning"],
    ph: ["photography"],
    barber: ["barbershop", "hair"],
    barbershop: ["barber", "hair"],
    salon: ["beauty", "hair salon", "nails", "saloon", "salons"],
    "saloon": ["salon", "beauty", "hair salon", "nails"],
    salon: ["beauty", "hair salon", "nails", "saloon"],
    "hair": ["salon", "haircut", "barber"],
    nails: ["nail salon", "manicure", "pedicure"],
    nail: ["nails", "manicure", "pedicure"],
    dentist: ["dental", "dental care"],
    dental: ["dentist"],
    physician: ["doctor", "medical", "healthcare"],
    doctor: ["physician", "medical"],
    clinic: ["medical", "healthcare", "urgent care"],
    vet: ["veterinary", "animal hospital"],
    veterinary: ["vet", "animal hospital"],
    bakery: ["baker", "pastry", "baked goods"],
    florist: ["flowers", "flower shop"],
    pharmacy: ["drugstore", "chemist"],
    laundry: ["dry cleaner", "laundromat", "wash and fold"],
    "laundromat": ["laundry", "wash and fold"],
    "dry cleaner": ["laundry", "dry cleaning"],
    "car wash": ["car detailing", "detail"],
    locksmith: ["lock and key", "locks"],
    account: ["bookkeeping", "tax", "accounting"],
    accountant: ["bookkeeping", "tax"],
    accounting: ["bookkeeper", "tax"],
    law: ["lawyer", "legal", "attorney"],
    lawyer: ["law", "attorney", "law firm"],
    attorney: ["lawyer", "law firm"],
    insurance: ["insurance agency", "insurance broker"],
    "spa": ["massage", "wellness", "day spa", "nails"],
    nail: ["manicure", "pedicure", "nails"]
  };
}

function nameRegexForNiche(niche = "") {
  const words = nicheWordList(niche);

  if (words.length === 0) return "";

  if (words.length === 1) {
    const variants = stemVariants(words[0], keywordSynonyms()[words[0]] || []).map(escapeRegex);
    return `(${variants.join("|")})`;
  }

  const syns = keywordSynonyms();
  const allVariants = new Set();

  for (const word of words) {
    for (const v of stemVariants(word, syns[word] || [])) allVariants.add(v);
  }

  return `(${[...allVariants].map(escapeRegex).join("|")})`;
}

function overpassFilters(niche = "") {
  const tagFilters = tagFiltersForNiche(niche);

  if (tagFilters.length > 0) {
    return tagFilters.map(tag => {
      const [k, v] = tag.split("=");
      const selector = `["${k}"="${v}"]`;
      return `node${selector}\n  way${selector}\n  relation${selector}`;
    });
  }

  const namePattern = nameRegexForNiche(niche);
  const nameSelector =
    namePattern.length > 0
      ? `node["name"~"${namePattern}",i]\n  way["name"~"${namePattern}",i]\n  relation["name"~"${namePattern}",i]`
      : "node\n  way\n  relation";

  return [nameSelector];
}

/*
  Major business centres per country, ordered so the tight job budget is spent
  on the densest markets first.

  A country-level query cannot be answered from the country bounding box. Mexico
  spans roughly 31 degrees of longitude and Nominatim happily returns the
  national centroid, which lands in empty desert in Zacatecas. Tiling that
  centroid produced 24 Overpass requests that mostly returned nothing, because
  there is genuinely nothing out there.

  Querying the same tag across real city bounding boxes returns plenty:
  shop=car_repair in Guadalajara returns 89 elements and in Mexico City 200+.
  So for a country we ask "where are the people", not "what is the middle of
  the country".
*/
export const COUNTRY_CITY_CENTERS = {
  // Exported for the location typeahead (src/locations.js), which builds its
  // offline suggestion index from these same coordinates.
  mx: [
    ["Mexico City", 19.4326, -99.1332],
    ["Guadalajara", 20.6597, -103.3496],
    ["Monterrey", 25.6866, -100.3161],
    ["Puebla", 19.0414, -98.2063],
    ["Tijuana", 32.5149, -117.0382],
    ["Leon", 21.1219, -101.6833],
    ["Ciudad Juarez", 31.6904, -106.4245],
    ["Zapopan", 20.7214, -103.3918],
    ["Merida", 20.9674, -89.5926],
    ["Queretaro", 20.5888, -100.3899],
    ["Cancun", 21.1619, -86.8515],
    ["Toluca", 19.2826, -99.6557]
  ],
  us: [
    ["New York", 40.7128, -74.006], ["Los Angeles", 34.0522, -118.2437],
    ["Chicago", 41.8781, -87.6298], ["Houston", 29.7604, -95.3698],
    ["Phoenix", 33.4484, -112.074], ["Philadelphia", 39.9526, -75.1652],
    ["San Antonio", 29.4241, -98.4936], ["San Diego", 32.7157, -117.1611],
    ["Dallas", 32.7767, -96.797], ["San Jose", 37.3382, -121.8863],
    ["Austin", 30.2672, -97.7431], ["Jacksonville", 30.3322, -81.6557],
    ["Charlotte", 35.2271, -80.8431], ["Columbus", 39.9612, -82.9988],
    ["Indianapolis", 39.7684, -86.1581], ["Seattle", 47.6062, -122.3321],
    ["Denver", 39.7392, -104.9903], ["Boston", 42.3601, -71.0589],
    ["Nashville", 36.1627, -86.7816], ["Portland", 45.5152, -122.6784]
  ],
  ca: [
    ["Toronto", 43.6532, -79.3832], ["Montreal", 45.5017, -73.5673],
    ["Vancouver", 49.2827, -123.1207], ["Calgary", 51.0447, -114.0719],
    ["Edmonton", 53.5461, -113.4938], ["Ottawa", 45.4215, -75.6972],
    ["Winnipeg", 49.8951, -97.1384], ["Quebec City", 46.8139, -71.208],
    ["Hamilton", 43.2557, -79.8711], ["London", 42.9849, -81.2453]
  ],
  gb: [
    ["London", 51.5074, -0.1278], ["Birmingham", 52.4862, -1.8904],
    ["Manchester", 53.4808, -2.2426], ["Leeds", 53.8008, -1.5491],
    ["Glasgow", 55.8642, -4.2518], ["Liverpool", 53.4084, -2.9916],
    ["Sheffield", 53.3811, -1.4701], ["Edinburgh", 55.9533, -3.1883],
    ["Bristol", 51.4545, -2.5879], ["Cardiff", 51.4816, -3.1791]
  ],
  au: [
    ["Sydney", -33.8688, 151.2093], ["Melbourne", -37.8136, 144.9631],
    ["Brisbane", -27.4698, 153.0251], ["Perth", -31.9523, 115.8613],
    ["Adelaide", -34.9285, 138.6007], ["Canberra", -35.2809, 149.13],
    ["Hobart", -42.8821, 147.3272], ["Gold Coast", -28.0167, 153.4]
  ],
  in: [
    ["Mumbai", 19.076, 72.8777], ["Delhi", 28.6139, 77.209],
    ["Bangalore", 12.9716, 77.5946], ["Hyderabad", 17.385, 78.4867],
    ["Chennai", 13.0827, 80.2707], ["Pune", 18.5204, 73.8567],
    ["Kolkata", 22.5726, 88.3639], ["Ahmedabad", 23.0225, 72.5714],
    ["Jaipur", 26.9124, 75.7873], ["Surat", 21.1702, 72.8311]
  ],
  de: [
    ["Berlin", 52.52, 13.405], ["Hamburg", 53.5511, 9.9937],
    ["Munich", 48.1351, 11.582], ["Cologne", 50.9375, 6.9603],
    ["Frankfurt", 50.1109, 8.6821], ["Stuttgart", 48.7758, 9.1829],
    ["Dusseldorf", 51.2277, 6.7735], ["Leipzig", 51.3397, 12.3731]
  ],
  fr: [
    ["Paris", 48.8566, 2.3522], ["Marseille", 43.2965, 5.3698],
    ["Lyon", 45.764, 4.8357], ["Toulouse", 43.6047, 1.4442],
    ["Nice", 43.7102, 7.262], ["Nantes", 47.2184, -1.5536],
    ["Bordeaux", 44.8378, -0.5792], ["Lille", 50.6292, 3.0573]
  ],
  es: [
    ["Madrid", 40.4168, -3.7038], ["Barcelona", 41.3874, 2.1686],
    ["Valencia", 39.4699, -0.3763], ["Seville", 37.3891, -5.9845],
    ["Zaragoza", 41.6488, -0.8891], ["Malaga", 36.7213, -4.4214],
    ["Bilbao", 43.263, -2.935], ["Murcia", 37.9922, -1.1307]
  ],
  it: [
    ["Rome", 41.9028, 12.4964], ["Milan", 45.4642, 9.19],
    ["Naples", 40.8518, 14.2681], ["Turin", 45.0703, 7.6869],
    ["Palermo", 38.1157, 13.3615], ["Genoa", 44.4056, 8.9463],
    ["Bologna", 44.4949, 11.3426], ["Florence", 43.7696, 11.2558]
  ],
  br: [
    ["Sao Paulo", -23.5505, -46.6333], ["Rio de Janeiro", -22.9068, -43.1729],
    ["Belo Horizonte", -19.9167, -43.9345], ["Brasilia", -15.7939, -47.8828],
    ["Salvador", -12.9777, -38.5016], ["Fortaleza", -3.7319, -38.5267],
    ["Curitiba", -25.4284, -49.2733], ["Porto Alegre", -30.0346, -51.2177]
  ],
  ae: [
    ["Dubai", 25.2048, 55.2708], ["Abu Dhabi", 24.4539, 54.3773],
    ["Sharjah", 25.3463, 55.4209], ["Al Ain", 24.2075, 55.7447]
  ],
  nl: [
    ["Amsterdam", 52.3676, 4.9041], ["Rotterdam", 51.9244, 4.4777],
    ["The Hague", 52.0705, 4.3007], ["Utrecht", 52.0907, 5.1214],
    ["Eindhoven", 51.4416, 5.4697]
  ],
  za: [
    ["Johannesburg", -26.2041, 28.0473], ["Cape Town", -33.9249, 18.4241],
    ["Durban", -29.8587, 31.0218], ["Pretoria", -25.7479, 28.2293]
  ],
  ng: [
    ["Lagos", 6.5244, 3.3792], ["Abuja", 9.0765, 7.3986],
    ["Kano", 12.0022, 8.592], ["Ibadan", 7.3775, 3.947],
    ["Port Harcourt", 4.8156, 7.0498]
  ],
  ph: [
    ["Manila", 14.5995, 120.9842], ["Quezon City", 14.676, 121.0437],
    ["Cebu City", 10.3157, 123.8854], ["Davao City", 7.1907, 125.4553]
  ],
  id: [
    ["Jakarta", -6.2088, 106.8456], ["Surabaya", -7.2575, 112.7521],
    ["Bandung", -6.9175, 107.6191], ["Medan", 3.5952, 98.6722]
  ],
  pl: [
    ["Warsaw", 52.2297, 21.0122], ["Krakow", 50.0647, 19.945],
    ["Wroclaw", 51.1079, 17.0385], ["Poznan", 52.4064, 16.9252],
    ["Gdansk", 54.352, 18.6466]
  ],
  tr: [
    ["Istanbul", 41.0082, 28.9784], ["Ankara", 39.9334, 32.8597],
    ["Izmir", 38.4237, 27.1428], ["Bursa", 40.1826, 29.0665]
  ],
  se: [
    ["Stockholm", 59.3293, 18.0686], ["Gothenburg", 57.7089, 11.9746],
    ["Malmo", 55.605, 13.0038], ["Uppsala", 59.8586, 17.6389]
  ],
  co: [
    ["Bogota", 4.711, -74.0721], ["Medellin", 6.2442, -75.5812],
    ["Cali", 3.4516, -76.532], ["Barranquilla", 10.9685, -74.7813]
  ],
  ar: [
    ["Buenos Aires", -34.6037, -58.3816], ["Cordoba", -31.4201, -64.1888],
    ["Rosario", -32.9442, -60.6505], ["Mendoza", -32.8895, -68.8458]
  ],
  // South Asia
  pk: [
    ["Lahore", 31.5204, 74.3587], ["Karachi", 24.8607, 67.0011],
    ["Islamabad", 33.6844, 73.0479], ["Faisalabad", 31.4504, 73.135],
    ["Rawalpindi", 33.5651, 73.0169], ["Multan", 30.1575, 71.5249],
    ["Peshawar", 34.0151, 71.585], ["Gujranwala", 32.1877, 74.1945],
    ["Sialkot", 32.4945, 74.5229], ["Quetta", 30.1798, 66.975]
  ],
  bd: [
    ["Dhaka", 23.8103, 90.4125], ["Chittagong", 22.3569, 91.7832],
    ["Khulna", 22.826, 89.558], ["Sylhet", 24.8949, 91.8687],
    ["Rajshahi", 24.3745, 88.6042], ["Narayanganj", 23.6231, 90.4994]
  ],
  lk: [
    ["Colombo", 6.9271, 79.8612], ["Dehiwala", 6.8489, 79.866],
    ["Kandy", 7.2906, 80.6337], ["Jaffna", 9.6615, 80.025], ["Galle", 6.0329, 80.2168]
  ],
  np: [
    ["Kathmandu", 27.7172, 85.324], ["Pokhara", 28.2096, 83.9856],
    ["Lalitpur", 27.671, 85.325], ["Biratnagar", 26.4525, 87.2718]
  ],
  af: [
    ["Kabul", 34.5553, 69.2075], ["Herat", 34.341, 62.198], ["Mazar-i-Sharif", 36.709, 67.111]
  ],
  // Middle East
  sa: [
    ["Riyadh", 24.7136, 46.6753], ["Jeddah", 21.4858, 39.1925],
    ["Mecca", 21.3891, 39.8579], ["Medina", 24.5247, 39.5692],
    ["Dammam", 26.4207, 50.0888], ["Al Khobar", 26.2826, 50.1973]
  ],
  qa: [["Doha", 25.2854, 51.531], ["Al Wakrah", 25.1683, 51.6019], ["Al Khor", 25.6825, 51.4969]],
  kw: [["Kuwait City", 29.3759, 47.9774], ["Hawalli", 29.3386, 48.0283], ["Farwaniya", 29.2845, 47.9333]],
  om: [["Muscat", 23.588, 58.3829], ["Salalah", 17.0198, 54.0894], ["Sohar", 24.3488, 56.7098]],
  bh: [["Manama", 26.2285, 50.586], ["Muharraq", 26.2804, 50.6126], ["Riffa", 26.1342, 50.555]],
  ir: [
    ["Tehran", 35.6892, 51.389], ["Mashhad", 36.2605, 59.6168], ["Isfahan", 32.6546, 51.668],
    ["Shiraz", 29.5918, 52.5837], ["Karaj", 35.84, 50.9392]
  ],
  iq: [["Baghdad", 33.3152, 44.3661], ["Basra", 30.5085, 47.7804], ["Mosul", 36.335, 43.1189], ["Erbil", 36.1901, 44.0091]],
  jo: [["Amman", 31.9454, 35.9284], ["Zarqa", 32.0728, 36.0876], ["Irbid", 32.5556, 35.85]],
  il: [["Tel Aviv", 32.0853, 34.7818], ["Jerusalem", 31.7683, 35.2137], ["Haifa", 32.794, 34.9896]],
  lb: [["Beirut", 33.8935, 35.5018], ["Tripoli", 34.4367, 35.8497], ["Sidon", 33.5613, 35.3975]],
  // North Africa
  eg: [
    ["Cairo", 30.0444, 31.2357], ["Alexandria", 31.2001, 29.9187], ["Giza", 30.0131, 31.2089],
    ["Sharm El Sheikh", 27.9158, 34.33], ["Luxor", 25.6872, 32.6396]
  ],
  ma: [["Casablanca", 33.5731, -7.5898], ["Rabat", 34.0209, -6.8416], ["Marrakesh", 31.6295, -7.9811], ["Fes", 34.0181, -5.0078]],
  dz: [["Algiers", 36.7538, 3.0588], ["Oran", 35.6971, -0.6308], ["Constantine", 36.365, 6.6147]],
  tn: [["Tunis", 36.8065, 10.1815], ["Sfax", 34.7406, 10.7603], ["Sousse", 35.8256, 10.6369]],
  // Sub-Saharan Africa
  ke: [["Nairobi", -1.2921, 36.8219], ["Mombasa", -4.0435, 39.6682], ["Kisumu", -0.0917, 34.768]],
  tz: [["Dar es Salaam", -6.7924, 39.2083], ["Dodoma", -6.163, 35.7516], ["Arusha", -3.3731, 36.682]],
  ug: [["Kampala", 0.3476, 32.5825], ["Gulu", 2.7744, 32.3027]],
  et: [["Addis Ababa", 9.025, 38.7469], ["Dire Dawa", 9.5926, 41.8569], ["Mekelle", 13.4967, 39.4753]],
  gh: [["Accra", 5.6037, -0.187], ["Kumasi", 6.6885, -1.6244], ["Tamale", 9.4034, -0.8424]],
  sn: [["Dakar", 14.7167, -17.4677], ["Thies", 14.7903, -16.9259]],
  ci: [["Abidjan", 5.36, -4.0083], ["Bouake", 7.69, -5.03]],
  cm: [["Douala", 4.0511, 9.7679], ["Yaounde", 3.848, 11.5021]],
  rw: [["Kigali", -1.9403, 29.8739]],
  // South-East Asia
  vn: [
    ["Ho Chi Minh City", 10.8231, 106.6297], ["Hanoi", 21.0285, 105.8542],
    ["Da Nang", 16.0544, 108.2022], ["Haiphong", 20.8449, 106.6881]
  ],
  th: [
    ["Bangkok", 13.7563, 100.5018], ["Chiang Mai", 18.7883, 98.9853],
    ["Pattaya", 12.9388, 100.8875], ["Nonthaburi", 13.8622, 100.5144]
  ],
  my: [
    ["Kuala Lumpur", 3.139, 101.6869], ["George Town", 5.4141, 100.3288],
    ["Johor Bahru", 1.4927, 103.7414], ["Ipoh", 4.5975, 101.0901]
  ],
  sg: [["Singapore", 1.3521, 103.8198]],
  kh: [["Phnom Penh", 11.5564, 104.9282], ["Siem Reap", 13.3671, 103.8448]],
  mm: [["Yangon", 16.8661, 96.1951], ["Mandalay", 21.9588, 96.0891]],
  la: [["Vientiane", 17.9757, 102.6331]],
  // Central Asia
  kz: [["Almaty", 43.222, 76.8512], ["Astana", 51.1694, 71.4491], ["Shymkent", 42.3167, 69.5901]],
  uz: [["Tashkent", 41.2995, 69.2401], ["Samarkand", 39.6542, 66.9758], ["Namangan", 40.9983, 71.6834]],
  // Northern / Western Europe
  no: [["Oslo", 59.9139, 10.7522], ["Bergen", 60.3913, 5.3221], ["Trondheim", 63.4305, 10.3951]],
  dk: [["Copenhagen", 55.6761, 12.5683], ["Aarhus", 56.1629, 10.2039], ["Odense", 55.4038, 10.4024]],
  fi: [["Helsinki", 60.1699, 24.9384], ["Tampere", 61.4978, 23.761], ["Turku", 60.4518, 22.2666]],
  pt: [["Lisbon", 38.7223, -9.1393], ["Porto", 41.1579, -8.6291], ["Braga", 41.5454, -8.4265], ["Coimbra", 40.2111, -8.4295]],
  ie: [["Dublin", 53.3498, -6.2603], ["Cork", 51.8985, -8.4756], ["Limerick", 52.6638, -8.6267], ["Galway", 53.2707, -9.0568]],
  ch: [["Zurich", 47.3769, 8.5417], ["Geneva", 46.2044, 6.1432], ["Basel", 47.5596, 7.5886], ["Bern", 46.948, 7.4474]],
  at: [["Vienna", 48.2082, 16.3738], ["Graz", 47.0707, 15.4395], ["Linz", 48.3069, 14.2858], ["Salzburg", 47.8095, 13.055]],
  // Central / Eastern / Southern Europe
  cz: [["Prague", 50.0755, 14.4378], ["Brno", 49.1951, 16.6068], ["Ostrava", 49.8209, 18.2625]],
  hu: [["Budapest", 47.4979, 19.0402], ["Debrecen", 47.5316, 21.6273], ["Szeged", 46.253, 20.1414]],
  ro: [["Bucharest", 44.4268, 26.1025], ["Cluj-Napoca", 46.7712, 23.6236], ["Timisoara", 45.7489, 21.2087], ["Iasi", 47.1585, 27.6014]],
  gr: [["Athens", 37.9838, 23.7275], ["Thessaloniki", 40.6401, 22.9444], ["Patras", 38.2466, 21.7346]],
  ua: [["Kyiv", 50.4501, 30.5234], ["Kharkiv", 49.9935, 36.2304], ["Odesa", 46.4825, 30.7233], ["Lviv", 49.8397, 24.0297]],
  bg: [["Sofia", 42.6977, 23.3219], ["Plovdiv", 42.1354, 24.7453], ["Varna", 43.2141, 27.9147]],
  rs: [["Belgrade", 44.7866, 20.4489], ["Novi Sad", 45.2671, 19.8335], ["Nis", 43.3209, 21.8954]],
  sk: [["Bratislava", 48.1486, 17.1077], ["Kosice", 48.7164, 21.2611]],
  si: [["Ljubljana", 46.0569, 14.5058], ["Maribor", 46.5547, 15.6459]],
  hr: [["Zagreb", 45.815, 15.9819], ["Split", 43.5081, 16.4402], ["Rijeka", 45.3271, 14.4422]],
  // Oceania
  nz: [["Auckland", -36.8485, 174.7633], ["Wellington", -41.2866, 174.7756], ["Christchurch", -43.5321, 172.6362], ["Hamilton", -37.787, 175.2793]],
  // Americas (beyond mx/br/co/ar)
  cl: [["Santiago", -33.4489, -70.6693], ["Concepcion", -36.827, -73.0498], ["Valparaiso", -33.0472, -71.6127]],
  pe: [["Lima", -12.0464, -77.0428], ["Arequipa", -16.409, -71.5375], ["Trujillo", -8.1091, -79.0215]],
  ec: [["Quito", -0.1807, -78.4678], ["Guayaquil", -2.1894, -79.8891], ["Cuenca", -2.9001, -79.0059]],
  cr: [["San Jose", 9.9281, -84.0907], ["Alajuela", 10.0151, -84.214], ["Cartago", 9.8644, -83.9193]],
  pa: [["Panama City", 8.9824, -79.5199], ["San Miguelito", 9.07, -79.47], ["David", 8.427, -82.431]],
  gt: [["Guatemala City", 14.6349, -90.5069], ["Mixco", 14.6333, -90.6064], ["Quetzaltenango", 14.8333, -91.5167]],
  do: [["Santo Domingo", 18.4861, -69.9312], ["Santiago", 19.4517, -70.697]],
  sv: [["San Salvador", 13.6929, -89.2182], ["Santa Ana", 13.9967, -89.561]],
  jm: [["Kingston", 17.9714, -76.7931], ["Montego Bay", 18.4762, -77.9223]],
  tt: [["Port of Spain", 10.6549, -61.5019], ["San Fernando", 10.2796, -61.4619]]
};

/*
  Densest metros per US state, so a state job searches its own cities.

  Without this a "texas" job queries COUNTRY_CITY_CENTERS.us, whose first entry
  is New York: Overpass happily returns 200 New York cafes, the inTargetArea
  gate throws every one of them away, and the job reports zero leads in Texas
  while having made a dozen successful API calls. Same for California.
*/
export const US_STATE_CITY_CENTERS = {
  alabama: [["Birmingham", 33.5186, -86.8104], ["Montgomery", 32.3668, -86.3000], ["Huntsville", 34.7304, -86.5861], ["Mobile", 30.6954, -88.0399]],
  arizona: [["Phoenix", 33.4484, -112.0740], ["Tucson", 32.2226, -110.9747], ["Mesa", 33.4152, -111.8315], ["Chandler", 33.3062, -111.8413]],
  arkansas: [["Little Rock", 34.7465, -92.2896], ["Fayetteville", 36.0626, -94.1574], ["Springdale", 36.1885, -94.2988], ["Fort Smith", 35.3859, -94.3985]],
  california: [["Los Angeles", 34.0522, -118.2437], ["San Diego", 32.7157, -117.1611], ["San Jose", 37.3382, -121.8863], ["Fresno", 36.7378, -119.7871], ["Sacramento", 38.5816, -121.4944], ["Long Beach", 33.7701, -118.1937], ["Oakland", 37.8044, -122.2712], ["Bakersfield", 35.3733, -119.0187]],
  colorado: [["Denver", 39.7392, -104.9903], ["Colorado Springs", 38.8339, -104.8214], ["Aurora", 39.7294, -104.8319], ["Fort Collins", 40.5853, -105.0844]],
  connecticut: [["Bridgeport", 41.1865, -73.1952], ["New Haven", 41.3083, -72.9279], ["Stamford", 41.0534, -73.5387], ["Hartford", 41.7658, -72.6734]],
  delaware: [["Wilmington", 39.7391, -75.5398], ["Dover", 39.1582, -75.5244], ["Newark", 39.6837, -75.7497]],
  florida: [["Jacksonville", 30.3322, -81.6557], ["Miami", 25.7617, -80.1918], ["Tampa", 27.9506, -82.4572], ["Orlando", 28.5383, -81.3792], ["Tallahassee", 30.4383, -84.2807], ["Fort Lauderdale", 26.1224, -80.1373], ["Cape Coral", 26.5629, -81.9495], ["Port St. Lucie", 27.2730, -80.3582]],
  georgia: [["Atlanta", 33.7490, -84.3880], ["Augusta", 33.4735, -82.0105], ["Columbus", 32.4610, -84.9877], ["Savannah", 32.0809, -81.0912], ["Macon", 32.8407, -83.6324]],
  hawaii: [["Honolulu", 21.3069, -157.8583], ["Hilo", 19.7297, -155.0900], ["Kailua", 21.4022, -157.7394]],
  idaho: [["Boise", 43.6150, -116.2023], ["Meridian", 43.6121, -116.3915], ["Nampa", 43.5400, -116.5633], ["Idaho Falls", 43.4666, -112.0341]],
  illinois: [["Chicago", 41.8781, -87.6298], ["Aurora", 41.7606, -88.3201], ["Joliet", 41.5250, -88.0817], ["Naperville", 41.7508, -88.1535], ["Rockford", 42.2711, -89.0940]],
  indiana: [["Indianapolis", 39.7684, -86.1581], ["Fort Wayne", 41.0793, -85.1394], ["Evansville", 37.9716, -87.5711], ["South Bend", 41.6764, -86.2520], ["Bloomington", 39.1653, -86.5264]],
  iowa: [["Des Moines", 41.5868, -93.6250], ["Cedar Rapids", 41.9779, -91.6656], ["Davenport", 41.5236, -90.5776], ["Sioux City", 42.4963, -96.4000]],
  kansas: [["Wichita", 37.6872, -97.3301], ["Overland Park", 38.9822, -94.6708], ["Kansas City", 39.1141, -94.6275], ["Olathe", 38.8814, -94.8191], ["Topeka", 39.0473, -95.6752]],
  kentucky: [["Louisville", 38.2527, -85.7585], ["Lexington", 38.0406, -84.5037], ["Bowling Green", 36.9685, -86.4808], ["Owensboro", 37.7742, -87.1138]],
  louisiana: [["New Orleans", 29.9511, -90.0715], ["Baton Rouge", 30.4515, -91.1871], ["Shreveport", 32.5252, -93.7502], ["Lafayette", 30.2241, -92.0198]],
  maine: [["Portland", 43.6591, -70.2568], ["Lewiston", 44.1003, -70.2078], ["Bangor", 44.8012, -68.7778]],
  maryland: [["Baltimore", 39.2904, -76.6122], ["Columbia", 39.2037, -76.8610], ["Germantown", 39.1732, -77.2714], ["Annapolis", 38.9784, -76.4922]],
  massachusetts: [["Boston", 42.3601, -71.0589], ["Worcester", 42.2626, -71.8023], ["Springfield", 42.1015, -72.5898], ["Cambridge", 42.3736, -71.1097]],
  michigan: [["Detroit", 42.3314, -83.0458], ["Grand Rapids", 42.9634, -85.6681], ["Warren", 42.5145, -83.0147], ["Lansing", 42.7325, -84.5555], ["Ann Arbor", 42.2808, -83.7430]],
  minnesota: [["Minneapolis", 44.9778, -93.2650], ["St. Paul", 44.9537, -93.0900], ["Rochester", 44.0121, -92.4802], ["Duluth", 46.7867, -92.1005]],
  mississippi: [["Jackson", 32.2988, -90.1848], ["Gulfport", 30.3674, -89.0928], ["Southaven", 34.9899, -90.0126], ["Hattiesburg", 31.3271, -89.2902]],
  missouri: [["Kansas City", 39.0997, -94.5786], ["St. Louis", 38.6270, -90.1994], ["Springfield", 37.2090, -93.2923], ["Columbia", 38.9517, -92.3341]],
  montana: [["Billings", 45.7833, -108.5007], ["Missoula", 46.8721, -113.9940], ["Great Falls", 47.5101, -111.3006], ["Bozeman", 45.6770, -111.0429]],
  nebraska: [["Omaha", 41.2565, -95.9345], ["Lincoln", 40.8136, -96.7026], ["Bellevue", 41.1367, -95.8939], ["Grand Island", 40.9264, -98.3420]],
  nevada: [["Las Vegas", 36.1699, -115.1398], ["Henderson", 36.0395, -114.9817], ["Reno", 39.5296, -119.8138], ["Sparks", 39.5349, -119.7527]],
  "new hampshire": [["Manchester", 42.9956, -71.4548], ["Nashua", 42.7654, -71.4676], ["Concord", 43.2081, -71.5376]],
  "new jersey": [["Newark", 40.7357, -74.1724], ["Jersey City", 40.7178, -74.0431], ["Paterson", 40.9168, -74.1718], ["Edison", 40.5187, -74.4121], ["Woodbridge", 40.5576, -74.2846]],
  "new mexico": [["Albuquerque", 35.0844, -106.6504], ["Las Cruces", 32.3199, -106.7637], ["Rio Rancho", 35.2328, -106.6591], ["Santa Fe", 35.6870, -105.9378]],
  "new york": [["New York", 40.7128, -74.0060], ["Buffalo", 42.8864, -78.8784], ["Rochester", 43.1566, -77.6088], ["Yonkers", 40.9312, -73.8988], ["Syracuse", 43.0481, -76.1474]],
  "north carolina": [["Charlotte", 35.2271, -80.8431], ["Raleigh", 35.7796, -78.6382], ["Greensboro", 36.0726, -79.7920], ["Durham", 35.9940, -78.8986]],
  "north dakota": [["Fargo", 46.8772, -96.7898], ["Bismarck", 46.8083, -100.7837], ["Grand Forks", 47.9253, -97.0329]],
  ohio: [["Columbus", 39.9612, -82.9988], ["Cleveland", 41.4993, -81.6944], ["Cincinnati", 39.1031, -84.5120], ["Toledo", 41.6528, -83.5378], ["Akron", 41.0814, -81.5190], ["Dayton", 39.7589, -84.1916]],
  oklahoma: [["Oklahoma City", 35.4676, -97.5164], ["Tulsa", 36.1540, -95.9928], ["Norman", 35.2226, -97.4395], ["Broken Arrow", 36.0526, -95.7908]],
  oregon: [["Portland", 45.5152, -122.6784], ["Eugene", 44.0521, -123.0868], ["Salem", 44.9429, -123.0352], ["Gresham", 45.4982, -122.4315]],
  pennsylvania: [["Philadelphia", 39.9526, -75.1652], ["Pittsburgh", 40.4406, -79.9959], ["Allentown", 40.6023, -75.4714], ["Erie", 42.1292, -80.0851], ["Harrisburg", 40.2732, -76.8867]],
  "rhode island": [["Providence", 41.8240, -71.4128], ["Warwick", 41.7001, -71.4162], ["Cranston", 41.7782, -71.4376]],
  "south carolina": [["Charleston", 32.7765, -79.9311], ["Columbia", 34.0007, -81.0348], ["North Charleston", 32.8546, -79.9748], ["Greenville", 34.8526, -82.3940]],
  "south dakota": [["Sioux Falls", 43.5460, -96.7313], ["Rapid City", 44.0805, -103.2310]],
  tennessee: [["Nashville", 36.1627, -86.7816], ["Memphis", 35.1495, -90.0490], ["Knoxville", 35.9606, -83.9207], ["Chattanooga", 35.0456, -85.3097]],
  texas: [["Houston", 29.7604, -95.3698], ["San Antonio", 29.4241, -98.4936], ["Dallas", 32.7767, -96.7970], ["Austin", 30.2672, -97.7431], ["Fort Worth", 32.7555, -97.3308], ["El Paso", 31.7619, -106.4850], ["Arlington", 32.7357, -97.1081], ["Corpus Christi", 27.8006, -97.3964], ["Plano", 33.0198, -96.6989], ["Laredo", 27.5306, -99.4803]],
  utah: [["Salt Lake City", 40.7608, -111.8910], ["West Valley City", 40.6916, -112.0011], ["Provo", 40.2338, -111.6585], ["Ogden", 41.2230, -111.9738]],
  vermont: [["Burlington", 44.4759, -73.2121], ["South Burlington", 44.4668, -73.1708]],
  virginia: [["Virginia Beach", 36.8529, -75.9780], ["Norfolk", 36.8508, -76.2859], ["Chesapeake", 36.7682, -76.2875], ["Richmond", 37.5407, -77.4360], ["Arlington", 38.8799, -77.1068]],
  washington: [["Seattle", 47.6062, -122.3321], ["Spokane", 47.6588, -117.4260], ["Tacoma", 47.2529, -122.4443], ["Bellevue", 47.6101, -122.2015]],
  "west virginia": [["Charleston", 38.3498, -81.6326], ["Huntington", 38.4192, -82.4454], ["Morgantown", 39.6295, -79.9559]],
  wisconsin: [["Milwaukee", 43.0389, -87.9065], ["Madison", 43.0731, -89.4012], ["Green Bay", 44.5133, -88.0133], ["Kenosha", 42.5847, -87.8215]],
  wyoming: [["Cheyenne", 41.1400, -104.8202], ["Casper", 42.8666, -106.3131], ["Laramie", 41.3128, -105.5885]],
  "district of columbia": [["Washington", 38.9072, -77.0369]]
};

/*
  Half-width of the box drawn around each city centre, in degrees. 0.22 covers a
  full metro area: shop=car_repair returns 89 elements for Guadalajara at this
  size while staying small enough for Overpass to answer in 1-3s.
*/
const CITY_QUERY_RADIUS_DEG = 0.22;

export function countryHint(location = "") {
  const l = foldText(clean(location)).toLowerCase();

  const states = [
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
    "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
    "maine", "maryland", "massachusetts", "michigan", "minnesota",
    "mississippi", "missouri", "montana", "nebraska", "nevada",
    "new hampshire", "new jersey", "new mexico", "new york",
    "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
    "pennsylvania", "rhode island", "south carolina", "south dakota",
    "tennessee", "texas", "utah", "vermont", "virginia", "washington",
    "west virginia", "wisconsin", "wyoming"
  ];

  // States are checked first on purpose: "new mexico" must resolve to the US,
  // not to Mexico, otherwise a US job gets queried against Mexican data.
  if (states.some(state => l.includes(state))) return "us";

  const countries = [
    ["united kingdom", "gb"], ["great britain", "gb"], ["england", "gb"],
    ["scotland", "gb"], ["wales", "gb"], [" uk", "gb"], ["australia", "au"],
    ["canada", "ca"], ["india", "in"], ["germany", "de"], ["france", "fr"],
    ["spain", "es"], ["italy", "it"], ["uae", "ae"], ["dubai", "ae"],
    ["mexico", "mx"], ["méxico", "mx"], ["brazil", "br"], ["brasil", "br"],
    ["netherlands", "nl"], ["holland", "nl"], ["poland", "pl"], ["portugal", "pt"],
    ["ireland", "ie"], ["sweden", "se"], ["norway", "no"], ["denmark", "dk"],
    ["finland", "fi"], ["switzerland", "ch"], ["austria", "at"],
    ["new zealand", "nz"], ["south africa", "za"], ["nigeria", "ng"],
    ["kenya", "ke"], ["egypt", "eg"], ["turkey", "tr"], ["turkiye", "tr"],
    ["singapore", "sg"], ["malaysia", "my"], ["indonesia", "id"],
    ["philippines", "ph"], ["vietnam", "vi"], ["thailand", "th"],
    ["saudi arabia", "sa"], ["saudi", "sa"], ["qatar", "qa"], ["kuwait", "kw"],
    ["jordan", "jo"], ["israel", "il"], ["lebanon", "lb"], ["morocco", "ma"],
    ["colombia", "co"], ["argentina", "ar"], ["chile", "cl"], ["peru", "pe"],
    ["costa rica", "cr"], ["panama", "pa"], ["guatemala", "gt"],
    ["jamaica", "jm"], ["trinidad", "tt"], ["romania", "ro"],
    ["czech", "cz"], ["hungary", "hu"], ["greece", "gr"], ["ukraine", "ua"],
    /*
      South Asia and the Middle East first among the additions: the paying
      customers are here, and without these entries countryHint() returned "" -
      so their jobs sent no cc= to Bing and no country to Tavily and were served
      from this host's French vantage point. "oman" is deliberately last: the
      check is a substring match, so it would otherwise fire on "romania".
    */
    ["pakistan", "pk"], ["bangladesh", "bd"], ["sri lanka", "lk"],
    ["nepal", "np"], ["afghanistan", "af"], ["iraq", "iq"], ["iran", "ir"],
    ["bahrain", "bh"], ["algeria", "dz"], ["tunisia", "tn"], ["ghana", "gh"],
    ["tanzania", "tz"], ["uganda", "ug"], ["ethiopia", "et"], ["oman", "om"],
    ["dominican republic", "do"], ["el salvador", "sv"], ["ecuador", "ec"],
    ["kazakhstan", "kz"], ["uzbekistan", "uz"], ["laos", "la"],
    ["myanmar", "mm"], ["cambodia", "kh"], ["bulgaria", "bg"], ["serbia", "rs"],
    ["slovakia", "sk"], ["slovenia", "si"], ["croatia", "hr"],
    ["senegal", "sn"], ["ivory coast", "ci"], ["cameroon", "cm"],
    ["rwanda", "rw"]
  ];

  for (const [needle, code] of countries) {
    if (l === needle.trim() || l.includes(needle)) return code;
  }

  return "";
}

/*
  Tavily's `country` filter takes a lowercase country NAME ("united kingdom"),
  never an ISO code, and rejects an unknown value with HTTP 400 - which costs
  the whole paid fallback. Only codes countryHint() itself can return are mapped
  here, so anything unmapped simply means "no country boost" rather than a
  request built to fail.
*/
const COUNTRY_CODE_NAMES = {
  us: "united states", gb: "united kingdom", ca: "canada", au: "australia",
  in: "india", de: "germany", fr: "france", es: "spain", it: "italy",
  ae: "united arab emirates", mx: "mexico", br: "brazil", nl: "netherlands",
  pl: "poland", pt: "portugal", ie: "ireland", se: "sweden", no: "norway",
  dk: "denmark", fi: "finland", ch: "switzerland", at: "austria",
  nz: "new zealand", za: "south africa", ng: "nigeria", ke: "kenya",
  eg: "egypt", tr: "turkey", sg: "singapore", my: "malaysia", id: "indonesia",
  ph: "philippines", vn: "vietnam", th: "thailand", sa: "saudi arabia",
  qa: "qatar", kw: "kuwait", jo: "jordan", il: "israel", lb: "lebanon",
  ma: "morocco", co: "colombia", ar: "argentina", cl: "chile", pe: "peru",
  cr: "costa rica", pa: "panama", gt: "guatemala", jm: "jamaica",
  tt: "trinidad and tobago", ro: "romania", cz: "czech republic",
  hu: "hungary", gr: "greece", ua: "ukraine",
  pk: "pakistan", bd: "bangladesh", lk: "sri lanka", np: "nepal",
  af: "afghanistan", iq: "iraq", ir: "iran", bh: "bahrain", dz: "algeria",
  tn: "tunisia", gh: "ghana", tz: "tanzania", ug: "uganda", et: "ethiopia",
  om: "oman", do: "dominican republic", sv: "el salvador", ec: "ecuador",
  kz: "kazakhstan", uz: "uzbekistan", la: "laos", mm: "myanmar",
  kh: "cambodia", bg: "bulgaria", rs: "serbia", sk: "slovakia",
  si: "slovenia", hr: "croatia", sn: "senegal", ci: "ivory coast",
  cm: "cameroon", rw: "rwanda"
};

export function countryNameFor(isoCode = "") {
  return COUNTRY_CODE_NAMES[String(isoCode || "").trim().toLowerCase()] || "";
}

/*
  Reverse index of the country names above plus the handful of short aliases
  users actually type ("USA", "UK", "UAE"). Used to tell a bare country name
  ("Pakistan") apart from a place inside one ("Lahore, Pakistan").

  Only names backed by a COUNTRY_CITY_CENTERS entry count, so a country we hold
  no city list for keeps the old geocoder-driven behaviour instead of forcing a
  country path that would find nothing to query.
*/
const COUNTRY_NAME_LOOKUP = (() => {
  const map = Object.create(null);
  for (const [code, name] of Object.entries(COUNTRY_CODE_NAMES)) map[name] = code;
  const extra = {
    usa: "us", america: "us", "united states of america": "us",
    uk: "gb", "great britain": "gb", britain: "gb", england: "gb",
    scotland: "gb", wales: "gb", uae: "ae", emirates: "ae",
    saudi: "sa", turkiye: "tr"
  };
  for (const [name, code] of Object.entries(extra)) map[name] = code;
  return map;
})();

export function bareCountryCode(location = "") {
  const l = foldText(clean(location)).toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  const code = COUNTRY_NAME_LOOKUP[l];
  return code && COUNTRY_CITY_CENTERS[code] ? code : "";
}

/*
  Name of the US state a location string names, or "".

  Only used as a hint. The authoritative signal is the addresstype Nominatim
  reports for the hit it picked, because "new york" is both a state and a city
  and Nominatim answers with the city first. This function supplies the map key
  once that hit has confirmed the request really was a state.
*/
function usStateHint(location = "") {
  const l = clean(location).toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();

  if (!l) return "";

  // Longest name first so "west virginia" wins over "virginia".
  const names = Object.keys(US_STATE_CITY_CENTERS).sort((a, b) => b.length - a.length);

  for (const name of names) {
    if (l === name) return name;
    if (new RegExp(`\\b${name}\\b`).test(l)) return name;
  }

  return "";
}

async function geocodeLocation(location) {
  const url = new URL(NOMINATIM_URL);

  url.searchParams.set("q", clean(location));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "0");

  const country = countryHint(location);
  if (country) url.searchParams.set("countrycodes", country);

  const res = await fetch(url, {
    headers: {
      "User-Agent": OSM_USER_AGENT
    },
    // Nominatim occasionally accepts and never answers; without a timeout the
    // job hangs in the search phase with nothing to show for it.
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    throw new Error(`Nominatim geocoding failed (${res.status} ${res.statusText})`);
  }

  const json = await res.json().catch(() => []);

  const hits = Array.isArray(json) ? json : [];

  let hit = hits.find(item => item && item.type !== "country") || hits[0] || null;

  if (!hit || !hit.lat || !hit.lon) {
    throw new Error(`Could not locate "${location}" on OpenStreetMap`);
  }

  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  const box = Array.isArray(hit.boundingbox)
    ? hit.boundingbox.map(Number)
    : null;

  // Nominatim reports bounding boxes as [south, north, west, east].
  const diag = box && box.length === 4
    ? Math.max(Math.abs(box[1] - box[0]), Math.abs(box[3] - box[2]))
    : Infinity;

  /*
    A query that resolves to a whole country needs city-level querying, not a
    box around the national centroid. Detect it from the hit type and from the
    size of the box, because Nominatim does not always label the country hit.

    A state is NOT a country. Texas spans 13 degrees, so the size test alone
    used to route "texas" to the US city list and return New York cafes. The
    addresstype check keeps states on their own city list instead.
  */
  const isState = hit.addresstype === "state" || hit.addresstype === "province";
  const isCountry = !isState && (hit.type === "country" || diag > 8);

  return { lat, lon, box, diag, isCountry, isState, state: usStateHint(hit.display_name || location) };
}

/*
  Builds one small bounding box per major city in a country.

  This replaces the old behaviour of tiling a 7x7 degree window around the
  country centroid, which for Mexico covered desert and returned nothing while
  costing 24 Overpass round trips.
*/
function cityChunksForCountry(isoCode, maxCities) {
  const cities = COUNTRY_CITY_CENTERS[String(isoCode || "").toLowerCase()];
  if (!Array.isArray(cities) || cities.length === 0) return [];

  return cities.slice(0, maxCities).map(([name, lat, lon]) => ({
    south: lat - CITY_QUERY_RADIUS_DEG,
    north: lat + CITY_QUERY_RADIUS_DEG,
    west: lon - CITY_QUERY_RADIUS_DEG,
    east: lon + CITY_QUERY_RADIUS_DEG,
    label: name
  }));
}

/*
  Same idea for a US state: one small box per metro inside that state.
*/
function cityChunksForState(stateKey, maxCities) {
  const cities = US_STATE_CITY_CENTERS[String(stateKey || "").toLowerCase()];
  if (!Array.isArray(cities) || cities.length === 0) return [];

  return cities.slice(0, maxCities).map(([name, lat, lon]) => ({
    south: lat - CITY_QUERY_RADIUS_DEG,
    north: lat + CITY_QUERY_RADIUS_DEG,
    west: lon - CITY_QUERY_RADIUS_DEG,
    east: lon + CITY_QUERY_RADIUS_DEG,
    label: name
  }));
}

/*
  The cities a location Nominatim could not place resolves to.

  A misspelled or unmapped locality ("Houstan Texas") names no place, but it may
  still name a US state or a country we hold a city list for. Returns that list
  (densest city first), or [] when the string names neither. The area gate uses
  the same list so its distance check agrees with the OSM fallback in
  searchOsmPlaces: OSM queries these cities, and the gate accepts leads near any
  of them, so a lead one side produces is never rejected by the other.
*/
export function stateFallbackCities(location = "", maxCities = 12) {
  const l = clean(location);
  if (!l) return [];

  const state = usStateHint(l);
  const cities = state && US_STATE_CITY_CENTERS[state];
  if (Array.isArray(cities) && cities.length) {
    return cities
      .slice(0, maxCities)
      .map(([name, lat, lon]) => ({ lat, lon, label: name, kind: "state", state }));
  }

  const country = countryHint(l);
  const countryCities = country && COUNTRY_CITY_CENTERS[country];
  if (Array.isArray(countryCities) && countryCities.length) {
    return countryCities.slice(0, maxCities).map(([name, lat, lon]) => ({ lat, lon, label: name, kind: "country", country }));
  }

  return [];
}

export function stateFallbackCenter(location = "") {
  const [first] = stateFallbackCities(location, 1);
  return first || null;
}

function bboxForQuery({ lat, lon, box }) {
  const useBox = box && box.length === 4;
  const diag = useBox
    ? Math.max(Math.abs(box[1] - box[0]), Math.abs(box[3] - box[2]))
    : Infinity;

  if (useBox && diag > 0.02 && diag < 12) {
    const [s, n, w, e] = box;
    return { south: s, north: n, west: w, east: e };
  }

  const radiusDeg = useBox && diag < 12 ? diag * 1.5 : 1.0;
  return {
    south: lat - radiusDeg,
    north: lat + radiusDeg,
    west: lon - radiusDeg,
    east: lon + radiusDeg
  };
}

function bboxChunks({ lat, lon, box }) {
  const useBox = box && box.length === 4;
  const diag = useBox
    ? Math.max(Math.abs(box[1] - box[0]), Math.abs(box[3] - box[2]))
    : Infinity;

  if (!useBox || diag < 2.5) return [bboxForQuery({ lat, lon, box })];

  const CELL = 1.2;
  const windowDeg = Math.min(diag * 0.6, 7);
  const cellsPerAxis = Math.max(1, Math.ceil(windowDeg / CELL));

  const chunks = [];
  for (let j = 0; j < cellsPerAxis; j++) {
    for (let i = 0; i < cellsPerAxis; i++) {
      chunks.push({
        south: lat - windowDeg / 2 + i * CELL,
        north: lat - windowDeg / 2 + (i + 1) * CELL,
        west: lon - windowDeg / 2 + j * CELL,
        east: lon - windowDeg / 2 + (j + 1) * CELL,
        i,
        j
      });
    }
  }

  const cy = cellsPerAxis / 2 - 0.5;
  const cx = cellsPerAxis / 2 - 0.5;

  return chunks
    .sort((a, b) => {
      const da = (a.i - cy) * (a.i - cy) + (a.j - cx) * (a.j - cx);
      const db = (b.i - cy) * (b.i - cy) + (b.j - cx) * (b.j - cx);
      return da - db;
    })
    .slice(0, 24);
}

/*
  Metro tiling for the "the target was not met" top-up passes.

  A city was previously answered with ONE bbox. That is fragile: Overpass
  answers a dense city query slowly, and if the first mirror times out the job
  silently keeps a partial element list and reports fewer businesses than the
  city actually has. For a strict service filter that partial list is the whole
  reason the job cannot reach the requested target.

  Splitting the same area into small concentric rings keeps every individual
  query cheap (so mirrors answer instead of timing out) while still covering
  the whole metro, and the rings are ordered centre-outwards so the densest
  part of the city is always collected first.
*/
const METRO_TIER_RADIUS_DEG = [0, 0.3, 0.6, 1.0];

function metroChunks({ lat, lon, box }, tier) {
  const base = bboxForQuery({ lat, lon, box });
  const reach = METRO_TIER_RADIUS_DEG[Math.min(tier, METRO_TIER_RADIUS_DEG.length - 1)];

  if (!reach) return [base];

  // Ring cells are small enough that a busy cell still answers quickly.
  const CELL = 0.3;
  const cells = [];

  for (let i = -Math.ceil(reach / CELL); i <= Math.ceil(reach / CELL); i++) {
    for (let j = -Math.ceil(reach / CELL); j <= Math.ceil(reach / CELL); j++) {
      const south = lat + i * CELL - CELL / 2;
      const west = lon + j * CELL - CELL / 2;

      const cell = {
        south,
        north: south + CELL,
        west,
        east: west + CELL,
        i: i + 0.5,
        j: j + 0.5
      };

      // Skip cells that fall entirely outside the already-known city box on the
      // tightest ring, so tier 1 stays a genuine metro top-up rather than
      // re-querying the same centre cells forever.
      if (tier === 1) {
        const insideBase =
          cell.north > base.south &&
          cell.south < base.north &&
          cell.east > base.west &&
          cell.west < base.east;

        if (insideBase) continue;
      }

      cells.push(cell);
    }
  }

  const cy = 0;
  const cx = 0;

  return cells
    .sort((a, b) => {
      const da = (a.i - cy) * (a.i - cy) + (a.j - cx) * (a.j - cx);
      const db = (b.i - cy) * (b.i - cy) + (b.j - cx) * (b.j - cx);
      return da - db;
    })
    .slice(0, 36);
}

function buildOverpassQuery(niche, bbox) {
  const filters = overpassFilters(niche);

  const lines = filters
    .flatMap(lines => lines.split("\n").map(line => line.trim()).filter(Boolean))
    .map(filter => `  ${filter}(${bbox.south},${bbox.west},${bbox.north},${bbox.east});`)
    .join("\n");

  /*
    400, not 80: a dense city returns far more tagged elements than the target
    and the contact filter then throws most of them away. Mexico City answers
    200+ car_repair elements, so an 80 cap silently truncated the best market in
    the country before filtering ever ran.
  */
  return `[out:json][timeout:30];\n(\n${lines}\n);\nout center tags 400;`;
}

function elementContact(tags = {}) {
  const phone = normalizePhone(
    tags.phone ||
      tags["contact:phone"] ||
      tags["contact:mobile"] ||
      tags["contact:telephone"] ||
      tags.tel ||
      ""
  );

  const website = normalizeWebsite(
    tags.website ||
      tags["contact:website"] ||
      tags["contact:url"] ||
      tags.url ||
      ""
  );

  return { phone, website };
}

function findCenter(element) {
  if (element.center && element.center.lat && element.center.lon) {
    return { lat: element.center.lat, lon: element.center.lon };
  }

  return { lat: element.lat || null, lon: element.lon || null };
}

const JUNK_PLACES = [
  "park",
  "playground",
  "picnic_site",
  "dog_park",
  "forest",
  "wood",
  "nature_reserve",
  "garden",
  "viewpoint",
  "hiking",
  "trail",
  "trailhead",
  "beach",
  "water",
  "lake",
  "fountain",
  "bench",
  "toilets",
  "drinking_water",
  "waste_basket",
  "recycling",
  "fire_hydrant",
  "biergarten",
  "shelter",
  "slipway",
  "pier",
  "marina",
  "swimming_pool",
  "fitness_station",
  "pitch",
  "stadium",
  "track",
  "recreation_ground",
  "public_bath",
  "place_of_worship",
  "church",
  "chapel",
  "mosque",
  "synagogue",
  "temple",
  "cemetery",
  "grave_yard",
  "historic",
  "memorial",
  "archaeological_site"
].reduce((acc, tag) => {
  acc.add(tag);
  return acc;
}, new Set());

function isJunkPlace(tags = {}) {
  const priority = clean(tags.primaryType || tags.craft || tags.shop || tags.amenity || tags.office || tags.leisure || tags.tourism || tags.landuse || tags.natural || "");
  if (JUNK_PLACES.has(priority)) return true;

  const any = [tags.shop, tags.amenity, tags.leisure, tags.tourism, tags.landuse, tags.natural]
    .filter(Boolean)
    .some(value => JUNK_PLACES.has(String(value).toLowerCase()));

  return any;
}

const FOOD_NICHE_WORDS = ["restaurant", "cafe", "coffee", "bakery", "bar", "food", "dining", "pizza", "burger", "sushi", "taco", "bbq", "grill", "steak", "mexican", "chinese", "italian", "indian", "thai", "breakfast", "lunch", "dinner"];

const FOOD_NICHE_STEMS = new Set(FOOD_NICHE_WORDS.map(singularizeWord));

/*
  "restaurants" used to miss this list because it only held singular forms, so
  every food venue was treated as a conflict and thrown away - a Lahore
  restaurant job collected 400 elements and kept none of them. Compare on the
  singular stem, and forgive a misspelling ("resturants") rather than losing the
  whole market to a typo.
*/
function isFoodNicheWord(word = "") {
  const w = String(word).toLowerCase();
  if (!w) return false;
  if (FOOD_NICHE_WORDS.includes(w)) return true;

  const stem = singularizeWord(w);
  if (FOOD_NICHE_STEMS.has(stem)) return true;

  return [...FOOD_NICHE_STEMS].some(food => wordClose(stem, food));
}

export function isFoodConflict(tags = {}, words = []) {
  const amenity = String(tags.amenity || "").toLowerCase();
  const cuisine = String(tags.cuisine || "").toLowerCase();
  const shop = String(tags.shop || "").toLowerCase();

  const isFoodPlace =
    amenity.includes("restaurant") ||
    amenity.includes("fast_food") ||
    amenity.includes("cafe") ||
    amenity.includes("bar") ||
    amenity.includes("pub") ||
    amenity.includes("ice_cream") ||
    shop.includes("baker") ||
    shop.includes("deli") ||
    shop.includes("butcher") ||
    shop.includes("convenience") ||
    shop.includes("supermarket") ||
    Boolean(cuisine);

  if (!isFoodPlace) return false;

  return !words.some(isFoodNicheWord);
}

function nicheMatches(tags, name, niche, words) {
  if (words.length === 0) return true;

  const tagValues = [
    tags.name,
    tags.description,
    tags.shop,
    tags.amenity,
    tags.office,
    tags.craft,
    tags.leisure,
    name
  ]
    .join(" ")
    .toLowerCase();

  const nameLower = String(name || "").toLowerCase();
  const checkWord = word => {
    if (name.includes(word)) return true;

    const syns = keywordSynonyms()[word] || [];
    if (syns.some(s => nameLower.includes(s))) return true;

    if (keywordMatches(word, tagValues)) return true;

    /*
      Last resort for a misspelled niche: compare the word against the same
      tag text with the bounded edit distance. Without this a job whose niche
      read "resturants" matched amenity=restaurant in no element, even after
      the tag query had already been corrected.
    */
    const tokens = tagValues.split(/[^a-z0-9]+/).filter(Boolean);
    return tokens.some(token => wordClose(word, token));
  };

  return words
    .filter(w => !NICHE_STOPWORDS.has(w) && w.length >= 3)
    .some(checkWord);
}

function keywordMatches(word, haystack) {
  const w = word.toLowerCase();
  const stems = [w];

  if (w.endsWith("ing")) stems.push(w.slice(0, -3));
  if (w.endsWith("ers")) stems.push(w.slice(0, -3));
  if (w.endsWith("er")) stems.push(w.slice(0, -2));
  if (w.endsWith("es")) stems.push(w.slice(0, -2));
  if (w.endsWith("s")) stems.push(w.slice(0, -1));

  const careStem = REQUIRED_SYNONYMS[w];
  if (careStem) stems.push(...careStem);

  const variants = new Set();

  for (const s of stems) {
    if (!s || s.length < 3) continue;
    variants.add(s);
    if (!s.endsWith("s")) variants.add(s + "s");
    if (!s.endsWith("ing")) variants.add(s + "ing");
  }

  const tokens = haystack.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  return [...variants].some(v => {
    if (v.length <= 3) return tokens.includes(v);
    return tokens.some(t => t.startsWith(v));
  });
}

const REQUIRED_SYNONYMS = {
  car: ["auto"],
  auto: ["car"]
};

function priorityScore(contact) {
  let score = 0;

  if (contact.phone) score += 2;
  if (contact.website) score += 1;

  return score;
}

function nameRelevanceSortKey(result) {
  return Number(result && result.nameRelevance) || 0;
}

/*
  Keep only places that can actually become a lead. OSM rarely carries an
  email, and an entry with neither a website nor a phone cannot be scraped
  and fails the no-contact policy, so letting those through just spent the
  candidate budget: the coffee/texas run skipped 16 leads for no contact
  because of them.
*/
export function contactableOsmPlaces(results = []) {
  const list = Array.isArray(results) ? results : [];
  return list.filter(item => item?.website || item?.phone);
}

/*
  Many OSM entries carry a street and postcode but no `addr:city`/`addr:state`.
  Phone-only leads then reach the user with no locality at all, which also
  blocks the locality check during verification. One reverse lookup per lead
  fills it in. Nominatim asks for at most one request per second, so this is
  capped and paced rather than fired in parallel.
*/
const REVERSE_LOOKUP_CAP = 12;
const REVERSE_LOOKUP_DELAY_MS = 1100;

function localityFromTags(tags = {}) {
  const city =
    tags["addr:city"] ||
    tags["addr:town"] ||
    tags["addr:village"] ||
    tags["addr:hamlet"] ||
    "";
  const state = tags["addr:state"] || "";
  const country = tags["addr:country"] || "";

  return {
    city: clean(city),
    state: clean(state),
    country: clean(country)
  };
}

export function needsReverseLookup(result) {
  if (!result) return false;
  if (result.city && result.state && result.country) return false;
  const { lat, lon } = result.location || {};
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
}

async function reverseLocality({ lat, lon }) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");

  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("zoom", "10");

  const res = await fetch(url, {
    headers: {
      "User-Agent": OSM_USER_AGENT
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    throw new Error(`Nominatim reverse lookup failed (${res.status} ${res.statusText})`);
  }

  const json = await res.json().catch(() => null);
  const address = (json && json.address) || {};

  return {
    city: clean(address.city || address.town || address.village || address.county || ""),
    state: clean(address.state || ""),
    country: clean(address.country || "")
  };
}

async function fillMissingLocality(results = [], debug = []) {
  const pending = results.filter(needsReverseLookup).slice(0, REVERSE_LOOKUP_CAP);

  if (pending.length === 0) return results;

  let filled = 0;

  for (const result of pending) {
    try {
      const { city, state, country } = await reverseLocality(result.location);
      if (city) result.city = city;
      if (state) result.state = state;
      if (country) result.country = country;
      if (city) filled += 1;
    } catch (err) {
      debug.push(`OSM reverse lookup failed: ${err.message}`);
      break;
    }

    await new Promise(resolve => setTimeout(resolve, REVERSE_LOOKUP_DELAY_MS));
  }

  debug.push(
    `OSM filled locality for ${filled}/${pending.length} place(s) via reverse lookup`
  );
}

export async function searchOsmPlaces({ niche, location, targetCount = 10, tier = 0 }) {
  const debug = [];

  if (!clean(location)) {
    return { results: [], debug: ["OSM: location is empty"] };
  }

  let geo;

  try {
    geo = await geocodeLocation(location);
    debug.push(`OSM geocoded "${location}" to ${geo.lat.toFixed(4)}, ${geo.lon.toFixed(4)}`);
  } catch (err) {
    debug.push(`OSM geocoding failed: ${err.message}`);

    /*
      A misspelled or unmapped locality ("Houstan Texas") must not kill the OSM
      source. Nominatim resolves exact names only, so the string is not a place -
      but it may still name a US state or a country we hold a city list for, and
      that list contains the intended metro (Houston, among the Texas cities).
      Falling back to it turns a silent zero into a real search instead of
      reporting "no such businesses" for a market that clearly has them.
    */
    const state = usStateHint(location);
    const country = countryHint(location);

    if (state && US_STATE_CITY_CENTERS[state]) {
      geo = { lat: null, lon: null, box: null, diag: Infinity, isState: true, isCountry: false, state };
      debug.push(`OSM location "${location}" was not recognised; falling back to US state "${state}" city list`);
    } else if (country && COUNTRY_CITY_CENTERS[country]) {
      geo = { lat: null, lon: null, box: null, diag: Infinity, isState: false, isCountry: true, state: "" };
      debug.push(`OSM location "${location}" was not recognised; falling back to country "${country}" city list`);
    } else {
      debug.push(`OSM location "${location}" is not a recognised place and names no known state or country`);
      return { results: [], debug, locationUnrecognised: true };
    }
  }

  /*
    A bare country name must search its cities even when Nominatim answered with
    a sub-region whose bounding box is too small for the size test in
    geocodeLocation. Without this "Pakistan" tiled one district's grid and
    reported an empty market that clearly is not empty.
  */
  const bareCountry = bareCountryCode(location);
  if (bareCountry) {
    geo.isCountry = true;
    geo.isState = false;
    debug.push(`OSM "${location}" is a country name; querying its major cities`);
  }

  const keywords = nicheWordList(niche);
  const tagFilters = overpassFilters(niche);

  /*
    Top-up passes get a longer budget. The tight pass is deliberately quick so a
    normal job stays fast, but a job that still cannot reach its target is
    spending the extra seconds precisely because the first answer was partial.
    The tier is known up here; the actual deadlines are derived further down,
    once it is settled whether this job answers from city chunks or one box.
  */
  const tierBudget = Math.min(Math.max(Number(tier) || 0, 0), METRO_TIER_RADIUS_DEG.length - 1);
  const budgetScale = 1 + tierBudget * 0.6;

  let chunks = geo.lat != null ? [bboxForQuery(geo)] : [];
  let chunked = false;
  let usingCityChunks = false;

  /*
    A state job searches its own metros. Falling through to the country list
    here is what made "coffee shop / texas" return New York cafes that the
    area gate then discarded, so a real search reported zero Texas leads.
  */
  if (geo.isState && geo.state) {
    const stateChunks = cityChunksForState(geo.state, 12);

    if (stateChunks.length > 0) {
      chunks = stateChunks;
      chunked = true;
      usingCityChunks = true;
      debug.push(
        `OSM "${location}" resolved to US state "${geo.state}"; querying ${stateChunks.length} ${geo.state} cities instead of the state-wide box`
      );
    }
  }

  /*
    Country-level queries are answered city by city.

    The previous approach tiled a 7x7 degree window around the country centroid.
    For "mexico" that window is centred on 23.66,-102.01, which is rural
    Zacatecas: 24 Overpass round trips, mostly timeouts, and 3 elements collected
    in total. Asking for the same tags around real cities returns 89 elements
    for Guadalajara and 200+ for Mexico City from a single cheap query.
  */
  if (geo.isCountry) {
    const iso = countryHint(location);
    const cityChunks = cityChunksForCountry(iso, 12);

    if (cityChunks.length > 0) {
      chunks = cityChunks;
      chunked = true;
      usingCityChunks = true;
      debug.push(`OSM "${location}" resolved to a country; querying ${cityChunks.length} major cities instead of the centroid`);
    } else if (geo.box) {
      /*
        A country we hold no city list for. Falling through tiled the national
        centroid into ~24 chunks that every mirror timed out on - a "Türkiye"
        job spent its whole OSM budget that way. This is a coverage gap, not an
        empty market, and it needs a city name to be answerable.
      */
      debug.push(`OSM "${location}" is country-sized but no city list exists for it; ask for a city instead of a whole country`);
      return { results: [], debug, locationUnrecognised: true };
    }
  }

  /*
    Nothing to query means the fallback above matched a state/country but that
    table held no cities for it. Report it as unrecognised rather than falling
    through to a bbox built from null coordinates.
  */
  if (chunks.length === 0) {
    debug.push(`OSM found no queryable area for "${location}"`);
    return { results: [], debug, locationUnrecognised: true };
  }

  /*
    City queries are slow but reliable; the grid queries they replaced were
    fast and useless. Spend the extra time only when it buys real coverage.

    Re-measured against the live host: the two mirrors that actually carry data
    answer a Glasgow "amenity=dentist" box in 30.9s (lz4.overpass-api.de) and
    37.6s (z.overpass-api.de), while overpass-api.de returns HTTP 502 in 0.25s
    and private.coffee / kumi.systems never answer at all. The old 35s per-attempt
    cap cut z off 2.6s before it would have replied, and the old 45s chunk budget
    ran out after the first working attempt - so a UK job reported OSM 0 even
    though the data was one request away. A Glasgow dental run found 6 of 20
    leads for exactly that reason.

    The budgets now cover the full measured range plus one fast-failing mirror,
    so two working instances can be asked inside a single chunk.
  */
  const deadlineMs = Math.round((usingCityChunks ? 150000 : 120000) * budgetScale);
  // Give a single city a fair chance, then move on rather than stalling the job.
  const chunkBudgetMs = Math.round(95000 * budgetScale);

  // Always split a large area, even when a specific tag filter exists.
  // One giant bbox (e.g. all of Texas) reliably times out on every Overpass
  // mirror and returns zero results, so small per-cell queries are required.
  if (!chunked) {
    /*
      Metro top-up for a plain city. Tier 0 keeps the historic single city box.
      Tier 1+ re-asks the same niche as a grid of small cells covering the
      surrounding metro, so a target that the tight box could not satisfy (often
      because one big query timed out and returned a partial set) gets a second,
      more reliable chance. Ordering stays centre-outwards so the densest cells
      are collected first, and the wide filter still marks out-of-area leads, so
      this widens coverage without widening what counts as "in the area".
    */
    if (!usingCityChunks && tierBudget > 0) {
      const ringChunks = metroChunks(geo, tierBudget);

      if (ringChunks.length > 1) {
        chunks = ringChunks;
        chunked = true;
        debug.push(
          `OSM top-up tier ${tierBudget}: re-queried "${location}" as ${ringChunks.length} metro cells (deadline ${Math.round(deadlineMs / 1000)}s) to reach the target`
        );
      }
    }

    if (!chunked) {
      const split = bboxChunks(geo);
      if (split.length > 1) {
        chunks = split;
        chunked = true;
      }
    }
  }

  const query0 = buildOverpassQuery(niche, chunks[0]);

  debug.push(`OSM tag filters: ${tagFilters.map(f => f.split("\n")[0].match(/\["([^"]+)"(?:="([^"]+)")?\]/)?.[2] || f.split("\n")[0].match(/\["([^"]+)"\]/)?.[1] || "generic").filter((v, i, a) => a.indexOf(v) === i).join(", ")}`);
  debug.push(`OSM query ${chunked ? `split into ${chunks.length} chunk(s)` : "single bbox"}; ${query0.replace(/\n/g, " ").slice(0, 150)}...`);

  let elements = [];
  const startTs = Date.now();
  /*
    Collect well past the target. Most raw elements are later dropped for having
    no name, no website or a junk tag, so stopping on the raw count starved the
    result. In Mexico only roughly one in ten tagged car_repair elements carries
    a phone or website, so the budget is set to sample several cities rather
    than exhausting one dense metro area. The deadline is the real limiter.
  */
  const chunkCap = Math.max(Math.min((Number(targetCount) || 10) * 50, 1000), 300);

  let workingMirror = -1;

  for (const chunk of chunks) {
    if (elements.length >= chunkCap) break;
    if (Date.now() - startTs > deadlineMs) break;

    const query = buildOverpassQuery(niche, chunk);
    let gotChunk = [];
    const chunkStart = Date.now();

    const mirrorOrder = overpassMirrorOrder(workingMirror);

    /*
      Try every configured mirror, not the first four.

      Six mirrors are configured because public Overpass instances go down
      independently and for long stretches. Capping the round at four meant that
      whenever the first four were all unhealthy the chunk returned nothing at
      all: a Lisbon run reported placesOsm 0 and saved no leads purely because
      two working mirrors were never asked. The per-chunk deadline still stops
      this from stalling the job.
    */
    for (const attempt of mirrorOrder) {
      // The deadline is enforced here too, not just between chunks: a single
      // chunk can otherwise spend 4 mirrors x 2 retries x 30s and blow the
      // entire job budget on one cell.
      if (Date.now() - startTs > deadlineMs) break;

      /*
        Per-chunk budget, independent of the overall deadline.

        Overpass mirrors go down for stretches, and when Mexico City times out on
        all four mirrors the old loop kept retrying until the whole job budget
        was gone and returned nothing at all. Observed: a dentist query burned
        80s on the first city and never reached Guadalajara or Monterrey, which
        together hold plenty of shops. Abandoning a hopeless chunk quickly lets
        the remaining cities answer instead.
      */
      if (Date.now() - chunkStart > chunkBudgetMs) {
        debug.push(`OSM giving up on ${chunk.label || "chunk"} after ${((Date.now() - chunkStart) / 1000).toFixed(0)}s, moving to the next area`);
        break;
      }

      const endpoint = OVERPASS_URLS[attempt];

      /*
        Single leash, sized to the slowest working mirror.

        Overpass normally answers in 1-3s, but from this host every mirror that
        carries data outside Switzerland measures 21-34s (api.de 24.9s, z 31.3s,
        lz4 34.3s for the same query). The old 24s unproven cap cut each of them
        off a second or two before they finished, so none was ever proven healthy
        and every non-Swiss country returned zero places. The cap now covers the
        full measured range, and the chunk budget below is wide enough to hold one
        complete attempt. An unproven mirror still gets only one attempt: a second
        long try would let a hung mirror spend two full budgets and starve the
        remaining cities. The chunk budget is clamped into the timer so one slow
        mirror cannot overshoot its area either.
      */
      const provenMirror = workingMirror >= 0;
      // 42s covers the slowest mirror measured carrying real data (37.6s).
      const attemptCap = 42000;
      const maxRetries = provenMirror ? 2 : 1;

      for (let retry = 0; retry < maxRetries; retry++) {
        if (Date.now() - startTs > deadlineMs) break;
        if (Date.now() - chunkStart > chunkBudgetMs) break;

        const controller = new AbortController();
        const remaining = Math.max(2000, deadlineMs - (Date.now() - startTs));
        const chunkRemaining = Math.max(2000, chunkBudgetMs - (Date.now() - chunkStart));
        const timer = setTimeout(() => controller.abort(), Math.min(attemptCap, remaining, chunkRemaining));

        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": OSM_USER_AGENT
            },
            body: new URLSearchParams({ data: query }),
            signal: controller.signal
          });

          // 406 means a policy rejection (usually User-Agent), 429/5xx means load.
          if ([406, 429, 500, 502, 503, 504].includes(res.status)) {
            debug.push(`OSM Overpass ${new URL(endpoint).hostname} unavailable (${res.status}), retry ${retry + 1}`);
            noteOverpassFailure(endpoint);
            clearTimeout(timer);
            await new Promise(r => setTimeout(r, 500));
            continue;
          }

          if (!res.ok) {
            throw new Error(`${new URL(endpoint).hostname} returned ${res.status} ${res.statusText}`);
          }

          const json = await res.json().catch(() => null);

          const got = json && Array.isArray(json.elements) ? json.elements : [];

          clearTimeout(timer);

          if (got.length === 0) {
            // The mirror answered correctly - its data simply has nothing here -
            // so it is healthy even though it gave this chunk nothing.
            noteOverpassSuccess(endpoint);
            debug.push(`OSM Overpass ${new URL(endpoint).hostname} returned 0 elements for chunk, trying next mirror`);
            await new Promise(r => setTimeout(r, 400));
            break;
          }

          gotChunk = got;
          workingMirror = attempt;
          noteOverpassSuccess(endpoint);
          debug.push(`OSM Overpass mirror ${new URL(endpoint).hostname} responded with ${got.length} elements for ${chunk.label ? chunk.label : `chunk at ${chunk.south.toFixed(2)},${chunk.west.toFixed(2)}`}`);
          break;
        } catch (err) {
          clearTimeout(timer);
          debug.push(`OSM Overpass mirror ${new URL(endpoint).hostname} failed: ${err.message}`);
          // A hang is remembered longer than a fast refusal: it is the same
          // endpoint burning the chunk budget on every later attempt.
          noteOverpassFailure(endpoint, {
            hang: err.name === "AbortError" || /abort|timed? ?out/i.test(err.message)
          });
          await new Promise(r => setTimeout(r, 400));
          /*
            A hang is not a transient server error. Retrying the same mirror just
            spends the second retry on the same unhealthy endpoint, which is how a
            single timed-out first mirror previously consumed the entire chunk
            budget and stopped the loop before a working mirror was ever asked.
            Move straight to the next mirror instead; only a fast 429/5xx (handled
            above) is worth retrying in place.
          */
          if (err.name === "AbortError" || /abort|timed? ?out/i.test(err.message)) break;
        }

        if (gotChunk.length > 0) break;
      }

      if (gotChunk.length > 0) break;
    }

    if (gotChunk.length > 0) {
      elements.push(...gotChunk);
    }

    // Be a polite Overpass client: one query in flight at a time, briefly
    // paused between cities. Firing twelve city queries back to back is what
    // earns a 429 and a queue of failing mirrors.
    if (usingCityChunks && gotChunk.length > 0 && Date.now() - startTs < deadlineMs) {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  if (elements.length === 0) {
    /*
      "returned no elements" reads as "there are no such businesses here", but
      the same line is produced when every public Overpass mirror is simply
      unreachable. The worker surfaces this line to the user, so separate the
      outage case from a genuine empty result.
    */
    const mirrorReturned = debug.some(l => /responded with \d+ elements/.test(l));
    const netErrors = debug.filter(l => /unavailable|failed:|giving up|unreachable|aborted/i.test(l)).length;
    const zeroAnswers = debug.filter(l => /returned 0 elements for chunk/.test(l)).length;

    let summary;
    if (mirrorReturned) {
      summary = "OSM Overpass reachable but returned no elements";
    } else if (zeroAnswers > 0 && netErrors > 0) {
      summary = "OSM Overpass: some mirrors answered but found no matching places (other mirrors were unreachable)";
    } else if (zeroAnswers > 0) {
      summary = "OSM Overpass reachable but returned no matching places";
    } else if (netErrors > 0) {
      summary = "OSM Overpass: all public Overpass mirrors were unreachable (no mirror responded)";
    } else {
      summary = "OSM Overpass returned no elements";
    }

    debug.push(summary);
    return { results: [], debug };
  }

  const seenNames = new Set();
  const seenDomains = new Set();
  const results = [];
  let droppedNoContact = 0;
  const limit = Math.max(Number(targetCount) || 10, 10);
  const websiteCount = elements.filter(
    el => normalizeWebsite((el.tags || {}).website || (el.tags || {})["contact:website"] || (el.tags || {}).url || "")
  ).length;
  debug.push(`OSM collected ${elements.length} raw elements (${websiteCount} with a website) before filtering`);

  for (const element of elements) {
    if (results.length >= limit) break;

    const tags = element.tags || {};
    const name = clean(tags.name);

    if (!name) continue;

    const center = findCenter(element);
    const contact = elementContact(tags);

    if (!nicheMatches(tags, name, niche, keywords)) continue;

    if (isJunkPlace(tags)) continue;

    if (isFoodConflict(tags, keywords)) continue;

    /*
      Contactability is checked here, inside the collection loop, and not after
      it. Filtering afterwards was silently discarding almost everything: the
      loop stopped at `limit` candidates and only then dropped the ones with no
      phone or website. In Mexico roughly one in ten tagged car_repair elements
      carries contact details, so 10 raw candidates became about 1 usable lead
      even though hundreds of elements had been fetched. Skipping them inline
      lets the loop keep pulling elements until it has real, contactable leads.
    */
    if (!contact.website && !contact.phone) {
      droppedNoContact++;
      continue;
    }

    const website = contact.website;
    const domain = website
      ? String(new URL(website).hostname || "").replace(/^www\./, "")
      : "";

    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    if (domain && seenDomains.has(domain)) continue;

    seenNames.add(nameKey);
    if (domain) seenDomains.add(domain);

    const primaryType = clean(
      tags.primaryType || tags.craft || tags.shop || tags.amenity || tags.office || tags.leisure || ""
    );
    const types = uniq(
      [tags.shop, tags.amenity, tags.office, tags.craft, tags.leisure, tags.healthcare].filter(Boolean)
    );

    const nameLower = name.toLowerCase();
    const relevanceCheck = words => {
      const tagText = [tags.shop, tags.amenity, tags.office, tags.craft, tags.leisure, tags.description]
        .filter(Boolean).join(" ").toLowerCase();
      const viaName = words.filter(w =>
        nameLower.includes(w) ||
        (keywordSynonyms()[w] || []).some(s => nameLower.includes(s))
      ).length;
      const viaTags = words.filter(w => keywordMatches(w, tagText)).length;
      return Math.min(2, viaName) * 10 + Math.min(1, viaTags) * 4;
    };

    const nameRelevance = relevanceCheck(keywords);
    const locality = localityFromTags(tags);

    results.push({
      source: "osm",
      osmId: `${element.type || "node"}/${element.id || ""}`,
      placeId: `osm:${element.id || ""}`,
      businessName: name,
      title: name,
      hostname: domain || "OpenStreetMap",
      url: website,
      website,
      phone: contact.phone,
      address: buildAddress(tags),
      addresses: buildAddress(tags) ? [buildAddress(tags)] : [],
      city: locality.city,
      state: locality.state,
      country: locality.country,
      rating: null,
      reviewCount: 0,
      businessStatus: "",
      types,
      primaryType,
      hasWebsite: Boolean(website),
      hasPhone: Boolean(contact.phone),
      location: center,
      osmElement: element.id || "",
      hasWebsiteValue: Boolean(website),
      rawPlace: tags,
      nameRelevance,
      sourceLabel: "Business found on OpenStreetMap"
    });
  }

  results.sort((a, b) =>
    nameRelevanceSortKey(b) - nameRelevanceSortKey(a) ||
    priorityScore(b) - priorityScore(a) ||
    a.businessName.localeCompare(b.businessName, undefined, { sensitivity: "base" })
  );

  /*
    Kept only places that can actually become a lead. OSM rarely carries an
    email, and an entry with neither a website nor a phone cannot be scraped
    and fails the no-contact policy, so letting those through just spent the
    candidate budget. They are now skipped inline during collection, so this
    pass is only a safety net.
  */
  const contactable = contactableOsmPlaces(results);

  if (droppedNoContact > 0) {
    debug.push(`OSM skipped ${droppedNoContact} place(s) with no website and no phone`);
  }

  await fillMissingLocality(contactable, debug);

  debug.push(`OSM found ${contactable.length} businesses for "${niche} in ${location}"`);

  return {
    results: contactable.slice(0, Number(targetCount) || 10),
    debug
  };
}