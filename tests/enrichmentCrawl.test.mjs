/*
  Whole-site enrichment crawl - tests.

  The enrichment feature must read a company's whole published site, not just
  the homepage plus the four keyword links the lead scraper has always used.
  These checks pin down:
    - the DEFAULT crawl shape is unchanged (lead scraping must not regress)
    - crawl:{includeAll} reads non-keyword pages (services, team, ...) too
    - crawl:{forceDeep} reads the deep contact/legal pages even when the
      homepage already shows an email
    - founding year and headcount come from the site's own schema.org markup
    - every crawl is capped by maxPages and stays on the submitted domain
  No API keys, no network beyond a local throwaway server.
*/
import assert from "node:assert/strict";
import http from "node:http";
import { scrapeWebsite } from "../src/scrape.js";

const pad = (s) => (s + " ".repeat(340)).slice(0, 340);

const PAGES = {
  "/": `<!doctype html><html><head><title>Acme Robotics</title></head><body>
    <p>Acme Robotics builds warehouse automation systems for factories worldwide.</p>
    <p>Reach us at hello@acmerobotics.test or call +1 216 555 0100.</p>
    <script type="application/ld+json">{"@type":"Organization","name":"Acme Robotics",
      "foundingDate":"1998","numberOfEmployees":250,"telephone":"+1-216-555-0100",
      "sameAs":["https://www.linkedin.com/company/acme-robotics"]}</script>
    <a href="/contact">Contact</a><a href="/about">About</a>
    <a href="/services">Services</a><a href="/team">Team</a>
    <a href="/privacy-policy">Privacy</a>
  </body></html>`,
  "/contact": `<!doctype html><html><head><title>Contact</title></head><body>${pad("Contact page content for Acme Robotics sales department.")}</body></html>`,
  "/about": `<!doctype html><html><head><title>About</title></head><body>${pad("About page: the history of Acme Robotics, started by a small engineering team in Ohio.")}</body></html>`,
  "/services": `<!doctype html><html><head><title>Services</title></head><body>${pad("Services: robotics integration, conveyor systems, pick and place automation.")}</body></html>`,
  "/team": `<!doctype html><html><head><title>Team</title></head><body>${pad("Our leadership team page listing the executives of the company.")}</body></html>`,
  "/privacy-policy": `<!doctype html><html><head><title>Privacy Policy</title></head><body>${pad("Privacy policy page for Acme Robotics, postal address: 500 Industrial Way.")}<script type="application/ld+json">{"@type":"Organization","name":"Acme Robotics","address":{"streetAddress":"500 Industrial Way","addressLocality":"Akron","addressCountry":"US"}}</script></body></html>`
};

const server = http.createServer((req, res) => {
  const path = req.url.split("?")[0].replace(/\/+$/, "") || "/";
  const html = PAGES[path];
  if (!html) {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<!doctype html><html><head><title>404 Not Found</title></head><body>not found</body></html>");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

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

try {
  const defaultCrawl = await scrapeWebsite(`${base}/`, { runAudits: false, render: false, skipCache: true });
  const deepCrawl = await scrapeWebsite(`${base}/`, {
    runAudits: false,
    render: false,
    skipCache: true,
    crawl: { maxPages: 12, includeAll: true, forceDeep: true }
  });

  const cappedCrawl = await scrapeWebsite(`${base}/`, {
    runAudits: false, render: false, skipCache: true, crawl: { maxPages: 2, includeAll: true }
  });

  const forcedDeepCrawl = await scrapeWebsite(`${base}/`, {
    runAudits: false, render: false, skipCache: true, crawl: { forceDeep: true }
  });
  const forcedDeepPaths = (forcedDeepCrawl.pagesScraped || []).map((u) => new URL(u).pathname);

  const defaultPaths = (defaultCrawl.pagesScraped || []).map((u) => new URL(u).pathname);
  const deepPaths = (deepCrawl.pagesScraped || []).map((u) => new URL(u).pathname);
  const cappedPaths = (cappedCrawl.pagesScraped || []).map((u) => new URL(u).pathname);

  check("default crawl shape is unchanged for the lead scraper", () => {
    assert.ok(defaultPaths.includes("/"), "homepage is always read");
    assert.ok(defaultPaths.includes("/contact"), "keyword-ranked pages are still read");
    assert.ok(!defaultPaths.includes("/services"), "a non-keyword page must not be read by default");
    assert.ok(!defaultPaths.includes("/privacy-policy"), "deep pages are not read when an email was found");
  });

  check("the enrichment crawl reads the whole site, not just keyword pages", () => {
    assert.ok(deepPaths.includes("/services"), `services page missing: ${JSON.stringify(deepPaths)}`);
    assert.ok(deepPaths.includes("/team"), `team page missing: ${JSON.stringify(deepPaths)}`);
    assert.ok(deepPaths.includes("/privacy-policy"), "deep contact pages are read even when an email exists");
    assert.ok(deepPaths.length > defaultPaths.length, "the deep crawl reads strictly more pages");
  });

  check("the crawl stays on the submitted domain and caps at maxPages", () => {
    const hosts = new Set((deepCrawl.pagesScraped || []).map((u) => new URL(u).hostname));
    assert.equal(hosts.size, 1, `crawl escaped its own host: ${[...hosts].join(", ")}`);
    assert.ok(deepPaths.length <= 12, `maxPages must cap the crawl, got ${deepPaths.length}`);
    assert.ok(cappedPaths.length <= 2, `maxPages=2 must read at most 2 pages, got ${cappedPaths.length}`);
    assert.ok(cappedPaths.includes("/"), "the homepage is always the first page read");
  });

  check("forceDeep alone pulls the deep contact pages the default crawl skips", () => {
    assert.ok(forcedDeepPaths.includes("/privacy-policy"), `privacy page missing: ${JSON.stringify(forcedDeepPaths)}`);
    assert.ok(!forcedDeepPaths.includes("/services"), "without includeAll the crawl shape stays keyword-ranked");
  });

  check("founding year and headcount come from the site's own schema", () => {
    assert.equal(deepCrawl.founded, "1998");
    assert.equal(deepCrawl.companySize, "250");
    assert.equal(deepCrawl.socialLinks.linkedin, "https://www.linkedin.com/company/acme-robotics");
    assert.ok(deepCrawl.phones.length > 0, "published phone is part of the whole information");
    assert.ok(deepCrawl.addresses.some((a) => /Industrial Way/.test(a)), "deep-page address is captured");
  });

  /* Strip the schema founding year temporarily: the field must then be empty
     rather than carried over or guessed. */
  const originalHome = PAGES["/"];
  PAGES["/"] = originalHome.replace(/"foundingDate":"1998",/, "");
  let bareCrawl;
  try {
    bareCrawl = await scrapeWebsite(`${base}/`, { runAudits: false, render: false, skipCache: true });
  } finally {
    PAGES["/"] = originalHome;
  }

  check("a site that publishes no founding year claims none", () => {
    assert.equal(bareCrawl.founded, "", "no schema and no 'Founded in YYYY' text means an empty field");
  });
} finally {
  server.close();
}


/* A business that publishes its Gmail on its own contact page must not read as
   'no email found' - it is kept and flagged as freemail instead of dropped. */
{
  const providers = await import('../src/enrichmentProviders.js');
  const mapped = providers.mapWebsiteEmails(
    { emails: ['info@bigappleplumbingcorp.com', 'bigappleplumbing@gmail.com'], website: 'https://bigappleplumbingcorp.com/' },
    'bigappleplumbingcorp.com'
  );
  check('a published freemail address is kept and flagged, never silently dropped', () => {
    const gmail = mapped.find(e => e.email === 'bigappleplumbing@gmail.com');
    assert.ok(gmail, 'the company published this address on its own site - it must be returned');
    assert.equal(gmail.freemail, true, 'it must be flagged as freemail so the UI can label it');
    const corporate = mapped.find(e => e.email === 'info@bigappleplumbingcorp.com');
    assert.equal(corporate.freemail, false, 'a corporate-domain address is not freemail');
  });
}

console.log(failures === 0 ? "\nALL ENRICHMENT CRAWL CHECKS PASSED" : `\n${failures} crawl check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);