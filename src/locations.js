/*
  Location typeahead.

  The location field is free text - the pipeline geocodes whatever is typed -
  so the failure mode is a typo: "Houstan Texas" geocodes to nothing, every
  candidate is dropped, and the job reports zero. Suggesting real places as the
  user types, and writing a canonical "City, Region" string back, removes that
  class of mistake before it reaches the worker.

  Two sources, cheapest first:

    1. A local index built at load from tables already in the codebase: every US
       state and its major cities (with coordinates, from osm.js) plus the major
       cities of the countries in COUNTRY_CITY_CENTERS. Instant and offline, and
       it covers the common US/city cases without a network hop.

    2. Photon (photon.komoot.io), a free keyless OSM geocoder with a typeahead
       API, for anything the local list does not hold: other world cities, towns
       and neighbourhoods. Best-effort and fail-open - if it is slow or down,
       the local rows still return. Turn it off with LOCATION_SUGGEST_REMOTE=0.

  No API key and no new dependency. Nominatim is deliberately NOT used here:
  its usage policy forbids autocomplete/typeahead traffic, so using it would
  put the geocoding the worker depends on at risk.
*/

import { STATE_CITIES, STATE_ABBR } from "./geo.js";
import { US_STATE_CITY_CENTERS, COUNTRY_CITY_CENTERS } from "./apis/osm.js";
import { clientIp } from "./abuseGuard.js";

const MAX_SUGGESTIONS = 8;
const MIN_QUERY = 2;
const REMOTE_TIMEOUT_MS = 3500;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const PHOTON_URL = "https://photon.komoot.io/api/";
const USER_AGENT = "leadmoz-location-suggest/1.0 (+https://leadmoz.com)";

const norm = (s) => String(s || "")
  .trim()
  .toLowerCase()
  .normalize("NFD")
  // Fold accents so "Munchen" finds "Munich" and "Krakow"/"Kraków" agree, the
  // same folding geo.js uses for matching.
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const titleCase = (s) =>
  String(s || "").replace(/(^|\s)([a-z])/g, (m, sp, c) => sp + c.toUpperCase());

let regionDisplay = null;
try {
  regionDisplay = new Intl.DisplayNames(["en"], { type: "region" });
} catch {
  regionDisplay = null;
}

function countryName(code) {
  const cc = String(code || "").toUpperCase();
  if (regionDisplay) {
    try {
      const n = regionDisplay.of(cc);
      if (n && n !== cc) return n;
    } catch {
      /* not a known region code */
    }
  }
  return cc;
}

/*
  Spellings and abbreviations a user types that are not the country's display
  name, added to the search terms so "uk" finds "United Kingdom" and "uae"
  finds the Emirates.
*/
const COUNTRY_ALIASES = {
  us: ["usa", "america"],
  gb: ["uk", "britain", "england", "scotland", "wales"],
  ae: ["uae", "emirates"],
  nl: ["holland"],
  za: ["rsa"],
  in: ["bharat"],
  de: ["deutschland"],
  es: ["espana"],
  br: ["brasil"],
  ar: ["argentina"],
  co: ["colombia"],
  id: ["indonesia"],
  mx: ["mexico"],
  ca: ["canada"],
  au: ["australia"],
  fr: ["france"],
  it: ["italy"],
  pl: ["poland", "polska"],
  se: ["sweden"],
  tr: ["turkey", "turkiye"],
  ph: ["philippines"],
  ng: ["nigeria"]
};

/*
  Which country a short form refers to, so "uk" ranks United Kingdom above the
  handful of English cities whose terms also contain that alias. Only exact
  queries qualify - a longer query uses ordinary prefix scoring.
*/
const ALIAS_TO_COUNTRY = (() => {
  const map = new Map();
  const set = (key, code) => {
    const k = norm(key);
    if (k && !map.has(k)) map.set(k, code);
  };

  for (const code of Object.keys(COUNTRY_CITY_CENTERS)) {
    set(code, code.toUpperCase());
    set(countryName(code), code.toUpperCase());
  }
  for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) {
    const cc = code.toUpperCase();
    for (const a of aliases) set(a, cc);
  }

  return map;
})();

function entry(fields) {
  const { label, name, city, region, country, countryCode, regionCode, lat, lon, kind } = fields;
  const aliasTerms = COUNTRY_ALIASES[String(countryCode || "").toLowerCase()] || [];
  return {
    label,
    name: name || city || region || country || label,
    city: city || "",
    region: region || "",
    country: country || "",
    countryCode: countryCode || "",
    regionCode: regionCode || "",
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    kind: kind || "city",
    terms: norm(`${label} ${region} ${country} ${countryCode} ${regionCode} ${aliasTerms.join(" ")}`)
  };
}

// Built once at module load; the tables are static.
const INDEX = (() => {
  const out = [];

  for (const [state, cities] of Object.entries(US_STATE_CITY_CENTERS)) {
    const region = titleCase(state);
    for (const [city, lat, lon] of cities) {
      out.push(entry({
        label: `${city}, ${region}`,
        city,
        region,
        country: "United States",
        countryCode: "US",
        regionCode: STATE_ABBR[state] || "",
        lat,
        lon,
        kind: "city"
      }));
    }
  }

  // States as searchable regions: a state-wide query is valid (the worker
  // expands it into its cities), so it is worth suggesting on its own.
  for (const state of Object.keys(US_STATE_CITY_CENTERS)) {
    out.push(entry({
      label: titleCase(state),
      region: titleCase(state),
      country: "United States",
      countryCode: "US",
      regionCode: STATE_ABBR[state] || "",
      kind: "region"
    }));
  }

  // Extra US city names from geo.js that the coordinate table does not carry,
  // so the dropdown is not thinner than the worker's own knowledge.
  const seen = new Set(out.filter(e => e.kind === "city").map(e => norm(e.label)));
  for (const [state, names] of Object.entries(STATE_CITIES)) {
    const region = titleCase(state);
    for (const city of names) {
      const label = `${city}, ${region}`;
      if (seen.has(norm(label))) continue;
      seen.add(norm(label));
      out.push(entry({
        label,
        city,
        region,
        country: "United States",
        countryCode: "US",
        regionCode: STATE_ABBR[state] || "",
        kind: "city"
      }));
    }
  }

  for (const [code, cities] of Object.entries(COUNTRY_CITY_CENTERS)) {
    // US cities already came from the richer state table above.
    const cname = countryName(code);
    for (const [city, lat, lon] of cities) {
      out.push(entry({
        label: `${city}, ${cname}`,
        city,
        region: "",
        country: cname,
        countryCode: code.toUpperCase(),
        lat,
        lon,
        kind: "city"
      }));
    }
  }

  for (const code of Object.keys(COUNTRY_CITY_CENTERS)) {
    const cname = countryName(code);
    out.push(entry({ label: cname, country: cname, countryCode: code.toUpperCase(), kind: "country" }));
  }

  const US = entry({ label: "United States", country: "United States", countryCode: "US", kind: "country" });
  if (!out.some(e => norm(e.label) === "united states" && e.kind === "country")) out.push(US);

  return out;
})();

const KIND_RANK = { city: 0, region: 1, country: 2 };

/*
  Every token of the query must prefix some token of the entry, so "san an"
  matches "San Antonio, Texas". Prefix matches score higher at the start of the
  string, and a label that begins with the whole query gets a large bonus so the
  obvious result stays on top.
*/
function score(entryItem, q) {
  const qTokens = q.split(" ").filter(Boolean);
  if (!qTokens.length) return 0;

  const hayTokens = entryItem.terms.split(" ");
  let total = 0;

  for (const t of qTokens) {
    const idx = hayTokens.findIndex(w => w.startsWith(t));
    if (idx === -1) return 0;
    total += idx === 0 ? 14 : 7;
  }

  if (norm(entryItem.label).startsWith(q)) total += 45;

  const owner = ALIAS_TO_COUNTRY.get(q);
  if (owner && entryItem.kind === "country" && entryItem.countryCode === owner) total += 60;

  return total;
}

function toSuggestion(e) {
  return {
    label: e.label,
    name: e.name,
    city: e.city,
    region: e.region,
    country: e.country,
    kind: e.kind,
    lat: e.lat,
    lon: e.lon
  };
}

/*
  Two entries are the same place when they share a name and country and their
  regions are equal OR either region is unknown. So the local "Houston, Texas"
  absorbs a vaguer remote "Houston, United States", but "Springfield, Illinois"
  and "Springfield, Missouri" both survive.
*/
function makeDedupe() {
  const groups = new Map();
  const nameKey = (s) => norm(`${s.name || s.city || ""}|${s.country || ""}`);
  const regionKey = (s) => norm(s.region || "");

  return {
    has(s) {
      const list = groups.get(nameKey(s));
      if (!list) return false;
      const r = regionKey(s);
      return list.some(x => x === r || !x || !r);
    },
    add(s) {
      const k = nameKey(s);
      const list = groups.get(k) || [];
      list.push(regionKey(s));
      groups.set(k, list);
    }
  };
}

export function localSuggestions(query, limit = MAX_SUGGESTIONS) {
  const q = norm(query);
  if (q.length < MIN_QUERY) return [];

  const scored = [];
  for (const e of INDEX) {
    const s = score(e, q);
    if (s > 0) scored.push({ e, s });
  }

  scored.sort((a, b) =>
    b.s - a.s ||
    (KIND_RANK[a.e.kind] ?? 3) - (KIND_RANK[b.e.kind] ?? 3) ||
    a.e.label.length - b.e.label.length ||
    a.e.label.localeCompare(b.e.label)
  );

  const out = [];
  const dedupe = makeDedupe();
  for (const { e } of scored) {
    const s = toSuggestion(e);
    if (dedupe.has(s)) continue;
    dedupe.add(s);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function mapPhoton(feature) {
  const p = (feature && feature.properties) || {};
  const coords = (feature && feature.geometry && feature.geometry.coordinates) || [];
  const name = p.name || p.city || p.locality || "";
  if (!name) return null;

  const city = p.city && p.city !== name ? p.city : name;
  const region = p.state || p.county || "";
  const country = countryName(p.countrycode) || p.country || "";
  const label = [...new Set([name, region, country].filter(Boolean))].join(", ");

  const kind = /city|town|village|municipality/i.test(p.osm_value || p.type || "") ? "city" : "place";

  return {
    label,
    name,
    city,
    region,
    country,
    kind,
    lat: Number.isFinite(coords[1]) ? coords[1] : null,
    lon: Number.isFinite(coords[0]) ? coords[0] : null
  };
}

async function remoteSuggestions(query, limit) {
  const url = `${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=${limit}&lang=en`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
  });
  if (!res.ok) return [];

  const json = await res.json();
  const features = Array.isArray(json && json.features) ? json.features : [];
  return features.map(f => mapPhoton(f)).filter(Boolean);
}

function remoteEnabled() {
  return process.env.LOCATION_SUGGEST_REMOTE !== "0";
}

const cache = new Map();

export async function suggestLocations(query, { limit = MAX_SUGGESTIONS } = {}) {
  const q = norm(query);
  if (q.length < MIN_QUERY) return [];

  const cached = cache.get(q);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const local = localSuggestions(query, limit);

  let remote = [];
  if (remoteEnabled() && local.length < limit) {
    remote = await photonSafe(query, limit);
  }

  const merged = mergeSuggestions(local, remote, limit);

  cache.set(q, { at: Date.now(), value: merged });
  if (cache.size > CACHE_MAX) {
    for (const key of cache.keys()) {
      cache.delete(key);
      if (cache.size <= CACHE_MAX) break;
    }
  }

  return merged;
}

async function photonSafe(query, limit) {
  try {
    return await remoteSuggestions(query, limit);
  } catch {
    return [];
  }
}

export function mergeSuggestions(local, remote, limit) {
  const out = [];
  const dedupe = makeDedupe();
  for (const s of [...local, ...remote]) {
    if (dedupe.has(s)) continue;
    dedupe.add(s);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------- rate guard */

const ipHits = new Map();

function allowIp(ip, limit = 90, windowMs = 60 * 1000) {
  const now = Date.now();
  const rec = ipHits.get(ip);

  if (!rec || now > rec.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + windowMs });
    if (ipHits.size > 5000) {
      for (const [k, v] of ipHits) if (v.resetAt < now) ipHits.delete(k);
    }
    return true;
  }

  rec.count += 1;
  return rec.count <= limit;
}

export function registerLocationRoutes(app) {
  app.get("/api/locations", async (req, res) => {
    const q = String(req.query.q || "").trim();

    if (q.length < MIN_QUERY) {
      return res.json({ suggestions: [] });
    }

    if (!allowIp(clientIp(req))) {
      return res.status(429).json({ error: "Too many requests" });
    }

    const suggestions = await suggestLocations(q, { limit: MAX_SUGGESTIONS });

    res.set("Cache-Control", "public, max-age=60");
    res.json({ suggestions });
  });
}

export { norm as normalizeLocationQuery };
