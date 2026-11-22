import assert from "node:assert/strict";
import { locationEvidence, verifyLead } from "../src/advancedVerifier.js";

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("ok - " + name);
  } catch (err) {
    console.log("NOT OK - " + name);
    console.log("  " + err.message);
    process.exitCode = 1;
  }
}

/*
  Regression: a state code is not a city.

  A live job for "roofers @ Austin TX" returned 10/10 and marked five of them
  verified, but three were in San Antonio and two were in Houston. The cause
  was here: every Texan address ends in ", TX 77087", so "TX" satisfied the
  location check on its own and "strong" was returned for the wrong city.
*/

check("a Houston address is not strong evidence for Austin TX", () => {
  const scraped = {
    addresses: ["3748 Dover Ave, Houston, TX, 77087, US"],
    text: "Family owned roofing company serving the greater Houston area since 1998. Call us for a free estimate on roof repair and replacement in Houston TX."
  };
  assert.notEqual(
    locationEvidence(scraped, "Austin TX"),
    "strong",
    "Houston must not score as strong Austin evidence"
  );
});

check("a San Antonio address is not strong evidence for Austin TX", () => {
  const scraped = {
    addresses: ["114 N Ellison Dr #403, San Antonio, TX, 78212, US"],
    text: "Roofing company in San Antonio TX. Free roof replacement and storm damage repair across San Antonio and Bexar County."
  };
  assert.notEqual(
    locationEvidence(scraped, "Austin TX"),
    "strong",
    "San Antonio must not score as strong Austin evidence"
  );
});

check("a real Austin address is still strong for Austin TX", () => {
  const scraped = {
    addresses: ["2512 Wheless Ln, Austin, TX, 78723, US"],
    text: "The Roofing Guy is a local Austin roofer. We serve Austin TX and the surrounding Travis County area."
  };
  assert.equal(
    locationEvidence(scraped, "Austin TX"),
    "strong",
    "a genuine Austin business must still pass"
  );
});

check("a state-only request still accepts any city in that state", () => {
  const scraped = {
    addresses: ["3748 Dover Ave, Houston, TX, 77087, US"],
    text: "Roofing contractor in Houston TX serving the whole state of Texas."
  };
  assert.equal(
    locationEvidence(scraped, "Texas"),
    "strong",
    "asking for a state must still accept a business anywhere in it"
  );
});

check("a bare state abbreviation is still decisive", () => {
  const scraped = {
    addresses: ["3748 Dover Ave, Houston, TX, 77087, US"],
    text: "Roofing contractor in Houston TX."
  };
  assert.equal(
    locationEvidence(scraped, "TX"),
    "strong",
    "asking for TX must still accept a Texan business"
  );
});

check("wrong-state city is not strong for a different state", () => {
  const scraped = {
    addresses: ["1200 Main St, Dallas, TX, 75201, US"],
    text: "Commercial cleaning company based in Dallas TX."
  };
  assert.notEqual(
    locationEvidence(scraped, "Colorado Springs CO"),
    "strong",
    "a Dallas business is not a Colorado Springs lead"
  );
});

/*
  The end-to-end gate. This is the one that actually reached the customer:
  verifyLead set status from locationMatches(), which also walked the region
  alias list, so a San Antonio roofer with a phone number came back "verified"
  on an "Austin TX" job. A well-populated, contactable, wrong-city business is
  exactly the shape of lead that used to be over-credited.
*/
function localRoofingScraped(city, state, zip) {
  return {
    scrapeOk: true,
    businessName: "Roofing Company " + city,
    title: "Roofing Company " + city,
    description: "Roof repair and replacement in " + city,
    text:
      "Family owned roofing company in " + city + " " + state + ". We do roof " +
      "repair, replacement and storm damage repair. Call today for a free " +
      "estimate. Serving the whole area for over 20 years. Licensed and insured.",
    addresses: [zip + ", " + city + ", " + state + ", " + zip.split(" ")[1] + ", US"],
    website: "https://" + city.toLowerCase().replace(/ /g, "") + "-roofing.example.com",
    phones: ["(512) 555-0142"],
    emails: ["info@" + city.toLowerCase().replace(/ /g, "") + "-roofing.example.com"],
    pagesScraped: ["https://x.example.com", "https://x.example.com/about"],
    nicheConfirmed: true
  };
}

const results = [];
for (const [city, state, zip] of [
  ["San Antonio", "TX", "78216"],
  ["Houston", "TX", "77087"],
  ["Dallas", "TX", "75246"]
]) {
  results.push([city, await verifyLead(localRoofingScraped(city, state, zip), {
    niche: "roofers",
    location: "Austin TX"
  })]);
}

check("a wrong-city Texan business is never verified for Austin TX", () => {
  for (const [city, r] of results) {
    assert.notEqual(r.status, "verified", city + " must not be verified for an Austin job");
  }
});

check("a genuine Austin business with a phone is verified", async () => {
  const r = await verifyLead(localRoofingScraped("Austin", "TX", "78723"), {
    niche: "roofers",
    location: "Austin TX"
  });
  assert.equal(r.status, "verified", "a real Austin roofer should still verify");
});
/*
  Second regression, found after the alias fix shipped. The first e2e run still
  returned "roofers @ Austin TX 10/10" with three San Antonio businesses marked
  verified, because locationMatches read the scraped page copy. Each of those
  sites has a /service-areas page listing Austin, so "we serve Austin" was
  treated as proof of being in Austin. The AI then personalised on that false
  premise: "I noticed Stephens Roofing has a dedicated Austin line" was written
  about a company whose address is 11803 Warfield St, San Antonio.

  Service-area copy is a claim about where they will travel, not where they are.
*/
check("a service-area page listing Austin is not proof of being in Austin", () => {
  const scraped = {
    businessName: "Stephens Roofing: Roofers in San Antonio",
    addresses: ["11803 Warfield St, San Antonio, TX 78216, United States"],
    pagesScraped: ["https://www.stephensroofing.net/service-areas"],
    text: "Proudly serving Austin, Round Rock, Cedar Park and the greater Central Texas area since 1998. Free estimates on every roof."
  };
  assert.notEqual(
    locationEvidence(scraped, "Austin TX"),
    "strong",
    "body copy must never establish Austin locality"
  );
});

check("a Dallas business is not strong evidence for Austin TX", () => {
  const scraped = {
    businessName: "New View Roofing - 5 Star Dallas Roofing Contractors",
    addresses: ["4722 Gaston Ave, Dallas, Texas, 75246, US"],
    text: "Dallas roofing contractors now expanding our service area into Austin TX."
  };
  assert.notEqual(
    locationEvidence(scraped, "Austin TX"),
    "strong",
    "an expansion claim is not an Austin address"
  );
});

check("an Austin address still scores strong", () => {
  const scraped = {
    businessName: "Alta Roofing, LLC",
    addresses: ["6517 Cascada Drive, Austin, TX 78750, US"],
    text: "Serving Austin and the Hill Country."
  };
  assert.equal(
    locationEvidence(scraped, "Austin TX"),
    "strong",
    "a real Austin address must still be strong evidence"
  );
});

/*
  The assertion that actually covers the shipped bug. locationEvidence only
  scores a lead; what reached the customer was inTargetArea, which is fed by
  locationConfirmed. These three cases reproduce the live e2e output exactly:
  a San Antonio and a Dallas business, each with a phone, each whose site
  advertises Austin, reported as verified Austin leads on a 10/10 job.
*/
const serviceAreaLeads = [
  ["San Antonio service-area page", {
    businessName: "Stephens Roofing: Roofers in San Antonio",
    title: "Stephens Roofing | San Antonio Roofers",
    addresses: ["11803 Warfield St, San Antonio, TX 78216, United States"],
    phones: ["(210) 555-0111"],
    emails: ["inquiries@stephensroofing.example.com"],
    pagesScraped: ["https://stephensroofing.example.com/service-areas"],
    text: "Proudly serving Austin, Round Rock, Cedar Park and the greater Central Texas area since 1998."
  }],
  ["Dallas expansion page", {
    businessName: "New View Roofing - 5 Star Dallas Roofing Contractors",
    title: "Dallas Roofing Contractors",
    addresses: ["4722 Gaston Ave, Dallas, Texas, 75246, US"],
    phones: ["(214) 555-0133"],
    emails: ["info@newviewroofing.example.com"],
    pagesScraped: ["https://newviewroofing.example.com/service-area/"],
    text: "Dallas roofing contractors now expanding our service area into Austin TX."
  }],
  ["no address at all, Austin in copy only", {
    businessName: "Bison Roofing: San Antonio Roofing Company",
    title: "Bison Roofing San Antonio",
    phones: ["(210) 555-0177"],
    pagesScraped: ["https://bisonroofing.example.com/service-area/"],
    text: "Top rated roofing across Austin and the Rio Grande Valley."
  }]
];

const serviceAreaResults = [];
for (const [label, scraped] of serviceAreaLeads) {
  serviceAreaResults.push([label, await verifyLead(
    { scrapeOk: true, nicheConfirmed: true, ...scraped },
    { niche: "roofers", location: "Austin TX" }
  )]);
}

check("a service-area claim never sets locationConfirmed for the named city", () => {
  for (const [label, r] of serviceAreaResults) {
    assert.equal(
      r.locationConfirmed,
      false,
      label + " must not be locationConfirmed for Austin TX, got " + JSON.stringify(r.locationConfirmed)
    );
  }
});

check("a service-area claim never comes back verified for the named city", () => {
  for (const [label, r] of serviceAreaResults) {
    assert.notEqual(
      r.status,
      "verified",
      label + " must not be verified for an Austin job"
    );
  }
});

check("a real Austin address still sets locationConfirmed", async () => {
  const r = await verifyLead(
    { scrapeOk: true, nicheConfirmed: true, ...localRoofingScraped("Austin", "TX", "78723") },
    { niche: "roofers", location: "Austin TX" }
  );
  assert.equal(r.locationConfirmed, true, "a genuine Austin roofer must stay in area");
  assert.equal(r.status, "verified", "and must still verify");
});

console.log("\n" + pass + " passed, " + (process.exitCode ? "failures above" : "all green"));
