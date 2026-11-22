// Region -> major cities, used to expand a broad search area into per-city
// queries. A state-wide query ("dentist texas") mostly returns directories,
// because there are far too many practices for one page of results; per-city
// queries are what actually surface individual businesses.

export const STATE_ABBR = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
    colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
    hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
    kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
    massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
    missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
    oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
    virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
    wyoming: "WY", "district of columbia": "DC"
};

export const STATE_CITIES = {
    alabama: ["Birmingham", "Montgomery", "Huntsville", "Mobile", "Tuscaloosa", "Hoover"],
    alaska: ["Anchorage", "Fairbanks", "Juneau", "Sitka", "Ketchikan"],
    arizona: ["Phoenix", "Tucson", "Mesa", "Scottsdale", "Glendale", "Tempe"],
    arkansas: ["Little Rock", "Fayetteville", "Fort Smith", "Springdale", "Jonesboro", "Rogers"],
    california: ["Los Angeles", "San Diego", "San Jose", "San Francisco", "Fresno", "Sacramento"],
    colorado: ["Denver", "Colorado Springs", "Aurora", "Fort Collins", "Boulder", "Pueblo"],
    connecticut: ["Bridgeport", "New Haven", "Stamford", "Hartford", "Waterbury", "Norwalk"],
    delaware: ["Wilmington", "Dover", "Newark", "Middletown", "Smyrna"],
    "district of columbia": ["Washington"],
    florida: ["Jacksonville", "Miami", "Tampa", "Orlando", "Fort Lauderdale", "St. Petersburg"],
    georgia: ["Atlanta", "Augusta", "Columbus", "Savannah", "Athens", "Roswell"],
    hawaii: ["Honolulu", "Hilo", "Kailua", "Kahului", "Waipahu"],
    idaho: ["Boise", "Idaho Falls", "Pocatello", "Nampa", "Meridian"],
    illinois: ["Chicago", "Aurora", "Rockford", "Naperville", "Springfield", "Peoria"],
    indiana: ["Indianapolis", "Fort Wayne", "Evansville", "South Bend", "Carmel", "Bloomington"],
    iowa: ["Des Moines", "Cedar Rapids", "Davenport", "Sioux City", "Iowa City", "Waterloo"],
    kansas: ["Wichita", "Overland Park", "Kansas City", "Topeka", "Olathe", "Lawrence"],
    kentucky: ["Louisville", "Lexington", "Bowling Green", "Owensboro", "Covington", "Richmond"],
    louisiana: ["New Orleans", "Baton Rouge", "Shreveport", "Lafayette", "Lake Charles", "Alexandria"],
    maine: ["Portland", "Bangor", "Lewiston", "Augusta", "Sanford", "Scarborough"],
    maryland: ["Baltimore", "Columbia", "Silver Spring", "Rockville", "Bethesda", "Annapolis"],
    massachusetts: ["Boston", "Worcester", "Springfield", "Cambridge", "Lowell", "Brockton"],
    michigan: ["Detroit", "Grand Rapids", "Warren", "Ann Arbor", "Lansing", "Traverse City"],
    minnesota: ["Minneapolis", "St. Paul", "Rochester", "Duluth", "Bloomington", "Brooklyn Park"],
    mississippi: ["Jackson", "Gulfport", "Southaven", "Hattiesburg", "Biloxi", "Olive Branch"],
    missouri: ["Kansas City", "St. Louis", "Springfield", "Columbia", "Independence", "Lee's Summit"],
    montana: ["Billings", "Missoula", "Great Falls", "Bozeman", "Butte", "Helena"],
    nebraska: ["Omaha", "Lincoln", "Bellevue", "Grand Island", "Kearney", "Fremont"],
    nevada: ["Las Vegas", "Henderson", "Reno", "North Las Vegas", "Carson City", "Sparks"],
    "new hampshire": ["Manchester", "Nashua", "Concord", "Dover", "Rochester", "Salem"],
    "new jersey": ["Newark", "Jersey City", "Paterson", "Elizabeth", "Edison", "Woodbridge"],
    "new mexico": ["Albuquerque", "Las Cruces", "Rio Rancho", "Santa Fe", "Roswell", "Farmington"],
    "new york": ["New York", "Brooklyn", "Queens", "Manhattan", "Bronx", "Staten Island", "Buffalo", "Rochester", "Yonkers", "Syracuse", "Albany"],
    "north carolina": ["Charlotte", "Raleigh", "Greensboro", "Durham", "Winston-Salem", "Fayetteville"],
    "north dakota": ["Fargo", "Bismarck", "Grand Forks", "Minot", "West Fargo", "Williston"],
    ohio: ["Columbus", "Cleveland", "Cincinnati", "Toledo", "Akron", "Dayton"],
    oklahoma: ["Oklahoma City", "Tulsa", "Norman", "Broken Arrow", "Edmond", "Lawton"],
    oregon: ["Portland", "Eugene", "Salem", "Gresham", "Hillsboro", "Beaverton"],
    pennsylvania: ["Philadelphia", "Pittsburgh", "Allentown", "Reading", "Erie", "Lancaster"],
    "rhode island": ["Providence", "Warwick", "Cranston", "Pawtucket", "East Providence", "Woonsocket"],
    "south carolina": ["Charleston", "Columbia", "North Charleston", "Mount Pleasant", "Rock Hill", "Greenville"],
    "south dakota": ["Sioux Falls", "Rapid City", "Aberdeen", "Brookings", "Watertown", "Mitchell"],
    tennessee: ["Nashville", "Memphis", "Knoxville", "Chattanooga", "Clarksville", "Murfreesboro"],
    texas: ["Houston", "San Antonio", "Dallas", "Austin", "Fort Worth", "El Paso", "Arlington", "Corpus Christi", "Plano", "Laredo"],
    utah: ["Salt Lake City", "West Valley City", "Provo", "West Jordan", "Orem", "Ogden"],
    vermont: ["Burlington", "South Burlington", "Rutland", "Barre", "Montpelier", "Winooski"],
    virginia: ["Virginia Beach", "Norfolk", "Chesapeake", "Richmond", "Newport News", "Alexandria"],
    washington: ["Seattle", "Spokane", "Tacoma", "Vancouver", "Bellevue", "Kent"],
    "west virginia": ["Charleston", "Huntington", "Morgantown", "Parkersburg", "Wheeling", "Martinsburg"],
    wisconsin: ["Milwaukee", "Madison", "Green Bay", "Kenosha", "Racine", "Appleton"],
    wyoming: ["Cheyenne", "Casper", "Laramie", "Gillette", "Rock Springs", "Sheridan"]
};

export const COUNTRY_CITIES = {
    "united kingdom": ["London", "Birmingham", "Manchester", "Leeds", "Glasgow", "Edinburgh", "Bristol", "Liverpool"],
    "united states": ["New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia"],
    usa: ["New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia"],
    uk: ["London", "Birmingham", "Manchester", "Leeds", "Glasgow", "Edinburgh"],
    canada: ["Toronto", "Montreal", "Vancouver", "Calgary", "Ottawa", "Edmonton"],
    australia: ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Canberra"],
    ireland: ["Dublin", "Cork", "Galway", "Limerick"]
};

const norm = (s) => String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    // Folding accents lets a business page written in the local spelling match
    // the city name the user typed: Munchen/Munich, Zurich/Zurich, Krakow.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");

/*
  Cities whose local-language name differs from the English name a user is
  likely to type.

  Without this a "tattoo studio in Lisbon" search returns a page whose address
  reads "Lisboa", the alias set never matches, every lead is marked out of the
  target area, and a search that found real businesses reports zero.
*/
const WORLD_CITY_ALIASES = {
    lisbon: ["lisboa", "lisboa city"],
    "lisbon, portugal": ["lisboa"],
    porto: ["oporto", "porto"],
    "porto, portugal": ["oporto"],
    madrid: ["madrid"],
    barcelona: ["barcelona"],
    rome: ["roma"],
    "rome, italy": ["roma"],
    milan: ["milano"],
    "milan, italy": ["milano"],
    venice: ["venezia"],
    florence: ["firenze"],
    naples: ["napoli"],
    bologna: ["bologna"],
    turin: ["torino"],
    palermo: ["palermo"],
    athens: ["athina", "athens"],
    vienna: ["wien"],
    "vienna, austria": ["wien"],
    munich: ["munchen", "muenchen"],
    "munich, germany": ["munchen", "muenchen"],
    cologne: ["koln", "cologne"],
    "cologne, germany": ["koln"],
    frankfurt: ["frankfurt am main"],
    berlin: ["berlin"],
    hamburg: ["hamburg"],
    zurich: ["zurich", "zuerich"],
    "zurich, switzerland": ["zuerich"],
    geneva: ["geneve", "geneva"],
    bern: ["bern"],
    prague: ["praha"],
    "prague, czechia": ["praha"],
    "prague, czech republic": ["praha"],
    warsaw: ["warszawa"],
    "warsaw, poland": ["warszawa"],
    krakow: ["krakow", "krakow"],
    "krakow, poland": ["krakow"],
    budapest: ["budapest"],
    brussels: ["bruxelles", "brussel"],
    "brussels, belgium": ["bruxelles"],
    amsterdam: ["amsterdam"],
    copenhagen: ["kobenhavn"],
    stockholm: ["stockholm"],
    oslo: ["oslo"],
    helsinki: ["helsinki"],
    lisbon_pt: ["lisboa"],
    kyoto: ["kyoto"],
    "tokyo, japan": ["tokyo"],
    osaka: ["osaka"],
    mumbai: ["mumbai", "bombay"],
    "mumbai, india": ["bombay"],
    delhi: ["new delhi", "delhi"],
    "new delhi, india": ["delhi"],
    bangalore: ["bengaluru", "bangalore"],
    "bangalore, india": ["bengaluru"],
    chennai: ["chennai", "madras"],
    dubai: ["dubai"],
    "dubai, uae": ["dubai"],
    "cape town": ["cape town", "kaapstad"],
    "johannesburg": ["johannesburg"],
    lagos: ["lagos"],
    "lagos, nigeria": ["lagos"],
    nairobi: ["nairobi"],
    cairo: ["al qahirah", "cairo"],
    istanbul: ["istanbul", "constantinople"],
    ankara: ["ankara"],
    tehran: ["tehran", "teheran"],
    "new york city": ["new york", "nyc"],
    "san francisco": ["san francisco"],
    "mexico city": ["ciudad de mexico", "cdmx"],
    "sao paulo": ["sao paulo"],
    "rio de janeiro": ["rio de janeiro"],
    buenos: ["buenos aires"],
    bogota: ["bogota"],
    lima: ["lima"],
    santiago: ["santiago"],
    seoul: ["seoul", "soul"],
    "hong kong": ["hong kong", "xianggang"],
    singapore: ["singapore", "singapura"],
    manila: ["manila"],
    "kuala lumpur": ["kuala lumpur"],
    jakarta: ["jakarta"],
    bangkok: ["bangkok", "krung thep"]
};

const ABBR_TO_STATE = new Map();
for (const [state, abbr] of Object.entries(STATE_ABBR)) {
    if (!ABBR_TO_STATE.has(abbr.toUpperCase())) ABBR_TO_STATE.set(abbr.toUpperCase(), state);
}

// Every city name known to sit inside a region, e.g. "houston" for "texas".
const CITY_INDEX = new Map();
for (const [region, cities] of Object.entries(STATE_CITIES)) {
    for (const city of cities) {
        const k = norm(city);
        if (!CITY_INDEX.has(k)) CITY_INDEX.set(k, new Set());
        CITY_INDEX.get(k).add(region);
    }
}
for (const [region, cities] of Object.entries(COUNTRY_CITIES)) {
    for (const city of cities) {
        const k = norm(city);
        if (!CITY_INDEX.has(k)) CITY_INDEX.set(k, new Set());
        CITY_INDEX.get(k).add(region);
    }
}

export function regionOf(city) {
    return CITY_INDEX.get(norm(city)) || null;
}

export function isRegion(location) {
    const l = norm(location);
    return Boolean(STATE_CITIES[l] || COUNTRY_CITIES[l] || STATE_ABBR[l]);
}

// Cities to search for a region. A specific city returns just itself, so this
// is a no-op for narrow searches.
export function expandRegion(location) {
    const l = norm(location);
    if (STATE_CITIES[l]) return STATE_CITIES[l];
    if (COUNTRY_CITIES[l]) return COUNTRY_CITIES[l];

    const state = ABBR_TO_STATE.get(l.toUpperCase());
    if (state) return STATE_CITIES[state] || [];

    // "richmond va" -> Virginia
    const parts = l.split(" ");
    if (parts.length > 1) {
        const tail = ABBR_TO_STATE.get(parts[parts.length - 1].toUpperCase());
        if (tail) return STATE_CITIES[tail] || [];
    }

    return [];
}

// The state a location belongs to, from a full name, an abbreviation or a
// "city ST" pair.
export function stateOf(location) {
    const l = norm(location);
    if (STATE_ABBR[l]) return l;
    const byAbbr = ABBR_TO_STATE.get(l.toUpperCase());
    if (byAbbr) return byAbbr;
    const parts = l.split(" ");
    if (parts.length > 1) {
        const tail = ABBR_TO_STATE.get(parts[parts.length - 1].toUpperCase());
        if (tail) return tail;
    }
    return null;
}

// Reverse index so the table works in both directions: typing "munchen" must
// find "munich", and typing "lisbon" must find "lisboa".
const WORLD_CITY_VARIANTS = (() => {
    const map = new Map();

    const merge = (key, values) => {
        const k = norm(key);
        if (!k) return;
        const existing = map.get(k) || new Set();
        for (const v of [norm(key), ...values.map(norm)]) {
            if (v) existing.add(v);
        }
        map.set(k, existing);
    };

    for (const [english, variants] of Object.entries(WORLD_CITY_ALIASES)) {
        merge(english, variants);
        for (const variant of variants) merge(variant, [english, ...variants]);
    }

    return map;
})();

function worldCityVariants(value = "") {
    return [...(WORLD_CITY_VARIANTS.get(norm(value)) || [])];
}

export { worldCityVariants as cityNameVariants };

// Strings that prove a business serves the requested area: the region name, its
// postal abbreviation, and any known city inside it. A practice in Houston is
// in Texas even if the page only says "Houston, TX".
export function locationAliases(location) {
    const l = norm(location);
    const out = new Set();

    const push = (v) => {
        const n = norm(v);
        if (n) out.add(n);
    };

push(l);
    push(STATE_ABBR[l]);
    push(ABBR_TO_STATE.get(l.toUpperCase()));
    push(stateOf(location));

    // Local-language and spelling variants, e.g. "lisbon" also accepts "lisboa".
    for (const alias of worldCityVariants(l)) {
        push(alias);
    }

    for (const city of expandRegion(location)) {
        push(city);
        push(STATE_ABBR[norm(city)]);
        for (const alias of worldCityVariants(city)) {
            push(alias);
        }
    }

    // Reverse mapping: the user typed a city, accept the parent region.
    for (const region of CITY_INDEX.get(l) || []) {
        push(region);
        push(STATE_ABBR[region]);
    }

    return [...out];
}
