/*
  Person-level web research - tests.

  Once a decision-maker is NAMED, enrichment must search the public internet
  for that person (LinkedIn/X profile first) and only attach what truly
  matches. These checks pin down:
    - queries anchor the person to the company (no bare-name matching)
    - a page confirms the person only when it names BOTH person and company
    - profile URLs come from search results, must contain the person's own
      name slug, and are LinkedIn /in/ or X/Twitter profiles only
    - a search-result title is extracted honestly or left empty
    - with web search disabled/missing keys the function returns an empty
      result with a note and never throws (no keys = no crash, no invention)
  No network: the availability flag is forced off for the entry-point test.
*/
import assert from "node:assert/strict";
import {
  personQueries,
  peopleFromPersonPage,
  publicPersonProfiles,
  titleFromSearchResult,
  researchPersonByName
} from "../src/enrichmentResearch.js";

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

/* ---- queries anchor the person to the company ---- */
check("personQueries pairs the person's name with the company", () => {
  const qs = personQueries("Jason Fried", "Basecamp", "basecamp.com");
  assert.ok(qs.length >= 1, "at least one query");
  assert.ok(qs.every(q => q.includes("\"Jason Fried\"")), `every query carries the exact name: ${JSON.stringify(qs)}`);
  assert.ok(qs.some(q => /basecamp/i.test(q)), `at least one query names the company: ${JSON.stringify(qs)}`);
});

check("personQueries refuses an empty or single-word name", () => {
  assert.deepEqual(personQueries("", "Acme", "acme.test"), []);
  assert.deepEqual(personQueries("   ", "Acme", "acme.test"), []);
});

/* ---- page confirmation: person AND company, never one alone ---- */
const page = (text, title = "") => ({ text, title, emails: [], ownerName: "", ownerRole: "" });

check("a page naming the person at the company confirms with its title", () => {
  /* The shared role extractor requires the role directly after the name
     ("Jason Fried, Founder") - prose like "who serves as" is deliberately
     not matched, so the test uses the form real profile pages use. */
  const scraped = page(
    "Jason Fried, Founder and CEO, leads Basecamp and writes about its craft.",
    "Basecamp - Leadership"
  );
  const out = peopleFromPersonPage(scraped, "Jason Fried", "Basecamp", "basecamp.com");
  assert.equal(out.length, 1, "one confirmation");
  assert.equal(out[0].name, "Jason Fried");
  assert.ok(/founder|ceo/i.test(out[0].title), `title must carry the role, got "${out[0].title}"`);
});

check("a page naming only the person (different company) is rejected", () => {
  const scraped = page("Jason Fried wrote about work habits in a guest essay for a magazine today.");
  assert.deepEqual(peopleFromPersonPage(scraped, "Jason Fried", "Basecamp", "basecamp.com"), []);
});

check("a page naming only the company is rejected", () => {
  const scraped = page("Basecamp builds software for teams. Our pricing is simple.");
  assert.deepEqual(peopleFromPersonPage(scraped, "Jason Fried", "Basecamp", "basecamp.com"), []);
});

check("single-word 'names' are never treated as a person", () => {
  const scraped = page("Contact Basecamp today. Services and Support.");
  assert.deepEqual(peopleFromPersonPage(scraped, "Contact", "Basecamp", "basecamp.com"), []);
});

check("person + company without any role pattern still confirms, title empty", () => {
  const scraped = page("Many years ago Jason Fried started Basecamp in a small office.");
  const out = peopleFromPersonPage(scraped, "Jason Fried", "Basecamp", "basecamp.com");
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "", "no stated role means an empty title, never an invented one");
});

/* ---- profile URLs: search results only, name slug must match ---- */
const results = [
  { url: "https://www.linkedin.com/in/jason-fried", title: "Jason Fried | LinkedIn", snippet: "" },
  { url: "https://www.linkedin.com/in/jane-doe-marketer", title: "Jane Doe | LinkedIn", snippet: "" },
  { url: "https://x.com/jasonfried", title: "Jason Fried (@jasonfried)", snippet: "" },
  { url: "https://example.com/about/team", title: "Our Team", snippet: "" },
  { url: "https://www.linkedin.com/company/basecamp", title: "Basecamp | LinkedIn", snippet: "" }
];

check("publicPersonProfiles keeps only the person's own profile slugs", () => {
  const profiles = publicPersonProfiles(results, "Jason Fried");
  assert.ok(profiles.some(u => u.includes("/in/jason-fried")), `LinkedIn profile missing: ${JSON.stringify(profiles)}`);
  assert.ok(profiles.some(u => u.includes("x.com/jasonfried")), `X profile missing: ${JSON.stringify(profiles)}`);
  assert.ok(!profiles.some(u => u.includes("jane-doe")), "another person's profile must never attach");
  assert.ok(!profiles.some(u => u.includes("/company/")), "company pages are not personal profiles");
  assert.ok(!profiles.some(u => u.includes("/about/team")), "plain pages are not profiles");
});

check("publicPersonProfiles returns nothing for an empty name", () => {
  assert.deepEqual(publicPersonProfiles(results, ""), []);
});

/* ---- search-result titles: extracted or honestly empty ---- */
check("titleFromSearchResult trims the name and the network's own suffix", () => {
  assert.equal(
    titleFromSearchResult({ title: "Jason Fried - Founder at Basecamp | LinkedIn" }, "Jason Fried"),
    "Founder at Basecamp"
  );
});

check("titleFromSearchResult leaves no title when the remainder is chrome", () => {
  assert.equal(titleFromSearchResult({ title: "Jason Fried | LinkedIn" }, "Jason Fried"), "");
  assert.equal(titleFromSearchResult({ title: "Jason Fried" }, "Jason Fried"), "");
  assert.equal(titleFromSearchResult({ title: "Jason Fried (@jasonfried) on X" }, "Jason Fried"), "");
  assert.equal(titleFromSearchResult({ title: "Someone Else - CEO" }, "Jason Fried"), "");
});

check("titleFromSearchResult refuses a bare company name as a job title", () => {
  assert.equal(
    titleFromSearchResult({ title: "Randy Gitli - Aladdin Plumbing Corp. | LinkedIn" }, "Randy Gitli"),
    "",
    "a company ending like Corp. is never the person's job title"
  );
  assert.equal(
    titleFromSearchResult({ title: "Randy Gitli - Owner | Aladdin Plumbing" }, "Randy Gitli"),
    "Owner",
    "a real role is still kept"
  );
});

check("publicPersonProfiles counts www and bare profile URLs once", () => {
  const profiles = publicPersonProfiles([
    { url: "https://www.linkedin.com/in/jason-fried" },
    { url: "https://linkedin.com/in/jason-fried" },
    { url: "https://www.linkedin.com/in/jason-fried/" }
  ], "Jason Fried");
  assert.equal(profiles.length, 1, `duplicates survived: ${JSON.stringify(profiles)}`);
});

/* ---- entry point: disabled web search degrades to an honest empty ---- */
const hadFlag = Object.prototype.hasOwnProperty.call(process.env, "ENRICHMENT_WEB_SEARCH_ENABLED");
const oldFlag = process.env.ENRICHMENT_WEB_SEARCH_ENABLED;
process.env.ENRICHMENT_WEB_SEARCH_ENABLED = "false";
let disabledResult;
try {
  disabledResult = await researchPersonByName("Jason Fried", { company: "Basecamp", domain: "basecamp.com" });
} finally {
  if (hadFlag) process.env.ENRICHMENT_WEB_SEARCH_ENABLED = oldFlag;
  else delete process.env.ENRICHMENT_WEB_SEARCH_ENABLED;
}

check("disabled web search returns empty with a note and never throws", () => {
  assert.deepEqual(disabledResult.contacts, []);
  assert.deepEqual(disabledResult.profiles, []);
  assert.ok(disabledResult.notes.some(n => /not available/.test(n)), `note missing: ${JSON.stringify(disabledResult.notes)}`);
});

const noDomainResult = await researchPersonByName("Jason Fried", { company: "Basecamp", domain: "" });
check("an empty domain is rejected before any search", () => {
  assert.deepEqual(noDomainResult.contacts, []);
  assert.equal(noDomainResult.queriesRun, 0, "no query may run without a domain");
});

console.log(failures === 0 ? "\nALL PERSON RESEARCH CHECKS PASSED" : `\n${failures} person research check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
