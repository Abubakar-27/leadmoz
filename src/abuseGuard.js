import crypto from "crypto";
import path from "path";
import { readJsonWithBackup, writeJsonAtomic } from "./atomicJson.js";

/*
  Layered abuse prevention for the free intro credits.

  The abuse this exists to stop is not a clever attacker; it is the obvious
  loop: register, claim the free credits, register again, claim again. Email
  verification alone does not stop it (throwaway inboxes are cheap), IP alone
  does not stop it (offices, universities, households and mobile carriers share
  addresses, and a permanent IP ban would lock out legitimate users), and
  fingerprinting is invasive and fragile. So this module provides several
  independent, proportionate signals, each used to THROTTLE or to raise a risk
  score - never to silently and permanently ban a shared address.

  All state is server-side and persisted to data/abuse.json with the same
  crash-safe atomic write the rest of the app uses, so a restart does not hand
  an attacker a fresh budget. The deployment is a single process; the counters
  are therefore consistent within it. A multi-instance deployment would need a
  shared store (documented in the report).

  IP resolution NEVER reads X-Forwarded-For by hand. Express is configured with
  trust proxy = 1 and nginx is the only hop, so req.ip is already the resolved
  client address with spoofed entries stripped.
*/

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "abuse.json");

const HOUR_MS = 60 * 60 * 1000;
const DEVICE_COOKIE = "cf_device";
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function num(envName, fallback) {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/*
  Thresholds are configurable so they can be tuned in production without a code
  change. The defaults are deliberately generous enough that a normal office or
  household behind one IP is never throttled.
*/
export function abuseLimits() {
  return {
    signupPerIpPerHour: num("ABUSE_SIGNUP_PER_IP_PER_HOUR", 5),
    verifyEmailPerIpPerHour: num("ABUSE_VERIFY_EMAIL_PER_IP_PER_HOUR", 12),
    verifyEmailPerAddressPerHour: num("ABUSE_VERIFY_EMAIL_PER_ADDRESS_PER_HOUR", 6),
    generationsPerIpPerHour: num("ABUSE_GENERATIONS_PER_IP_PER_HOUR", 60),
    deviceAccountsMax: num("ABUSE_DEVICE_ACCOUNTS_MAX", 4),
    /*
      Any form that causes outbound mail. Test/save are counted per account
      because a single user can point them at an arbitrary recipient; campaign
      sends are additionally capped by the plan's daily send limit.
    */
    emailTestPerUserPerHour: num("ABUSE_EMAIL_TEST_PER_USER_PER_HOUR", 10),
    emailTestPerIpPerHour: num("ABUSE_EMAIL_TEST_PER_IP_PER_HOUR", 30),
    emailSendPerUserPerHour: num("ABUSE_EMAIL_SEND_PER_USER_PER_HOUR", 60),
    emailSendPerIpPerHour: num("ABUSE_EMAIL_SEND_PER_IP_PER_HOUR", 120),
    subscribePerIpPerHour: num("ABUSE_SUBSCRIBE_PER_IP_PER_HOUR", 10)
  };
}

function emptyState() {
  return { counters: {}, devices: {} };
}

function readState() {
  const data = readJsonWithBackup(FILE, emptyState);
  return {
    counters: data && typeof data.counters === "object" && data.counters ? data.counters : {},
    devices: data && typeof data.devices === "object" && data.devices ? data.devices : {}
  };
}

function writeState(data) {
  writeJsonAtomic(FILE, data, { backup: false });
}

function prune(state, now) {
  for (const key of Object.keys(state.counters)) {
    const entry = state.counters[key];
    if (!entry || Number(entry.resetAt || 0) < now - HOUR_MS) delete state.counters[key];
  }
}

/*
  Express is told to trust one proxy hop, so req.ip is the real client. The
  socket address is only a fallback for the case where req.ip is somehow absent.
*/
export function clientIp(req) {
  if (req && req.ip) return String(req.ip);
  if (req && req.socket && req.socket.remoteAddress) {
    return String(req.socket.remoteAddress).replace(/^::ffff:/, "");
  }
  return "unknown";
}

/*
  Increment a fixed-window counter and report whether the caller is within it.
  A fixed window is used because it is cheap, and these are burst limits (stop
  a script hammering signup), not precise quotas.
*/
export function consumeRate(key, limit, windowMs = HOUR_MS) {
  const now = Date.now();
  const state = readState();
  prune(state, now);

  let entry = state.counters[key];
  if (!entry || Number(entry.resetAt || 0) <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    state.counters[key] = entry;
  }

  entry.count += 1;
  const allowed = limit <= 0 ? false : entry.count <= limit;
  const remaining = Math.max(0, limit - entry.count);
  const retryAfterMs = allowed ? 0 : Math.max(0, Number(entry.resetAt) - now);

  writeState(state);

  return { allowed, count: entry.count, limit, remaining, retryAfterMs };
}

/*
  Shared 429 response for the routes that send email. Callers pass the result
  of consumeRate(); a true return means the response has already been sent and
  the handler must stop.
*/
export function rejectIfRateLimited(res, check, message) {
  if (!check || check.allowed) return false;
  const retryAfterSeconds = Math.max(1, Math.ceil(Number(check.retryAfterMs || 0) / 1000));
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    error: message || "Too many requests. Please try again in a little while.",
    retryInMinutes: Math.max(1, Math.ceil(retryAfterSeconds / 60))
  });
  return true;
}

export function peekRate(key) {
  const now = Date.now();
  const entry = readState().counters[key];
  if (!entry || Number(entry.resetAt || 0) <= now) return { count: 0, remaining: null };
  return { count: entry.count, resetAt: Number(entry.resetAt) };
}

export function resetRate(key) {
  const state = readState();
  if (state.counters[key]) {
    delete state.counters[key];
    writeState(state);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function parseCookies(req) {
  const header = (req && req.headers && req.headers.cookie) || "";
  const out = {};
  for (const piece of header.split(";")) {
    const v = piece.trim();
    if (!v) continue;
    const i = v.indexOf("=");
    if (i < 0) continue;
    out[decodeURIComponent(v.slice(0, i))] = decodeURIComponent(v.slice(i + 1));
  }
  return out;
}

/*
  A privacy-conscious, first-party device identifier. It is a random value, not
  a fingerprint: nothing about the visitor's hardware, fonts or canvas is
  collected. It is HttpOnly so scripts cannot read it, and it exists only to be
  ONE signal - an account created from the same device as several others is
  flagged for review, never auto-banned, because one device is routinely shared.
*/
export function ensureDeviceCookie(req, res) {
  const cookies = parseCookies(req);
  let id = cookies[DEVICE_COOKIE];
  if (id && /^[a-f0-9]{32,64}$/.test(id)) return id;

  id = crypto.randomBytes(24).toString("hex");
  const existing = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : undefined;
  const cookie = `${DEVICE_COOKIE}=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE}`;

  if (Array.isArray(existing)) res.setHeader("Set-Cookie", [...existing, cookie]);
  else if (existing) res.setHeader("Set-Cookie", [String(existing), cookie]);
  else res.setHeader("Set-Cookie", cookie);

  return id;
}

export function deviceIdFromRequest(req) {
  const cookies = parseCookies(req);
  const id = cookies[DEVICE_COOKIE];
  return id && /^[a-f0-9]{32,64}$/.test(id) ? id : "";
}

function hashDevice(deviceId) {
  return deviceId ? sha256(`device:${deviceId}`) : "";
}

/*
  Record that a user account was created from this device. Returns how many
  distinct accounts now share it, which feeds the risk score.
*/
export function registerDevice(deviceId, userId) {
  if (!deviceId || !userId) return { deviceHash: "", accounts: 0 };

  const hash = hashDevice(deviceId);
  const now = Date.now();
  const state = readState();
  prune(state, now);

  const entry = state.devices[hash] || { users: {}, firstSeen: now, lastSeen: now };
  const known = Object.keys(entry.users);
  if (!entry.users[userId]) entry.users[userId] = now;
  entry.lastSeen = now;
  if (known.length === 0) entry.firstSeen = now;
  state.devices[hash] = entry;

  writeState(state);
  return { deviceHash: hash, accounts: Object.keys(entry.users).length };
}

export function deviceAccountCount(deviceId) {
  if (!deviceId) return 0;
  const entry = readState().devices[hashDevice(deviceId)];
  return entry ? Object.keys(entry.users || {}).length : 0;
}

export function hashDeviceId(deviceId) {
  return hashDevice(deviceId);
}

/*
  Reverse of registerDevice: the accounts seen on a device handle. The handle is
  the same hash the analytics beacons use as an anonymous session id, so the
  admin payment-visit tracker can show which account a logged-out visitor later
  turned into instead of leaving them as a bare session string.
*/
export function accountsForDeviceHash(hash) {
  const h = String(hash || "");
  if (!h) return [];
  const entry = readState().devices[h];
  return entry ? Object.keys(entry.users || {}) : [];
}

/*
  Signals about an IP that are useful for review WITHOUT applying a blanket
  ban. Counting distinct accounts seen from an address over the last window
  tells a moderator whether a burst of signups looks like a shared office or a
  farming run; the decision stays human.
*/
export function ipAccountBurst(ip, userIds = []) {
  if (!ip) return 0;
  return userIds.filter(Boolean).length;
}
