import path from "path";
import { readJsonWithBackup, writeJsonAtomic } from "./atomicJson.js";
import { enrichmentLimits } from "./enrichmentConfig.js";

/*
  Company enrichment cache.

  Re-enriching the same domain is the most common repeat action (a user refreshes
  the page, retries a job, or reuses a company already seen through lead
  generation). A fresh cached bundle is returned for FREE and without touching a
  provider, which is both the cost control and the "0 credits for cached data"
  rule from the product spec.
*/

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "enrichment-cache.json");
const MAX_ENTRIES = 2000;

function emptyCache() {
  return { version: 1, domains: {} };
}

function readCache() {
  const raw = readJsonWithBackup(FILE, emptyCache);
  return {
    version: 1,
    domains: raw && typeof raw.domains === "object" && raw.domains ? raw.domains : {}
  };
}

function writeCache(data) {
  writeJsonAtomic(FILE, data);
}

export function getCachedEnrichment(domain) {
  const key = String(domain || "").toLowerCase();
  if (!key) return null;
  const entry = readCache().domains[key];
  if (!entry || !entry.data) return null;
  const expiresMs = new Date(entry.expiresAt || 0).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return null;
  return { data: entry.data, savedAt: entry.savedAt, expiresAt: entry.expiresAt, cached: true };
}

export function setCachedEnrichment(domain, data) {
  const key = String(domain || "").toLowerCase();
  if (!key || !data) return null;

  const cache = readCache();
  const ttlMs = enrichmentLimits().cacheTtlDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  cache.domains[key] = {
    savedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    data
  };

  const keys = Object.keys(cache.domains);
  if (keys.length > MAX_ENTRIES) {
    const oldest = keys.sort((a, b) =>
      String(cache.domains[a].savedAt).localeCompare(String(cache.domains[b].savedAt))
    );
    for (const k of oldest.slice(0, keys.length - MAX_ENTRIES)) delete cache.domains[k];
  }

  writeCache(cache);
  return cache.domains[key];
}

export function purgeCacheForDomain(domain) {
  const key = String(domain || "").toLowerCase();
  const cache = readCache();
  if (!cache.domains[key]) return false;
  delete cache.domains[key];
  writeCache(cache);
  return true;
}

export function cacheStats() {
  const domains = readCache().domains;
  const keys = Object.keys(domains);
  return {
    entries: keys.length,
    expired: keys.filter(k => new Date(domains[k].expiresAt || 0).getTime() <= Date.now()).length
  };
}
