import fs from "fs";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { readJsonWithBackup, writeJsonAtomic } from "./atomicJson.js";

const DATA_DIR = path.join(process.cwd(), "data");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");

function emptyAuth() {
  return { users: [], sessions: [], emailCodes: [], usage: [] };
}
function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AUTH_FILE) && !fs.existsSync(`${AUTH_FILE}.bak`)) {
    writeJsonAtomic(AUTH_FILE, emptyAuth(), { backup: false });
  }
}
export function readAuth() {
  ensureFile();
  const data = readJsonWithBackup(AUTH_FILE, emptyAuth);
  return {
    users: Array.isArray(data.users) ? data.users : [],
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    emailCodes: Array.isArray(data.emailCodes) ? data.emailCodes : [],
    usage: Array.isArray(data.usage) ? data.usage : []
  };
}
export function writeAuth(data) {
  ensureFile();
  writeJsonAtomic(AUTH_FILE, data);
}
export function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}
function adminEmails() {
  return String(process.env.SUPER_ADMIN_EMAILS || process.env.SUPER_ADMIN_EMAIL || "")
    .split(",").map(normalizeEmail).filter(Boolean);
}
export function publicUser(user) {
  if (!user) return null;
  const safe = { ...user };
  delete safe.passwordHash;
  delete safe.smtpPass;
  delete safe.geminiApiKey;

  if (safe.gmailSender && typeof safe.gmailSender === "object") {
    const sender = { ...safe.gmailSender };
    delete sender.smtpPass;
    safe.gmailSender = sender;
  }

  return safe;
}
export function getUserByEmail(email) {
  return readAuth().users.find(u => u.email === normalizeEmail(email)) || null;
}
export function getUserById(id) {
  return readAuth().users.find(u => u.id === id) || null;
}
export { readAuth as readAuthStore };
export async function verifyPassword(password, hash) {
  if (!hash) return false;
  return await bcrypt.compare(String(password), String(hash));
}
async function hashPassword(password) {
  return await bcrypt.hash(String(password), 12);
}
export function createOrUpdateGoogleUser({ email, name = "", avatar = "", referredBy = "", signupIp = "" }) {
  const data = readAuth();
  const cleanEmail = normalizeEmail(email);
  let user = data.users.find(u => u.email === cleanEmail);
  if (!user) {
    user = {
      id: `user_${crypto.randomBytes(18).toString("hex")}`,
      email: cleanEmail,
      name: name || cleanEmail.split("@")[0],
      avatar,
      provider: "google",
      hasPassword: false,
      passwordHash: "",
      role: adminEmails().includes(cleanEmail) ? "admin" : "user",
      plan: "free",
      status: "active",
      referredBy: String(referredBy || ""),
      signupIp: String(signupIp || ""),
      refCode: "",
      free_tier_lifetime_credits: 10,
      credits_used: 0,
      credits_used_today: 0,
      credits_last_reset: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.users.push(user);
  } else {
    if (user.credits_used_today === undefined) user.credits_used_today = 0;
    if (user.credits_last_reset === undefined) user.credits_last_reset = new Date().toISOString().slice(0, 10);
    user.name = name || user.name;
    user.avatar = avatar || user.avatar;
    user.provider = user.provider === "email" ? "email+google" : "google";
    if (adminEmails().includes(cleanEmail)) user.role = "admin";
    user.updatedAt = new Date().toISOString();
  }
  writeAuth(data);
  return user;
}
export async function createEmailUserWithPassword({ email, password, referredBy = "", signupIp = "" }) {
  const data = readAuth();
  const cleanEmail = normalizeEmail(email);
  let user = data.users.find(u => u.email === cleanEmail);
  if (!user) {
    user = {
      id: `user_${crypto.randomBytes(18).toString("hex")}`,
      email: cleanEmail,
      name: cleanEmail.split("@")[0],
      avatar: "",
      provider: "email",
      hasPassword: true,
      passwordHash: await hashPassword(password),
      role: adminEmails().includes(cleanEmail) ? "admin" : "user",
      plan: "free",
      status: "active",
      referredBy: String(referredBy || ""),
      signupIp: String(signupIp || ""),
      refCode: "",
      free_tier_lifetime_credits: 10,
      credits_used: 0,
      credits_used_today: 0,
      credits_last_reset: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.users.push(user);
  } else {
    if (user.credits_used_today === undefined) user.credits_used_today = 0;
    if (user.credits_last_reset === undefined) user.credits_last_reset = new Date().toISOString().slice(0, 10);
    user.provider = user.provider === "google" ? "email+google" : "email";
    user.hasPassword = true;
    user.passwordHash = await hashPassword(password);
    if (adminEmails().includes(cleanEmail)) user.role = "admin";
    user.updatedAt = new Date().toISOString();
  }
  writeAuth(data);
  return user;
}
export async function updateUserPassword(email, password) {
  const data = readAuth();
  const cleanEmail = normalizeEmail(email);
  const user = data.users.find(u => u.email === cleanEmail);
  if (!user) return null;
  user.passwordHash = await hashPassword(password);
  user.hasPassword = true;
  user.updatedAt = new Date().toISOString();
  writeAuth(data);
  return user;
}
export function createSession(userId, remember = true) {
  const data = readAuth();
  const token = crypto.randomBytes(32).toString("hex");
  const days = remember ? 30 : 1;
  data.sessions = data.sessions.filter(s => Number(s.expiresAtMs || 0) > Date.now());
  data.sessions.push({
    token,
    userId,
    createdAt: new Date().toISOString(),
    expiresAtMs: Date.now() + 1000 * 60 * 60 * 24 * days
  });
  writeAuth(data);
  return { token, maxAgeSeconds: 60 * 60 * 24 * days };
}
export function getSessionUser(token) {
  if (!token) return null;
  const data = readAuth();
  const session = data.sessions.find(s => s.token === token && Number(s.expiresAtMs || 0) > Date.now());
  if (!session) return null;
  const user = data.users.find(u => u.id === session.userId) || null;
  if (user && adminEmails().includes(user.email)) user.role = "admin";
  return user;
}
export function deleteSession(token) {
  const data = readAuth();
  data.sessions = data.sessions.filter(s => s.token !== token);
  writeAuth(data);
}
export function saveEmailCode(email, code, purpose = "signup") {
  const data = readAuth();
  const cleanEmail = normalizeEmail(email);
  data.emailCodes = data.emailCodes.filter(c => !(c.email === cleanEmail && c.purpose === purpose));
  data.emailCodes.push({
    email: cleanEmail, code, purpose, verified: false, attempts: 0,
    createdAt: new Date().toISOString(),
    expiresAtMs: Date.now() + 1000 * 60 * 10
  });
  writeAuth(data);
}
export function verifyEmailCode(email, code, purpose = "signup") {
  const data = readAuth();
  const cleanEmail = normalizeEmail(email);
  const item = data.emailCodes.find(c => c.email === cleanEmail && c.purpose === purpose);
  if (!item) return { ok: false, error: "Code not found. Request a new code." };
  if (Date.now() > Number(item.expiresAtMs || 0)) return { ok: false, error: "Code expired. Request a new code." };
  item.attempts = Number(item.attempts || 0) + 1;
  if (item.attempts > 5) {
    data.emailCodes = data.emailCodes.filter(c => !(c.email === cleanEmail && c.purpose === purpose));
    writeAuth(data);
    return { ok: false, error: "Too many attempts. Request a new code." };
  }
  if (String(item.code) !== String(code).trim()) {
    writeAuth(data);
    return { ok: false, error: "Invalid code." };
  }
  item.verified = true;
  item.verifiedAt = new Date().toISOString();
  writeAuth(data);
  return { ok: true };
}
export function hasVerifiedCode(email, purpose = "signup") {
  const cleanEmail = normalizeEmail(email);
  const item = readAuth().emailCodes.find(c => c.email === cleanEmail && c.purpose === purpose && c.verified);
  return Boolean(item && Date.now() <= Number(item.expiresAtMs || 0));
}
export function consumeVerifiedCode(email, purpose = "signup") {
  const data = readAuth();
  const cleanEmail = normalizeEmail(email);
  data.emailCodes = data.emailCodes.filter(c => !(c.email === cleanEmail && c.purpose === purpose));
  writeAuth(data);
}
export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
export function getUserUsage(userId, date = todayKey()) {
  return readAuth().usage.find(u => u.userId === userId && u.date === date) || { userId, date, leadsRequested: 0, jobsCreated: 0 };
}
export function addUserUsage(userId, leadCount, date = todayKey()) {
  const data = readAuth();
  let item = data.usage.find(u => u.userId === userId && u.date === date);
  if (!item) {
    item = { userId, date, leadsRequested: 0, jobsCreated: 0 };
    data.usage.push(item);
  }
  item.leadsRequested += Number(leadCount || 0);
  item.jobsCreated += 1;
  writeAuth(data);
  return item;
}
/*
  Counterpart to addUserUsage for the reserve/settle billing model: when a paid
  or lifetime job finishes with fewer billable leads than it reserved, the
  unused difference is given back to the day's usage so a short search does not
  silently consume a paid plan's daily allowance. Clamped at zero so a refund
  can never push usage negative and hand out free allowance.
*/
export function adjustUserUsage(userId, delta, date = todayKey()) {
  const data = readAuth();
  const item = data.usage.find(u => u.userId === userId && u.date === date);
  if (!item) return null;
  item.leadsRequested = Math.max(0, Number(item.leadsRequested || 0) + Number(delta || 0));
  writeAuth(data);
  return item;
}
/*
  Billing cycles that can be stored. The 3- and 6-month plans are separate plan
  ids, and auth.html sends "3month"/"6month" for them. This used to collapse
  anything that was not exactly "yearly" into "monthly", so the length of the
  term the customer actually paid for was thrown away before the admin ever saw
  it, and the panel showed "monthly" against a six-month payment.

  Declared before setUserPlan/requestUserPlan so both can normalise through the
  same set instead of each keeping its own partial list of cycles.
*/
const ALLOWED_BILLING_CYCLES = new Set(["monthly", "yearly", "3month", "6month"]);

/*
  AppSumo lifetime redemption. Tier 1 is five leads a day forever, which is the
  same limit as the free plan, so the account is anchored to "free" for its
  limits and marked with the lifetime tiers/flags below. planExpiresAt stays
  empty so no expiry window exists for a lifetime account to fall out of.
*/
export function setLifetimeTier(userId, tierLevel = 1, codeString = "") {
  const data = readAuth();
  const user = data.users.find(u => u.id === userId);
  if (!user) return null;

  user.plan = "free";
  user.planBilling = "";
  user.planRequest = "";
  user.planRequestedAt = "";
  user.planDurationDays = 0;
  user.planExpiresAt = "";
  user.planApprovedAt = new Date().toISOString();
  user.lifetimeTier = Math.max(1, Number(tierLevel) || 1);
  user.lifetimeActivatedAt = new Date().toISOString();
  user.appsumoCode = String(codeString || "");
  user.updatedAt = new Date().toISOString();
  writeAuth(data);
  return user;
}

export function setUserPlan(userId, plan, durationDays = 30, billing = "") {
  const data = readAuth();
  const user = data.users.find(u => u.id === userId);
  if (!user) return null;

  const cleanPlan = String(plan || "free").trim();
const paidPlans = ["starter", "pro", "starter3", "starter6", "pro3", "pro6", "agency", "agency3", "agency6"];

  user.plan = cleanPlan;
  user.planRequest = "";
  user.planRequestedAt = "";
  // Must accept every prepaid cycle, not just monthly/yearly. The 3- and 6-month
  // plans are separate ids, so keeping only the old two values here would leave
  // an approved starter3 user still labelled as a monthly subscriber.
  const cycle = String(billing || "").trim();
  if (ALLOWED_BILLING_CYCLES.has(cycle)) user.planBilling = cycle;
  user.planApprovedAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();

  if (paidPlans.includes(cleanPlan)) {
    const days = Math.max(1, Number(durationDays) || 30);
    user.planDurationDays = days;
    user.planExpiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  } else {
    user.planDurationDays = 0;
    user.planExpiresAt = "";
  }

  writeAuth(data);
  return user;
}

export function isPlanExpired(user) {
  if (!user) return false;
  /*
    AppSumo lifetime deals never expire: the redeemed tier is permanent, so a
    lifetime account must survive every expiry path regardless of what happens
    to its plan fields later.
  */
  if (Number(user.lifetimeTier || 0) > 0) return false;
  const expiry = user.planExpiresAt;
  if (!expiry) return false;
  const expMs = new Date(expiry).getTime();
  return Number.isFinite(expMs) && Date.now() > expMs;
}

export function expireExpiredPlans() {
  const data = readAuth();
  let changed = false;

  for (const user of data.users) {
    if (user.role === "admin") continue;
    if (Number(user.lifetimeTier || 0) > 0) continue;
const paidPlans = ["starter", "pro", "starter3", "starter6", "pro3", "pro6", "agency"];
    if (!paidPlans.includes(String(user.plan || "free"))) continue;
    if (!isPlanExpired(user)) continue;

    user.plan = "free";
    user.planRequest = "";
    user.planRequestedAt = "";
    user.planDurationDays = 0;
    user.planExpiresAt = "";
    user.planExpiredAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();
    changed = true;
  }

  if (changed) writeAuth(data);
  return changed;
}

export function getPlanExpiryInfo(user) {
  if (!user || !user.planExpiresAt) return { planExpiresAt: "", planDurationDays: 0, expiresInMs: 0 };
  const ms = new Date(user.planExpiresAt).getTime() - Date.now();
  return {
    planExpiresAt: user.planExpiresAt,
    planDurationDays: Number(user.planDurationDays || 0),
    expiresInMs: Number.isFinite(ms) ? Math.max(0, ms) : 0
  };
}

export function requestUserPlan(userId, plan, billing = "monthly", promoCode = "") {
  const data = readAuth();
  const user = data.users.find(u => u.id === userId);
  if (!user) return null;
  const cycle = String(billing || "").trim().toLowerCase();
  user.planRequest = String(plan || "").trim();
  user.planBilling = ALLOWED_BILLING_CYCLES.has(cycle) ? cycle : "monthly";
  user.planRequestedAt = new Date().toISOString();
  // Stored on the request rather than applied here: approval is manual and can
  // happen days later, so the code is re-validated at that point before any
  // discount or use count is committed.
  user.promoCode = String(promoCode || "").trim().slice(0, 64);
  user.updatedAt = new Date().toISOString();
  writeAuth(data);
  return user;
}

function buildRefCode(email = "") {
  const base = (String(email).split("@")[0] || "ref").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "ref";
  const taken = readAuth().users;
  let code = base;
  let i = 0;
  while (taken.some(u => String(u.refCode || "").toLowerCase() === code.toLowerCase())) {
    i += 1;
    code = `${base}${i}`;
  }
  return code;
}

export function ensureRefCode(user) {
  if (!user) return "";
  if (user.refCode) return user.refCode;

  const data = readAuth();
  const fresh = data.users.find(u => u.id === user.id);
  if (!fresh) return "";

  if (!fresh.refCode) {
    fresh.refCode = buildRefCode(fresh.email || "ref");
    fresh.updatedAt = new Date().toISOString();
    writeAuth(data);
  }

  return fresh.refCode;
}

export function resolveRefCode(refCode) {
  const code = String(refCode || "").trim();
  if (!code) return null;

  const user = readAuth().users.find(u => String(u.refCode || "").toLowerCase() === code.toLowerCase());

  if (!user) return null;
  if (user.role === "admin") return null;
  if (user.status !== "active") return null;

  return user;
}

export function getAllUsers() {
  return readAuth().users.map(publicUser);
}
export function getAllUsage() {
  return readAuth().usage;
}
