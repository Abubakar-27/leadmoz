import { cacheKeyForAi, getCached, setCached } from "./domainCache.js";

const AI_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function cachedClassify(url = "", niche = "", location = "") {
  const key = cacheKeyForAi(url, "classify");
  if (!key) return null;
  return getCached(key, AI_CACHE_TTL_MS);
}

export function setCachedClassify(url = "", niche = "", location = "", value) {
  const key = cacheKeyForAi(url, "classify");
  if (!key) return;
  setCached(key, value, AI_CACHE_TTL_MS);
}

export function cachedAnalyze(url = "", niche = "", location = "") {
  const key = cacheKeyForAi(url, "analyze");
  if (!key) return null;
  return getCached(key, AI_CACHE_TTL_MS);
}

export function setCachedAnalyze(url = "", niche = "", location = "", value) {
  const key = cacheKeyForAi(url, "analyze");
  if (!key) return;
  setCached(key, value, AI_CACHE_TTL_MS);
}
