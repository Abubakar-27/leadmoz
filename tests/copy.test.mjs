import { readFileSync } from "node:fs";
import { deriveWeaknesses } from "../src/weaknesses.js";

let failures = 0;
const check = (name, cond, detail = "") => {
    if (cond) console.log(`  PASS  ${name}`);
    else { failures += 1; console.log(`  FAIL  ${name} ${detail}`); }
};

/* Builds a lead that trips every signal-tier finding we can reach.

   textLength is a realistic full page, not a stub. Absence-based findings
   ("no booking", "no call to action") are deliberately withheld from pages too
   short to read, because we cannot claim something is missing from a page we
   barely captured. A 400-character fixture would silently drop those findings
   and the copy checks below would be asserting against an empty list. */
const baseSignals = () => ({
    hasBooking: false,
    hasPricing: false,
    hasTestimonials: false,
    hasCTA: false,
    hasEmail: false,
    hasPhone: false,
    likelyOldSite: true,
    hasViewport: false,
    hasMetaDescription: false,
    hasSchemaMarkup: false,
    textLength: 9000,
    linkCount: 24
});

/* Audit knobs get their own argument; signal tweaks merge into the base set so
   an override can never wipe out the other defaults. */
function leadWith(signals = {}, audits = {}) {
    return {
        website: "https://example.test",
        scrapeOk: true,
        mapsRating: 4.8,
        mapsReviewCount: 120,
        leakingFunnelAudit: { broken_internal_links: ["a", "b"] },
        seoSchemaAudit: { dead_social_icons: 2, contact_form: { issues: ["no action"] } },
        ...audits,
        rawSignals: { ...baseSignals(), ...signals }
    };
}

const all = deriveWeaknesses(leadWith());
console.log(`  (${all.length} findings derived)\n`);

console.log("\n[1] Copy is not written for one particular trade");
/*
  The first version of the booking pitch said "put them on your chair", which
  is barber language shown to a plumber. The preview labels every card with the
  visitor's own niche, so any word tied to one trade is a bug waiting to be seen.
*/
const FORBIDDEN = [
    "chair", "salon", "barber", "shop ", "spa", "groom", "fade", "shave",
    "restaurant", "menu", "table", "diner", "clinic", "patient", "doctor",
    "hair", "nail", "massage", "plumber", "pipe", "roofer", "truck"
];

for (const f of all) {
    const text = `${f.label} ${f.detail} ${f.hook}`.toLowerCase();
    const hits = FORBIDDEN.filter(w => text.includes(w));
    check(`"${f.id}" is trade-neutral`, hits.length === 0, `-> found: ${hits.join(", ")}`);
}

console.log("\n[2] Copy suits a plumber, because that is what was tested");
const booking = all.find(f => f.id === "no_online_booking");
check("the booking finding is still derived", Boolean(booking), JSON.stringify(all.map(f => f.id)));
check("booking pitch mentions no furniture", !/chair|table|seat/i.test(booking?.hook || ""), booking?.hook);

console.log("\n[3] Nothing claims a speed score, a viewport test we did not run, etc.");
const banned = [/lighthouse/i, /page ?speed/i, /load(ed|ing) in \d/i, /score of \d/i, /pixels?/i, /https|certificate|ssl/i];
for (const f of all) {
    const text = `${f.label} ${f.detail} ${f.hook}`;
    const hit = banned.find(re => re.test(text));
    check(`"${f.id}" claims nothing unmeasured`, !hit, `-> ${hit}`);
}

console.log("\n[4] The honest fallback still exists for the dashboard");
/* A genuinely tidy site: nothing failing, and the good reviews are on-site. */
const tidy = { broken_internal_links: [], dead_social_icons: 0, contact_form: { issues: [] } };
const clean = deriveWeaknesses(leadWith({
    hasBooking: true, hasPricing: true, hasTestimonials: true, hasCTA: true,
    hasEmail: true, hasPhone: true, likelyOldSite: false, hasViewport: true,
    hasMetaDescription: true, hasSchemaMarkup: true, textLength: 9000, linkCount: 12
}, {
    leakingFunnelAudit: { broken_internal_links: tidy.broken_internal_links },
    seoSchemaAudit: { dead_social_icons: tidy.dead_social_icons, contact_form: tidy.contact_form }
}));
check("clean lead -> single fallback", clean.length === 1 && clean[0].id === "no_defects_found", JSON.stringify(clean.map(f => f.id)));

console.log("\n[5] Strong reputation is only claimed when the site shows no proof");
const wellRated = (signals) => deriveWeaknesses(leadWith(signals, {
    leakingFunnelAudit: { broken_internal_links: [] },
    seoSchemaAudit: { dead_social_icons: 0, contact_form: { issues: [] } }
})).filter(f => f.id === "strong_reputation_no_site_proof");

const shown = wellRated({
    hasTestimonials: true, hasBooking: true, hasPricing: true, hasCTA: true,
    hasEmail: true, hasPhone: true, likelyOldSite: false, hasViewport: true,
    hasMetaDescription: true, hasSchemaMarkup: true, textLength: 9000, linkCount: 12
});
check("reviews visible on site -> no 'no proof' claim", shown.length === 0, JSON.stringify(shown.map(f => f.id)));

const hidden = wellRated({
    hasTestimonials: false, hasBooking: true, hasPricing: true, hasCTA: true,
    hasEmail: true, hasPhone: true, likelyOldSite: false, hasViewport: true,
    hasMetaDescription: true, hasSchemaMarkup: true, textLength: 9000, linkCount: 12
});
check("reviews absent from site -> claim is made", hidden.length === 1, JSON.stringify(hidden.map(f => f.id)));

console.log("\n[6] No anonymous card is ever allowed to say there is nothing wrong");
/* The landing page promises "the specific weakness we found on their site".
   A card reading "Nothing broken, nothing tuned" breaks that promise, and it
   showed up in real plumber output. It stays valid for the paid dashboard,
   where the full picture is useful, but must never reach a logged-out row.

   These are source-level assertions because preview.test.mjs has no network
   harness to drive a real search through. Each one is stated as the invariant
   it protects rather than as the line that happens to implement it today. */
const previewSource = readFileSync(new URL("../src/preview.js", import.meta.url), "utf8");
const cleanBranch = previewSource.match(/if \(topId === "no_defects_found"\)[\s\S]{0,300}/);

check("preview recognises a clean site", Boolean(cleanBranch));
check("clean site is counted, not queued", /clean \+= 1/.test(cleanBranch?.[0] || ""), cleanBranch?.[0]);
check("clean site is never pushed onto a card list", !/clean\.push/.test(cleanBranch?.[0] || ""), cleanBranch?.[0]);

/*
  A clean site is held for the audit pass rather than discarded. Signals alone
  cannot see a dead link or a form that submits nowhere, so treating a
  single-pass clean site as proof of health is what made searches report "we
  could not find a weakness we could prove" while the site that would have
  proved one sat unaudited. */
check("clean sites are retained for auditing", /const cleanCandidates = \[\]/.test(previewSource));
check("a clean site is pushed to the audit pool, not the card list", /cleanCandidates\.push/.test(cleanBranch?.[0] || ""));
check("the audit pool includes the clean candidates", /\.\.\.cleanCandidates/.test(previewSource));

/* The gate that made the audit unreachable when nothing had passed yet. */
const auditGate = previewSource.match(/if \(AUDIT_TOP_LEADS[^\n]*/)?.[0] || "";
check("audit is gated on the pool, not on already having leads",
    /auditPool\.length > 0/.test(auditGate) && !/leads\.length > 0/.test(auditGate), auditGate);

/* Paying for an audit must not let an inference back onto a card. */
check("rows still leading with a clear verdict are filtered out", /class !== "clear"/.test(previewSource));
check("only defect-led rows are credited back out of the clean count", /findings\[0\]\?\.class === "defect"/.test(previewSource));

console.log(`\n${failures === 0 ? "ALL COPY CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
