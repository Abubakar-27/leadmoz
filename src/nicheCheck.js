/*
  Niche relevance: does this business actually PROVIDE the requested service,
  or does it merely mention the word?

  A keyword match is not proof. "Barber Law Office", "Barber Life Academy",
  "The Pet Barber" and "Book of Barbering" all contain the word "barber" while
  being a law firm, a trade school, a dog groomer and a blog respectively.
  Requiring the literal keyword is what let all four through.

  So we score three independent things:
    serviceScore  - evidence it sells/books the service (trade markers, prices,
                    street addresses, booking CTAs). Generic, so it works for
                    every niche.
    contentScore  - evidence it publishes/teaches instead of serving (quizzes,
                    calculators, "know what to ask", guides, tips).
    directoryScore- evidence it lists other businesses ("The 16 Best ...",
                    "My Best Houston", "View all results", categories).
  Plus a conflicting-sector check that catches a business that clearly belongs
  to a different industry than the one requested.

  verdict:
    "reject"  - confidently not a lead (wrong industry, or not a business)
    "accept"  - confidently a local business serving the niche, no AI needed
    "unknown" - genuinely ambiguous, let the AI classifier decide
*/

const SERVICE_PATTERNS = [
  { re: /\bbook (now|online|your appointment|an appointment)\b/i, w: 3 },
  { re: /\b(make|book|schedule|reserve) (an? |your )?(appointment|visit|consultation|session)\b/i, w: 3 },
  { re: /\bcall (us )?(to|for) (schedule|book|an appointment|prices)\b/i, w: 3 },
  { re: /\b(schedule|reserve) (now|online|your)\b/i, w: 3 },
  { re: /\b(walk[- ]?ins? (welcome|accepted|available))\b/i, w: 3 },
  { re: /\b(service menu|services menu|price list|our menu|what we offer)\b/i, w: 3 },
  { re: /\bour (services|team|staff|shop|prices|technicians|barbers|stylists)\b/i, w: 2 },
  { re: /\b(free|no obligation) (estimates?|quotes?|consultations?)\b/i, w: 2 },
  { re: /\b(open (now|today)|business hours|store hours|our hours|opening hours)\b/i, w: 2 },
  { re: /\b(our story|who we are|why choose us|about our shop)\b/i, w: 2 },
  { re: /\b(get|request) (a )?(quote|estimate|price)\b/i, w: 2 },
  { re: /\b(accept|same day) (walk ins?|cash|cards?)\b/i, w: 1 },
  { re: /\b(we|come) (are|get) (licensed|insured|certified)\b/i, w: 1 },
  { re: /\b(serving|proud to serve) (the )?(community|since)\b/i, w: 1 },
  { re: /\b(over|\d{1,3}\+?) years (of|helping|serving)\b/i, w: 2 },
  { re: /\b(based on|reviews from) [\d,]+ (reviews|ratings|stars)\b/i, w: 1 }
];

const PRICE_PATTERNS = [
  { re: /\$\s?\d/, w: 2 },
  { re: /[-=]{3,}\s*\$\s?\d/, w: 2 },
  { re: /\b(pricing|prices start|starting at|from as little as)\b/i, w: 1 }
];

const BUSINESS_PATHS = new Set([
  "", "index", "index.html", "index.php", "home", "about", "about-us", "aboutus",
  "contact", "contact-us", "contactus", "menu", "menus", "services", "service",
  "shop", "store", "book", "book-now", "book-online", "booking", "appointment",
  "appointments", "locations", "location", "hours", "our-story", "story", "faq",
  "faqs", "gallery", "team", "our-team", "staff", "reviews", "products",
  "pricing", "cart", "checkout", "order", "orders", "account", "login", "join",
  "careers", "privacy", "terms", "sitemap", "wp-admin", "en", "default"
]);

const EDITORIAL_PATH_SEGMENTS = new Set([
  "guide", "guides", "blog", "blogs", "article", "articles", "post", "posts",
  "news", "category", "categories", "tag", "tags", "resources", "search",
  "near-me", "directory", "listings", "best", "top", "how-to", "howto", "tips",
  "inspiration", "ideas", "newsletter", "archive", "author", "destinations",
  "city-guides", "cityguide", "reviews-list", "ranking", "rankings"
]);

function pagePath(url = "") {
  try {
    return new URL(String(url)).pathname || "";
  } catch {
    return "";
  }
}

function pageSegments(url = "") {
  return pagePath(url)
    .split("/")
    .filter(Boolean)
    .map(s => s.toLowerCase().replace(/\.(html?|php|aspx?|jsp)$/, ""));
}

/*
  A business's own pages are /contact, /menu, /services, /locations. A page
  whose path is a category, a listicle or an article slug is not the business
  even when the copy is perfect:
    /best-coffee-shops-nyc/            article slug
    /coffee-shops/                     the niche itself, as a category
    /the-coffee-spot-guide-to/usa-canada/new-york-city/
  The URL is the most reliable signal we were not using at all.
*/
function pathSignals(url, niche) {
  const segments = pageSegments(url);
  if (!segments.length) return null;

  const nicheSlug = String(niche || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  for (const seg of segments) {
    if (!seg) continue;

    if (EDITORIAL_PATH_SEGMENTS.has(seg)) {
      return `Editorial page path "/${seg}/"`;
    }

    if (nicheSlug && (seg === nicheSlug || seg === nicheSlug.replace(/s$/, ""))) {
      return `Category page path "/${seg}/" lists businesses, it is not one`;
    }

    if (/^(usa|us|uk|eu|united-states|united-kingdom|canada)-[a-z-]+$/.test(seg)) {
      return `Geographic guide path "/${seg}/"`;
    }

    if (/^\d{4}(-\d{2}){0,2}$/.test(seg)) {
      return `Dated article path "/${seg}/"`;
    }

    if (seg.includes("-") && seg.split("-").length >= 3) {
      return `Article slug path "/${seg}/"`;
    }
  }

  if (segments.length >= 4) {
    return `Deep nested path "/${segments.join("/")}/" is a content page`;
  }

  return null;
}

const TOOL_RE = /\b(quiz|quizzes|calculator|detector|finder|generator|planner|selector|matcher)\b/gi;

function distinctTools(text) {
  const found = new Set();
  for (const m of text.matchAll(TOOL_RE)) found.add(m[0].toLowerCase());
  return [...found];
}

const CONTENT_PATTERNS = [
  { re: /\bknow what to (ask|tell|look for)\b/i, w: 3 },
  { re: /\b(quiz|calculator|detector|finder|generator|planner tool)\b/i, w: 2 },
  { re: /\b(read|view) (more )?(our )?(the )?(articles?|posts?|guides?|blogs?)\b/i, w: 2 },
  { re: /\b(subscribe|newsletter|sign up for our)\b/i, w: 2 },
  { re: /\b(podcast|magazine|newsletter|blog)\b/i, w: 2 },
  { re: /\b(tips?|guides?|ideas|inspiration|how to|diy|explore)\b/i, w: 1 }
];

const DIRECTORY_PATTERNS = [
  { re: /\bmy best [a-z]{2,20}\b/i, w: 4 },
  { re: /\bthe \d{1,3} (best|top|greatest|coolest|most)\b/i, w: 4 },
  { re: /\b(best|top) \d{1,3} (places|shops|businesses|services|spots|options)\b/i, w: 4 },
  { re: /\bview all results\b/i, w: 3 },
  { re: /\ball (results|listings|businesses|shops|reviews)\b/i, w: 2 },
  { re: /\bcategories\b/i, w: 2 },
  { re: /\b(search|filter|sort) (by|results|listings)\b/i, w: 2 },
  { re: /\b(near me|in your area)\b.{0,30}\b(browse|search|filter)\b/i, w: 3 }
];

const EDUCATION_PATTERNS = [
  { re: /\b(academy|college|university|campus|trade school)\b/i, w: 3 },
  { re: /\b(students?|graduates?|alumni)\b/i, w: 3 },
  { re: /\b(enroll|enrollment|admissions?|enrolment)\b/i, w: 3 },
  { re: /\b(curriculum|faculty|semester|tuition|scholarship)\b/i, w: 3 },
  { re: /\bcampus tour\b/i, w: 3 },
  { re: /\b(courses?|certification|certificate program)\b/i, w: 2 },
  { re: /\b(our )?programs?\b/i, w: 2 }
];

/*
  A business that clearly belongs to some other industry is not a lead for the
  requested niche, no matter how many times the niche word appears.
  `aliases` marks sectors the requested niche might legitimately be, so a
  "pet groomer" search is not rejected for being a groomer.
*/
const SECTORS = [
  {
    key: "law", label: "law firm",
    aliases: ["law", "attorney", "lawyer", "legal", "litigation", "estate", "probate"],
    markers: [
      /\battorney\b/i, /\b(law office|law firm)\b/i, /\blawyers?\b/i,
      /\b(counsel|counselor at law)\b/i,
      /\b(probate|estate planning|litigation|mediation|personal injury|family law|criminal defense|immigration)\b/i,
      /\b(consultation|retainer)\b/i
    ]
  },
  {
    key: "pet", label: "pet grooming / veterinary",
    aliases: ["pet", "dog", "puppy", "vet", "veterinary", "animal", "kennel", "cat"],
    markers: [
      /\b(dog|pet|puppy|canine|cat) groomer\b/i,
      /\b(dog|pet|puppy|canine|cat) grooming\b/i,
      /\bkennel\b/i, /\bveterinar(y|ian)\b/i, /\banimal hospital\b/i,
      /\bpet (sitter|boarding|store|supply|care)\b/i,
      /\b(groom your|for the special pet|your pet)\b/i
    ]
  },
  {
    key: "education", label: "school / training",
    aliases: ["school", "academy", "college", "course", "training", "education", "university", "tutor", "campus"],
    markers: EDUCATION_PATTERNS
  },
  {
    key: "medical", label: "medical / dental clinic",
    aliases: ["doctor", "clinic", "medical", "dentist", "dental", "chiropractic", "therap", "clinic"],
    markers: [
      /\b(dentist|orthodontist|dermatologist|pediatrician|optometrist|chiropractor)\b/i,
      /\b(our )?(patients|medical (centre|center|group|practice)|clinic)\b/i,
      /\b(insurance accepted|we accept insurance|new patients)\b/i,
      /\b(diagnos\w+|symptoms|treatment plan|prescription)\b/i
    ]
  },
  {
    key: "real estate", label: "real estate",
    aliases: ["realty", "real estate", "realtor", "property", "rental", "homes", "broker"],
    markers: [
      /\b(real estate|realtor|realtys?)\b/i, /\b(listings?|mls)\b/i,
      /\b(homes? for sale|properties for (sale|rent))\b/i, /\b(mortgage|closing costs?)\b/i
    ]
  },
  {
    key: "finance", label: "financial / insurance",
    aliases: ["financial", "finance", "insurance", "tax", "accounting", "bookkeeping", "mortgage", "loan", "invest"],
    markers: [
      /\b(insurance (agency|broker|company)|financial (advisor|planning|planner))\b/i,
      /\b(tax preparation|tax filing|bookkeeping|payroll|audit)\b/i,
      /\b(loan|mortgage|interest rate|credit union)\b/i, /\b(401k|ira|retirement planning)\b/i
    ]
  },
  {
    key: "government", label: "government",
    aliases: ["government", "city", "county", "state", "municipal", "public", "federal"],
    markers: [
      { re: /\b(department of|state of|county of|city of)\b/i, w: 3 },
      { re: /\b(texas|houston|dallas|austin)\s+(county|city|state)\b/i, w: 2 },
      { re: /\b(permit(s|ted)?|code enforcement|ordinance)\b/i, w: 2 }
    ]
  },
  {
    key: "news media", label: "news / media",
    aliases: ["news", "media", "blog", "magazine", "publication", "journal"],
    markers: [
      /\b(subscribe to (our|the))\b/i, /\b(newsletter|epaper|magazine issue)\b/i,
      /\b(article by|author bio|press release)\b/i, /\bread (the )?(latest|full) (article|story)\b/i
    ]
  },
  {
    key: "ecommerce",
    aliases: ["ecommerce", "e-commerce", "retail", "supply", "supplies", "wholesale", "products", "shop"],
    markers: [
      { re: /\b(add to cart|shopping cart|free shipping|check ?out)\b/i, w: 3 },
      { re: /\b(our (product )?catalog|catalogue|product range)\b/i, w: 2 },
      { re: /\bships? (nationwide|worldwide)\b/i, w: 2 }
    ]
  },
  {
    key: "photography", label: "photography studio",
    aliases: ["photo", "photos", "photography", "photographer", "videography", "video", "film", "studio", "creative"],
    markers: [
      { re: /\b(photograph(y|er|ic)|videograph(y|er)|wedding (photo|film)|filmmak(er|ing))\b/i, w: 3 },
      { re: /\b(portfolio|shooting gallery|prints? & framing)\b/i, w: 1 }
    ]
  },
  {
    key: "tourism", label: "tourism / visitor guide",
    aliases: ["travel", "tour", "tourism", "vacation", "holiday", "trip", "attraction", "attractions", "visitor", "guide", "hotel", "restaurant"],
    domains: [/^visit[a-z0-9-]+\./i, /^(www\.)?visit[a-z0-9-]+\.(com|org|net)$/i, /\b(convention|visitors?)\.(com|org|net)$/i],
    markers: [
      { re: /\b(visitors? bureau|convention (and|&) visitors?|tourism board|visitor (information|centre|center))\b/i, w: 3 },
      { re: /\b(things to do|plan your (trip|visit|day))\b/i, w: 3 },
      { re: /\b(where to (stay|eat|play|shop)|top attractions|visitor guide)\b/i, w: 2 },
      { re: /\b(events calendar|annual report|fiscal year)\b/i, w: 1 }
    ]
  }
];

const STREET_RE = /\b\d{1,6}\s+[a-z0-9][\w.'-]*(?:\s+[\w.'-]+){0,4}\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|highway|hwy|suite|ste|#)\b/i;

const ACCEPT_SCORE = 8;
const REJECT_CONTENT_SCORE = 9;
const REJECT_EDUCATION_SCORE = 9;
const REJECT_DIRECTORY_SCORE = 7;
const REJECT_SECTOR_SCORE = 9;

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fields(scraped = {}) {
  const strong = clean([
    scraped.businessName,
    scraped.title,
    scraped.description,
    scraped.ogTitle,
    scraped.ogDescription
  ].filter(Boolean).join(" "));

  const body = clean([
    scraped.text,
    scraped.h1,
    scraped.headings,
    Array.isArray(scraped.addresses) ? scraped.addresses.join(" ") : ""
  ].filter(Boolean).join(" "));

  return { strong, body };
}

function score(patterns, strong, body) {
  let total = 0;
  const hits = [];
  for (const entry of patterns) {
    const re = entry instanceof RegExp ? entry : entry.re;
    const w = entry instanceof RegExp ? 3 : entry.w;
    const inStrong = re.test(strong);
    const inBody = re.test(body);
    if (!inStrong && !inBody) continue;
    total += (inStrong ? w * 2 : 0) + (inBody ? w : 0);
    hits.push(String(re).slice(0, 44));
  }
  return { total, hits };
}

function nicheWords(niche = "") {
  return String(niche || "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(w => w.length >= 3);
}

function sectorImpliesNiche(sector, words) {
  return sector.aliases.some(alias => {
    const parts = alias.split(/\s+/);
    return parts.every(part => words.some(w => w === part || w.startsWith(part) || part.startsWith(w)));
  });
}

function conflictingSector(scraped, niche) {
  const { strong, body } = fields(scraped);
  const host = clean(scraped.website || scraped.url || "").toLowerCase();
  const words = nicheWords(niche);
  if (!words.length) return null;

  let worst = null;

  for (const sector of SECTORS) {
    if (sectorImpliesNiche(sector, words)) continue;

    const { total, hits } = score(sector.markers || [], strong, body);

    let domainHits = [];
    for (const re of sector.domains || []) {
      if (host && re.test(host)) domainHits.push(`domain:${re.source.slice(0, 30)}`);
    }

    const grand = total + domainHits.length * 4;
    if (grand < REJECT_SECTOR_SCORE) continue;

    if (!worst || grand > worst.score) {
      worst = { key: sector.key, label: sector.label, score: grand, hits: [...domainHits, ...hits] };
    }
  }

  return worst;
}

export function serviceProviderEvidence(scraped = {}) {
  const { strong, body } = fields(scraped);
  const services = score(SERVICE_PATTERNS, strong, body);
  const prices = score(PRICE_PATTERNS, strong, body);
  const hasStreet = STREET_RE.test(strong) || STREET_RE.test(body);

  return {
    score: services.total + prices.total + (hasStreet ? 2 : 0),
    services: services.hits,
    prices: prices.hits,
    hasStreet
  };
}

export function assessNiche({ scraped = {}, niche = "" } = {}) {
  const { strong, body } = fields(scraped);

  const pathHit = pathSignals(scraped.website || scraped.url || "", niche);
  if (pathHit) {
    return { verdict: "reject", reason: pathHit, signals: [pathHit] };
  }

  const service = serviceProviderEvidence(scraped);

  const sector = conflictingSector(scraped, niche);
  if (sector) {
    return {
      verdict: "reject",
      reason: `Wrong industry: looks like ${sector.label || sector.key || "a different trade"}, not a ${clean(niche) || "local service"} provider`,
      signals: sector.hits
    };
  }

  const content = score(CONTENT_PATTERNS, strong, body);
  const education = score(EDUCATION_PATTERNS, strong, body);
  const directory = score(DIRECTORY_PATTERNS, strong, body);

  // Conclusive on their own: interactive tools and "what to ask your <trade>"
  // advice copy belong to an advice site, never to a business selling the
  // service. Aggregate scoring alone is too blunt for these.
  const tools = distinctTools(body);
  if (tools.length >= 3) {
    return {
      verdict: "reject",
      reason: `Advice/tools site (${tools.slice(0, 3).join(", ")}), not a business that provides the service`,
      signals: tools
    };
  }

  if (/\bknow what to (ask|tell|look for)\b/i.test(strong) || /\bknow what to (ask|tell|look for)\b/i.test(body)) {
    return {
      verdict: "reject",
      reason: "Advice content telling visitors what to ask a provider, not a provider itself",
      signals: ["know what to ask"]
    };
  }

  if (education.total >= REJECT_EDUCATION_SCORE) {
    return {
      verdict: "reject",
      reason: `School/academy content, not an operating ${clean(niche) || "local"} business`,
      signals: education.hits
    };
  }

  if (directory.total >= REJECT_DIRECTORY_SCORE) {
    return {
      verdict: "reject",
      reason: "Listing page that ranks other businesses, not a single business",
      signals: directory.hits
    };
  }

  if (content.total >= REJECT_CONTENT_SCORE && service.score < ACCEPT_SCORE) {
    return {
      verdict: "reject",
      reason: "Editorial/advice content site, not a business that provides the service",
      signals: content.hits
    };
  }

  if (service.score >= ACCEPT_SCORE) {
    return { verdict: "accept", reason: "", signals: service.services };
  }

  return {
    verdict: "unknown",
    reason: "",
    signals: [],
    scores: {
      service: service.score,
      content: content.total,
      directory: directory.total,
      education: education.total
    }
  };
}
