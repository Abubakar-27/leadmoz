// cheerio's .text() joins sibling text nodes with no separator, which merged
// "Contact Us" into the following email and produced a real, unsendable lead
// address: usinfo@thecoffeegarden.comthe
import assert from "node:assert";
import http from "node:http";
import { scrapeWebsite, normalizeBusinessName } from "../src/scrape.js";

const HTML = `<!doctype html><html><head><title>Coffee Shop</title></head><body>
  <nav>
    <span>Contact Us</span><a href="mailto:info@thecoffeegarden.com">Email Us</a>
  </nav>
  <p>Call us</p><p>713-555-0100</p>
  <div>Reach the shop at us today during business hours</div>
  <a href="tel:+17135550100">Ring the shop</a>
  <script>var x = "info@notreal.com";</script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

let scraped;
try {
  scraped = await scrapeWebsite(`http://127.0.0.1:${port}/`, { runAudits: false, render: false });
} finally {
  server.close();
}

const emails = scraped.emails || [];
const bad = emails.filter(e => /comthe|com[a-z]/.test(e));
assert.strictEqual(bad.length, 0, `no repaired/garbage TLDs allowed, got: ${JSON.stringify(emails)}`);

assert.ok(
  emails.includes("info@thecoffeegarden.com"),
  `expected a clean mailto email, got: ${JSON.stringify(emails)}`
);

// A script body must never become a lead email.
assert.ok(
  !emails.includes("info@notreal.com"),
  "emails inside <script> must be ignored"
);

// The repaired address must not have absorbed the preceding word.
assert.ok(
  !emails.some(e => /^usinfo@/i.test(e)),
  `email must not start mid-word, got: ${JSON.stringify(emails)}`
);

// Word boundaries must survive in the text the gate reads.
const text = scraped.text || "";
assert.ok(/Contact Us/.test(text), `"Contact Us" must stay two words, got: ${text.slice(0, 120)}`);
assert.ok(!/Usinfo@/.test(text), "text must not merge words into an email");
assert.ok(!/\bus713-555-0100\b/.test(text), "adjacent paragraphs must not merge into the phone");

// Existing name normalisation must still hold.
assert.strictEqual(normalizeBusinessName("Contact Us - Pall Mall Barbers"), "Pall Mall Barbers");
assert.strictEqual(normalizeBusinessName("Home"), "");

console.log("ALL EMAIL EXTRACTION CHECKS PASSED");
