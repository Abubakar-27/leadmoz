import path from "path";
import { readJsonWithBackup, writeJsonAtomic } from "./atomicJson.js";

/*
  Signup-email capture for payment-intent visitors.

  A buyer clicks "Get Starter/Pro/Agency" and lands on /auth?plan=<paid> while
  logged out, so the payment-visit tracker can only see an anonymous device
  handle. The moment that visitor types their email to start signing up we know
  who they are - even if they never finish - so we remember the email against
  the same first-party device handle the tracker already uses.

  Scope and privacy: only paid-plan signups are recorded (a free signup becomes
  a registered user and is identified by their account anyway), the value is the
  email the visitor themselves submitted on our own page, and entries expire
  after RETENTION_MS so this is not an indefinite log. It is internal,
  admin-only data - never exposed to any client.
*/

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "paymentIntents.json");

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

function emptyState() {
  return { version: 1, byDevice: {} };
}

function read() {
  const data = readJsonWithBackup(FILE, emptyState);
  return {
    version: 1,
    byDevice: data && typeof data.byDevice === "object" && data.byDevice ? data.byDevice : {}
  };
}

function write(data) {
  writeJsonAtomic(FILE, data, { backup: false });
}

/*
  Remember the email a paid-plan visitor entered. Idempotent per device: a second
  start (or a corrected address) updates the stored email and timestamp.
*/
export function recordIntentEmail(deviceHash, email, plan) {
  const key = String(deviceHash || "");
  const addr = String(email || "").trim();
  if (!key || !addr) return { ok: false };

  const now = Date.now();
  const data = read();
  const existing = data.byDevice[key];
  data.byDevice[key] = {
    email: addr,
    plan: String(plan || "").toLowerCase(),
    firstAt: existing && existing.firstAt ? existing.firstAt : now,
    lastAt: now
  };

  for (const [k, entry] of Object.entries(data.byDevice)) {
    if (!entry || now - Number(entry.lastAt || 0) > RETENTION_MS) delete data.byDevice[k];
  }

  const keys = Object.keys(data.byDevice);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => Number(data.byDevice[a].lastAt || 0) - Number(data.byDevice[b].lastAt || 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach(k => delete data.byDevice[k]);
  }

  write(data);
  return { ok: true };
}

export function emailForDevice(deviceHash) {
  const key = String(deviceHash || "");
  if (!key) return null;
  const entry = read().byDevice[key];
  return entry ? { email: String(entry.email || ""), plan: String(entry.plan || "") } : null;
}
