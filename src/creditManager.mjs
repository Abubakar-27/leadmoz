import { getUserById, readAuth, writeAuth, isPlanExpired } from "./authStore.js";

export function hasFreeCredits(user) {
  if (!user) return false;
  const paid = isPaidUserPlan(user.plan);
  if (paid) return true;

  const total = 5;
  const used = Number(user.credits_used_today) || 0;
  const lastReset = user.credits_last_reset || null;
  const today = new Date().toISOString().slice(0, 10);
  if (lastReset !== today) {
    return true;
  }
  return used < total;
}

export function getFreeCreditsLeft(user) {
  if (!user) return 0;
  const paid = isPaidUserPlan(user.plan);
  if (paid) return 999999;
  const total = 5;
  const today = new Date().toISOString().slice(0, 10);
  const lastReset = user.credits_last_reset || null;
  if (lastReset !== today) {
    return total;
  }
  const used = Number(user.credits_used_today) || 0;
  return Math.max(0, total - used);
}

export function consumeFreeCredit(userId) {
  const data = readAuth();
  const user = data.users.find((u) => u.id === userId);
  if (!user) return false;

  const paid = isPaidUserPlan(user.plan);
  if (paid) return true;

  const total = 5;
  const today = new Date().toISOString().slice(0, 10);
  const lastReset = user.credits_last_reset || null;
  if (lastReset !== today) {
    user.credits_last_reset = today;
    user.credits_used_today = 0;
  }
  const used = Number(user.credits_used_today) || 0;
  if (used >= total) return false;

  user.credits_used_today = used + 1;
  writeAuth(data);
  return true;
}

export function isPaidUserPlan(plan = "free") {
  const p = String(plan).toLowerCase();
  const paidPlans = ["starter", "pro", "starter3", "starter6", "pro3", "pro6", "agency"];
  return paidPlans.includes(p) && !isPlanExpired({ plan });
}
