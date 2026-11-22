import fs from "fs";
import path from "path";
import crypto from "crypto";

const dataDir = path.join(process.cwd(), "data");
const cachePath = path.join(dataDir, "domain-cache.json");

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

function loadCache() {
  try {
    if (fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn("domain-cache read failed:", err.message);
  }
  return {};
}

function saveCache(cache) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const pruned = {};
    const entries = Object.entries(cache || {}).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
    for (let i = 0; i < entries.length && i < MAX_ENTRIES; i += 1) {
      const [k, v] = entries[i];
      if (v && typeof v === "object") pruned[k] = v;
    }
    fs.writeFileSync(cachePath, JSON.stringify(pruned, null, 2));
  } catch (err) {
    console.warn("domain-cache write failed:", err.message);
  }
}

function domainKey(url = "") {
  try {
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) {
      return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    }
    return String(url).replace(/^www\./, "").split("/")[0].toLowerCase();
  } catch {
    return String(url).toLowerCase().trim();
  }
}

export function cacheKeyForScrape(url = "") {
  const d = domainKey(url);
  if (!d) return "";
  return `scrape:${d}`;
}

export function cacheKeyForAi(url = "", kind = "classify") {
  const d = domainKey(url);
  if (!d) return "";
  return `ai:${kind}:${d}`;
}

export function getCached(key, ttlMs = DEFAULT_TTL_MS) {
  if (!key) return null;
  const cache = loadCache();
  const entry = cache[key];
  if (!entry || typeof entry !== "object") return null;
  const at = Number(entry.at || 0);
  if (!at || Date.now() - at > ttlMs) {
    delete cache[key];
    saveCache(cache);
    return null;
  }
  try {
    return entry.value;
  } catch {
    return null;
  }
}

export function setCached(key, value, ttlMs = DEFAULT_TTL_MS) {
  if (!key) return;
  const cache = loadCache();
  cache[key] = { value, at: Date.now(), ttlMs };
  saveCache(cache);
}

export function cachedDomain(url = "") {
  return domainKey(url);
}
