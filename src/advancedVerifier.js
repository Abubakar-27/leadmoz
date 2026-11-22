import { parsePhoneNumberFromString } from "libphonenumber-js";
import { findEmailsWithHunterDomain, verifyEmailWithHunter } from "./apis/hunter.js";
import { locationAliases, cityNameVariants, COUNTRY_CITIES, STATE_CITIES } from "./geo.js";

/*
  Same-city spelling variants, normalized and flattened to comparable words.

  Only single-token variants become decisive words. A multi-word variant such as
  "lisboa city" is checked as a phrase instead, because splitting it would let the
  filler word "city" match anything.
*/
function spellingVariantsOf(location) {
    const out = [];

    for (const variant of cityNameVariants(location)) {
        const normalized = normalizeLocationText(variant);
        if (!normalized) continue;

        if (!/\s/.test(normalized) && normalized.length > 2) out.push(normalized);
    }

    return [...new Set(out)];
}
import { metroAreaVerdict } from "./areaGate.js";

import { assessNiche } from "./nicheCheck.js";

function clean(value = "") {
    return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function getDomain(url = "") {
    try {
        return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
        return "";
    }
}

function getEmailDomain(email = "") {
    return String(email).split("@")[1]?.toLowerCase() || "";
}

function normalizePhone(phone = "") {
    const raw = String(phone)
        .replace(/^tel:/i, "")
        .replace(/[^\d+().\-\s]/g, "")
        .trim();

    // This is only phone parsing fallback. It does NOT restrict search to USA.
    const parsed = parsePhoneNumberFromString(raw, "US");
    if (!parsed || !parsed.isValid()) return "";

    return parsed.formatNational();
}

function normalizeEmail(email = "") {
    return String(email)
        .trim()
        .toLowerCase()
        .replace(/^mailto:/i, "")
        .split("?")[0]
        .replace(/[;,]+$/, "");
}

function isBadEmail(email = "") {
    const e = normalizeEmail(email);

    const badParts = [
        "example.com",
        "domain.com",
        "schema.org",
        "sentry.io",
        "wixpress.com",
        "wordpress.org",
        "cloudflare.com",
        "noreply",
        "no-reply",
        ".png",
        ".jpg",
        ".jpeg",
        ".svg",
        ".webp",
        ".gif",
        ".css",
        ".js"
    ];

    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) return true;

    return badParts.some(part => e.includes(part));
}

function isGenericName(name = "") {
    const n = clean(name);

    const badNames = [
        "",
        "home",
        "contact",
        "contact us",
        "about",
        "about us",
        "services",
        "official site",
        "book now",
        "get quote",
        "request estimate",
        "index",
        "welcome",
        "homepage"
    ];

    return badNames.includes(n) || n.length < 3;
}

function nicheMatches(scraped, niche) {
    const text = clean([
        scraped.businessName,
        scraped.title,
        scraped.description,
        scraped.text,
        scraped.website,
        ...(scraped.rawSignals?.types || []),
        ...(scraped.signals?.types || []),
        ...(Array.isArray(scraped.pagesScraped) ? scraped.pagesScraped : [])
    ].join(" "));

    const nicheText = clean(niche);

    if (nicheText.includes("plumber") || nicheText.includes("plumbing")) {
        return [
            "plumber",
            "plumbing",
            "drain",
            "sewer",
            "pipe",
            "water heater",
            "leak",
            "rooter",
            "emergency plumbing",
            "clog",
            "toilet",
            "faucet",
            "water line",
            "gas line"
        ].some(word => text.includes(word));
    }

    return nicheText
        .split(/\s+/)
        .filter(word => word.length > 3)
        .some(word => text.includes(word));
}

function escapeRegex(value = "") {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWord(text, word) {
    return new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(text);
}

const US_STATE_ABBREVIATIONS = {
    alabama: "al",
    alaska: "ak",
    arizona: "az",
    arkansas: "ar",
    california: "ca",
    colorado: "co",
    connecticut: "ct",
    delaware: "de",
    florida: "fl",
    georgia: "ga",
    hawaii: "hi",
    idaho: "id",
    illinois: "il",
    indiana: "in",
    iowa: "ia",
    kansas: "ks",
    kentucky: "ky",
    louisiana: "la",
    maine: "me",
    maryland: "md",
    massachusetts: "ma",
    michigan: "mi",
    minnesota: "mn",
    mississippi: "ms",
    missouri: "mo",
    montana: "mt",
    nebraska: "ne",
    nevada: "nv",
    "new hampshire": "nh",
    "new jersey": "nj",
    "new mexico": "nm",
    "new york": "ny",
    "north carolina": "nc",
    "north dakota": "nd",
    ohio: "oh",
    oklahoma: "ok",
    oregon: "or",
    pennsylvania: "pa",
    "rhode island": "ri",
    "south carolina": "sc",
    "south dakota": "sd",
    tennessee: "tn",
    texas: "tx",
    utah: "ut",
    vermont: "vt",
    virginia: "va",
    washington: "wa",
    "west virginia": "wv",
    wisconsin: "wi",
    wyoming: "wy"
};

function locationWordMatches(text, word) {
    if (hasWord(text, word)) return true;

    const abbreviation = US_STATE_ABBREVIATIONS[word];

    if (abbreviation) {
        return hasWord(text, abbreviation);
    }

    return false;
}

function normalizeLocationText(value = "") {
    return clean(value)
        .replace(/[.,]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/*
  Some place names are also the tail of a different place name.

  "Mexico" is a country, but "New Mexico" is a US state. A substring test, and
  even a word-boundary test, treats one as the other, so a car shop in Santa
  Fe that lists "New Mexico" in its address was being sold as a lead for a
  "mexico" search. The same trap exists for the other "new ..." place names.

  These tokens only count as a match when at least one occurrence of the word
  is NOT part of the longer name. If every occurrence sits inside "new
  mexico", the page is describing New Mexico, not Mexico.
*/
const CONFLICTING_PLACE_NAMES = {
    mexico: ["new mexico"],
    jersey: ["new jersey"],
    york: ["new york"],
    hampshire: ["new hampshire"],
    orleans: ["new orleans"],
    zealand: ["new zealand"],
    wales: ["new wales"],
    south: ["south africa", "south korea", "south america"],
    north: ["north america", "north korea"]
};

/*
  The same map seen from the abbreviation side ("tx", "ca", "ny"). Used to tell
  a bare state code apart from a city name when deciding which token actually
  pins a business to the place that was asked for.
*/
const STATE_ABBREVIATION_SET = new Set(
    Object.values(US_STATE_ABBREVIATIONS).map(v => String(v).toLowerCase())
);

function occursInsideLongerName(text, index, word) {
    const key = word.toLowerCase();
    const phrases = CONFLICTING_PLACE_NAMES[key] || [];
    const before = text.slice(0, index).toLowerCase();

    for (const phrase of phrases) {
        if (!phrase.endsWith(key)) continue;

        const prefix = phrase.slice(0, phrase.length - key.length).trim();
        if (!prefix) continue;

        if (new RegExp(`(?:^|[^\\w])${escapeRegex(prefix)}\\s+$`).test(before)) return true;
    }

    return false;
}

/*
  True when the text contains the word on its own terms, ignoring every
  occurrence that only appears as the tail of a longer place name. US state
  abbreviations still count, so "texas" can be satisfied by "TX".
*/
function matchesOutsideLongerNames(text, word) {
  if (!word) return false;

  const re = new RegExp(`\\b${escapeRegex(word)}\\b`, "gi");
  let match;

  while ((match = re.exec(text)) !== null) {
    if (!occursInsideLongerName(text, match.index, word)) return true;
  }

    return false;
}

function hasUsableWordMatch(text, word) {
    if (matchesOutsideLongerNames(text, word)) return true;

    const abbreviation = US_STATE_ABBREVIATIONS[String(word || "").toLowerCase()];
    if (abbreviation) return matchesOutsideLongerNames(text, abbreviation);

    return false;
}

function hasUsablePhraseMatch(text, phrase) {
    const words = String(phrase || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return false;

    if (words.length === 1) return hasUsableWordMatch(text, words[0]);

    return new RegExp(`(?:^|[^\\w])${escapeRegex(phrase)}(?:$|[^\\w])`, "i").test(text);
}

/*
  Where a claim about location comes from, kept apart on purpose.

  identityLocationText is the part that says where the business actually is:
  its own name, its page title, its parsed address and its city/state fields.

  bodyLocationText is marketing copy. A roofer in San Antonio whose
  /service-areas page lists Austin is not an Austin business, it is a San
  Antonio business that will travel to Austin. Location matching used to read
  body copy, which is how 3 San Antonio and 2 Dallas roofers were reported as
  Austin leads and why the AI then wrote "I noticed you have a dedicated Austin
  line" about companies with San Antonio addresses.
*/
/*
  Addresses reach us either as plain strings or as parsed records depending on the
  scraper. Spreading the array straight into a join produced "[object Object]" for
  the record shape, so every location lookup silently failed and in-area leads were
  reported out of area. Flatten both shapes explicitly.
*/
function addressStrings(scraped = {}) {
    const list = Array.isArray(scraped.addresses) ? scraped.addresses : scraped.addresses ? [scraped.addresses] : [];

    return list
        .map(entry => {
            if (typeof entry === "string") return entry;
            if (!entry || typeof entry !== "object") return "";
            return [entry.raw, entry.formatted, entry.address, entry.street, entry.city, entry.state, entry.postalCode, entry.zip]
                .filter(Boolean)
                .join(" ");
        })
        .filter(Boolean);
}

function identityLocationText(scraped = {}) {
    return normalizeLocationText([
        scraped.businessName,
        scraped.title,
        scraped.city,
        scraped.state,
        scraped.country,
        ...addressStrings(scraped)
    ].filter(Boolean).join(" "));
}

/*
  The subset of identity text that can actually establish where a business is:
  a postal address, or a city/state the source gave us.

  The business name and page title are held back on purpose. A company can be
  named after a place and operate somewhere else entirely, which is why "Mexico
  Auto Repair LLC" at 2201 S 56th St, Tacoma WA was being sold as a Mexico lead.
  Naming a place earns weak evidence, never confirmation.
*/
function addressLocationText(scraped = {}) {
    return normalizeLocationText([
        scraped.city,
        scraped.state,
        scraped.country,
        ...addressStrings(scraped)
    ].filter(Boolean).join(" "));
}

function bodyLocationText(scraped = {}) {
    return normalizeLocationText([
        scraped.description,
        scraped.text,
        ...(Array.isArray(scraped.pagesScraped) ? scraped.pagesScraped : [])
    ].filter(Boolean).join(" "));
}

function locationMatches(scraped, location) {
    // The website/URL is deliberately excluded: a domain like
    // mexicoautorepairllc.com says nothing about where the business is.
    const identityText = identityLocationText(scraped);
    const addressText = addressLocationText(scraped);
    const bodyText = bodyLocationText(scraped);
    const text = normalizeLocationText(`${identityText} ${bodyText}`);

    const loc = normalizeLocationText(location);

    if (!loc) return true;

    /*
      Global logic (no USA-only restriction):
      - The website must prove at least one important location word typed by the user.
      - US state names also match their abbreviations (e.g. "texas" vs "TX").
      - A place name that is the tail of a longer place name does not match
        (e.g. "mexico" must not be satisfied by "New Mexico").

      Examples:
      texas usa         => must contain texas or usa (either one is enough)
      sahiwal pakistan  => must contain sahiwal or pakistan
      pathankot india   => must contain pathankot or india
      sydney australia  => must contain sydney or australia
    */

    const words = loc
        .split(/\s+/)
        .map(word => word.trim())
        .filter(Boolean);

    const uselessWords = new Set([
        "near",
        "in",
        "at",
        "the",
        "city",
        "area",
        "region",
        "state",
        "province",
        "district",
        "county"
    ]);

    const importantWords = words.filter(word => {
        return (word.length > 2 || isStateToken(word)) && !uselessWords.has(word);
    });

    if (!importantWords.length) return false;

    /*
      "A city inside the requested region counts as the region" is right for a
      region request and wrong for a city request. locationAliases("Austin TX")
      is ["texas","houston","san antonio","dallas","austin", ...], and matching
      against all of it meant a San Antonio roofer confirmed "Austin TX", which
      is how 3 San Antonio and 2 Houston businesses were reported verified on
      an Austin job. A request that names a city is now confirmed by that city;
      a request that is only a state keeps accepting any city inside it.
    */
    const cityWords = importantWords.filter(word => !isStateToken(word));
    const decisiveWords = cityWords.length ? cityWords : importantWords;

    /*
      A local spelling of the requested city is the same place, not a sibling
      city. Almost every Lisbon business writes "Lisboa", so matching only the
      literal requested word marked genuine Lisbon leads as out of area.
      cityNameVariants is deliberately separate from locationAliases: it holds
      only same-city spellings, so "Lisbon" gains "lisboa" while "Austin TX" gains
      nothing and Houston can never become decisive.
    */
    for (const variant of spellingVariantsOf(location)) {
        if (!decisiveWords.includes(variant)) decisiveWords.push(variant);
    }

    /*
      A request that names a city is confirmed by that city appearing where the
      business says it is: its name, its title or its address. Body copy is not
      enough, because "we also serve Austin" is a claim about where they will
      travel, not where they are. Both the phrase check and the word check below
      used to read the full scraped text, which is how a Dallas company's
      "now expanding our service area into Austin TX" page completed a 10/10
      Austin order with Texan businesses.
    */
    const decisiveText = cityWords.length ? addressText : text;

    if (hasUsablePhraseMatch(decisiveText, loc)) return true;

    for (const word of decisiveWords) {
        if (hasUsableWordMatch(decisiveText, word)) return true;
    }

    // Whole-phrase variant check, so "lisboa city" is not lost to word splitting.
    for (const variant of spellingVariantsOf(location)) {
        if (hasUsablePhraseMatch(decisiveText, variant)) return true;
    }

    if (!cityWords.length) {
        for (const alias of locationAliases(location)) {
            if (alias === loc) continue;
            if (decisiveWords.some(w => String(w).toLowerCase() === String(alias).toLowerCase())) continue;
            if (hasUsableWordMatch(text, alias)) return true;
        }
    }

    return false;
}

export function locationEvidence(scraped, location) {
    const loc = normalizeLocationText(location);
    if (!loc) return "strong";

    /*
      Strong evidence has to come from somewhere that describes where the
      business actually is: its address or its own page copy.

      The business name and page title are excluded, because a company can be
      named after a country or a city and still operate somewhere else. A
      "Mexico Auto Repair LLC" in Tacoma, Washington was being sold as a
      Mexico lead purely on the strength of its own name. A name-only match is
      still worth keeping, so it degrades to "weak" instead of being dropped.
    */
    const identityText = identityLocationText(scraped);
    const addressText = addressLocationText(scraped);
    const bodyText = bodyLocationText(scraped);

    // Body copy may downgrade the evidence, never establish it.
    const placeText = `${identityText} ${bodyText}`.trim();

    if (hasUsablePhraseMatch(addressText, loc)) return "strong";

    const placeWords = loc.split(/\s+/).map(w => w.trim()).filter(Boolean);
    const ignored = new Set(["near", "in", "at", "the", "city", "area", "region", "state", "province", "district", "county"]);
    const importantPlaceWords = placeWords.filter(
        w => (w.length > 2 || isStateToken(w)) && !ignored.has(w)
    );

    /*
      Two different mistakes used to hide behind one check.

      1. A state code is not a city. "roofers @ Austin TX" scored "strong" on
         any Texan address, because they all end in ", TX 77087".

      2. Region expansion is not locality. locationAliases("Austin TX") is
         ["texas","houston","san antonio","dallas","austin", ...]. That list is
         correct for *finding* candidates, but matching "houston" against it and
         calling the result an Austin business marked 2 Houston and 3 San
         Antonio roofers as verified on a job that reported 10/10.

      So "strong" now requires the place that was actually asked for. A request
      that is only a state keeps using the abbreviation or the state name on its
      own, which is what asking for a state means. Nearby cities still match,
      but only as "weak", so they surface for review instead of inflating the
      verified count.
    */
    const cityWords = importantPlaceWords.filter(w => !isStateToken(w));
    const decisiveWords = cityWords.length ? cityWords : importantPlaceWords;
    const decisiveText = cityWords.length ? addressText : placeText;

    // Same-city spelling variants are decisive here too: "Lisboa" in the address
    // is strong evidence for a Lisbon request, not a weak sibling hint.
    for (const variant of spellingVariantsOf(location)) {
        if (!decisiveWords.includes(variant)) decisiveWords.push(variant);
    }

    for (const word of decisiveWords) {
        if (hasUsableWordMatch(decisiveText, word)) return "strong";
    }

    for (const variant of cityNameVariants(location)) {
        if (hasUsablePhraseMatch(decisiveText, normalizeLocationText(variant))) return "strong";
    }

    let siblingCityMatch = false;
    for (const alias of locationAliases(location)) {
        if (alias === loc) continue;
        if (decisiveWords.some(w => String(w).toLowerCase() === String(alias).toLowerCase())) continue;
        if (hasUsableWordMatch(placeText, alias)) {
            siblingCityMatch = true;
            break;
        }
    }

    if (locationMatches(scraped, location)) return "weak";
    if (siblingCityMatch) return "weak";

    return "none";
}

function isStateToken(word = "") {
    const w = String(word || "").trim().toLowerCase();
    if (!w) return false;
    if (US_STATE_ABBREVIATIONS[w]) return true;
    return STATE_ABBREVIATION_SET.has(w);
}

/*
  Every place name we can recognise, used only to REJECT a lead.

  The matcher above deliberately ignores the business name when deciding whether a
  lead is in the requested city, because "Mexico Auto Repair LLC" in Tacoma is not
  a Mexico lead. That rule is right, but it left a hole: a lead with no parseable
  address at all cannot be placed by coordinates either, and such leads are
  counted on the strength of the search query alone. That is how "Williamsburg
  Brooklyn Tattoo", "NYC's Premier Tattoo Studio" and "Art Ink Tattoo Studio -
  New York" were saved into a Lisbon order.

  So the name gets a negative check. If the business's own name, title or domain
  names a city we recognise, and that city is not the one requested, the lead is
  rejected. This can only ever remove wrong-city leads; it can never add one,
  because a name that says nothing about location proves nothing either way.
*/
/*
  Major cities used only to REJECT a lead, and deliberately built from places far
  from anywhere else. A "Brooklyn" or "NYC" in a business name is decisive, but
  listing the requested city's own neighbours would be harmful: Setubal, Amadora
  and Cascais are legitimately part of a Lisbon order, and the distance gate in
  areaGate.js already decides those on real coordinates. This list only needs to
  catch leads that are unambiguously somewhere else.
*/
const FAR_PLACE_NAMES = [
    // United States
    "new york city", "new york", "nyc", "brooklyn", "manhattan", "queens", "bronx",
    "los angeles", "hollywood", "san francisco", "silicon valley", "chicago",
    "houston", "phoenix", "philadelphia", "philly", "san diego", "dallas", "austin",
    "san jose", "jacksonville", "columbus", "charlotte", "indianapolis", "seattle",
    "denver", "boston", "nashville", "portland", "detroit", "baltimore", "milwaukee",
    "las vegas", "memphis", "louisville", "oklahoma city", "cleveland", "pittsburgh",
    "cincinnati", "st louis", "saint louis", "tampa", "orlando", "buffalo", "rochester",
    "honolulu", "anchorage", "atlanta", "newark", "jersey city",
    // Canada
    "toronto", "montreal", "vancouver", "calgary", "ottawa", "edmonton", "winnipeg",
    "quebec city", "hamilton", "halifax",
    // United Kingdom and Ireland
    "london", "manchester", "birmingham", "glasgow", "leeds", "edinburgh", "bristol",
    "liverpool", "sheffield", "newcastle", "brighton", "dublin", "cork", "galway", "limerick",
    // Australia and New Zealand
    "sydney", "melbourne", "brisbane", "perth", "adelaide", "canberra", "auckland", "wellington",
    // Western Europe
    "madrid", "barcelona", "valencia", "sevilla", "seville", "bilbao", "zaragoza",
    "paris", "lyon", "marseille", "toulouse", "nice", "nantes", "nantes", "strasbourg",
    "berlin", "munich", "munchen", "hamburg", "frankfurt", "cologne", "stuttgart", "dusseldorf",
    "amsterdam", "rotterdam", "utrecht", "brussels", "antwerp", "vienna", "zurich", "geneva",
    "bern", "milan", "rome", "turin", "naples", "florence", "warsaw", "krakow", "prague",
    "budapest", "vienna", "copenhagen", "stockholm", "oslo", "helsinki", "dubai", "tel aviv",
    "moscow", "istanbul", "cairo", "lagos", "nairobi", "johannesburg", "cape town",
    "mexico city", "sao paulo", "buenos aires", "rio de janeiro", "santiago", "bogota", "lima"
];

let placeNameIndex = null;

function knownPlaceNames() {
    if (placeNameIndex) return placeNameIndex;

    const names = new Set(FAR_PLACE_NAMES);

    for (const list of Object.values(COUNTRY_CITIES || {})) {
        for (const name of list || []) names.add(normalizePlaceToken(name));
    }

    for (const list of Object.values(STATE_CITIES || {})) {
        for (const name of list || []) names.add(normalizePlaceToken(name));
    }

    /*
      Longest first so "new york city" is tested before "new york" and "york"
      can never match on its own.
    */
    placeNameIndex = [...names]
        .filter(name => name && name.length > 2)
        .sort((a, b) => b.length - a.length);

    return placeNameIndex;
}

function normalizePlaceToken(value = "") {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ");
}

/**
 * A city named by the lead itself that is not the requested city.
 * @returns {string} the conflicting place name, or "" when there is none.
 */
function conflictingPlaceName(scraped, location) {
    const requested = locationAliases(location).map(normalizePlaceToken);
    const requestedAlso = [normalizePlaceToken(location)];

    /*
      When the request names a city, only that city itself is non-conflicting.
      locationAliases("Austin TX") contains san antonio, houston and dallas, so
      skipping every alias meant a San Antonio business with no address at all
      produced no conflict, the unknown-location allowance then confirmed it,
      and a service-area claim in page copy passed as an Austin lead - which is
      what locationCityGate pins down. locationMatches already refuses sibling
      aliases for a city request; this check now agrees with it. A region or
      state request keeps accepting every city inside its aliases, and state
      tokens never conflict ("Texas Plumbing" is not out of area for Austin).
    */
    const cityWords = normalizeLocationText(location)
        .split(/\s+/)
        .filter(word => (word.length > 2 || isStateToken(word)) && !isStateToken(word));
    const sameCity = new Set([
        ...requestedAlso,
        ...spellingVariantsOf(location)
    ]);

    const haystacks = [
        String(scraped.businessName || ""),
        String(scraped.title || ""),
        // The domain is included because directory-style hostnames carry the city
        // ("artinktattoonyc.com") even when the visible title does not.
        hostnameOf(scraped.website || scraped.url || "")
    ]
        .map(normalizePlaceToken)
        .filter(Boolean);

    if (!haystacks.length) return "";

    for (const hay of haystacks) {
        for (const place of knownPlaceNames()) {
            if (cityWords.length) {
                /*
                  The requested city and its spellings never conflict, and
                  neither does the requested state - "Texas Plumbing" is not
                  out of area for an Austin job. Only the requested state,
                  though: "new york" is also a state name, and skipping every
                  state token let "Art Ink Tattoo Studio - New York" confirm
                  itself for a Lisbon order.
                */
                if (sameCity.has(place) || (isStateToken(place) && requested.includes(place))) continue;
            } else if (requested.includes(place) || requestedAlso.includes(place)) {
                continue;
            }

            /*
              Short tokens need real word boundaries. "nyc" is decisive inside
              "artinktattoonyc.com", but a plain substring test would also fire on
              innocent text, and a token like "la" would match "lashes". Anything
              long enough to be distinctive can match as a phrase.
            */
            if (place.length <= 4) {
                const safe = place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                if (!new RegExp(`(^|[^a-z])${safe}([^a-z]|$)`, "i").test(hay)) continue;
            } else if (!hay.includes(place)) {
                continue;
            }

            return place;
        }
    }

    return "";
}

function hostnameOf(url = "") {
    try {
        return new URL(String(url)).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

function uniqueWords(text = "") {
    return [...new Set(String(text).split(/\W+/).filter(Boolean))];
}

const EXPECTED_COUNTRY_WORDS = {
    US: ["usa", "us", "united states", "america"],
    GB: ["uk", "united kingdom", "britain"],
    AU: ["australia"],
    CA: ["canada"],
    IN: ["india"],
    DE: ["germany", "deutschland"],
    FR: ["france"],
    ES: ["spain", "espana", "españa"],
    IT: ["italy", "italia"],
    AE: ["uae", "united arab emirates"]
};

const FOREIGN_LANGUAGE_GROUPS = [
    [
        "mentions légales", "tous droits réservés", "politique de confidentialité",
        "conditions générales", "plan du site", "à propos", "panneaux solaires",
        "magasin solaire", "être rappelé", "nos services", "pose de panneaux"
    ],
    [
        "impressum", "datenschutzerklärung", "rechtliches", "kontakt",
        "widerrufsrecht", "zum kauf", "über uns"
    ],
    [
        "aviso legal", "política de privacidad", "todos los derechos reservados",
        "condiciones de uso", "sobre nosotros"
    ],
    [
        "informativa sulla privacy", "tutti i diritti riservati",
        "termini e condizioni", "chi siamo"
    ],
    [
        "privacyverklaring", "algemene voorwaarden", "over ons"
    ]
];

function expectedCountryForJob(location = "") {
    const loc = clean(location);
    const words = uniqueWords(loc);

    for (const [country, keys] of Object.entries(EXPECTED_COUNTRY_WORDS)) {
        if (keys.some(k => loc.includes(k))) return country;
    }

    for (const state of Object.keys(US_STATE_ABBREVIATIONS)) {
        if (words.includes(state) || loc.endsWith(state)) return "US";
    }

    return (process.env.DEFAULT_COUNTRY || "US").toUpperCase();
}

function foreignSiteRisk(scraped, expectedCountry) {
    const text = clean([
        scraped.title,
        scraped.description,
        scraped.text,
        ...(Array.isArray(scraped.pagesScraped) ? scraped.pagesScraped : [])
    ].join(" "));

    let hits = [];
    let risk = 0;

    for (const group of FOREIGN_LANGUAGE_GROUPS) {
        const found = group.filter(m => text.includes(m));
        if (found.length >= 1) {
            risk += 2;
            hits.push(...found);
        }
    }

    if (expectedCountry === "US") {
        const foreignAddressWords = [
            "france", "paris", "deutschland", "germany", "espagne", "spain",
            "italie", "italy", "nederland", "netherlands", "belgique", "belgium",
            "suisse", "switzerland", "sverige", "sweden"
        ];
        const addr = clean((scraped.addresses || []).join(" "));
        const textAddr = clean([scraped.title, scraped.description, scraped.text].join(" "));
        for (const word of foreignAddressWords) {
            if (addr.includes(word) || textAddr.includes(` ${word} `)) {
                risk += 2;
                hits.push(`address "${word}"`);
            }
        }
    }

    return { risk, reason: hits.join(", ") };
}

function evidenceScorePhone(item) {
    let score = 0;

    if (item.method === "tel_link") score += 90;
    if (item.method === "schema_telephone") score += 85;
    if (item.method === "contact_page_visible") score += 70;
    if (item.method === "header_footer_visible") score += 60;
    if (item.method === "body_context_visible") score += 35;
    if (item.method === "scraped_phone_fallback") score += 35;

    if (item.pageUrl?.toLowerCase().includes("contact")) score += 20;
    if (item.pageUrl?.toLowerCase().includes("about")) score += 8;
    if (item.context && /call|phone|tel|contact|estimate|emergency/i.test(item.context)) score += 15;

    return score;
}

function evidenceScoreEmail(item, website) {
    let score = 0;

    const email = normalizeEmail(item.value);
    const emailDomain = getEmailDomain(email);
    const siteDomain = getDomain(website);

    if (item.method === "mailto_link") score += 90;
    if (item.method === "schema_email") score += 85;
    if (item.method === "cloudflare_email") score += 80;
    if (item.method === "contact_page_visible") score += 65;
    if (item.method === "body_context_visible") score += 35;
    if (item.method === "scraped_email_fallback") score += 35;

    if (emailDomain === siteDomain) score += 35;
    if (/^(info|contact|hello|support|office|admin|service|sales)@/i.test(email)) score += 15;
    if (item.pageUrl?.toLowerCase().includes("contact")) score += 15;

    return score;
}

function pickBestPhone(scraped) {
    const evidence = Array.isArray(scraped.phoneEvidence) ? scraped.phoneEvidence : [];

    const fallbackEvidence = Array.isArray(scraped.phones)
        ? scraped.phones.map(phone => ({
            value: phone,
            method: "scraped_phone_fallback",
            pageUrl: scraped.website,
            context: "Phone found by scraper"
        }))
        : [];

    const allEvidence = [...evidence, ...fallbackEvidence];

    const candidates = allEvidence
        .map(item => ({
            ...item,
            normalized: normalizePhone(item.value),
            evidenceScore: evidenceScorePhone(item)
        }))
        .filter(item => item.normalized && item.evidenceScore >= 35);

    if (!candidates.length) return { value: "", source: null };

    const grouped = new Map();

    for (const item of candidates) {
        const key = item.normalized;
        const current = grouped.get(key);

        if (!current) {
            grouped.set(key, {
                value: key,
                evidenceScore: item.evidenceScore,
                sources: [item]
            });
        } else {
            current.evidenceScore += item.evidenceScore + 15;
            current.sources.push(item);
        }
    }

    const sorted = [...grouped.values()].sort((a, b) => b.evidenceScore - a.evidenceScore);

    return {
        value: sorted[0].value,
        source: sorted[0]
    };
}

async function pickBestEmail(scraped) {
    const evidence = Array.isArray(scraped.emailEvidence) ? scraped.emailEvidence : [];

    const fallbackEvidence = Array.isArray(scraped.emails)
        ? scraped.emails.map(email => ({
            value: email,
            method: "scraped_email_fallback",
            pageUrl: scraped.website,
            context: "Email found by scraper"
        }))
        : [];

    const allEvidence = [...evidence, ...fallbackEvidence];

    const candidates = allEvidence
        .map(item => ({
            ...item,
            normalized: normalizeEmail(item.value),
            evidenceScore: evidenceScoreEmail(item, scraped.website)
        }))
        .filter(item => item.normalized && !isBadEmail(item.normalized) && item.evidenceScore >= 35);

    const hunterProof = [];

    for (const candidate of candidates.slice(0, 3)) {
        const hunter = await verifyEmailWithHunter(candidate.normalized);

        candidate.hunter = hunter;

        if (hunter.ok) {
            hunterProof.push(`Hunter checked ${candidate.normalized}: ${hunter.result}, score ${hunter.score}`);

            if (hunter.result === "deliverable") candidate.evidenceScore += 45;
            if (hunter.result === "risky") candidate.evidenceScore += 15;
            if (hunter.result === "undeliverable") candidate.evidenceScore -= 80;

            if (hunter.score >= 80) candidate.evidenceScore += 25;
            else if (hunter.score >= 60) candidate.evidenceScore += 10;

            if (hunter.disposable) candidate.evidenceScore -= 60;
            if (hunter.gibberish) candidate.evidenceScore -= 60;
            if (hunter.block) candidate.evidenceScore -= 40;
        }
    }

    const goodCandidates = candidates
        .filter(item => item.evidenceScore >= 35)
        .sort((a, b) => b.evidenceScore - a.evidenceScore);

    if (goodCandidates.length) {
        return {
            value: goodCandidates[0].normalized,
            source: goodCandidates[0],
            hunterProof
        };
    }

    const hunterDomain = await findEmailsWithHunterDomain(scraped.website);

    if (hunterDomain.ok && hunterDomain.emails.length) {
        const sorted = hunterDomain.emails
            .filter(item => item.confidence >= 50)
            .sort((a, b) => b.confidence - a.confidence);

        if (sorted.length) {
            return {
                value: sorted[0].value,
                source: {
                    method: "hunter_domain_search",
                    confidence: sorted[0].confidence,
                    type: sorted[0].type,
                    department: sorted[0].department,
                    position: sorted[0].position,
                    sources: sorted[0].sources
                },
                hunterProof: [
                    ...hunterProof,
                    `Hunter domain search found ${sorted[0].value} with confidence ${sorted[0].confidence}`
                ]
            };
        }
    }

    return {
        value: "",
        source: null,
        hunterProof
    };
}

const NON_BUSINESS_HOST_HINTS = [
    "411.com",
    "contactout",
    "signalhire",
    "rocketreach",
    "lead411",
    "pipl.com",
    "beenverified",
    "truepeoplesearch",
    "fastpeoplesearch",
    "usphonebook",
    "nuwber",
    "spokeo",
    "clustrmaps",
    "idcrawl",
    "barbershops.net",
    "hair salons directory",
    "loccit",
    "numlookup",
    "thatnumber",
    "tellows",
    "peoplelegacy",
    "people search",
    "directory",
    "listings",
    "reviews",
    "ratings",
    "nearme",
    "near-me",
    "advisor",
    "analytica",
    "compass",
    "guide",
    "guides",
    "top-rated",
    "toprated",
    "best-"
];

const DIRECTORY_PAGE_SIGNALS = [
    { re: /\b(browse|search|explore|discover|find)\b[^.!?\n]{0,40}\b(business|professional|provider|listing|profile|shop|company|contractor|directory|service)s?\b/i, w: 3 },
    { re: /\b(list|submit|claim|add|feature) your (business|listing|company|service|profile)\b/i, w: 4 },
    { re: /\b(get listed|claim your listing|add your business|list your business|advertise (with|on|here))\b/i, w: 4 },
    { re: /\b(unlimited|free) (listings|profiles|leads|directory)\b/i, w: 3 },
    { re: /\b\d[\d,]{2,}\+? (businesses|professionals|listings|providers|shops|contractors|services|companies|agencies|technicians|experts)\b/i, w: 3 },
    { re: /\b(compare|ranking|ranked|rated) (the )?(best|top|local)\b/i, w: 2 },
    { re: /\btop \d+\b/i, w: 1 },
    { re: /\bwrite a review\b|\bleave a review\b/i, w: 2 },
    { re: /\bverified reviews?\b/i, w: 2 },
    { re: /\bprofiles?\b/i, w: 1 },
    { re: /\bread (more )?(reviews|our reviews)\b|\bsee (all )?reviews\b/i, w: 1 },
    { re: /\bbook (now|online|an appointment|a service)\b/i, w: -1 },
    { re: /\b(our|view our) (services|prices|hours|about|menu)\b/i, w: -1 }
];

const EDITORIAL_PAGE_SIGNALS = [    { re: /\b(how to|what is|why (you|we) should|guide to|guide for|everything you need to know|step[- ]by[- ]step)\b/i, w: 3 },
    { re: /\b(license|licensing|permit) (requirements?|laws?|rules?|board|process|fees?|renewal)\b/i, w: 4 },
    { re: /\bstate (board|department|agency|commission|bureau|office)\b/i, w: 4 },
    { re: /\b(frequently asked questions|faqs?)\b/i, w: 1 },
    { re: /\bupdated (on)?:?\s*\w+ \d{1,2},? \d{4}/i, w: 2 },
    { re: /\b\d+ (tips?|ways?|reasons?|steps?|things)\b/i, w: 2 },
    { re: /\b(affiliate|advertisement|sponsored) (link|disclosure|post)?/i, w: 1 }
];

/*
  Matched against the page title and hostname only, never the body text: a real
  barbershop may well mention "state board certified" on its about page, but a
  site called "Barber College" or "Barber License Renewal" is not a shop.
*/
const TRADE_SCHOOL_SIGNALS = [
    /\b(barber|hair|beauty|cosmetology|barbers) (school|college|academy|university|campus)\b/i,
    /\b(school|college|academy|university) of (barber|hair|beauty|cosmetology)\b/i,
    /\b(online|correspondence) (barber|hair|beauty) school\b/i,
    /\bhow to (become|be) a (licensed )?(barber|hairdresser|hairstylist|beautician)\b/i
];

const LICENSE_COURSE_SIGNALS = [
    /\b(license|licence) (renewal|renewal course|class|course|training)\b/i,
    /\brenew(al)? your (barber|hair|beauty|cosmetology) license\b/i,
    /\b(barber|hair|beauty|cosmetology) (ce|c\.e\.) (course|class|hours)\b/i,
    /\bcontinuing education\b.{0,40}\b(barber|hair|beauty|cosmetology)\b/i,
    /\b(hours|course|class|training) (for|in) .{0,20}(barber|cosmetology) (license|renewal)\b/i,
    /\b(barber|hair|beauty|cosmetology)\b.{0,40}\bcontinuing education\b/i,
    /\b(barber|hair|beauty|cosmetology)\b.{0,30}\b(certif|certificate|certification)\b/i,
    /\b(certif|certification|certificate) (course|class|program|renewal)\b/i,
    /\bcert(ification)?\b.{0,30}\b(barber|cosmetology|hair)\b/i,
    /\b\d+\s?hour (barber|hair|beauty|cosmetology)\b/i
];

function nicheSignalPatterns(niche = "") {
    const words = String(niche || "")
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(w => w.length >= 3);

    const patterns = [];

    for (const word of words.slice(0, 2)) {
        const singular = word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word;
        const esc = singular.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        // "12,000+ barbers near you" / "500+ listings"
        patterns.push({ re: new RegExp(`\\b\\d[\\d,]{2,}\\+? ${esc}s?\\b`, "i"), w: 3 });
        // "browse local barber profiles", "find a plumber in Austin"
        patterns.push({
            re: new RegExp(`\\b(browse|search|explore|discover|find|compare)\\b[^.!?\\n]{0,40}\\b${esc}s?\\b`, "i"),
            w: 3
        });
    }

    return patterns;
}

export function detectNonBusinessSite(scraped = {}, job = {}) {
    const host = getDomain(scraped.website || scraped.url || "");
    const text = `${scraped.title || ""} ${scraped.description || ""} ${scraped.text || ""}`.slice(0, 20000);

    const hostHit = NON_BUSINESS_HOST_HINTS.find(h => host.includes(h));
    if (hostHit) {
        return { hardReject: true, reason: `"${hostHit}" sites are directories/content pages, not a single local business` };
    }

    const nichePatterns = nicheSignalPatterns(job.niche);

    // Title/hostname only, so body copy mentioning certifications is not punished.
    const titleHost = `${scraped.title || ""} ${host}`.slice(0, 300);

    if (TRADE_SCHOOL_SIGNALS.some(re => re.test(titleHost))) {
        return { hardReject: true, reason: "Barber/beauty school or trade college, not an operating local business" };
    }

    if (LICENSE_COURSE_SIGNALS.some(re => re.test(titleHost))) {
        return { hardReject: true, reason: "Licence/certification course site, not an operating local business" };
    }

    let dirScore = 0;
    for (const s of [...DIRECTORY_PAGE_SIGNALS, ...nichePatterns]) if (s.re.test(text)) dirScore += s.w;

    let editorialScore = 0;
    for (const s of EDITORIAL_PAGE_SIGNALS) if (s.re.test(text)) editorialScore += s.w;

    if (dirScore >= 5) {
        return { hardReject: true, reason: `Directory/aggregator page (lists many businesses), not a single business` };
    }

    if (editorialScore >= 6) {
        return { hardReject: true, reason: `Informational/editorial site (guides and articles), not a business that buys services` };
    }

    const niche = assessNiche({ scraped, niche: job.niche });
    if (niche.verdict === "reject") {
        return { hardReject: true, reason: niche.reason };
    }

    return { hardReject: false, reason: "" };
}

export async function verifyLead(scraped, job) {
    const nonBusiness = detectNonBusinessSite(scraped, job || {});

    if (nonBusiness.hardReject) {
        return {
            status: "rejected",
            hardReject: true,
            confidenceScore: 0,
            primaryPhone: "",
            primaryEmail: "",
            phoneSource: null,
            emailSource: null,
            proof: [nonBusiness.reason],
            rejectionReasons: [nonBusiness.reason]
        };
    }

    let score = 0;

    const proof = [];
    const rejectionReasons = [];

    const bestPhone = pickBestPhone(scraped);
    const bestEmail = await pickBestEmail(scraped);

    const hasName = !isGenericName(scraped.businessName);
    const hasPhone = Boolean(bestPhone.value);
    const hasEmail = Boolean(bestEmail.value);
    const hasAddress = Array.isArray(scraped.addresses) && scraped.addresses.length > 0;
    const hasMultiplePages =
        Array.isArray(scraped.pagesScraped) && scraped.pagesScraped.length > 1;

    if (scraped.scrapeOk) {
        score += 10;
        proof.push("Website scraped successfully");
    } else {
        rejectionReasons.push("Website scrape failed");
    }

    if (hasName) {
        score += 20;
        proof.push("Business name found");
    } else {
        rejectionReasons.push("Business name weak or generic");
    }

    if (hasPhone) {
        score += 35;
        proof.push(
            `Trusted phone found via ${
                bestPhone.source?.sources?.[0]?.method ||
                bestPhone.source?.method ||
                "trusted source"
            }`
        );
    } else {
        rejectionReasons.push("No trusted phone found");
    }

    if (bestEmail.hunterProof?.length) {
        proof.push(...bestEmail.hunterProof);
    }

    if (hasEmail) {
        score += 20;
        proof.push(`Trusted email found via ${bestEmail.source?.method || "trusted source"}`);

        const emailDomain = getEmailDomain(bestEmail.value);
        const websiteDomain = getDomain(scraped.website);

        if (emailDomain === websiteDomain) {
            score += 10;
            proof.push("Email domain matches website");
        }
    } else {
        rejectionReasons.push("No trusted public email found");
    }

    if (hasAddress) {
        score += 10;
        proof.push("Address found");
    }

    if (hasMultiplePages) {
        score += 10;
        proof.push("Multiple website pages scraped");
    }

    if (nicheMatches(scraped, job.niche)) {
        score += 20;
        proof.push("Niche confirmed");
    } else {
        rejectionReasons.push("Niche not confirmed");
    }

    const locationConfirmed = locationMatches(scraped, job.location);
    const locationStrength = locationEvidence(scraped, job.location);

    /*
      OpenStreetMap, Google Places and every other structured source hand over a
      city, a state, an address or a lat/lon. A plain web-search result often has
      none of those: Tavily and Firecrawl return a name and a URL, the page has no
      parseable address block, and the lead ends up with an empty city.

      Treating "we know nothing" as "it is somewhere else" is not a location
      check, it is an invented one. The query was already scoped to the requested
      city, so silence is not evidence against it. This is the same rule the rest
      of the file relies on: a missing verdict is absent, not disproven.

      So a lead with no location information at all is counted, labelled
      "unknown", and pushed into needsReview so a human confirms it. Only a lead
      that positively names a different place is rejected.
    */
    const hasLocationEvidence = Boolean(
      String(scraped.city || "").trim() ||
      String(scraped.state || "").trim() ||
      (Array.isArray(scraped.addresses) && scraped.addresses.length) ||
      scraped.location ||
      (Number.isFinite(Number(scraped.lat)) && Number.isFinite(Number(scraped.lon)))
    );

    const unknownLocation = !hasLocationEvidence;

    /*
      A lead that names a different city in its own name, title or domain is out
      of area no matter what else it looks like. This runs before the "no
      information" allowance on purpose: that allowance exists for leads the
      matcher simply could not read, not for leads that positively place
      themselves somewhere else.
    */
    const conflictingPlace = conflictingPlaceName(scraped, job.location);
    const nameConfirmed = locationConfirmed || (unknownLocation && !conflictingPlace);

    /*
      Name matching alone could not fill the requested number, because it throws
      away businesses the user would have been happy with. "Cacilhas Tattoo" is a
      Lisbon business whose address never spells "Lisbon", and the matcher
      deliberately ignores the business name because a company can be named after
      a city and still operate elsewhere. Meanwhile real nearby businesses in
      Amadora or Odivelas were refused even though the user asked for "Lisbon".

      OpenStreetMap hands us a lat/lon for every business, so the honest question
      is how far away it actually is. A business inside the metro counts toward the
      target, and it is reported as weak evidence rather than address-level proof,
      so the verifier below downgrades it to needsReview instead of passing it off
      as a verified downtown company.
    */
    const metro = await metroAreaVerdict(scraped, job.location, job.metroRadiusKm);
    const geoConfirmed = metro.inArea;

    if (geoConfirmed) {
        proof.push(`Within ${metro.reason}`);
    }

    const inAreaConfirmed = nameConfirmed || geoConfirmed;

    if (inAreaConfirmed) {
        score += 25;
        proof.push(`Location confirmed for "${job.location}"`);
    } else {
        score += 8;
        rejectionReasons.push(`Location not confirmed for "${job.location}"`);
    }

    if (inAreaConfirmed && locationStrength === "weak") {
        score -= 15;
        rejectionReasons.push(`"${job.location}" only appears in page content, not in the business address or title`);
    }

    /*
      Counted, but never dressed up as confirmed: no address, no coordinates and
      no city means the only thing that places this business is the search query.
    */
    if (unknownLocation) {
        score -= 15;
        rejectionReasons.push(`No address or coordinates found, so "${job.location}" is unconfirmed`);
    }

    if (conflictingPlace) {
        rejectionReasons.push(`Names "${conflictingPlace}" in its own name or domain, which is not "${job.location}"`);
    }

    /*
      A distance-only match is weaker than an address match, so it is capped at
      the same -15 penalty and can never reach "verified" on its own.
    */
    if (geoConfirmed && !locationConfirmed) {
        score -= 15;
        rejectionReasons.push(`Confirmed by distance only (${metro.reason}), not by a matching address`);
    }

    const expectedCountry = expectedCountryForJob(job.location);
    const foreign = foreignSiteRisk(scraped, expectedCountry);

    // One foreign-language phrase (2) + one foreign address word (2) is enough to flag.
    if (foreign.risk >= 3) {
        score -= 30;
        rejectionReasons.push(`Site appears to be in a different country (${foreign.reason})`);
    }

    score = Math.min(score, 100);

    let status = "rejected";

    if (score >= 75 && hasName && locationConfirmed && (hasPhone || hasEmail)) {
        status = hasPhone ? "verified" : "needsReview";
    } else if (score >= 55 && hasName && (hasPhone || hasEmail)) {
        status = "needsReview";
    }

    return {
        status,
        confidenceScore: score,
        /*
          inTargetArea is what the target count is measured against, so it accepts
          a metro match. `areaSource` keeps the distinction visible: "address" means
          the business itself said it was in the requested place, "metro" means we
          placed it by distance and it still needs a human look.
        */
        locationConfirmed: inAreaConfirmed,
        areaSource: locationConfirmed ? "address" : geoConfirmed ? "metro" : unknownLocation ? "unknown" : "none",
        distanceKm: metro.distanceKm,
        metroReason: metro.reason,
        primaryPhone: bestPhone.value,
        primaryEmail: bestEmail.value,
        phoneSource: bestPhone.source,
        emailSource: bestEmail.source,
        proof,
        rejectionReasons
    };
}