import path from "node:path";
import { readJsonWithBackup, writeJsonAtomic } from "./atomicJson.js";

const dataDir = path.join(process.cwd(), "data");
const RATES_PATH = path.join(dataDir, "rates.json");
const FETCH_URL = "https://open.er-api.com/v6/latest/USD";
const TTL_MS = 2 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const EMPTY = {};

let inFlight = null;

function readCached() {
  const d = readJsonWithBackup(RATES_PATH, EMPTY);
  return {
    usdPkr: Number(d.usdPkr) || 0,
    usdInr: Number(d.usdInr) || 0,
    asOf: d.asOf || "",
    updatedAt: d.updatedAt || ""
  };
}

function writeCached(rates) {
  writeJsonAtomic(RATES_PATH, rates);
}

function isFresh(r) {
  if (!(r.usdPkr > 0) || !(r.usdInr > 0)) return false;
  if (!r.updatedAt) return false;
  return Date.now() - new Date(r.updatedAt).getTime() < TTL_MS;
}

async function fetchRates() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(FETCH_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`rates http ${res.status}`);
    const json = await res.json();
    if (!json || typeof json.rates !== "object") throw new Error("bad payload");
    const usdPkr = Number(json.rates.PKR) || 0;
    const usdInr = Number(json.rates.INR) || 0;
    if (!(usdPkr > 0) || !(usdInr > 0)) throw new Error("missing currencies");
    const feedTime = Number(json.time_last_update_unix) || 0;
    return {
      usdPkr,
      usdInr,
      asOf: feedTime > 0 ? new Date(feedTime * 1000).toISOString() : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timer);
  }
}

/*
  Returns fresh rates when available. While a refresh is in flight, concurrent
  callers share the same promise so a burst of requests only hits the API once.
  If the API is down, serve the last-known cached values marked stale rather
  than breaking every checkout page.
*/
export async function getRates() {
  const cached = readCached();
  if (isFresh(cached)) return { ok: true, stale: false, ...cached };

  if (!inFlight) {
    inFlight = fetchRates()
      .then(r => { writeCached(r); return r; })
      .catch(() => null)
      .finally(() => { inFlight = null; });
  }
  const freshData = await inFlight;

  if (freshData) return { ok: true, stale: false, ...freshData };
  if (cached.usdPkr > 0 && cached.usdInr > 0) return { ok: true, stale: true, ...cached };
  return { ok: false };
}

export function convert(usd, currency, rates) {
  const amount = Number(usd) || 0;
  if (!rates || !(rates.usdPkr > 0) || !(rates.usdInr > 0)) return null;
  if (currency === "PKR") return amount * rates.usdPkr;
  if (currency === "INR") return amount * rates.usdInr;
  return amount;
}

export function formatLocal(usd, currency, rates) {
  const value = convert(usd, currency, rates);
  if (value == null) return null;
  const grouped = Math.round(value).toLocaleString("en-US");
  if (currency === "PKR") return `Rs ${grouped}`;
  if (currency === "INR") return `₹${grouped}`;
  return `$${grouped}`;
}

export function registerRatesRoute(app) {
  app.get("/api/rates", async (_req, res) => {
    const r = await getRates();
    if (!r.ok) return res.status(503).json({ ok: false });
    res.setHeader("Cache-Control", "max-age=600");
    res.json({
      ok: true,
      usdPkr: r.usdPkr,
      usdInr: r.usdInr,
      updatedAt: r.updatedAt,
      asOf: r.asOf || "",
      stale: !!r.stale
    });
  });
}