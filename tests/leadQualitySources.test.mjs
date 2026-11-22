import assert from "node:assert/strict";
import { contactableOsmPlaces } from "../src/apis/osm.js";
import {
  applyScrapeFailureStatus,
  SCRAPE_FAILURE_MAX_CONFIDENCE,
  SCRAPE_FAILURE_REASON
} from "../src/leadStatus.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`not ok - ${name}`);
    console.log(`  ${err.message}`);
  }
}

check("keeps places that have a website", () => {
  const out = contactableOsmPlaces([
    { businessName: "With Site", website: "https://withsite.test", phone: "" }
  ]);
  assert.equal(out.length, 1);
});

check("keeps places that have a phone", () => {
  const out = contactableOsmPlaces([
    { businessName: "Phone Only", website: "", phone: "+15125550134" }
  ]);
  assert.equal(out.length, 1);
});

check("drops places with neither website nor phone", () => {
  const out = contactableOsmPlaces([
    { businessName: "Bare", website: "", phone: "" },
    { businessName: "Contactable", website: "https://ok.test", phone: "" }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].businessName, "Contactable");
});

check("tolerates junk input", () => {
  assert.deepEqual(contactableOsmPlaces(null), []);
  assert.deepEqual(contactableOsmPlaces(undefined), []);
  assert.deepEqual(contactableOsmPlaces([null, {}]), []);
});

check("verified downgrades when the site could not be loaded", () => {
  const out = applyScrapeFailureStatus(
    { status: "verified", confidenceScore: 100, primaryEmail: "hi@dead.test" },
    false
  );
  assert.equal(out.status, "needsReview");
  assert.equal(out.confidenceScore, SCRAPE_FAILURE_MAX_CONFIDENCE);
  assert.ok(out.rejectionReasons.includes(SCRAPE_FAILURE_REASON));
});

check("verified stays verified when the site loaded", () => {
  const input = { status: "verified", confidenceScore: 100, rejectionReasons: [] };
  const out = applyScrapeFailureStatus(input, true);
  assert.equal(out.status, "verified");
  assert.equal(out.confidenceScore, 100);
});

check("failed scrape only lowers an inflated score", () => {
  const out = applyScrapeFailureStatus(
    { status: "verified", confidenceScore: 45, rejectionReasons: [] },
    false
  );
  assert.equal(out.confidenceScore, 45);
  assert.equal(out.status, "needsReview");
});

check("rejected and needsReview statuses are untouched", () => {
  const rejected = { status: "rejected", confidenceScore: 0, rejectionReasons: ["wrong niche"] };
  assert.equal(applyScrapeFailureStatus(rejected, false), rejected);

  const review = { status: "needsReview", confidenceScore: 40, rejectionReasons: [] };
  assert.equal(applyScrapeFailureStatus(review, false), review);
});

check("missing verification object does not throw", () => {
  assert.equal(applyScrapeFailureStatus(undefined, false), undefined);
  assert.equal(applyScrapeFailureStatus(null, false), null);
});

if (failures) {
  console.log(`\n${failures} assertion group(s) failed`);
  process.exit(1);
}
console.log("\nall lead-quality checks passed");
