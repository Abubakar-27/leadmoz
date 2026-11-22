/*
  Web-search research provider - tests.

  The research stage must:
    - build tight queries around the company name and domain
    - only credit a person to the company when the page names the company
    - keep ONLY company-domain emails from third-party pages (never freemail
      or another domain found on an aggregator page)
    - work with NO search key configured (returns nothing + a note, no throw)
  No network: pages are fed in as scraped objects.
*/
import assert from "node:assert/strict";
import {
  researchQueries,
  peopleFromResearchPage,
  emailsFromResearchPage,
  researchPeopleOnWeb
} from "../src/enrichmentResearch.js";

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`not ok - ${name}`);
    console.log(`  ${err.message}`);
  }
}

/* ---- query building */
await check("queries mention the company name and the domain", () => {
  const queries = researchQueries("Acme Robotics", "acmerobotics.test");
  assert.ok(queries.some(q => q.includes("Acme Robotics")), `no name query: ${JSON.stringify(queries)}`);
  assert.ok(queries.some(q => q.includes("acmerobotics.test")), `no domain query: ${JSON.stringify(queries)}`);
  assert.ok(queries.length <= 2, "query count must stay capped");
});

await check("a nameless company falls back to the domain query", () => {
  const queries = researchQueries("", "plumbco.test");
  assert.ok(queries.length >= 1 && queries[0].includes("plumbco.test"), JSON.stringify(queries));
});

/* ---- company-mention gate */
const goodPage = {
  title: "Acme Robotics - About",
  text: "Acme Robotics was founded by Jane Doe, Owner, in 1998. Jane Doe - Owner runs the company.",
  emails: [],
  scrapeOk: true
};

await check("a page naming the company yields its people", () => {
  const people = peopleFromResearchPage(goodPage, "Acme Robotics", "acmerobotics.test");
  assert.ok(people.length > 0, "expected at least one person");
  assert.ok(people.some(p => /jane doe/i.test(p.name)), JSON.stringify(people));
});

await check("a page that never mentions the company yields nobody", () => {
  const unrelated = {
    title: "Best CEO list",
    text: "John Smith, CEO of an unrelated startup, spoke at a conference about growth.",
    emails: [],
    scrapeOk: true
  };
  const people = peopleFromResearchPage(unrelated, "Acme Robotics", "acmerobotics.test");
  assert.equal(people.length, 0, `unrelated people leaked in: ${JSON.stringify(people)}`);
});

await check("role words without a person name never become contacts", () => {
  const jobPage = {
    title: "Careers",
    text: "We are hiring a Product Marketing Manager. Acme Robotics careers page.",
    emails: [],
    scrapeOk: true
  };
  const people = peopleFromResearchPage(jobPage, "Acme Robotics", "acmerobotics.test");
  assert.equal(people.length, 0, JSON.stringify(people));
});

/* ---- email filtering */
await check("only company-domain emails survive a third-party page", () => {
  const page = {
    title: "Directory listing",
    text: "Contact Acme Robotics at sales@acmerobotics.test or the listed gmail.",
    emails: ["sales@acmerobotics.test", "random@gmail.com", "other@competitor.test"],
    scrapeOk: true
  };
  const emails = emailsFromResearchPage(page, "acmerobotics.test");
  assert.deepEqual(emails, ["sales@acmerobotics.test"], JSON.stringify(emails));
});

/* ---- no-key behaviour */
await check("without a search key the provider returns nothing and a note, never throws", async () => {
  const saved = { t: process.env.TAVILY_API_KEYS, tk: process.env.TAVILY_API_KEY, f: process.env.FIRECRAWL_API_KEYS, fk: process.env.FIRECRAWL_API_KEY, e: process.env.ENRICHMENT_WEB_SEARCH_ENABLED };
  delete process.env.TAVILY_API_KEYS; delete process.env.TAVILY_API_KEY;
  delete process.env.FIRECRAWL_API_KEYS; delete process.env.FIRECRAWL_API_KEY;
  try {
    const out = await researchPeopleOnWeb("acmerobotics.test", { companyName: "Acme Robotics" });
    assert.equal(out.contacts.length, 0);
    assert.equal(out.emails.length, 0);
    assert.ok(out.notes.some(n => /web_search: not available/.test(n)), JSON.stringify(out.notes));
  } finally {
    if (saved.t !== undefined) process.env.TAVILY_API_KEYS = saved.t;
    if (saved.tk !== undefined) process.env.TAVILY_API_KEY = saved.tk;
    if (saved.f !== undefined) process.env.FIRECRAWL_API_KEYS = saved.f;
    if (saved.fk !== undefined) process.env.FIRECRAWL_API_KEY = saved.fk;
    if (saved.e !== undefined) process.env.ENRICHMENT_WEB_SEARCH_ENABLED = saved.e;
  }
});

await check("an explicitly disabled provider never searches", async () => {
  const saved = process.env.ENRICHMENT_WEB_SEARCH_ENABLED;
  process.env.ENRICHMENT_WEB_SEARCH_ENABLED = "false";
  try {
    const out = await researchPeopleOnWeb("acmerobotics.test", { companyName: "Acme Robotics" });
    assert.equal(out.contacts.length, 0);
    assert.ok(out.notes.length > 0, "a disabled provider must say why");
  } finally {
    if (saved === undefined) delete process.env.ENRICHMENT_WEB_SEARCH_ENABLED;
    else process.env.ENRICHMENT_WEB_SEARCH_ENABLED = saved;
  }
});

console.log(failures === 0 ? "\nALL WEB RESEARCH CHECKS PASSED" : `\n${failures} research check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
