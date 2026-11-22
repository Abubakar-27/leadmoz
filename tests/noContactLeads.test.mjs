// A lead with no email and no phone cannot be contacted, so it must never reach
// the results list. Both save paths used to allow it: the normal path saved it
// as "kept for manual review", and the low-confidence backfill had its own
// no-contact branch.
import assert from "node:assert";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");

function block(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `end marker not found after: ${startMarker}`);
  return src.slice(start, end);
}

// 1. Both save paths must skip, not save. saveBackfillLead is defined earlier in
// the file, so its guard is the first match and the normal path is the last.
const GUARD = "if (!leadPhone && !leadEmail) {";
const guardCount = src.split(GUARD).length - 1;
assert.ok(guardCount === 2, `expected 2 no-contact guards, found ${guardCount}`);

const backfillGuard = src.indexOf(GUARD);
const normalGuard = src.lastIndexOf(GUARD);
assert.ok(backfillGuard < normalGuard, "saveBackfillLead guard must come first");

const dupAt = src.indexOf("const globalDup = findGlobalDuplicateLead", backfillGuard);
const addAt = src.indexOf("addLeadIfUnique", backfillGuard);
const backfill = src.slice(backfillGuard, dupAt);
assert.ok(dupAt > backfillGuard && addAt > backfillGuard, "must find both anchors after the guard");
assert.ok(backfillGuard < addAt, "the backfill contact guard must run before the lead is added");
assert.ok(/leadsSkippedNoContact \+= 1/.test(backfill), "the backfill guard must count the skip");
assert.ok(/return false;/.test(backfill), "the backfill guard must not add the lead");

const normal = src.slice(normalGuard, src.indexOf("const listingName = result.businessName", normalGuard));
assert.ok(
  !/saveBackfillLead|addLeadIfUnique/.test(normal),
  "the normal no-contact branch must not save a lead"
);
assert.ok(/leadsSkippedNoContact \+= 1/.test(normal), "the normal branch must count the skip");
assert.ok(/return true;/.test(normal), "the normal branch must continue to the next candidate");

assert.ok(
  !/No contact details were extracted automatically/.test(src),
  "the 'no contact details' backfill copy path must be gone"
);

// 3. Diagnostics must still be able to report the skips.
assert.ok(/leadsSkippedNoContact/.test(src), "diagnostics counter must survive");
assert.ok(/Skipped \(no contact\)/.test(src) || /Skipped \(no email\/phone\)/.test(src), "the UI label must survive");

console.log("ALL NO-CONTACT LEAD CHECKS PASSED");
