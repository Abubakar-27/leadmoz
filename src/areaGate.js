/*
  Distance-based area gate.

  Why this exists
  ---------------
  The target count is measured against leads flagged `inTargetArea`, and until now
  that flag came only from matching the requested place NAME against the business
  name, title or address. Two real Lisbon tattoo studios were thrown away by it:
  "Cacilhas Tattoo" (Cacilhas is a Lisbon parish, so its address never spells
  "Lisbon") and "Tattoo Studio in Lisbon" (the city only appears in the business
  name, which the matcher deliberately ignores because a company can be named
  after a city and operate elsewhere).

  At the same time the metro is full of genuine nearby businesses (Amadora,
  Odivelas, Setubal, Sobreda) that a user asking for "Lisbon" would happily work
  with. Rejecting them meant a "redesign" job in Lisbon could save 15 real leads
  and still only count 5 toward a target of 10, then loop through every pass
  forever without ever reaching it.

  OpenStreetMap already resolves a lat/lon for every business it returns, so this
  module answers the question the text matcher cannot: how far is it, actually?

  Honesty rules kept deliberately
  ------------------------------
  * A distance match sets `inTargetArea` so the lead counts, but it is reported
    as `metro` evidence, never as address-level ("strong") confirmation. The
    verifier downgrades it to needsReview, so a metro lead can fill the order
    without being passed off as a verified downtown business.
  * A city request never accepts another city that is simply far away, so Austin
    can still not be filled with San Antonio roofers: Setubal is ~40km from
    Lisbon and is refused, while Amadora at ~9km is accepted as "near Lisbon".
*/

import { stateFallbackCities } from "./apis/osm.js";

const DEFAULT_METRO_RADIUS_KM = 25;

// Nominatim answers in seconds once, then we keep it for the life of the process.
const centerCache = new Map();
const inflight = new Map();

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (Number(deg) * Math.PI) / 180;
}

export function haversineKm(a, b) {
  if (!a || !b) return null;

  const lat1 = Number(a.lat);
  const lon1 = Number(a.lon ?? a.lng);
  const lat2 = Number(b.lat);
  const lon2 = Number(b.lon ?? b.lng);

  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function cacheKey(location) {
  return String(location || "").trim().toLowerCase();
}

async function fetchCenter(location) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(String(location || "").trim());

  const res = await fetch(url, {
    headers: {
      // Nominatim's usage policy requires an identifying User-Agent.
      "User-Agent": "leadmoz-leadfinder/1.0 (lead generation tool)",
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) throw new Error(`geocode ${res.status}`);

  const rows = await res.json();
  const hit = Array.isArray(rows) ? rows[0] : null;

  if (!hit) return null;

  const lat = Number(hit.lat);
  const lon = Number(hit.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return { lat, lon, label: hit.display_name || String(location) };
}

/**
 * Memoised centre lookup for the requested location.
 * Returns null rather than throwing: a geocode failure must never fail a job.
 */
/*
  When Nominatim cannot place the string, fall back to the cities of the state or
  country it names. This keeps the area gate consistent with the OSM source on a
  misspelled location: both key off the same table, so a lead the OSM source
  returned from any of those cities is measured against a real nearby city
  rather than refused as "requested area could not be geocoded" - which is
  exactly how a job with a typo'd location ended up dropping every candidate it
  collected.

  The whole list is returned, not just the densest city: a typo names no single
  place, and OSM queries every one of these cities, so accepting only one would
  reintroduce the mismatch this exists to remove.
*/
function fallbackCenters(location) {
  return stateFallbackCities(location).map(c => ({ lat: c.lat, lon: c.lon, label: c.label, fallback: true }));
}

/*
  The words to actually search with.

  Why this exists
  ---------------
  A user asked for "plumbers" in "Dellas, Federal District, Brazil". Nominatim
  resolves that string to a beauty salon inside a shopping centre in Asa Norte,
  Brasilia (addresstype=shop, type=beauty) - a real point, but not a place
  anybody searches for a trade in.

  The job therefore asked the engines for "plumbers in Dellas, Federal District,
  Brazil", which returns mall pages, city directories and blog posts instead of
  plumbers. It collected 255 results, dropped 175 as directories, failed 46 at
  the gate and saved 0 of the 10 leads it was asked for - twice.

  The coordinates were never the problem and are still the filter: a lead has to
  be near the requested point. Only the query text was wrong, because a search
  engine needs a locality, not a shop. When the request resolves to a POI, the
  containing city is used for the search text and the original point is kept for
  distance, so the job finally finds nearby businesses instead of failing.
*/
const localityCache = new Map();

// Nominatim addresstypes that already name a searchable place.
const PLACE_ADDRESSTYPES = new Set([
  "city", "town", "village", "hamlet", "municipality", "borough",
  "suburb", "neighbourhood", "quarter", "city_district", "district",
  "county", "state", "province", "region", "country", "state_district"
]);

/**
 * Pure decision: given a Nominatim hit, what should the search text be?
 * Exported so the rule can be tested without the network.
 */
export function localityFromHit(hit, raw = "") {
  const typed = String(raw || "").trim();
  const unchanged = { location: typed, changed: false, reason: "already a place" };

  if (!hit || typeof hit !== "object") return unchanged;

  const addresstype = String(hit.addresstype || hit.type || "").toLowerCase();
  if (!addresstype || PLACE_ADDRESSTYPES.has(addresstype)) return unchanged;

  const addr = hit.address || {};
  const city =
    addr.city || addr.town || addr.village || addr.municipality ||
    addr.suburb || addr.county || addr.state || "";

  if (!city || city.toLowerCase() === typed.toLowerCase()) return unchanged;

  return {
    location: city,
    changed: true,
    reason: `"${typed}" is a ${addresstype} inside ${city}, so the search used ${city}`
  };
}

export async function searchLocalityFor(location) {
  const raw = String(location || "").trim();
  const key = cacheKey(location);

  if (!key) return { location: raw, changed: false, reason: "no location given" };
  if (localityCache.has(key)) return localityCache.get(key);

  let result = { location: raw, changed: false, reason: "already a place" };

  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=" +
      encodeURIComponent(raw);

    const res = await fetch(url, {
      headers: {
        "User-Agent": "leadmoz-leadfinder/1.0 (lead generation tool)",
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (res.ok) {
      const rows = await res.json();
      result = localityFromHit(Array.isArray(rows) ? rows[0] : null, raw);
    }
  } catch {
    // A geocode failure must never fail a job: search the text as typed.
  }

  localityCache.set(key, result);
  return result;
}

/**
 * Memoised centre lookup for the requested location.
 * Returns an array of acceptable centres, or [] rather than throwing: a
 * geocode failure must never fail a job.
 */
export async function requestedAreaCenters(location) {
  const key = cacheKey(location);
  if (!key) return [];
  if (centerCache.has(key)) return centerCache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const task = fetchCenter(location)
    .then(center => (center ? [center] : fallbackCenters(location)))
    .catch(() => fallbackCenters(location))
    .then(centers => {
      if (centers.length) centerCache.set(key, centers);
      return centers;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/**
 * Single-centre convenience wrapper: the location's own point when it resolves,
 * otherwise the first fallback city.
 */
export async function requestedAreaCenter(location) {
  const [first] = await requestedAreaCenters(location);
  return first || null;
}

/**
 * Verdict for one lead against the requested area.
 *
 * @returns {Promise<{inArea:boolean, distanceKm:number|null, viaGeo:boolean, reason:string}>}
 */
export async function metroAreaVerdict(scraped, location, radiusKm = DEFAULT_METRO_RADIUS_KM) {
  const base = { inArea: false, distanceKm: null, viaGeo: false, reason: "no coordinates" };

  const point =
    scraped?.location ||
    (Number.isFinite(Number(scraped?.lat)) && Number.isFinite(Number(scraped?.lon))
      ? { lat: Number(scraped.lat), lon: Number(scraped.lon) }
      : null);

  if (!point) return base;

  const centers = await requestedAreaCenters(location);
  if (!centers.length) {
    return { ...base, reason: "requested area could not be geocoded" };
  }

  /*
    Nearest accepted centre wins. Normally there is exactly one (the geocoded
    location). On an unrecognised location there are several (the state's
    cities), so a lead is in-area if it is near ANY of them - matching the set
    of cities OSM was asked about.
  */
  let best = null;
  for (const center of centers) {
    const d = haversineKm(point, center);
    if (d == null) continue;
    if (!best || d < best.distanceKm) best = { distanceKm: d, center };
  }
  if (!best) return base;

  const limit = Number(radiusKm) || DEFAULT_METRO_RADIUS_KM;
  const inArea = best.distanceKm <= limit;
  const where = best.center.fallback ? `assumed ${best.center.label} (from "${location}")` : location;

  return {
    inArea,
    distanceKm: best.distanceKm,
    viaGeo: true,
    reason: inArea
      ? `${best.distanceKm.toFixed(1)}km from ${where} (within ${limit}km)`
      : `${best.distanceKm.toFixed(1)}km from ${where} (beyond ${limit}km)`
  };
}

export const METRO_RADIUS_OPTIONS = [15, 25, 40, 60];