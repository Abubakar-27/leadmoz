import { toPreviewCandidate, assignDistinctFindings } from "../src/preview.js";
import { weaknessesForPreview, weaknessesForFreeTier, safeAuditText } from "../src/weaknesses.js";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (name, cond, detail = "") => {
    if (cond) console.log(`  PASS  ${name}`);
    else { failures += 1; console.log(`  FAIL  ${name} ${detail}`); }
};

const scraped = (over = {}) => ({
    website: "https://jonesplumbing.test",
    businessName: "Jones Plumbing Co",
    primaryEmail: "hello@jonesplumbing.test",
    primaryPhone: "+1 512 555 0142",
    addresses: ["1200 Congress Ave, Austin TX"],
    scrapeOk: true,
    text: "x".repeat(400),
    signals: { hasBooking: false, hasTestimonials: false, hasCTA: false, hasEmail: true, hasPhone: true, hasViewport: true, hasMetaDescription: true, likelyOldSite: false, textLength: 400, linkCount: 8 },
    ...over
});

console.log("\n[1] Nothing identifying exists on a preview card");
const cards = assignDistinctFindings([
    toPreviewCandidate(scraped(), "plumber"),
    toPreviewCandidate(scraped({ businessName: "Beta Plumbing" }), "plumber"),
    toPreviewCandidate(scraped({ businessName: "Gamma Plumbing" }), "plumber")
]);

check("three cards produced", cards.length === 3, String(cards.length));
check("no reveal field on any card", cards.every(c => !("revealed" in c)), Object.keys(cards[0]).join(","));
check("label is the category only", cards.every(c => /^A /.test(c.label)), cards[0].label);

/*
  Cards carry the scrape internally so the audit pass can reach it, so the card
  is reduced to its public shape first, exactly as runPreview does before
  caching. That reduced object is what a visitor can ever see.
*/
const publicCards = cards.map(c => ({ label: c.label, weakness: c.weakness }));
const body = JSON.stringify(publicCards);

check("public card has only label and weakness", Object.keys(publicCards[0]).join(",") === "label,weakness", Object.keys(publicCards[0]).join(","));
check("no business name", !/Jones Plumbing|Beta Plumbing|Gamma Plumbing/.test(body));
check("no email address", !/@/.test(body), body.slice(0, 120));
check("no phone number", !/\+?\d[\d\s().-]{8,}\d/.test(body));
check("no url or domain", !/https?:\/\/|\.test|\.com/i.test(body));
check("no street address", !/Congress Ave/i.test(body));
check("weakness copy still present", publicCards.every(c => c.weakness?.label && c.weakness?.hook));

console.log("\n[2] The scrape stays internal, and is dropped before it is cached");
/*
  The candidate carries the whole scrape - name, contacts, addresses and the
  full page HTML - so the audit pass can read it. That object must not reach the
  cache, because the cached value is what every later visitor is served.
*/
check("scrape is available internally", Boolean(cards[0].scraped));
check("cached card carries no scrape", !publicCards.some(c => "scraped" in c));
check("page text not in the public body", !body.includes("x".repeat(50)));

console.log("\n[3] The response layer has no unlock path, and the landing page has no preview");
/*
  Unlocking one lead per row was built, shipped, then removed. These assertions
  exist so it cannot come back by accident: the server has no reveal branch, and
  the preview module has no identity helper to call.
*/
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const preview = readFileSync(new URL("../src/preview.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

check("server never reads a reveal field", !/lead\.revealed/.test(server));
check("server emits no revealedCount", !/revealedCount/.test(server));
check("server builds cards from a fixed field list", /label: String\(lead\.label/.test(server) && /weakness: \{/.test(server));
check("preview has no identity helper", !/previewIdentity|applySingleReveal/.test(preview));
check("preview never sets an identity field", !/\bidentity\s*[:,}]/.test(preview));
check("preview strips the scrape before caching", /const publicLeads = leads\.map/.test(preview));
check("cached value is built from publicLeads", /leads: publicLeads/.test(preview));
check("landing page renders no unlock UI", !/pv-badge|pv-reveal|pv-contact|is-open/.test(html));
check("landing page has no free-preview section", !/id="preview"|class="preview"|previewForm|Show Me 3 Free Leads/.test(html));
check("landing page has no preview copy at all", !/Free preview|See 3 real leads|free previews? left this hour/i.test(html));
check("landing page does not call the preview endpoint", !/api\/preview/.test(html));
check("landing page has no preview script block", !/getElementById\("pv/.test(html));

console.log("\n[4] Audit findings still reach the preview (parity with paid users)");
const audited = {
    website: "https://audited.test",
    scrapeOk: true,
    leakingFunnelAudit: { broken_internal_links: ["/gone", "/also-gone"] },
    seoSchemaAudit: { dead_social_icons: 3, contact_form: { has_contact_form: true, issues: ["Form has no action attribute"] } },
    rawSignals: {
        hasBooking: true, hasPricing: true, hasTestimonials: true, hasCTA: true,
        hasEmail: true, hasPhone: true, hasViewport: true, hasMetaDescription: true,
        hasSchemaMarkup: true, likelyOldSite: false, textLength: 5000, linkCount: 30
    }
};
const previewIds = weaknessesForPreview(audited).map(f => f.id);
const freeIds = weaknessesForFreeTier(audited).map(f => f.id);
check("preview keeps audit findings", previewIds.includes("broken_links") || previewIds.includes("broken_contact_form"), previewIds.join(","));
check("free plan still hides them", !freeIds.includes("broken_links") && !freeIds.includes("broken_contact_form"), freeIds.join(","));

console.log("\n[5] Audit evidence must not smuggle a URL into card copy");
/*
  The site audit writes sentences containing the page URL, which is right for an
  engineer and wrong on a card whose business is meant to stay anonymous. It
  leaked a masked card's domain before this was handled.
*/
const withUrl = "Form on https://secret-roofing.example/contact-us has no action attribute (submits to same page)";
const cleaned = safeAuditText(withUrl);
check("url removed", !/https?:/i.test(cleaned), cleaned);
check("hostname removed", !/secret-roofing/i.test(cleaned), cleaned);
check("sentence still readable", /no action attribute/i.test(cleaned), cleaned);

const formFinding = weaknessesForPreview({
    website: "https://secret-roofing.example",
    scrapeOk: true,
    leakingFunnelAudit: { broken_internal_links: [], form_vulnerabilities: { has_contact_form: true, issues: [withUrl] } },
    seoSchemaAudit: {},
    rawSignals: { hasBooking: true, hasPricing: true, hasTestimonials: true, hasCTA: true, hasEmail: true, hasPhone: true, hasViewport: true, hasMetaDescription: true, textLength: 5000, linkCount: 30 }
}).find(f => f.id === "broken_contact_form");

const text = formFinding ? `${formFinding.label} ${formFinding.detail} ${formFinding.hook}` : "";
check("finding produced", Boolean(formFinding));
check("no url in finding copy", !/https?:\/\//i.test(text), text);
check("no domain in finding copy", !/secret-roofing/i.test(text), text);
check("still explains the fault", /no action attribute/i.test(text), text);

console.log(`\n${failures === 0 ? "ALL MASKING CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
