import { evaluateLeadQuality, isNoWebsiteLead } from "../src/leadQualityGate.js";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error("assertion returned false");
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

function assert(value, message) {
  if (!value) throw new Error(message || "expected truthy");
}

const VERIFIED = { evidence: "verified", class: "defect", id: "broken_links", detail: "3 internal links return 404" };
const CLEAR = { evidence: "inferred", class: "clear", id: "no_issues", detail: "Nothing measurable is wrong" };
const OPPORTUNITY = { evidence: "inferred", class: "opportunity", id: "no_testimonials", detail: "No reviews on site" };

console.log("lead quality gate");

check("a lead with a verified defect passes", () => {
  const r = evaluateLeadQuality({
    phone: "(512) 555-0100",
    website: "https://acme.com",
    weaknesses: [VERIFIED]
  });
  assert(r.ok, "should pass");
  assert(r.hasVerifiedFault === true, "should flag verified fault");
});

check("a lead with only an opportunity passes but is not a verified fault", () => {
  const r = evaluateLeadQuality({
    phone: "(512) 555-0100",
    website: "https://acme.com",
    weaknesses: [OPPORTUNITY]
  });
  assert(r.ok, "should pass");
  assert(r.hasVerifiedFault === false, "should not claim a verified fault");
});

check("a lead whose only finding is CLEAR is rejected", () => {
  const r = evaluateLeadQuality({
    phone: "(512) 555-0100",
    website: "https://acme.com",
    weaknesses: [CLEAR]
  });
  assert(!r.ok, "CLEAR must not count as a weakness");
});

check("a lead with no findings at all is rejected", () => {
  const r = evaluateLeadQuality({
    phone: "(512) 555-0100",
    website: "https://acme.com",
    weaknesses: []
  });
  assert(!r.ok, "no findings means nothing to pitch");
});

check("a lead with no contact is rejected", () => {
  const r = evaluateLeadQuality({
    website: "https://acme.com",
    email: "",
    phone: "",
    weaknesses: [VERIFIED]
  });
  assert(!r.ok, "uncontactable lead must be rejected");
});

check("an email-only lead with a real defect passes", () => {
  const r = evaluateLeadQuality({
    email: "hi@acme.com",
    website: "https://acme.com",
    weaknesses: [VERIFIED]
  });
  assert(r.ok, "email is a valid contact");
});

check("a no-website lead passes because the absence is the finding", () => {
  const r = evaluateLeadQuality({
    phone: "(512) 555-0100",
    website: "",
    rawSignals: { noWebsite: true },
    weaknesses: []
  });
  assert(r.ok, "no website is a genuine finding");
});

check("isNoWebsiteLead detects a blank website", () => {
  assert(isNoWebsiteLead({ website: "", rawSignals: {} }) === true);
  assert(isNoWebsiteLead({ website: "https://acme.com", rawSignals: {} }) === false);
});

check("a null lead is rejected rather than throwing", () => {
  const r = evaluateLeadQuality(null);
  assert(!r.ok, "null must be rejected");
});

check("weaknesses are derived when absent, so a raw lead is still judged", () => {
  const r = evaluateLeadQuality({
    phone: "(512) 555-0100",
    website: "https://acme.com",
    rawSignals: { textLength: 3000, noMobileViewport: true }
  });
  assert(typeof r.ok === "boolean", "should return a verdict, not throw");
});

check("build rejects a website-bearing lead by default", () => {
  const r = evaluateLeadQuality({
    phone: "(512) 555-0100",
    website: "https://acme.com",
    weaknesses: [VERIFIED]
  }, { serviceFilter: "build" });
  assert(!r.ok, "build must reject existing websites when the source is available");
});

check("build accepts a website-bearing lead when the no-website source is unavailable", () => {
  const r = evaluateLeadQuality({
    phone: "(512) 555-0100",
    website: "https://acme.com",
    weaknesses: [VERIFIED]
  }, { serviceFilter: "build", allowExistingWebsite: true });
  assert(r.ok, "degraded build must keep the website-bearing lead");
});

check("degraded build keeps a clean-audit website lead as an improvement prospect", () => {
  const r = evaluateLeadQuality({
    phone: "(512) 555-0100",
    website: "https://acme.com",
    weaknesses: [CLEAR]
  }, { serviceFilter: "build", allowExistingWebsite: true });
  assert(r.ok, "degraded build must not drop a clean-audit lead");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
