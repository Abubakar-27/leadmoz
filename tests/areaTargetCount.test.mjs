import assert from "node:assert/strict";
import { targetMet } from "../src/worker.js";

let pass = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log("ok - " + name);
  } catch (err) {
    console.log("NOT OK - " + name);
    console.log("  " + err.message);
    process.exitCode = 1;
  }
}

/*
  A user who selects an area is buying leads from that area. The order used to
  be satisfied by the raw length of the leads array, so "roofers @ Austin TX"
  reported 10/10 while 3 of the 10 were in San Antonio and 2 were in Houston.
  The target is now measured against leads flagged inTargetArea.
*/

const austin = { businessName: "Alta Roofing", inTargetArea: true };
const nearby = { businessName: "Stephens Roofing", inTargetArea: false };

await check("out-of-area leads do not count toward the target", () => {
  const job = { leads: [austin, austin, austin, nearby, nearby, nearby, nearby, nearby, nearby, nearby] };
  assert.equal(
    targetMet(job, 10),
    false,
    "3 in-area plus 7 nearby must not complete a 10-lead Austin order"
  );
});

await check("the target is met once enough in-area leads exist", () => {
  const job = { leads: [austin, austin, austin, austin, austin, austin, austin, austin, austin, austin, nearby] };
  assert.equal(targetMet(job, 10), true, "10 in-area leads complete the order");
});

await check("nearby leads do not stop the search early", () => {
  const job = { leads: Array.from({ length: 40 }, () => nearby) };
  assert.equal(targetMet(job, 10), false, "40 out-of-area leads are still 0 in-area");
});

await check("leads saved before this field existed still count", () => {
  const legacy = { leads: [{ businessName: "Old Lead" }, { businessName: "Older Lead" }] };
  assert.equal(
    targetMet(legacy, 2),
    true,
    "a missing inTargetArea must not silently void historic leads"
  );
});

await check("an empty job is not a completed job", () => {
  assert.equal(targetMet({ leads: [] }, 10), false);
assert.equal(targetMet({}, 10), false);
});

/*
  Third regression: the map-listing lead builder. mapsNoWebsiteLead() is the
  second builder in worker.js and it never runs verifyLead, so it had no locality
  verdict at all. inTargetArea was absent, and absent counted as in-area, so OSM
  and Google Maps listings from anywhere in the region could fill an order for a
  named city. These cases reproduce the live leak: "San Antonio, TX" against an
  "Austin TX" request, where the state code matches but the city does not.
*/
import { mapsNoWebsiteLead as mapLead } from "../src/worker.js";

const austinJob = { niche: "roofers", location: "Austin TX" };

async function checkMapLead(name, place, expectedInArea) {
  const lead = await mapLead(place, austinJob);
  assert.equal(
    lead.inTargetArea,
    expectedInArea,
    name + " -> expected inTargetArea " + expectedInArea + ", got " + JSON.stringify(lead.inTargetArea)
  );
}

await checkMapLead("a San Antonio map listing is out of area for Austin TX", {
  businessName: "Stephens Roofing",
  address: "11803 Warfield St, San Antonio, TX 78216",
  addresses: ["11803 Warfield St, San Antonio, TX 78216"],
  phone: "210-555-0111",
  source: "osm"
}, false);

await checkMapLead("a Dallas map listing is out of area for Austin TX", {
  businessName: "New View Roofing",
  address: "4722 Gaston Ave, Dallas, TX 75246",
  addresses: ["4722 Gaston Ave, Dallas, TX 75246"],
  phone: "214-555-0133",
  source: "google_places"
}, false);

await checkMapLead("an Austin map listing is in area for Austin TX", {
  businessName: "The Roofing Guy",
  address: "2512 Wheless Ln, Austin, TX 78723",
  addresses: ["2512 Wheless Ln, Austin, TX 78723"],
  phone: "512-555-0142",
  source: "osm"
}, true);

await checkMapLead("a listing with no address at all cannot claim the city", {
  businessName: "Some Roofing Company",
  phone: "512-555-0100",
  source: "osm"
}, false);

await checkMapLead("a city request still accepts its own city via city/state fields", {
  businessName: "Alta Roofing LLC",
  city: "Austin",
  state: "TX",
  phone: "512-555-0123",
  source: "osm"
}, true);

const sanAntonioListing = {
  businessName: "Stephens Roofing",
  address: "11803 Warfield St, San Antonio, TX 78216",
  addresses: ["11803 Warfield St, San Antonio, TX 78216"],
  phone: "210-555-0111",
  source: "osm"
};

await check("a state-level request accepts a San Antonio listing", async () => {
  const lead = await mapLead(sanAntonioListing, { niche: "roofers", location: "Texas" });
  assert.equal(lead.inTargetArea, true, "asking for Texas must still accept any Texan business");
});

await check("a bare state abbreviation request accepts the same listing", async () => {
  const lead = await mapLead(sanAntonioListing, { niche: "roofers", location: "TX" });
  assert.equal(lead.inTargetArea, true, "asking for TX must still accept a Texan listing");
});

await check("an out-of-area map lead still carries the flag as false, not missing", async () => {
  const lead = await mapLead(
    { businessName: "New View Roofing", address: "4722 Gaston Ave, Dallas, TX 75246", addresses: ["4722 Gaston Ave, Dallas, TX 75246"], phone: "214-555-0133", source: "osm" },
    austinJob
  );
assert.equal("inTargetArea" in lead, true, "the field must exist so it cannot be read as in-area");
});

console.log("\n" + pass + " passed, " + (process.exitCode ? "failures above" : "all green"));
