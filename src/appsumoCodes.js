import fs from "fs";
import path from "path";
import crypto from "crypto";
import { readJsonWithBackup, writeJsonAtomic } from "./atomicJson.js";

/*
  AppSumo redemption codes, stored like promoCodes.json: one JSON file, written
  crash-safely through atomicJson helpers, keyed by a normalised code string.

  Each record mirrors the requested appsumo_codes table shape:
    id            text, random UUID (primary key)
    code_string   text, canonical display form, e.g. "LEAD-XXXXX-XXXXX"
    is_used       boolean, default false
    redeemed_at   timestamp, null until claimed
    user_id       text, account that claimed it, null until claimed
    tier_level    integer, default 1 (Tier 1 = 5 leads/day, lifetime)
    created_at    timestamp when the code was imported

  Lookups compare on a normalised key (uppercase, no spaces/underscores, no
  dashes) so "lead-xxxxx-xxxxx" and "LEAD-XXXXX-XXXXX" and "LEADXXXXX-XXXXX"
  all resolve to the same record, the same loose matching promoCodes uses.
*/

const DATA_DIR = path.join(process.cwd(), "data");
export const APP_SUMO_CODES_FILE = path.join(DATA_DIR, "appsumoCodes.json");

function emptySumoCodes() {
  return { codes: [], meta: { importedCount: 0 } };
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(APP_SUMO_CODES_FILE) && !fs.existsSync(`${APP_SUMO_CODES_FILE}.bak`)) {
    writeJsonAtomic(APP_SUMO_CODES_FILE, emptySumoCodes(), { backup: false });
  }
}

function toCodeKey(code = "") {
  return String(code).toUpperCase().replace(/[\s_]/g, "").replace(/-+/g, "");
}

export function readSumoCodes() {
  ensureFile();
  const data = readJsonWithBackup(APP_SUMO_CODES_FILE, emptySumoCodes);
  return {
    codes: Array.isArray(data.codes) ? data.codes : [],
    meta: data.meta || { importedCount: 0 }
  };
}

export function writeSumoCodes(data) {
  ensureFile();
  writeJsonAtomic(APP_SUMO_CODES_FILE, data);
}

export function sumoCodeCount() {
  return readSumoCodes().codes.length;
}

export function getSumoCode(code) {
  const key = toCodeKey(code);
  if (!key) return null;
  const rec = readSumoCodes().codes.find(c => toCodeKey(c.code_string) === key);
  return rec
    ? { ...rec, is_used: rec.is_used === true, tier_level: Number(rec.tier_level || 1) }
    : null;
}

/*
  Idempotent bulk import for the seeding script and tests. Duplicate rows inside
  the batch and rows already in the store are skipped, so re-running a seed only
  adds what is missing. Canonical display form keeps the dashes from the CSV;
  uniqueness is enforced on the normalised key.
*/
export function insertSumoCodes(codeStrings) {
  const data = readSumoCodes();
  const existing = data.codes;
  const norm = c => toCodeKey(c.code_string);
  const seen = new Set();
  let added = 0, skipped = 0, invalid = 0;

  for (const raw of codeStrings) {
    const cleaned = String(raw || "").trim();
    const key = toCodeKey(cleaned);
    if (!cleaned || !key || !/^LEAD/i.test(cleaned)) {
      invalid += 1;
      continue;
    }
    if (seen.has(key) || existing.some(c => norm(c) === key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    existing.push({
      id: crypto.randomUUID(),
      code_string: cleaned.toUpperCase(),
      is_used: false,
      redeemed_at: null,
      user_id: null,
      tier_level: 1,
      created_at: new Date().toISOString()
    });
    added += 1;
  }

  if (added) {
    data.meta.importedCount = existing.length;
    writeSumoCodes(data);
  }

  return { added, skipped, invalid, total: existing.length };
}

/*
  The claim. Re-reads the store and marks the record used in the same local
  write as the response is derived from, so a code can never be handed out twice
  from one request. The caller pre-checks with getSumoCode before creating an
  account; this re-check is what makes a claim that lost a race fail cleanly.
*/
export function claimSumoCode(codeString, userId) {
  const data = readSumoCodes();
  const rec = data.codes.find(c => toCodeKey(c.code_string) === toCodeKey(codeString)) || null;
  if (!rec) {
    return { ok: false, error: "Invalid code. Please double-check your code." };
  }
  if (rec.is_used === true) {
    return { ok: false, error: "This code has already been redeemed." };
  }
  rec.is_used = true;
  rec.redeemed_at = new Date().toISOString();
  rec.user_id = String(userId || "");
  writeSumoCodes(data);
  return {
    ok: true,
    code: rec.code_string,
    tier_level: Number(rec.tier_level || 1)
  };
}