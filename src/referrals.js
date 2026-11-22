import fs from "fs";
import path from "path";
import crypto from "crypto";

const dataDir = path.join(process.cwd(), "data");
const refPath = path.join(dataDir, "referrals.json");

function ensureFile() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(refPath)) {
    fs.writeFileSync(refPath, JSON.stringify({ commissions: [] }, null, 2));
  }
}

function readReferrals() {
  ensureFile();
  try {
    const data = JSON.parse(fs.readFileSync(refPath, "utf8"));
    return { commissions: Array.isArray(data.commissions) ? data.commissions : [] };
  } catch {
    return { commissions: [] };
  }
}

function writeReferrals(data) {
  ensureFile();
  fs.writeFileSync(refPath, JSON.stringify(data, null, 2));
}

export const REFERRAL_RATE = 0.2;

export function getRefUrl(refCode, origin = "") {
  const code = encodeURIComponent(String(refCode || ""));
  if (!code) return "";
  const base = String(process.env.PUBLIC_BASE_URL || origin || "https://leadmoz.com").replace(/\/+$/, "");
  return `${base}/auth?ref=${code}`;
}

export function createCommission({ referrerId, referrerEmail, refereeId, refereeEmail, plan, billing, amountPaid, approvalTrace }) {
  if (!referrerId || !refereeId) return null;
  if (referrerId === refereeId) return null;

  ensureFile();
  const data = readReferrals();

  const recent = data.commissions.find(c =>
    c.refereeId === refereeId
    && c.plan === plan
    && (c.billing || "") === (billing === "yearly" ? "yearly" : "monthly")
    && c.status !== "void"
    && (Date.now() - new Date(c.createdAt).getTime()) < 24 * 60 * 60 * 1000
  );
  if (recent) return recent;

  const amount = Math.max(0, Number(amountPaid) || 0);
  if (amount <= 0) return null;

  const commission = Number((amount * REFERRAL_RATE).toFixed(2));

  const record = {
    id: `ref_${crypto.randomBytes(9).toString("hex")}`,
    referrerId,
    referrerEmail,
    refereeId,
    refereeEmail,
    plan: String(plan || ""),
    billing: billing === "yearly" ? "yearly" : "monthly",
    amountPaid: amount,
    rate: REFERRAL_RATE,
    commission,
    status: "pending",
    createdAt: new Date().toISOString(),
    paidAt: "",
    voidedAt: "",
    approvalTrace: approvalTrace || ""
  };

  data.commissions.push(record);
  writeReferrals(data);
  return record;
}

export function listCommissions() {
  return readReferrals().commissions;
}

export function commissionsForReferrer(referrerId) {
  return readReferrals().commissions.filter(c => c.referrerId === referrerId);
}

export function markCommissionPaid(id) {
  const data = readReferrals();
  const item = data.commissions.find(c => c.id === id);
  if (!item) return null;
  item.status = "paid";
  item.paidAt = new Date().toISOString();
  item.voidedAt = "";
  writeReferrals(data);
  return item;
}

export function voidCommission(id) {
  const data = readReferrals();
  const item = data.commissions.find(c => c.id === id);
  if (!item) return null;
  item.status = "void";
  item.voidedAt = new Date().toISOString();
  item.paidAt = "";
  writeReferrals(data);
  return item;
}

export function referralSummary() {
  const list = readReferrals().commissions;
  const pending = list.filter(c => c.status === "pending");
  const paid = list.filter(c => c.status === "paid");
  const voided = list.filter(c => c.status === "void");
  return {
    total: list.length,
    pending: pending.length,
    paid: paid.length,
    void: voided.length,
    pendingTotalUsd: Number(pending.reduce((s, c) => s + Number(c.commission || 0), 0).toFixed(2)),
    paidTotalUsd: Number(paid.reduce((s, c) => s + Number(c.commission || 0), 0).toFixed(2))
  };
}