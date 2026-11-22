import * as cheerio from "cheerio";
import { expandRegion } from "./geo.js";
import { countryHint, countryNameFor } from "./apis/osm.js";

const MIN_SCORE = 20;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/*
  Turns a paid-search HTTP status into a plain reason for the diagnostics panel.

  Without this, every failure collapsed to "htmlLength: 0", so a job that failed
  because the account was out of credit looked identical to one where the engines
  were blocked - and the user was told "search engines were unreachable" when the
  real fix was to top up a plan. The status is recorded verbatim so billing and
  outage problems can be told apart at a glance.
*/
function engineStatusNote(engine, status) {
    if (!status) return `${engine} returned nothing`;
    if (status === 401 || status === 403) return `${engine} rejected the API key (HTTP ${status})`;
    if (status === 402) return `${engine} is out of credits (HTTP ${status})`;
    if (status === 429) return `${engine} is rate limited (HTTP ${status})`;
    if (status === 432) return `${engine} exceeded its plan usage limit (HTTP ${status})`;
    if (status === 404) return `${engine} endpoint not found (HTTP ${status})`;
    if (status >= 500) return `${engine} server error (HTTP ${status})`;
    return `${engine} returned HTTP ${status}`;
}

function bingUnwrap(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== "www.bing.com") return url;

        const raw = decodeURIComponent(parsed.searchParams.get("u") || "");
        if (!raw) return url;

        /*
          Bing now fronts the redirect param with an "a1" marker
          ("u=a1aHR0cHM6..."), while older pages sent the base64 alone. A legacy
          value always begins with "aH" (base64 of "http"), so a leading "a1"
          means the marker is present. Try the marker-stripped form first, then
          the raw value, so both spellings decode.
        */
        const candidates = raw.startsWith("a1") ? [raw.slice(2), raw] : [raw];

        for (const candidate of candidates) {
            const b64 = candidate.replace(/-/g, "+").replace(/_/g, "/");
            const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
            let str = Buffer.from(padded, "base64").toString("utf8");

            const marker = str.indexOf("http");
            if (marker > 0) str = str.slice(marker);

            if (/^https?:\/\//i.test(str)) return normalizeUrl(str);
        }
    } catch {}

    return url;
}

function normalizeUrl(url) {
    try {
        url = decodeURIComponent(url);
    } catch {}

    url = bingUnwrap(url);

    try {
        const u = new URL(url);

        for (const key of ["uddg", "u", "url", "r", "target"]) {
            const value = u.searchParams.get(key);
            if (value && /^https?:\/\//i.test(value)) {
                return normalizeUrl(value);
            }
        }

        if (!["http:", "https:"].includes(u.protocol)) return null;

        [
            "utm_source",
            "utm_medium",
            "utm_campaign",
            "utm_term",
            "utm_content",
            "fbclid",
            "gclid",
            "msclkid"
        ].forEach(k => u.searchParams.delete(k));

        u.hash = "";

        return u.href;
    } catch {
        return null;
    }
}

function getHost(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
        return "";
    }
}

function allEnginesBlocked(debug, query) {
    const entries = debug.filter(d => d.query === query);
    if (entries.length < 3) return false;
    return entries.every(d => d.htmlLength <= 8 && d.linksFound === 0);
}

const DIRECTORY_HOST_FRAGMENTS = [
    "threebestrated",
    "placedigger",
    "cybo",
    "cylex",
    "hotfrog",
    "yably",
    "find-us-here",
    "tuugo",
    "yell",
    "cityfos",
    "tupalo",
    "wheree",
    "europages",
    "kompass",
    "thomsonlocal",
    "nicelocal",
    "businessyab",
    "hoovers",
    "manta",
    "directory",
    "dentaquest",
    "mcnatx",
    "n49",
    "indiamart",
    "justdial",
    "sulekha",
    "bakili",
    "infobel",
    "kellysearch",
    "yelloyellow",
    "locanto",
    "shopandgo",
    "dunandbradstreet",
    "dnb",
    "zoominfo",
    "datanyze",
    "apollo",
    "lead411",
    "uswitch",
    "checkatrade",
    "trustatrader",
    "bark",
    "ratedpeople",
    "mybuilder",
    "homify",
    "trustedpros",
    "servicemagic",
    "angieslist",
    "porch",
    "homeadvisor",
    "fetchly",
    "elocal",
    "localbusinessguide",
    "brownbook",
    "ttmkt",
    "officina",
    "qualitybusinessdirectory",
    "yellow-listings",
    "merchantcircle",
    "superpages",
    "dexknows",
    "whitepages",
    "yellowmonkey",
    "qplaces",
    "top-rated",
    "topproducts",
    "expertise",
    "loc8nearme",
    "mystore411",
    "yellowbot",
    "allbiz",
    "expoza",
    "startshere",
    "vymaps",
    "wikimapia",
    "10best",
    "ezlocal",
    "fortunebuilders",
    "functionwell",
    "courtside",
    "merchantcircle",
    "superpages",
    "dexknows",
    "ycdirectory",
    "tupalo",
    "bizcommunity",
    "hotfrog",
    "brownbook",
    "plus.google",
    "goo.gl",
    "maps.google",
    "yelptraining",
    "foursquare",
    "citysearch",
    "kudzu",
    "spoke",
    "yelpcdn",
    "businessyab",
    "atlasglen",
    "porch",
    "buildzoom",
    "homewyse",
    "fixr",
    "craftsmans",
    "generalcontractor",
    "angieslist",
    "yelp",
    "searchbusiness",
    "topeverything",
    "topclean",
    "elocal",
    "cityfos",
    "wisesite",
    "ecryn",
    "knownacross",
    "xwhos",
    "india_list",
    "bizlistings",
    "find-us-here",
    "alexa",
    "similarweb",
    "cylex",
    "cybo",
    "agreatertown",
    "yelloyellow",
    "worldplaces",
    "yes114",
    "myrealestatemaster",
    "localis",
    "infobel",
    "europages",
    "kompass",
    "thomsonlocal",
    "kellysearch"
];

const DIRECTORY_TLD_FRAGMENTS = ["placedigger", "cybo", "cylex", "tuugo", "nicelocal", "threebestrated"];

const MARKETPLACE_HOST_FRAGMENTS = [
    "olx",
    "daraz",
    "alibaba",
    "aliexpress",
    "amazon",
    "ebay",
    "etsy",
    "craigslist",
    "offerup",
    "letgo",
    "mercari",
    "poshmark",
    "carousell",
    "vinted",
    "depop",
    "gumtree",
    "kijiji",
    "avito",
    "ebay-kleinanzeigen",
    "zameen",
    "pakwheels",
    "dubizzle",
    "99acres",
    "wayfair",
    "bestbuy",
    "overstock",
    "wish.com",
    "temu.com",
    "shein",
    "noon.com",
    "souq.com",
    "dhgate",
    "flipkart",
    "snapdeal",
    "meesho",
    "shopclues",
    "airbnb.com",
    "vrbo",
    "booking.com",
    "agoda.com",
    "expedia.com",
    // Service directories / booking marketplaces (they are not the business)
    "whatclinic",
    "zocdoc",
    "fresha",
    "healthgrades",
    "yelp.",
    "yellowpages",
    "thumbtack",
    "angi.com",
    "carewell",
    "bookingtime",
    "square-booking",
    "booksy",
    "vagaro",
    "mindbody",
    "gosq",
    "simplybook",
    "setmore",
    "acuityscheduling"
];

export function isMarketplaceHost(hostname) {
    return MARKETPLACE_HOST_FRAGMENTS.some(f => hostname.includes(f));
}

const NON_LOCAL_TITLE_PATTERNS = [
    /\bmarketplace\b/i,
    /classifieds?\b/i,
    /\bbuy (and|&) sell\b/i,
    /\blistings?\b/i,
    /\bdirectory\b/i,
    // Generic aggregator signals (niche-agnostic). These catch "listicle" and
    // comparison sites that advertise many businesses instead of being one.
    /\bthe best\b.{1,60}\b(in|near|across|around|of)\b/i,
    /\b(find|discover|browse|search for|compare)\b.{0,30}\bthe best\b/i,
    /\b(all|every|top|best)\b.{0,25}\b\d{2,}\s?k?\s?\+?\b/i,
    /\blist of\b/i,
    /\b\d+\s?k\+/i,
    /\bcheck (prices?|costs?|rates?|availability|reviews)\b/i,
    /\b(read|compare) \d+ (reviews|ratings|prices)\b/i,
    /\brated (and|by)\b.{0,20}\b(patients?|customers?|clients?)\b/i,
    // Trade bodies, associations and nonprofits (not a single practice)
    /\b(association|federation|guild|coalition|consortium)\b/i,
    /\b(american|national|state|regional|local) (dental|medical|health|barber\w*|hair|beauty) (association|federation)\b/i,
    // Payer / government-program portals (no bookable appointment). These are
    // matched only in a directory context: a real practice that says it accepts
    // Medicaid is still a real practice.
    /\b(medicaid|chip|medicare|managed care)\b.{0,40}\b(provider|providers|program|portal|member|members|enroll|eligibility|network)\b/i,
    /\b(provider|providers|directory|portal|member|enroll(ment)?|eligibility)\b.{0,40}\b(medicaid|chip|medicare|managed care)\b/i,
    /\b(medicaid|chip)\b.{0,20}\bprogram\b/i,
    // Job boards: they post openings, they are not the employer
    /\b(dental|medical|office|healthcare) (staff|jobs?|careers|openings)\b/i,
    /\b(rural|public|community|regional) (health|medical|care) (services?|clinic|clinics|network|authority)\b/i,
    // Location/locator index pages
    /\b(dental|medical|clinic|barber|hair|salon) locations?\b/i,
    /\bfind (shops|barbers|businesses|professionals|providers|companies|services|contractors|doctors|dentists|clinics) near\b/i,
    /\bnear (me|you)\b/i,
    /\bview (all )?(barbers|shops|businesses|listings)\b/i,
    /\bbest .{1,40}(in|of) .{1,30}\s20\d\d\b/i,
    /\b(list|top) (of )?the best\b/i,
    /\bhow to (apply|get|become)\b/i,
    /\brequirements, cost\b/i,
    /\byearly (fees|salary|cost)\b/i,
    /\bdepartment of (licensing|regulation|commerce|state|public services?)\b/i,
    /\btop \d+\b/i,
    /\btop [\w\s]{0,30}(in|of|across|near) [a-z]{3,}\b/i,
    /\bbrowse (local |all |top )?(business|professional|service|provider|listing|profile|shop|company|contractor|directory)/i,
    /\bfind (a|an|local) [\w-]{0,20} (near you|near me|in [a-z]{3,})/i,
    /\bprofiles?\b.*\b(book|review|rating|contact|service)/i,
    // People-search / contact-lookup pages (not businesses)
    /^to contact \w+ (send an email|try calling)/i,
    /\b(address (&|and) phone|phone (&|and) address)\b/i,
    /\bpeople (search|lookup)\b/i,
    /\bperson-search\b/i,
    /\b(email|phone|reverse phone) lookup\b/i,
    /\bpublic records\b/i,
    /\bhow to (contact|reach) (him|her|them|[a-z]+)\b/i,
    /\bfree (people|phone|address) (search|lookup)\b/i,
    // Barber/beauty schools and trade colleges (education, not a local shop)
    /\b(barber|hair|beauty|cosmetology|barbers) (school|college|academy|university|campus)\b/i,
    /\b(school|college|academy|university) of (barber|hair|beauty|cosmetology)\b/i,
    /\bhow to (become|be) a (licensed )?(barber|hairdresser|hairstylist|beautician)\b/i,
    /\b(state |national )?board of (barber|cosmetology)\b/i,
    // Licence / certification courses sold online
    /\b(license|licence) (renewal|renewal course|class|course|training)\b/i,
    /\b(renew|renewal) your (barber|hair|beauty|cosmetology) license\b/i,
    /\bcontinuing education\b.{0,40}\b(barber|hair|beauty|cosmetology)\b/i,
    /\b(barber|hair|beauty|cosmetology)\b.{0,40}\bcontinuing education\b/i,
    /\b(barber|hair|beauty|cosmetology)\b.{0,30}\b(certif|certificate|certification)\b/i,
    /\b(barber|hair|beauty|cosmetology) (ce|c\.e\.) (course|class|hours)\b/i,
    /\b(hours|course|class|training) (for|in) .{0,20}(barber|cosmetology) (license|renewal)\b/i,
    /\b(certif|certification|certificate) (course|class|program|renewal)\b/i,
    /\b\d+\s?hour (barber|hair|beauty|cosmetology)\b/i,
    /\b(online|correspondence) (barber|hair|beauty) school\b/i
];

export function hasNonLocalTitle(title = "") {
    const t = String(title || "");
    if (!t.trim()) return false;
    return NON_LOCAL_TITLE_PATTERNS.some(r => r.test(t));
}

export function looksLikeDirectory(hostname) {
    return DIRECTORY_HOST_FRAGMENTS.some(f => hostname.includes(f));
}

export function isBadDomain(hostname) {
    if (isMarketplaceHost(hostname)) return true;

    const h = String(hostname).toLowerCase();
    if (h.endsWith(".gov") || h.endsWith(".gov.uk") || h.endsWith(".edu") ||
        h.includes(".gov.") || h.includes(".edu.")) return true;

    const bad = [
        "facebook.com",
        "instagram.com",
        "linkedin.com",
        "youtube.com",
        "tiktok.com",
        "x.com",
        "twitter.com",
        "pinterest.com",
        "google.com",
        "bing.com",
        "cc.bingj.com",
        "mojeek.com",
        "ecosia.org",
        "startpage.com",
        "qwant.com",
        "aol.com",
        "ask.com",
        "dogpile.com",
        "yandex.com",
        "searx.be",
        "search.marginalia.nu",
        "search.brave.com",
        "duckduckgo.com",
        "yahoo.com",
        "wikipedia.org",
        "reddit.com",
        "quora.com",
        "yelp.com",
        "yellowpages.com",
        "bbb.org",
        "angi.com",
        "thumbtack.com",
        "mapquest.com",
        "chamberofcommerce.com",
        "barbershops.net",
        "github.com",
        "indeed.com",
        "glassdoor.com",
        "homedepot.com",
        "lowes.com",
        "amazon.com",
        "convertio.co",
        "gamesradar.com",
        "ign.com",
        "polygon.com",
        "kotaku.com",
        "spotify.com",
        "apple.com",
        "microsoft.com",
        "newsweek.com",
        "forbes.com",
        "businessinsider.com",
        "cnet.com",
        "theverge.com",
        "wired.com",
        "techcrunch.com",
        "crunchbase.com",
        "hubspot.com",
        "zillow.com",
        "realtor.com",
        "cars.com",
        "autotrader.com",
        "healthgrades.com",
        "ratemds.com",
        "webmd.com",
        "nextdoor.com",
        "angieslist.com",
        "porch.com",
        "thumbtack.com",
        "homeadvisor.com",
        "houzz.com",
        "tripadvisor.com",
        "sitejabber.com",
        "gofundme.com",
        "kickstarter.com",
        "indiegogo.com",
        "etsy.com",
        "ebay.com",
        "walmart.com",
        "target.com",
        "pornhub.com",
        "xhvister.com",
        "xhamster.com",
        "xnxx.com",
        "xvideos.com",
        "redtube.com",
        "youporn.com",
        "onlyfans.com",
        "picsart.com",
        "vimeo.com",
        "twitch.tv",
        "spotify.com",
        "soundcloud.com",
        "bandcamp.com",
        "dailymotion.com",
        "metacafe.com",
        "dailymail.co.uk",
        "cnn.com",
        "bbc.com",
        "bbc.co.uk",
        "nbcnews.com",
        "foxnews.com",
        "cbsnews.com",
        "abcnews.com",
        "wsj.com",
        "nytimes.com",
        "washingtonpost.com",
        "googleusercontent.com",
        "cloudfront.net",
        "amazonaws.com",
        "azureedge.net",
        "akamaized.net",
        "stackoverflow.com",
        "medium.com",
        "substack.com",
        "patreon.com",
        "eventbrite.com",
        "meetup.com",
        "openai.com",
        "chatgpt.com",
        "statista.com",
        "similarweb.com",
        "semrush.com",
        "upwork.com",
        "fiverr.com",
        "freelancer.com",
        "maps.google.com",
        "goo.gl",
        "bit.ly",
        "tinyurl.com",
        "archive.org",
        "waybackmachine.org",
        // People-search / data brokers / contact-lookup sites are never a business lead.
        "411.com",
        "contactout.com",
        "signalhire.com",
        "rocketreach.co",
        "lead411.com",
        "pipl.com",
        "beenverified.com",
        "fastpeoplesearch.com",
        "truepeoplesearch.com",
        "myLife.com",
        "nuwber.com",
        "usphonebook.com",
        "thatswhats.com",
        "instantcheck.com",
        "clustrmaps.com",
        "idcrawl.com",
        "radaris.com",
        "checkpeople.com",
        "peoplelegacy.com",
        "datarocket.com",
        "peekyou.com",
        "reunion.com",
        "classmates.com",
        "veripages.com",
        "thatnumber.com",
        "tellows.com",
        "spokeo.com",
        "loccit.com",
        "numlookup.com",
        "sync.me",
        "emailondeck.com",
        "hunter.io",
        "clearbit.com",
        "apollo.io",
        "seamless.ai",
        "b2bcontact.com",
        "companyinfobase.com",
        "buzzfile.com",
        "growjo.com",
        "lead442.com",
        "marketlead.io",
        "reply.io",
        "mailshake.com",
        "lemlist.com",
        "woodpecker.co",
        "instantly.ai",
        "smartlead.ai",
        "regie.ai",
        "krisp.ai",
        "listsend.com",
        "mailsend.com",
        "convertkit.com",
        "klaviyo.com",
        "beehiiv.com",
        "ghost.io",
        "buttondown.email"
    ];

    const academicJunk = [
        "academia.edu",
        "ovid.com",
        "dokumen.pub",
        "researchgate.net",
        "scholarworks.",
        "digitalcommons.",
        "journals.sagepub.com",
        "uknowledge.uky.edu",
        "zhihu.com",
        "mastodon.social",
        "buttondown.email",
        "w3.org",
        "schemas.live.com",
        "storage.live.com",
        "youtubekids.com",
        "cookidoo.thermomix.com",
        "vorwerk.com"
    ];

    const junkFragment = [
        "porn",
        "xxx",
        "sex",
        "escort",
        "hentai",
        "onlyfans",
        "cam",
        "webcam",
        "dating",
        "tinder",
        "streaming",
        "torrent",
        "pirate"
    ];

    if (academicJunk.some(f => hostname.includes(f))) return true;

    if (junkFragment.some(f => hostname.includes(f))) return true;

    return bad.some(d => hostname === d || hostname.endsWith("." + d));
}
// function isForeignDomainForUS(hostname = "") {
//   const h = String(hostname).toLowerCase();

//   const foreignTlds = [
//     ".pk",
//     ".in",
//     ".bd",
//     ".lk",
//     ".np",
//     ".ae",
//     ".sa",
//     ".qa",
//     ".uk",
//     ".au",
//     ".ca",
//     ".de",
//     ".fr"
//   ];

//   return foreignTlds.some(tld => h.endsWith(tld));
// }
const CC_TLDS = new Set([
    "ac", "ad", "ae", "af", "ag", "ai", "al", "am", "ao", "aq", "ar", "as", "at", "au", "aw",
    "ax", "az", "ba", "bb", "bd", "be", "bf", "bg", "bh", "bi", "bj", "bl", "bm", "bn", "bo",
    "bq", "br", "bs", "bt", "bv", "bw", "by", "bz", "ca", "cc", "cd", "cf", "cg", "ch", "ci",
    "ck", "cl", "cm", "cn", "co", "cr", "cu", "cv", "cw", "cx", "cy", "cz", "de", "dj", "dk",
    "dm", "do", "dz", "ec", "ee", "eg", "eh", "er", "es", "et", "eu", "fi", "fj", "fk", "fm",
    "fo", "fr", "ga", "gb", "gd", "ge", "gf", "gg", "gh", "gi", "gl", "gm", "gn", "gp", "gq",
    "gr", "gs", "gt", "gu", "gw", "gy", "hk", "hm", "hn", "hr", "ht", "hu", "id", "ie", "il",
    "im", "in", "io", "iq", "ir", "is", "it", "je", "jm", "jo", "jp", "ke", "kg", "kh", "ki",
    "km", "kn", "kp", "kr", "kw", "ky", "kz", "la", "lb", "lc", "li", "lk", "lr", "ls", "lt",
    "lu", "lv", "ly", "ma", "mc", "md", "me", "mf", "mg", "mh", "mk", "ml", "mm", "mn", "mo",
    "mp", "mq", "mr", "ms", "mt", "mu", "mv", "mw", "mx", "my", "mz", "na", "nc", "ne", "nf",
    "ng", "ni", "nl", "no", "np", "nr", "nu", "nz", "om", "pa", "pe", "pf", "pg", "ph", "pk",
    "pl", "pm", "pn", "pr", "ps", "pt", "pw", "py", "qa", "re", "ro", "rs", "ru", "rw", "sa",
    "sb", "sc", "sd", "se", "sg", "sh", "si", "sj", "sk", "sl", "sm", "sn", "so", "sr", "ss",
    "st", "su", "sv", "sx", "sy", "sz", "tc", "td", "tf", "tg", "th", "tj", "tk", "tl", "tm",
    "tn", "to", "tr", "tt", "tv", "tw", "tz", "ua", "ug", "uk", "us", "uy", "uz", "va", "vc",
    "ve", "vg", "vi", "vn", "vu", "wf", "ws", "ye", "yt", "za", "zm", "zw"
]);

function ownCcTlds(countryCode = "") {
    const country = (countryCode || "US").toUpperCase();
    if (country === "US") return new Set(["us"]);
    if (country === "GB") return new Set(["uk", "gb"]);
    if (country === "AU") return new Set(["au"]);
    if (country === "CA") return new Set(["ca"]);
    if (country === "IN") return new Set(["in"]);
    if (country === "DE") return new Set(["de"]);
    if (country === "FR") return new Set(["fr"]);
    if (country === "ES") return new Set(["es"]);
    if (country === "IT") return new Set(["it"]);
    if (country === "AE") return new Set(["ae"]);
    return new Set();
}

function isForeignDomainForCountry(hostname = "") {
    const h = String(hostname).toLowerCase();
    const m = h.match(/\.([a-z]{2})$/) || h.match(/^([a-z]{2})$/);
    if (!m) return false;

    const tld = m[1];
    if (!CC_TLDS.has(tld)) return false;

    const own = ownCcTlds(process.env.DEFAULT_COUNTRY || "US");
    return !own.has(tld);
}

function looksLikeBusinessWebsite(url) {
    const hostname = getHost(url);
    if (!hostname || isBadDomain(hostname)) return false;
    if (looksLikeDirectory(hostname)) return false;

    /*
      Country TLDs are deliberately not filtered here.

      This used to drop any domain whose ccTLD was not the DEFAULT_COUNTRY, so a
      search for a New Zealand or Portuguese business threw away every genuine
      result the search APIs returned: .co.nz and .pt both went straight into
      the bin, and the run reported zero leads while holding real candidates.

      Guessing relevance from a TLD is also unreliable in the other direction,
      since most small businesses use .com. The address-based area gate in the
      verifier is authoritative and runs later on the scraped page, which is a
      far stronger signal than the domain suffix.
    */

    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();

    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|xml|mp4|mp3|doc|docx|xls|xlsx)$/i.test(path)) {
        return false;
    }

    if (path.includes("/search")) return false;
    if (path.includes("/maps")) return false;
    if (path.includes("/login")) return false;
    if (path.includes("/account")) return false;

    return true;
}

function scoreUrl(url, title = "", niche = "", location = "") {
    let score = 0;

    const hostname = getHost(url);
    const full = `${url} ${title}`.toLowerCase();
    if (hasNonLocalTitle(title)) score -= 500;

    const nicheWords = niche.toLowerCase().split(/\s+/).filter(Boolean);
    const locationWords = location.toLowerCase().split(/\s+/).filter(Boolean);

    function wordStems(word) {
        const stems = new Set([word]);

        if (word.length > 4 && word.endsWith("ies")) {
            stems.add(word.slice(0, -3) + "y");
        } else if (word.length > 3 && word.endsWith("es")) {
            stems.add(word.slice(0, -2));
        } else if (word.length > 3 && word.endsWith("s")) {
            stems.add(word.slice(0, -1));
        }

        return [...stems].filter(Boolean);
    }

    for (const word of nicheWords) {
        if (word.length <= 2) continue;

        if (wordStems(word).some(stem => full.includes(stem))) score += 20;
    }

    for (const word of locationWords) {
        if (word.length > 2 && full.includes(word)) score += 10;
    }

    const nicheText = niche.toLowerCase();

    if (nicheText.includes("plumb")) {
        if (hostname.includes("plumb")) score += 25;
        if (hostname.includes("drain")) score += 10;
        if (hostname.includes("sewer")) score += 10;
        if (hostname.includes("water heater")) score += 10;
        if (hostname.includes("rooter")) score += 10;
    }

    if (nicheText.includes("mechanic") || nicheText.includes("auto") || nicheText.includes("car")) {
        if (hostname.includes("auto")) score += 25;
        if (hostname.includes("mechanic")) score += 25;
        if (hostname.includes("repair")) score += 15;
        if (hostname.includes("garage")) score += 15;
        if (hostname.includes("tire")) score += 10;
        if (hostname.includes("body shop")) score += 10;
        if (hostname.includes("detail")) score += 10;
    }

    if (nicheText.includes("electric")) {
        if (hostname.includes("electric")) score += 25;
        if (hostname.includes("electrical")) score += 25;
    }

    if (nicheText.includes("cleaning")) {
        if (hostname.includes("clean")) score += 25;
        if (hostname.includes("maid")) score += 20;
        if (hostname.includes("janitor")) score += 20;
    }

    if (nicheText.includes("cafe") || nicheText.includes("restaurant")) {
        if (hostname.includes("cafe")) score += 25;
        if (hostname.includes("restaurant")) score += 25;
        if (hostname.includes("grill")) score += 15;
        if (hostname.includes("kitchen")) score += 15;
    }

    if (nicheText.includes("roof")) {
        if (hostname.includes("roof")) score += 25;
    }

    if (nicheText.includes("landscap")) {
        if (hostname.includes("landscap")) score += 25;
        if (hostname.includes("lawn")) score += 20;
        if (hostname.includes("garden")) score += 15;
    }

    if (nicheText.includes("hvac")) {
        if (hostname.includes("hvac")) score += 25;
        if (hostname.includes("heating")) score += 15;
        if (hostname.includes("cooling")) score += 15;
        if (hostname.includes("air conditioning")) score += 20;
    }

    if (nicheText.includes("hair") || nicheText.includes("salon") || nicheText.includes("saloon")) {
        if (hostname.includes("salon") || hostname.includes("saloon")) score += 25;
        if (hostname.includes("hair")) score += 20;
        if (hostname.includes("beauty")) score += 15;
    }

    if (nicheText.includes("solar")) {
        if (hostname.includes("solar")) score += 25;
        if (hostname.includes("sun")) score += 15;
        if (hostname.includes("energy")) score += 15;
        if (hostname.includes("panel")) score += 10;
        if (hostname.includes("electric")) score += 10;
    }

    if (nicheText.includes("dent")) {
        if (hostname.includes("dent")) score += 25;
        if (hostname.includes("dental")) score += 25;
    }

    if (nicheText.includes("paint")) {
        if (hostname.includes("paint")) score += 25;
        if (hostname.includes("painting")) score += 25;
    }

    if (nicheText.includes("pest")) {
        if (hostname.includes("pest")) score += 25;
        if (hostname.includes("exterminat")) score += 20;
        if (hostname.includes("termite")) score += 15;
    }

    if (nicheText.includes("pool")) {
        if (hostname.includes("pool")) score += 25;
        if (hostname.includes("swimming")) score += 20;
    }

    if (nicheText.includes("law") || nicheText.includes("attorney") || nicheText.includes("lawyer")) {
        if (hostname.includes("law")) score += 25;
        if (hostname.includes("attorney")) score += 25;
        if (hostname.includes("lawyer")) score += 25;
        if (hostname.includes("legal")) score += 20;
    }

    if (hostname.includes("service")) score += 10;
    if (hostname.includes("repair")) score += 10;
    if (hostname.includes("hvac")) score += 5;

    if (url.includes("/contact")) score += 8;
    if (url.includes("/about")) score += 5;

    if (hostname.split(".")[0].length <= 25) score += 5;

    return score;
}

function extractLinksFromHtml(html, baseUrl, niche, location) {
    const $ = cheerio.load(html);
    const links = [];

    const pageText = html.toLowerCase();

    if (pageText.startsWith("ratelimited_page")) return links;
    if (/anomaly/i.test(pageText) && html.length < 20000) return links;
    if (/welcome to duckduckgo|challenge-platform|cf-browser-verification/i.test(pageText)) return links;

    $("a").each((_, el) => {
        let href = $(el).attr("href") || "";
        const title = $(el).text().replace(/\s+/g, " ").trim();

        if (!href) return;

        if (href.startsWith("//")) href = "https:" + href;

        if (href.startsWith("/")) {
            try {
                href = new URL(href, baseUrl).href;
            } catch {}
        }

        const clean = normalizeUrl(href);
        if (!clean || !looksLikeBusinessWebsite(clean)) return;

        links.push({
            title: title || getHost(clean),
            url: clean,
            snippet: "",
            hostname: getHost(clean),
            score: scoreUrl(clean, title, niche, location)
        });
    });

    const rawLinks = html.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];

    for (const raw of rawLinks) {
        const clean = normalizeUrl(raw.replace(/&amp;/g, "&"));

        if (!clean || !looksLikeBusinessWebsite(clean)) continue;

        links.push({
            title: getHost(clean),
            url: clean,
            snippet: "",
            hostname: getHost(clean),
            score: scoreUrl(clean, "", niche, location)
        });
    }

    return links;
}

async function fetchSearchPage(url) {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        try {
            const res = await fetch(url, {
                signal: ctrl.signal,
                headers: {
                    "user-agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
                    accept:
                        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                }
            });
            if (res.status === 429 || res.status === 403) return "RATELIMITED_PAGE╳";
            return await res.text();
        } finally {
            clearTimeout(t);
        }
    } catch {
        return "";
    }
}

async function searchEngine(engineName, url, niche, location) {
    const html = await fetchSearchPage(url);

    const links = extractLinksFromHtml(html, url, niche, location);

    return {
        engine: engineName,
        htmlLength: html.length,
        // Kept so the caller can tell a real result page from a block page that
        // happens to be a large document, such as Mojeek's captcha.
        rawHtml: html,
        links
    };
}

function keyList(raw) {
    return String(raw || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
}

/*
  Tiered key pools: *_API_KEYS_PAID is reserved for paid accounts and is never
  read on a free search, while free accounts only ever see the shared pool.
  The fallback runs the other way on purpose - if no paid pool is configured a
  paid account still gets search, but a free account must never reach a paid key.
*/
export function firecrawlKeys(paid = false) {
    if (paid) {
        const paidKeys = keyList(process.env.FIRECRAWL_API_KEYS_PAID);
        if (paidKeys.length) return paidKeys;
    }
    return keyList(process.env.FIRECRAWL_API_KEYS || process.env.FIRECRAWL_API_KEY);
}

export function hasFirecrawl(paid = false) {
    return firecrawlKeys(paid).length > 0;
}

let firecrawlKeyIndex = 0;

function nextFirecrawlKey(paid = false) {
    const keys = firecrawlKeys(paid);
    if (!keys.length) return "";
    const key = keys[firecrawlKeyIndex % keys.length];
    firecrawlKeyIndex += 1;
    return key;
}

/*
  Blocked-page detection for the scraped engines.

  A length check is not enough. Mojeek answers a blocked request with a real
  200 and a full <title>Captcha</title> page of about 5.5 KB, so counting bytes
  alone treats it as a healthy response and keeps paying for it.
*/
function looksBlockedPage(html = "") {
    if (!html) return true;

    const head = html.slice(0, 6000).toLowerCase();

    if (html.startsWith("RATELIMITED_PAGE")) return true;
    if (head.includes("<title>captcha</title>")) return true;
    if (/just a moment|checking your browser|enable javascript and cookies|verify you are human|unusual traffic|access denied|attention required/.test(head)) return true;

    return false;
}

/*
  Engines that keep answering with a block page are set aside for a cooldown
  window. Without this the seven dead engines consume the entire search deadline
  on every query variant, and the paid APIs that actually return candidates are
  never reached.

  The set-aside used to be permanent for the life of the process. That is right
  while a query burst is in flight, but wrong for a long-lived worker: a shared
  IP gets throttled by DuckDuckGo or Bing for a few minutes, the engine collects
  its two strikes, and it is then skipped for every later job until the process
  restarts. A single throttled spell therefore retired the one free source that
  still surfaced real local businesses. The strike now carries an expiry so the
  engine is retried once the cooldown passes instead of being dropped forever.
*/
const blockedEngineStrikes = new Map();
const MAX_ENGINE_STRIKES = 2;
const ENGINE_COOLDOWN_MS = Math.max(1000, Number(process.env.ENGINE_COOLDOWN_MS || 5 * 60 * 1000));

/*
  This answers "should we bother querying this engine", so it may only look at
  the strike history.

  It used to also inspect the html argument, and the only caller passed an
  empty string. Empty html reads as blocked, so every scraped engine was
  excluded from the first query onwards: the circuit breaker never armed, the
  strikes never accumulated, and the free engines were reported as "skipped"
  rather than "dead".
*/
function engineIsUsable(engineName) {
    const state = blockedEngineStrikes.get(engineName);
    if (!state) return true;
    if (state.strikes < MAX_ENGINE_STRIKES) return true;

    // Cooldown elapsed: clear the strikes and let the engine be tried again
    // rather than retiring it for the life of the process.
    if (Date.now() >= state.until) {
        blockedEngineStrikes.delete(engineName);
        return true;
    }

    return false;
}

function noteEngineResult(engineName, html) {
    const state = blockedEngineStrikes.get(engineName) || { strikes: 0, until: 0 };

    if (looksBlockedPage(html)) {
        state.strikes += 1;
        if (state.strikes >= MAX_ENGINE_STRIKES) {
            state.until = Date.now() + ENGINE_COOLDOWN_MS;
        }
        blockedEngineStrikes.set(engineName, state);
    } else if (html && html.length > 500) {
        blockedEngineStrikes.delete(engineName);
    }
}

export function tavilyKeys(paid = false) {
    if (paid) {
        const paidKeys = keyList(process.env.TAVILY_API_KEYS_PAID);
        if (paidKeys.length) return paidKeys;
    }
    return keyList(process.env.TAVILY_API_KEYS || process.env.TAVILY_API_KEY);
}

let tavilyKeyIndex = 0;

/*
  Rotate Tavily keys for the same reason Firecrawl rotates.

  A dev key carries a monthly credit that a single job can exhaust, and once it
  is spent every later query returns HTTP 429 and the search silently degrades to
  whatever the scraped engines can find. Rotating spreads the load across every
  configured key, and a single shared TAVILY_API_KEY keeps working exactly as
  before.
*/
function nextTavilyKey(paid = false) {
    const keys = tavilyKeys(paid);
    if (!keys.length) return "";
    const key = keys[tavilyKeyIndex % keys.length];
    tavilyKeyIndex += 1;
    return key;
}

async function searchEngineFromTavily(query, niche, location, paid = false) {
    const key = nextTavilyKey(paid);
    if (!key) return { engine: "tavily-api", htmlLength: 0, links: [] };

    /*
      Country preference for a local search.

      Leaving it unset defaults Tavily to this host's French vantage point, which
      is how a UK job got French and directory results back. The job's location
      resolves to a real country name ("united kingdom") and takes precedence
      over TAVILY_COUNTRY, which stays only as an operator override for jobs
      whose location text names no country.

      Tavily rejects an unknown value with HTTP 400 rather than ignoring it, and
      a 400 here used to cost the whole fallback - so a boost is always a bonus:
      on 400 the exact same query is retried without the country instead of
      letting one bad mapping lose the paid source.
    */
    const configuredCountry = String(process.env.TAVILY_COUNTRY || "").trim();
    const country = countryNameFor(countryHint(location))
        || (configuredCountry && configuredCountry.toLowerCase() !== "auto" ? configuredCountry : "");

    const buildBody = (withCountry) => {
        const body = {
            query,
            max_results: Number(process.env.TAVILY_MAX_RESULTS || 20),
            search_depth: "basic",
            include_answer: false,
            include_raw_content: false,
            include_images: false
        };

        if (withCountry && country) body.country = country;

        return body;
    };

    let res;
    let json;

    try {
        /*
          A hard timeout is not optional here. This fetch had none, so one
          stalled connection from Tavily blocked the whole search pass forever:
          the job's deadline is only checked between calls, never during one.
          That is how searches sat in "searching" for hours with zero results
          and no further progress.
        */
        const send = async (withCountry) => {
            const r = await fetch("https://api.tavily.com/search", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${key}`
                },
                body: JSON.stringify(buildBody(withCountry)),
                signal: AbortSignal.timeout(Number(process.env.TAVILY_TIMEOUT_MS || 25000))
            });

            return { r, bodyJson: r.status === 200 ? await r.json().catch(() => null) : null };
        };

        let attempt = await send(true);

        if (attempt.r.status === 400 && country) {
            attempt = await send(false);
        }

        res = attempt.r;

        if (res.status !== 200) {
            return {
                engine: "tavily-api",
                htmlLength: 0,
                links: [],
                quotaState: res.status,
                status: res.status,
                note: engineStatusNote("Tavily", res.status)
            };
        }

        json = attempt.bodyJson;
    } catch {
        return {
            engine: "tavily-api",
            htmlLength: 0,
            links: [],
            note: "Tavily request failed or timed out"
        };
    }

    const items = (json && Array.isArray(json.results)) ? json.results : [];

    const links = [];

    for (const item of items.slice(0, 25)) {
        const rawUrl = item.url || "";
        if (!rawUrl) continue;

        const clean = normalizeUrl(rawUrl);
        if (!clean || !looksLikeBusinessWebsite(clean)) continue;

        const title = (item.title || "").replace(/\s+/g, " ").trim() || getHost(clean);

        links.push({
            title,
            url: clean,
            hostname: getHost(clean),
            score: scoreUrl(clean, title, niche, location)
        });
    }

    return {
        engine: "tavily-api",
        htmlLength: items.length > 0 ? 1000 : 0,
        links
    };
}

/*
  Firecrawl bills per requested result, so a high limit is rejected outright with
  HTTP 402 "Insufficient credits" while a smaller limit on the same key
  succeeds. Verified on the production key: limit=20 -> 402, limit=10 -> 10
  results, limit=5 -> 5 results.

  Requesting FIRECRAWL_SEARCH_LIMIT=20 therefore discarded the only search engine
  that still had credit, and because every other source was also dead (Tavily
  over quota, Places key not permitted, Overpass blocked) the job completed with
  zero leads. Walking the limit down turns a hard failure into partial results.
*/
const FIRECRAWL_LIMIT_LADDER = [20, 10, 6, 3];

async function searchEngineFromFirecrawl(query, niche, location, paid = false) {
    const key = nextFirecrawlKey(paid);
    if (!key) return { engine: "firecrawl-api", htmlLength: 0, links: [] };

    const configured = Number(process.env.FIRECRAWL_SEARCH_LIMIT || 10);
    const ladder = [...new Set([configured, ...FIRECRAWL_LIMIT_LADDER])]
        .filter(n => Number.isFinite(n) && n > 0)
        .sort((a, b) => b - a);

    let json = null;
    let lastStatus = 0;
    let rateLimited = false;

    for (const limit of ladder) {
        let res;
        try {
            // Same stall risk as Tavily: without a timeout one hung connection
            // freezes the search pass indefinitely, and the pass deadline is
            // only consulted between calls.
            res = await fetch("https://api.firecrawl.dev/v2/search", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${key}`
                },
                body: JSON.stringify({ query, limit }),
                signal: AbortSignal.timeout(Number(process.env.FIRECRAWL_TIMEOUT_MS || 40000))
            });
        } catch {
            break;
        }

        lastStatus = res.status;

        if (res.status === 200) {
            json = await res.json();
            break;
        }

        /*
          402 is a credit answer and 429 is a rate answer, and they need opposite
          handling. Retrying a 429 immediately just consumes another slot in the
          same exhausted minute and locks the key out for longer, so back off
          first. An auth or server fault will not change with the limit at all,
          so stop immediately.
        */
        if (res.status === 429) {
            rateLimited = true;
            await new Promise(resolve => setTimeout(resolve, 1500));
            continue;
        }

        if (res.status !== 402) break;
    }

    if (!json) {
        return {
            engine: "firecrawl-api",
            htmlLength: 0,
            links: [],
            quotaState: lastStatus,
            rateLimited,
            status: lastStatus,
            note: lastStatus
                ? engineStatusNote("Firecrawl", lastStatus)
                : "Firecrawl request failed or timed out"
        };
    }

    /*
      Firecrawl v2 groups results by source: data is { web: [...], news: [...] },
      where v1 returned a flat array. Calling .slice() on the v2 object threw and
      took the whole fallback with it, so both shapes are flattened here.
    */
    const payload = json && json.success === false ? null : (json && json.data);
    const data = Array.isArray(payload)
        ? payload
        : (payload && typeof payload === "object"
            ? Object.values(payload).flat().filter(item => item && typeof item === "object")
            : []);

    const links = [];

    for (const item of data.slice(0, 12)) {
        const rawUrl = item.url || "";
        if (!rawUrl) continue;

        const clean = normalizeUrl(rawUrl);
        if (!clean || !looksLikeBusinessWebsite(clean)) continue;

        const title = (item.title || "").replace(/\s+/g, " ").trim() || getHost(clean);

        links.push({
            title,
            url: clean,
            hostname: getHost(clean),
            score: scoreUrl(clean, title, niche, location)
        });
    }

    return {
        engine: "firecrawl-api",
        htmlLength: data.length > 0 ? 1000 : 0,
        links
    };
}

/*
  SearXNG: a metasearch instance we run ourselves in Docker on this same host.
  It aggregates Google/Bing/DuckDuckGo and ~70 other engines behind one local
  JSON endpoint, so it carries no API key, no monthly credit and no billable
  quota - the three things that emptied Tavily and Firecrawl and left the jobs
  at zero leads.

  It is wired in ahead of the paid APIs because it cannot run out of money:
  when it returns enough candidates the paid calls for that query are simply
  never made, which is the credit-conservation behaviour the old zero-gate had
  (it just applied it to the wrong, weaker engines). When it finds little, the
  paid engines still run in the same query exactly as before, so its quality
  can only add supply, never remove it.

  SEARXNG_URL=off opts out entirely; a dead container costs two fast
  connection-refused failures and then the standard cooldown, not a hang.
*/
function searxngUrl() {
    const configured = String(process.env.SEARXNG_URL ?? "http://127.0.0.1:8888").trim();
    if (!configured || configured === "off" || configured === "0") return "";
    return configured.replace(/\/+$/, "");
}

/*
  Where SearXNG sits in the pass.

  This container's only upstream engine is Bing, so everything it relays is a
  result Bing answers directly - plus the relays come from a French vantage
  point, which is how a UK job queued French directories ahead of the direct
  Bing call (25-27 links/query, healthy on every one of the 25 jobs audited).
  Asking it for a language or a market changes nothing: both were measured
  against the live instance and it ignored them or answered with zero results.

  "first"     - the original order, relay before everything else
  "fallback"  - the default: LangSearch and the direct engines lead, SearXNG is
                only reached from the escalation ladder when the main pass came
                up short, so its country can no longer occupy the front of the
                queue while a healthy engine sits behind it
  "off"       - never called
*/
function searxngMode() {
    const mode = String(process.env.SEARXNG_MODE || "fallback").trim().toLowerCase();
    return mode === "first" || mode === "off" ? mode : "fallback";
}

async function searchEngineFromSearxng(query, niche, location) {
    const base = searxngUrl();
    if (!base) return { engine: "searxng", htmlLength: 0, links: [] };

    let json;

    try {
        const params = new URLSearchParams({ q: query, format: "json", safesearch: "0" });
        const res = await fetch(`${base}/search?${params}`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(Number(process.env.SEARXNG_TIMEOUT_MS || 4000))
        });

        if (res.status !== 200) {
            noteEngineResult("searxng", "");
            return {
                engine: "searxng",
                htmlLength: 0,
                links: [],
                status: res.status,
                note: engineStatusNote("SearXNG", res.status)
            };
        }

        json = await res.json();
    } catch {
        noteEngineResult("searxng", "");
        return {
            engine: "searxng",
            htmlLength: 0,
            links: [],
            note: "SearXNG request failed or timed out (is the Docker container running?)"
        };
    }

    const items = (json && Array.isArray(json.results)) ? json.results : [];
    const payload = JSON.stringify(json) || "";

    // A healthy answer clears any cooldown; an empty one changes nothing, so a
    // container that is up but returning nothing never poisons the strikes.
    noteEngineResult("searxng", payload);

    const links = [];

    for (const item of items.slice(0, 30)) {
        const rawUrl = item.url || "";
        if (!rawUrl) continue;

        const clean = normalizeUrl(rawUrl);
        if (!clean || !looksLikeBusinessWebsite(clean)) continue;

        const title = (item.title || "").replace(/\s+/g, " ").trim() || getHost(clean);
        const snippet = (item.content || "").replace(/\s+/g, " ").trim();

        links.push({
            title,
            url: clean,
            snippet,
            hostname: getHost(clean),
            score: scoreUrl(clean, title, niche, location)
        });
    }

    return {
        engine: "searxng",
        htmlLength: items.length > 0 ? Math.max(payload.length, 600) : 0,
        links
    };
}

/*
  LangSearch: a free hosted web-search API (api.langsearch.com/v1/web-search).
  It is the second free layer, sitting just behind the self-hosted SearXNG.

  SearXNG is unlimited but its upstream engines can throttle this host's IP;
  LangSearch answers over HTTPS from its own index, so it covers exactly that
  window. It is free-tier and token-metered rather than unlimited, which is why
  it runs behind SearXNG and ahead of the paid APIs: it spends no money, and
  when it does run dry the standard strike/cooldown breaker stops it costing the
  pass anything but one failed call.

  LANGSEARCH_API_KEY enables it; without a key it is skipped entirely, so an
  install that never sets one behaves exactly as before.
*/
function langsearchKey() {
    const key = String(process.env.LANGSEARCH_API_KEY || "").trim();
    if (!key || key === "off" || key === "0") return "";
    return key;
}

/*
  The primary key is LANGSEARCH_API_KEY; LANGSEARCH_API_KEYS (comma-separated)
  adds spares. LangSearch returns a transient HTTP 502 on roughly one call in
  five, so a single key loses that whole query. With spares the retry below
  rotates to the next key instead of dropping the query.
*/
function langsearchKeys() {
    const keys = [];
    const primary = langsearchKey();
    if (primary) keys.push(primary);

    for (const part of String(process.env.LANGSEARCH_API_KEYS || "").split(",")) {
        const key = part.trim();
        if (!key || key === "off" || key === "0") continue;
        if (!keys.includes(key)) keys.push(key);
    }

    return keys;
}

async function searchEngineFromLangSearch(query, niche, location) {
    const keys = langsearchKeys();
    if (!keys.length) return { engine: "langsearch", htmlLength: 0, links: [] };

    let status = 0;
    let json = null;

    // A transient 5xx (LangSearch emits them, ~1 call in 5) is retried on the
    // next key so one blip cannot drop the query; 4xx is our fault, so it stops.
    const configuredAttempts = Number(process.env.LANGSEARCH_ATTEMPTS);
    const attempts = Number.isFinite(configuredAttempts) && configuredAttempts > 0
        ? Math.min(configuredAttempts, 5)
        : (keys.length > 1 ? 3 : 2);

    for (let attempt = 0; attempt < attempts && !json; attempt++) {
        const key = keys[attempt % keys.length];
        status = 0;

        try {
            const res = await fetch("https://api.langsearch.com/v1/web-search", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    accept: "application/json",
                    authorization: `Bearer ${key}`
                },
                body: JSON.stringify({
                    query,
                    count: Math.max(1, Math.min(20, Number(process.env.LANGSEARCH_MAX_RESULTS || 10))),
                    contents: { text: false }
                }),
                signal: AbortSignal.timeout(Number(process.env.LANGSEARCH_TIMEOUT_MS || 20000))
            });

            status = res.status;

            if (res.ok) {
                json = await res.json();
                break;
            }

            // 4xx: our fault (dead key, bad request) - retrying will not help.
            if (status < 500) break;
        } catch {
            status = 0;
        }

        if (attempt < attempts - 1) await sleep(300 * (attempt + 1));
    }

    if (!json) {
        noteEngineResult("langsearch", "");
        return {
            engine: "langsearch",
            htmlLength: 0,
            links: [],
            ...(status ? { status } : {}),
            note: status
                ? engineStatusNote("LangSearch", status)
                : "LangSearch request failed or timed out"
        };
    }

    const items = (json && json.data && json.data.webPages && Array.isArray(json.data.webPages.value))
        ? json.data.webPages.value
        : [];
    const payload = JSON.stringify(json) || "";

    // Same contract as SearXNG: a healthy answer clears any cooldown, an empty
    // one changes nothing, so a working engine never accrues phantom strikes.
    noteEngineResult("langsearch", payload);

    const links = [];

    for (const item of items.slice(0, 20)) {
        const rawUrl = item.url || "";
        if (!rawUrl) continue;

        const clean = normalizeUrl(rawUrl);
        if (!clean || !looksLikeBusinessWebsite(clean)) continue;

        const title = (item.name || item.title || "").replace(/\s+/g, " ").trim() || getHost(clean);
        const snippet = (item.snippet || item.description || "").replace(/\s+/g, " ").trim();

        links.push({
            title,
            url: clean,
            snippet,
            hostname: getHost(clean),
            score: scoreUrl(clean, title, niche, location)
        });
    }

    return {
        engine: "langsearch",
        htmlLength: items.length > 0 ? Math.max(payload.length, 600) : 0,
        links
    };
}

function addUnique(results, seen, links) {
    const sorted = links.sort((a, b) => b.score - a.score);

    for (const item of sorted) {
        const hostname = item.hostname || getHost(item.url);

        if (!hostname || seen.has(hostname)) continue;

        const title = String(item.title || "");
        if (hasNonLocalTitle(title)) continue;

        const score = item.score || 0;

        if (process.env.DEBUG_SEARCH === "1") {
            console.error(`[dbg-link] score=${score} keep=${score >= MIN_SCORE} host=${hostname}`);
        }

        if (score < MIN_SCORE) continue;

        seen.add(hostname);

        results.push({
            title: item.title || hostname,
            url: item.url,
            snippet: item.snippet || "",
            hostname,
            score
        });
    }
}

function buildNicheVariants(niche = "") {
    const phrase = String(niche).trim().toLowerCase().replace(/\s+/g, " ");
    if (!phrase) return [String(niche).trim()];

    const corrected = phrase
        .replace(/\bpannels?\b/g, "panel")
        .replace(/\bpanell\b/g, "panel")
        .replace(/\bairco\b/g, "air conditioning")
        .replace(/\belectricians\b/g, "electrician")
        .replace(/\broofing companies\b/g, "roofing company")
        .trim();

    const variants = new Set([phrase, corrected]);

    const words = phrase.split(" ");
    const lastWord = words[words.length - 1];

    const singular = (word) => {
        if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
        if (word.endsWith("es") && word.length > 3) return word.slice(0, -2);
        if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
        return word;
    };

    const basePhrase = words.slice(0, -1).concat(singular(lastWord)).join(" ");

    if (lastWord.endsWith("s") && lastWord.length > 3) variants.add(basePhrase);
    else variants.add(phrase + "s");

    for (const suffix of ["company", "services", "service", "business", "expert", "consulting", "near me"]) {
        variants.add(`${phrase} ${suffix}`);
        if (lastWord.endsWith("s") && lastWord.length > 3) variants.add(`${basePhrase} ${suffix}`);
    }

    for (const id of [
        "plumber", "plumbing", "electrician", "mechanic", "garage",
        "salon", "barber", "hvac", "roof", "roofing", "paint",
        "pest", "landscap", "pool", "solar", "handyman", "cleaner", "detailer", "detailing"
    ]) {
        if (phrase.includes(id)) {
            variants.add(`${id} company`);
            variants.add(`${id} services`);
            variants.add(`${id} near me`);
            variants.add(`${id} contractors`);
        }
    }

    return [...variants].slice(0, 8);
}

/*
  The free engines cost no quota, so they are the floor that guarantees a search
  never comes back empty. Hoisted to module scope so the escalation ladder below
  can reuse the exact same list as the main loop.
*/
const FREE_ENGINE_DEFS = [
    ["brave", "https://search.brave.com/search?q="],
    ["duck-html", "https://html.duckduckgo.com/html/?q="],
    ["duck-lite", "https://lite.duckduckgo.com/lite/?q="],
    ["mojeek", "https://www.mojeek.com/search?q="],
    ["ecosia", "https://www.ecosia.org/search?q="],
    ["bing", "https://www.bing.com/search?q="],
    ["yahoo", "https://search.yahoo.com/search?p="]
];

/*
  Only Bing still answers this host. Brave (429), DuckDuckGo (CAPTCHA page),
  Mojeek (Captcha page), Ecosia (firewall) and Yahoo (empty) are blocked at the
  edge, so every query paid for five ~8s timeouts that never returned a link.
  The default is Bing-only; an operator can re-enable others (e.g. after a proxy
  or IP change) with FREE_ENGINES=bing,brave,... without touching code.
*/
const FREE_ENGINE_ALLOW = String(process.env.FREE_ENGINES || "bing")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

const FREE_ENGINE_URLS = FREE_ENGINE_DEFS.filter(([name]) => FREE_ENGINE_ALLOW.includes(name));

function freeEngineUrl(engineName, q) {
    const base = FREE_ENGINE_URLS.find(([name]) => name === engineName)?.[1];
    if (!base) return "";
    /*
      Bing must NOT carry a locale tail at all.

      The host geolocates to France, so pinning a UK job's Bing call looked like
      the fix - but measured from this host with exactly the headers this pass
      sends, every pin is worse than no pin: cc=GB returned Bing's results-less
      ~95KB page on 3 of 3 tries, cc=PK on 2 of 2, and cc=US flipped between 0
      and 10 result blocks on consecutive calls. mkt= behaved the same way. A
      single earlier reading of "cc=GB -> 10 results" was a fluke of that
      request, not a property of the parameter.

      A bare URL returned the normal ~130KB page with 10 result blocks on every
      try, and for a UK query those results already carried UK markers, so Bing's
      IP-derived market is good enough and cannot be improved from this IP. The
      country correction therefore lives only where it is actually supported:
      Tavily's country field and the job's own location inside every query text.
    */
    const tail = {
        brave: "&source=web&cc=us&mkt=us",
        "duck-html": "&kl=us-en&k1=-1&kp=-2",
        "duck-lite": "&kl=us-en&k1=-1&kp=-2",
        mojeek: "",
        ecosia: "",
        bing: "",
        yahoo: "&country=us"
    }[engineName] || "";
    return base + encodeURIComponent(q) + tail;
}

/*
  One round of the free engines for a single query, run concurrently.

  Returns the links plus a per-engine breakdown. `producedNothing` is true when
  every engine that answered returned a block page or an unparseable stub, which
  used to abort the entire search after one query instead of simply moving on to
  a different query.
*/
async function runFreeEngineRound(q, niche, location) {
    const usable = FREE_ENGINE_URLS.filter(([name]) => engineIsUsable(name));
    const entries = [];

    if (!usable.length) {
        return { links: [], entries, producedNothing: true, enginesTried: 0 };
    }

    const staggered = usable.map(([engineName], index) => async () => {
        if (index > 0) await sleep(index * 120);
        const data = await searchEngine(engineName, freeEngineUrl(engineName, q), niche, location);
        noteEngineResult(engineName, data.rawHtml || "");
        return { engineName, data };
    });

    let settled = await Promise.all(staggered.map(run => run()));

    // Second chance for engines that came back with a block page or a stub.
    const throttled = settled.filter(s => s.data.htmlLength <= 8);

    if (throttled.length > 0) {
        await sleep(3000);

        const retried = await Promise.all(
            throttled.map(async ({ engineName }) => {
                const data = await searchEngine(engineName, freeEngineUrl(engineName, q), niche, location);
                return { engineName, data };
            })
        );

        settled = settled.map(s => retried.find(r => r.engineName === s.engineName) || s);
    }

    const links = [];

    for (const { engineName, data } of settled) {
        links.push(...(data.links || []));
        entries.push({
            query: q,
            engine: engineName,
            htmlLength: data.htmlLength,
            linksFound: (data.links || []).length,
            totalUsable: 0,
            // A blocked/empty scraped engine is indistinguishable from a genuine
            // zero unless the reason is recorded, which is what made the free
            // engines look "healthy but useless" in past post-mortems.
            ...(data.htmlLength <= 8 ? { note: `${engineName} blocked or returned an empty page` } : {})
        });
    }

    const producedNothing = links.length === 0;

    return { links, entries, producedNothing, enginesTried: settled.length };
}

/*
  The zero-result guarantee.

  These run only after the normal loop found nothing, and only against the free
  engines, so the guarantee can never spend paid quota. The order deliberately
  trades precision for recall: the same ask in looser wording first, then the
  location dropped entirely, then the niche stripped of filler words. A business
  that is real but in the wrong city still beats an empty results screen, and the
  area gate downstream decides what actually gets kept.
*/
function escalationQueries(niche, location) {
    const n = String(niche || "").trim();
    const loc = String(location || "").trim();
    const out = [];

    if (n && loc) {
        out.push(`${n} ${loc}`);
        out.push(`${n} in ${loc}`);
        out.push(`${n} ${loc} contact phone`);
        out.push(`best ${n} ${loc}`);
    }

    if (n) {
        out.push(n);
        out.push(`${n} contact email`);
        out.push(`local ${n}`);
        out.push(`${n} company`);

        // Drop filler so "commercial septic services" can still match a real
        // "septic" business when the full phrase matches nothing.
        const simple = n
            .replace(/\b(services?|company|companies|contractors?|providers?|agency|llc|inc|ltd|and)\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim();

        if (simple && simple !== n) {
            if (loc) out.push(`${simple} ${loc}`);
            out.push(simple);
        }
    }

    if (!n && loc) out.push(`businesses ${loc}`);

    return [...new Set(out.filter(q => q && q.length > 2))];
}

export async function searchPublicWeb({ niche, location, targetCount, passOffset = 0, deadlineMs = null, forceEscalation = false, allowEscalation = true, paid = false }) {
    const cleanNiche = String(niche || "").trim();
    const cleanLocation = String(location || "").trim();

    const nicheVariants = buildNicheVariants(cleanNiche);

    const queries = [];

    // A broad-region query ("dentist texas") is answered with directories
    // because one page cannot enumerate a whole state, so per-city queries go
    // first. They are what actually surface individual practices.
    const cities = expandRegion(cleanLocation);
    if (cities.length) {
        const want = Number(targetCount) || 5;
        const cityBudget = Math.min(cities.length, Math.max(3, Math.min(12, Math.ceil(want / 4))));

        for (const city of cities.slice(0, cityBudget)) {
            for (const variant of nicheVariants.slice(0, 2)) {
                queries.push(`${variant} ${city}`);
            }
            queries.push(`"${nicheVariants[0]}" ${city} contact`);
        }
    }

    for (const variant of nicheVariants) {
        queries.push(
            `"${variant}" ${cleanLocation}`,
            `"${variant}" ${cleanLocation} website contact`,
            `${variant} in ${cleanLocation}`,
            `${variant} ${cleanLocation} contact phone email`,
            `"${variant}" near me`
        );
    }

    const rotatedQueries = [];
    for (let i = 0; i < queries.length; i++) {
        rotatedQueries.push(queries[(i + passOffset) % queries.length]);
    }

    const results = [];
    const seen = new Set();
    const debug = [];
    let dryStreak = 0;
    // Brave/DDG throttle-retry burns ~4s per engine, so a 45s budget only ever
    // reached 2 engines and starved the query loop. 90s lets more engines run.
    // Callers that are waiting on a browser (the public preview) pass a much
    // smaller deadline, because a slow answer is worth nothing to them.
    const webDeadline = Date.now() + Number(deadlineMs || process.env.WEB_SEARCH_DEADLINE_MS || 90000);
    let timedOut = false;

    const useTavily = tavilyKeys(paid).length > 0;
    const useFirecrawl = hasFirecrawl(paid);
    const useLangSearch = langsearchKeys().length > 0;

    /*
      Budgets scale with the number of keys actually configured, because each key
      carries its own monthly credit. Hardcoding one number meant that adding a
      second key bought nothing: the job still made three calls and the new key
      sat idle. Three calls per key keeps a 2-key setup at six calls, and with
      rotation the load is spread instead of exhausting one key first.
    */
    const tavilyKeyCount = Math.max(tavilyKeys(paid).length, 1);
    const firecrawlKeyCount = Math.max(firecrawlKeys(paid).length, 1);

    const callsPerKey = Number(process.env.SEARCH_CALLS_PER_KEY || 3);
    let tavilyRemaining = useTavily
      ? Number(process.env.TAVILY_CALLS_PER_RUN || callsPerKey * tavilyKeyCount)
      : 0;
    let firecrawlRemaining = useFirecrawl
      ? Number(process.env.FIRECRAWL_CALLS_PER_RUN || callsPerKey * firecrawlKeyCount)
      : 0;

    for (const q of rotatedQueries) {
        if (Date.now() > webDeadline) { timedOut = true; break; }

        const before = results.length;

        /*
          Ordering: LangSearch first in the default mode, then the paid APIs,
          then the scraped engines - with SearXNG at the front only when
          SEARXNG_MODE=first is set to restore the old order.

          LangSearch leads because it answers like an API from the job's country
          and cannot send a bill. When it already delivered enough candidates,
          the paid calls for that query are skipped entirely, so Tavily and
          Firecrawl credits are spent only on the shortfall instead of on every
          query. When it falls short, the paid engines run in the same query
          exactly as before.

          The paid APIs therefore still run ahead of the seven scraped HTML
          engines (the bug fixed there stands: those return ~6 links per query
          from an IP half-blocked by every provider, and letting them satisfy
          the enough-candidates test is what kept Tavily uncalled).

          SearXNG is out of this loop by default: its only upstream is Bing, its
          vantage point is French, and asking it for a language or market was
          measured to change nothing - so it ran first while the direct Bing call
          (healthy on all 25 jobs audited) waited behind it. It is still free, so
          the default mode leaves it in the escalation ladder as a last resort.
        */
        /*
          Whether SearXNG answered this query with anything. It stays false when
          the container is disabled, on cooldown, on the default fallback mode
          (where this step does not run at all), or returned 0 because its
          upstream engines are throttling - which is exactly the window LangSearch
          exists to cover. That makes LangSearch a failover rather than a second
          parallel call, so its free-tier tokens are spent only when they are
          needed instead of on every query.
        */
        let searxngDelivered = false;

        // Only the "first" mode puts the relay at the head of the pass; in the
        // default mode it is left to the escalation ladder further down.
        if (searxngMode() === "first" && searxngUrl() && engineIsUsable("searxng") && results.length < targetCount * 2) {
            if (Date.now() > webDeadline) { timedOut = true; }
            else {
                const data = await searchEngineFromSearxng(q, cleanNiche, cleanLocation);

                addUnique(results, seen, data.links);

                searxngDelivered = data.links.length > 0;

                debug.push({
                    query: q,
                    engine: data.engine,
                    htmlLength: data.htmlLength,
                    linksFound: data.links.length,
                    totalUsable: results.length,
                    ...(data.status ? { status: data.status } : {}),
                    ...(data.note ? { note: data.note } : {})
                });
            }
        }

        // LangSearch: the failover free layer. It runs only when SearXNG did not
        // answer this query (and always first in the default fallback mode,
        // where SearXNG is out of the main pass entirely), so the unlimited
        // self-hosted source leads and the token-metered one is spent only on the
        // window SearXNG is throttled. It still sits ahead of the paid APIs, so no
        // money is spent while it answers.
        if (useLangSearch && engineIsUsable("langsearch") && results.length < targetCount * 2 && !searxngDelivered) {
            if (Date.now() > webDeadline) { timedOut = true; }
            else {
                const data = await searchEngineFromLangSearch(q, cleanNiche, cleanLocation);

                addUnique(results, seen, data.links);

                debug.push({
                    query: q,
                    engine: data.engine,
                    htmlLength: data.htmlLength,
                    linksFound: data.links.length,
                    totalUsable: results.length,
                    ...(data.status ? { status: data.status } : {}),
                    ...(data.note ? { note: data.note } : {})
                });
            }
        }

        const apiFallbacks = [];

        if (useTavily && tavilyRemaining > 0 && results.length < targetCount * 2) {
            apiFallbacks.push(async () => {
                tavilyRemaining -= 1;
                return searchEngineFromTavily(q, cleanNiche, cleanLocation, paid);
            });
        }

        if (useFirecrawl && firecrawlRemaining > 0 && results.length < targetCount * 2) {
            apiFallbacks.push(async () => {
                firecrawlRemaining -= 1;
                return searchEngineFromFirecrawl(q, cleanNiche, cleanLocation, paid);
            });
        }

        for (const runFallback of apiFallbacks) {
            if (Date.now() > webDeadline) { timedOut = true; break; }

            const data = await runFallback();

            addUnique(results, seen, data.links);

            debug.push({
                query: q,
                engine: data.engine,
                htmlLength: data.htmlLength,
                linksFound: data.links.length,
                totalUsable: results.length,
                ...(data.status ? { status: data.status } : {}),
                ...(data.note ? { note: data.note } : {})
            });
        }

        // Enough real candidates for this order: do not touch the dead engines.
        if (results.length >= targetCount * 2) {
            if (results.length - before > 0) dryStreak = 0;
            if (results.length >= targetCount * 4) break;
            continue;
        }

        // Engines that have answered with a block page twice are skipped.
        const round = await runFreeEngineRound(q, cleanNiche, cleanLocation);

        addUnique(results, seen, round.links);

        for (const entry of round.entries) {
            entry.totalUsable = results.length;
            debug.push(entry);
            if (results.length >= targetCount * 4) break;
        }

        /*
          This used to `return` the whole search when one query came back empty
          with every engine blocked, so a single blocked round produced a
          guaranteed zero no matter how many other queries were left. It now just
          records the dead end and keeps going: another query phrasing may still
          land, and the escalation ladder below is the real backstop.
        */
        if (round.producedNothing && round.enginesTried > 0) {
            debug.push({
                query: q,
                engine: "round-empty",
                htmlLength: 0,
                linksFound: 0,
                totalUsable: results.length
            });
        }

        if (timedOut) break;

        if (results.length - before > 0) dryStreak = 0;
        else dryStreak += 1;

        if (results.length >= targetCount * 4) break;

        // If several queries in a row add nothing, stop pounding the engines.
        if (dryStreak >= 7) break;
    }

    if (timedOut) {
        debug.push({ query: "", engine: "deadline", htmlLength: 0, linksFound: results.length, totalUsable: results.length });
    }

    /*
      The zero-result guarantee.

      This replaces a "last resort" that retried Brave alone. Brave is IP-blocked
      from this host, so that retry could only ever return zero: it was the
      reason a search that found nothing stayed at nothing.

      Instead, when the normal loop produced no usable candidate at all, walk a
      ladder of looser and broader phrasings against the free engines only. Free
      engines cost no quota, so spending rounds here cannot eat the Tavily or
      Firecrawl credits, and this runs on its own deadline so the main loop
      cannot starve it. It stops at the first query that yields anything.

      forceEscalation covers the more common failure: candidates DID come back,
      but every one was discarded downstream as a directory, a duplicate, or a
      listing with no reachable contact. results.length was non-zero so the
      ladder never fired, and the job closed at zero anyway. The worker sets
      this once it has seen a pass yield no leads, so the ladder runs even
      though candidates exist, and it keeps walking the whole ladder instead of
      stopping at the first hit.
    */
    const startedEmpty = results.length === 0;
    let escalated = false;

    if (allowEscalation && (startedEmpty || forceEscalation)) {
        escalated = true;
        const ladder = escalationQueries(cleanNiche, cleanLocation);
        const escalateDeadline =
            Date.now() + Number(process.env.SEARCH_ESCALATION_DEADLINE_MS || 75000);

        debug.push({
            query: "",
            engine: forceEscalation && !startedEmpty ? "escalation-force" : "escalation-start",
            htmlLength: 0,
            linksFound: 0,
            totalUsable: 0,
            note: `${ladder.length} broader phrasings, free engines only`
        });

        for (const q of ladder) {
            // A search that found nothing stops at its first hit. A search that
            // already has candidates keeps going: the goal is breadth, and the
            // whole point is that the existing ones may all be unusable.
            if (startedEmpty && results.length > 0) break;
            if (Date.now() > escalateDeadline) {
                debug.push({
                    query: q,
                    engine: "escalation-deadline",
                    htmlLength: 0,
                    linksFound: 0,
                    totalUsable: results.length
                });
                break;
            }

            /*
              The ladder is where SearXNG earns its place in the default mode: it
              is free, so the zero-result guarantee - the thing this ladder exists
              for - can lean on it without burning the paid credits the guarantee
              is meant to protect.

              Where it runs inside the step follows the mode. "first" keeps it at
              the front exactly as it leads the main loop. The default "fallback"
              mode runs it last, after LangSearch and the direct engines, so a
              French relay only reaches the queue when the sources that answer in
              the job's country came up short - never ahead of them.
            */
            const ladderRelay = async () => {
                if (searxngMode() === "off" || !searxngUrl() || !engineIsUsable("searxng")) return;

                const data = await searchEngineFromSearxng(q, cleanNiche, cleanLocation);
                addUnique(results, seen, data.links);

                debug.push({
                    query: q,
                    engine: data.engine,
                    htmlLength: data.htmlLength,
                    linksFound: data.links.length,
                    totalUsable: results.length,
                    ...(data.status ? { status: data.status } : {}),
                    ...(data.note ? { note: data.note } : {})
                });
            };

            if (searxngMode() === "first") await ladderRelay();

            if (useLangSearch && engineIsUsable("langsearch")) {
                const data = await searchEngineFromLangSearch(q, cleanNiche, cleanLocation);
                addUnique(results, seen, data.links);

                debug.push({
                    query: q,
                    engine: data.engine,
                    htmlLength: data.htmlLength,
                    linksFound: data.links.length,
                    totalUsable: results.length,
                    ...(data.status ? { status: data.status } : {}),
                    ...(data.note ? { note: data.note } : {})
                });
            }

            const round = await runFreeEngineRound(q, cleanNiche, cleanLocation);
            addUnique(results, seen, round.links);

            for (const entry of round.entries) {
                entry.totalUsable = results.length;
                debug.push(entry);
            }

            if (searxngMode() !== "first") await ladderRelay();

            debug.push({
                query: q,
                engine: forceEscalation && !startedEmpty ? "escalation-force-step" : "escalation-step",
                htmlLength: 0,
                linksFound: round.links.length,
                totalUsable: results.length
            });
        }
    }

    const finalResults = results
        .sort((a, b) => b.score - a.score)
        .slice(0, targetCount * 6);

    /*
      Collapse the per-query engine chatter into one entry per engine so the
      worker can tell the user which sources failed and why (out of credits,
      over quota, blocked, server error) instead of the old catch-all line. The
      paid engines come first because their reason is the actionable one.
    */
    const engineHealth = [];
    const healthSeen = new Set();
    for (const entry of debug) {
        if (!entry.note || healthSeen.has(entry.engine)) continue;
        healthSeen.add(entry.engine);
        engineHealth.push({
            engine: entry.engine,
            status: entry.status || 0,
            note: entry.note
        });
    }

    return {
        results: finalResults,
        debug,
        engineHealth,
        // Lets the worker spend its one escalation run deliberately rather than
        // guessing and either paying for it four times or never at all.
        escalated
    };
}

export const delay = sleep;