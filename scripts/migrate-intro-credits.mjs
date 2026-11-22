/*
  One-time migration for the free-credit change.

  Product decision: the old free tier gave every free account five leads a day,
  forever. That daily allowance is gone. In its place EVERY free account - new
  or already existing - gets a single, one-time balance of intro credits. This
  script grants that one-time balance to accounts that already existed before
  the switch, so existing users are not left with a zero balance after deploy.

  Entitlements that are NOT the free tier are deliberately left untouched:
    - paid plans keep their daily lead allowance;
    - AppSumo / lifetime accounts keep their lifetime entitlement;
    - admins are not metered at all.

  Idempotent: grantIntroCredits refuses a second grant and the idempotency key
  makes a re-run a no-op, so running this more than once changes nothing.

  Usage (run from the project root so data/ resolves correctly):
    node scripts/migrate-intro-credits.mjs --dry-run    # report only
    node scripts/migrate-intro-credits.mjs              # apply
*/
import { readAuth } from "../src/authStore.js";
import { getEffectivePlanId } from "../src/plans.js";
import { grantIntroCredits, isIntroConsumed, introCreditAmount } from "../src/creditLedger.js";

const DRY_RUN = process.argv.slice(2).includes("--dry-run");

function main() {
  const data = readAuth();
  const users = Array.isArray(data.users) ? data.users : [];

  const summary = {
    totalUsers: users.length,
    granted: 0,
    alreadyGranted: 0,
    adminsSkipped: 0,
    paidPreserved: 0,
    lifetimePreserved: 0,
    dryRun: DRY_RUN,
    introCredits: introCreditAmount()
  };

  for (const user of users) {
    if (!user || !user.id) continue;

    if (user.role === "admin") {
      summary.adminsSkipped += 1;
      continue;
    }

    if (Number(user.lifetimeTier || 0) > 0) {
      summary.lifetimePreserved += 1;
      continue;
    }

    if (getEffectivePlanId(user) !== "free") {
      summary.paidPreserved += 1;
      continue;
    }

    if (isIntroConsumed(user.id)) {
      summary.alreadyGranted += 1;
      continue;
    }

    if (DRY_RUN) {
      summary.granted += 1;
      continue;
    }

    const result = grantIntroCredits(user.id, {
      amount: summary.introCredits,
      reason: "existing_user_grant",
      idempotencyKey: `intro:${user.id}`
    });
    if (result.granted) summary.granted += 1;
    else summary.alreadyGranted += 1;
  }

  console.log("intro-credit migration");
  console.log("----------------------");
  console.log(`mode:                    ${DRY_RUN ? "DRY RUN (no changes written)" : "APPLIED"}`);
  console.log(`users scanned:           ${summary.totalUsers}`);
  console.log(`intro credits granted:   ${summary.granted}  (${summary.introCredits} each)`);
  console.log(`already had the grant:   ${summary.alreadyGranted}`);
  console.log(`admins skipped:          ${summary.adminsSkipped}`);
  console.log(`paid plans preserved:    ${summary.paidPreserved}`);
  console.log(`lifetime preserved:      ${summary.lifetimePreserved}`);
}

main();
