/*
  Google Maps sidecar source — ADDITIVE ONLY.

  This module never changes how the existing search engine works. It is a set of
  pure helpers plus a thin Docker/CLI wrapper used by scripts/gmaps-enrich.mjs.

  Design rules (keep these if you extend it):
  1. Everything is off unless GMAPS_ENABLED=true. Nothing in server.js, worker.js
     or search.js imports this file, so the old pipeline cannot be affected.
  2. Enrichment is stored under a NEW `lead.gmaps` key. Existing lead fields are
     never overwritten, so the dashboard, CSV export and AI scoring keep seeing
     exactly the shapes they already expect.
  3. No shell interpolation. The scraper is launched with spawn() and an args
     array; business names only ever reach a UTF-8 query file, never a command.
  4. No new npm dependencies — Node built-ins only.

  The external tool is gosom/google-maps-scraper (MIT). It drives the public
  Google Maps web UI and needs no Google API key. Review Google's Terms of
  Service before using it for production lead generation.
*/

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { loadEnv } from "./config.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function flag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

/** Reads .env (if present) and returns the sidecar configuration. */
export function gmapsConfig(projectRoot = process.cwd()) {
  if (!process.env.GMAPS_LOADED) {
    loadEnv();
    process.env.GMAPS_LOADED = "1";
  }

  const workDir = path.resolve(
    process.env.GMAPS_WORK_DIR || path.join(projectRoot, "data", "gmaps")
  );

  return {
    enabled: flag(process.env.GMAPS_ENABLED, false),
    mode: String(process.env.GMAPS_MODE || "docker").toLowerCase() === "binary" ? "binary" : "docker",
    image: String(process.env.GMAPS_IMAGE || "gosom/google-maps-scraper"),
    binary: String(process.env.GMAPS_BINARY || "google-maps-scraper"),
    cacheVolume: String(process.env.GMAPS_CACHE_VOLUME || "gmaps-playwright-cache"),
    workDir,
    depth: Math.max(1, Math.min(20, Number(process.env.GMAPS_DEPTH) || 1)),
    concurrency: Math.max(1, Math.min(16, Number(process.env.GMAPS_CONCURRENCY) || 2)),
    maxQueries: Math.max(1, Math.min(500, Number(process.env.GMAPS_MAX_QUERIES) || 50)),
    timeoutMs: Math.max(30000, Number(process.env.GMAPS_TIMEOUT_MS) || 15 * 60 * 1000),
    extraArgs: String(process.env.GMAPS_EXTRA_ARGS || ""),
    allowNameLocationMatch: flag(process.env.GMAPS_ALLOW_NAME_LOCATION_MATCH, true)
  };
}

/* ------------------------------------------------------------------ *
 * Normalization of the scraper's JSONL output
 * ------------------------------------------------------------------ */

/** Docker Desktop on Windows accepts D:/path style bind sources. */
function dockerPath(value) {
  return String(value).replace(/\\/g, "/");
}

function asText(value, max = 500) {
  return String(value === undefined || value === null ? "" : value).slice(0, max);
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Converts one scraper Entry into a flat, easy-to-read object.
 * Stored under lead.gmaps, never spread onto the lead itself.
 */
export function normalizeGmapsEntry(entry = {}) {
  const address = entry.complete_address || {};
  const longitude = entry.longitude !== undefined ? entry.longitude : entry.longtitude;

  return {
    source: "google_maps",
    placeId: asText(entry.place_id, 120),
    cid: asText(entry.cid, 120),
    dataId: asText(entry.data_id, 120),
    plusCode: asText(entry.plus_code, 120),
    title: asText(entry.title, 200),
    category: asText(entry.category, 200),
    categories: Array.isArray(entry.categories) ? entry.categories.map(v => asText(v, 120)).slice(0, 20) : [],
    address: asText(entry.address, 300),
    completeAddress: {
      borough: asText(address.borough, 120),
      street: asText(address.street, 200),
      city: asText(address.city, 120),
      postalCode: asText(address.postal_code, 60),
      state: asText(address.state, 120),
      country: asText(address.country, 120)
    },
    phone: asText(entry.phone, 60),
    website: asText(entry.web_site, 500),
    latitude: asNumber(entry.latitude),
    longitude: asNumber(longitude),
    reviewCount: asNumber(entry.review_count),
    reviewRating: asNumber(entry.review_rating),
    reviewsPerRating: entry.reviews_per_rating && typeof entry.reviews_per_rating === "object"
      ? { ...entry.reviews_per_rating }
      : {},
    openHours: entry.open_hours && typeof entry.open_hours === "object"
      ? { ...entry.open_hours }
      : {},
    priceRange: asText(entry.price_range, 80),
    status: asText(entry.status, 80),
    timezone: asText(entry.timezone, 80),
    description: asText(entry.description, 1000),
    thumbnail: asText(entry.thumbnail, 800),
    streetViewUrl: asText(entry.street_view_url, 800),
    reviewsLink: asText(entry.reviews_link, 800),
    owner: entry.owner && typeof entry.owner === "object"
      ? {
          id: asText(entry.owner.id, 120),
          name: asText(entry.owner.name, 200),
          link: asText(entry.owner.link, 800)
        }
      : null,
    about: Array.isArray(entry.about) ? entry.about.slice(0, 30) : [],
    images: Array.isArray(entry.images) ? entry.images.slice(0, 20) : [],
    emailCount: Array.isArray(entry.emails) ? entry.emails.length : 0,
    reviewCountCollected: Array.isArray(entry.user_reviews) ? entry.user_reviews.length : 0,
    reviewCollection: entry.review_collection || null,
    scrapedAt: new Date().toISOString()
  };
}

/** Reads JSON Lines (one Entry per line). Also tolerates a pretty JSON array. */
export function readGmapsJsonl(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(normalizeGmapsEntry);
  } catch {
    /* normal case: JSON Lines */
  }

  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const entry = JSON.parse(text);
      if (entry && typeof entry === "object") out.push(normalizeGmapsEntry(entry));
    } catch {
      /* skip a partial/truncated line rather than losing the whole file */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Matching helpers
 * ------------------------------------------------------------------ */

export function domainKey(value = "") {
  let raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    return new URL(raw).hostname.replace(/^www\./, "").replace(/:\d+$/, "");
  } catch {
    return "";
  }
}

function phoneKey(value = "") {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : "";
}

function nameKey(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function locationTokens(location = "") {
  return nameKey(location)
    .split(" ")
    .filter(word => word.length > 2 && !["the", "and", "for", "in", "at"].includes(word));
}

/** Returns { leadIndex, entryIndex, matchBy, confidence } for the best matches. */
export function matchEntriesToLeads(leads = [], entries = [], options = {}) {
  const usedEntries = new Set();
  const matches = [];
  const location = String(options.location || "");
  const tokens = locationTokens(location);
  const allowNameLocation = options.allowNameLocationMatch !== false;

  leads.forEach((lead, leadIndex) => {
    if (!lead || typeof lead !== "object") return;

    const leadDomain = domainKey(lead.website || lead.url || "");
    const leadPhone = phoneKey(lead.primaryPhone || lead.phone || "");
    const leadName = nameKey(lead.businessName || lead.name || "");
    if (!leadDomain && !leadPhone && !leadName) return;

    let best = null;
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      if (usedEntries.has(entryIndex)) continue;
      const entry = entries[entryIndex];

      const sameDomain = Boolean(leadDomain && domainKey(entry.website) === leadDomain);
      const samePhone = Boolean(leadPhone && phoneKey(entry.phone) === leadPhone);
      const entryName = nameKey(entry.title);
      const entryBlob = nameKey(`${entry.title} ${entry.address} ${entry.completeAddress?.city || ""}`);
      const sameNameAndArea = Boolean(
        allowNameLocation &&
        leadName &&
        entryName === leadName &&
        tokens.length &&
        tokens.some(token => entryBlob.includes(token))
      );

      if (!sameDomain && !samePhone && !sameNameAndArea) continue;

      const rank = sameDomain ? 3 : samePhone ? 2 : 1;
      if (!best || rank > best.rank) {
        best = {
          rank,
          leadIndex,
          entryIndex,
          matchBy: sameDomain ? "domain" : samePhone ? "phone" : "name+location",
          confidence: rank >= 2 ? "high" : "medium"
        };
      }
      if (rank === 3) break;
    }

    if (best) {
      usedEntries.add(best.entryIndex);
      delete best.rank;
      matches.push(best);
    }
  });

  return matches;
}

/**
 * Writes enrichment into a NEW nested key on each matched lead.
 * Returns the number of leads changed.
 */
export function applyGmapsMatches(leads = [], entries = [], matches = []) {
  let changed = 0;
  for (const match of matches) {
    const lead = leads[match.leadIndex];
    const entry = entries[match.entryIndex];
    if (!lead || !entry) continue;

    lead.gmaps = {
      ...entry,
      matchedBy: match.matchBy,
      matchConfidence: match.confidence
    };
    changed += 1;
  }
  return changed;
}

/* ------------------------------------------------------------------ *
 * Query building
 * ------------------------------------------------------------------ */

/** One query per lead, capped and de-duplicated. Names are sanitized. */
export function buildQueries(leads = [], location = "", maxQueries = 50) {
  const area = String(location || "").replace(/[\r\n\t]+/g, " ").trim();
  const seen = new Set();
  const queries = [];

  for (const lead of leads) {
    if (!lead || typeof lead !== "object") continue;
    const name = String(lead.businessName || lead.name || "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[|;&$`]/g, "")
      .trim();
    if (!name) continue;

    const query = area && !name.toLowerCase().includes(area.toLowerCase())
      ? `${name} ${area}`
      : name;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= maxQueries) break;
  }

  return queries;
}

/* ------------------------------------------------------------------ *
 * Scraper invocation (Docker or binary)
 * ------------------------------------------------------------------ */

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Scraper timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Scraper exited with code ${code}: ${stderr.slice(-800) || stdout.slice(-800)}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Runs the scraper for the given queries and returns the JSONL file path.
 * With --dry-run in the caller this function is simply not called.
 */
export async function runGmapsScrape(queries = [], config = gmapsConfig()) {
  if (!queries.length) throw new Error("No queries to scrape");

  fs.mkdirSync(config.workDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const queryFile = path.join(config.workDir, `queries-${stamp}.txt`);
  const resultFile = path.join(config.workDir, `results-${stamp}.jsonl`);
  fs.writeFileSync(queryFile, queries.join("\n") + "\n", "utf8");

  const extra = config.extraArgs
    ? config.extraArgs.split(/\s+/).filter(Boolean)
    : [];

  let command;
  let args;

  if (config.mode === "binary") {
    command = config.binary;
    args = [
      "-input", queryFile,
      "-results", resultFile,
      "-json",
      "-depth", String(config.depth),
      "-c", String(config.concurrency),
      "-exit-on-inactivity", "3m",
      ...extra
    ];
  } else {
    command = "docker";
    args = [
      "run", "--rm",
      "-v", `${config.cacheVolume}:/opt`,
      "-v", `${dockerPath(config.workDir)}:/work`,
      "-e", "DISABLE_TELEMETRY=1",
      config.image,
      "-input", "/work/" + path.basename(queryFile),
      "-results", "/work/" + path.basename(resultFile),
      "-json",
      "-depth", String(config.depth),
      "-c", String(config.concurrency),
      "-exit-on-inactivity", "3m",
      ...extra
    ];
  }

  try {
    await runProcess(command, args, config.timeoutMs);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        config.mode === "docker"
          ? "Docker was not found. Install Docker Desktop, or set GMAPS_MODE=binary and GMAPS_BINARY=<path>."
          : `Scraper binary not found: ${config.binary}`
      );
    }
    throw err;
  }

  if (!fs.existsSync(resultFile)) {
    throw new Error(`Scraper finished but wrote no results file: ${resultFile}`);
  }
  return resultFile;
}

/* ------------------------------------------------------------------ *
 * Small report helper (avoids touching the existing leadsToCsv)
 * ------------------------------------------------------------------ */

function csvCell(value) {
  let text = String(value === undefined || value === null ? "" : value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Writes a separate CSV report; your existing CSV export is untouched. */
export function writeEnrichmentCsv(filePath, rows = []) {
  const columns = [
    "jobId", "businessName", "website", "gmaps.title", "gmaps.phone",
    "gmaps.category", "gmaps.address", "gmaps.rating", "gmaps.reviews",
    "gmaps.status", "gmaps.placeId", "gmaps.matchBy", "gmaps.confidence"
  ];
  const lines = [columns.map(csvCell).join(",")];

  for (const row of rows) {
    const g = row.lead?.gmaps || {};
    lines.push([
      row.jobId,
      row.lead?.businessName || row.lead?.name || "",
      row.lead?.website || "",
      g.title,
      g.phone,
      g.category,
      g.address,
      g.reviewRating,
      g.reviewCount,
      g.status,
      g.placeId,
      g.matchedBy,
      g.matchConfidence
    ].map(csvCell).join(","));
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}
