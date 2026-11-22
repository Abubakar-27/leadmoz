import axios from "axios";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

function normalizePhone(val) {
  return String(val || "").replace(/[^+\d]/g, "");
}

export function buildOverpassQuery({ bbox, city, tags = [] } = {}) {
  const tagFilters = tags.length
    ? tags
    : ["amenity=restaurant", "shop=*", "office=*", "craft=*"];

  const tagClauses = tagFilters.map((t) => {
    if (t.includes("=")) {
      const [k, v] = t.split("=");
      if (v === "*") return `node[${k}](area);way[${k}](area);`;
      return `node[${k}=${v}](area);way[${k}=${v}](area);`;
    }
    return `node[tag~"${t}",i](area);way[tag~"${t}",i](area);`;
  });

  const query = `
[out:json][timeout:60];
(${tagClauses.join("")});
foreach (
  out center;
);
`;
  return query;
}

export async function mineOsmLeads({ bbox, city, tags } = {}) {
  const query = buildOverpassQuery({ bbox, city, tags });
  const payload = { data: query };
  let lastError;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await axios.post(endpoint, payload, {
        timeout: 60000,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        transformRequest: [(data) => new URLSearchParams(data).toString()],
      });

      const elements = res.data?.elements || [];
      const results = [];

      for (const el of elements) {
        const t = el.tags || {};
        if (t.website) continue;

        const phone = t.phone || t["contact:phone"] || t["phone:mobile"] || "";
        const email = t.email || t["contact:email"] || "";
        if (!phone && !email) continue;

        const lat = el.lat || el.center?.lat || el.nodes?.[0]?.lat;
        const lon = el.lon || el.center?.lon || el.nodes?.[0]?.lon;

        results.push({
          business_name: t.name || t["name:en"] || "",
          category: t.amenity || t.shop || t.office || t.craft || "",
          phone: normalizePhone(phone),
          email: String(email || "").trim(),
          geographic_coordinates: lat && lon ? `${lat},${lon}` : "",
          source: "OSM",
        });
      }
      return results;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("OSM mining failed");
}
