import { weaknessesForFreeTier, pricingIsExpected } from "../src/weaknesses.js";

let failures = 0;
const check = (name, cond, detail = "") => {
    if (cond) console.log(`  PASS  ${name}`);
    else { failures += 1; console.log(`  FAIL  ${name} ${detail}`); }
};

/* Copy of the preview's assignDistinctFindings so we exercise the real ranking
   input produced by the real derivation. */
function assignDistinctFindings(candidates) {
    const used = new Set();
    const distinct = [];
    const repeats = [];
    for (const candidate of candidates) {
        const fresh = candidate.findings.find(f => !used.has(f.id));
        const chosen = fresh || candidate.findings[0];
        if (!chosen) continue;
        used.add(chosen.id);
        const row = { label: candidate.label, weakness: { label: chosen.label, hook: chosen.hook, detail: chosen.detail } };
        if (fresh) distinct.push(row);
        else repeats.push(row);
    }
    return [...distinct, ...repeats];
}

const cand = (signals, niche = "barber") => ({
    label: "A Barber Shop",
    findings: weaknessesForFreeTier({ website: "https://x.example", scrapeOk: true, rawSignals: signals, niche })
});

/* Signal sets transcribed from the live diagnostic against real Austin barbers. */
const birds   = { hasBooking: true,  hasPricing: false, hasTestimonials: true,  hasCTA: false, hasEmail: false, hasPhone: true,  likelyOldSite: false, linkCount: 5, textLength: 18000 };
const south   = { hasBooking: true,  hasPricing: false, hasTestimonials: false, hasCTA: true,  hasEmail: true,  hasPhone: true,  likelyOldSite: false, linkCount: 4, textLength: 5411 };
const barbons = { hasBooking: true,  hasPricing: false, hasTestimonials: false, hasCTA: true,  hasEmail: false, hasPhone: false, likelyOldSite: false, linkCount: 2, textLength: 2721 };
const shed    = { hasBooking: true,  hasPricing: true,  hasTestimonials: true,  hasCTA: true,  hasEmail: true,  hasPhone: true,  likelyOldSite: false, linkCount: 3, textLength: 15255 };

console.log("\n[1] Pricing is not pitched at service niches");
check("barber -> pricing not expected", pricingIsExpected("barber") === false);
check("dental office -> pricing not expected", pricingIsExpected("dental office") === false);
check("massage therapist -> pricing not expected", pricingIsExpected("massage therapist") === false);
check("unknown niche keeps old behaviour", pricingIsExpected("") === true);
check("boutique -> pricing expected", pricingIsExpected("boutique") === true);
const bar = cand(birds);
check("barber lead has no pricing finding", !bar.findings.some(f => f.id === "no_pricing"), JSON.stringify(bar.findings.map(f => f.id)));
const boutique = cand(birds, "gift boutique");
check("boutique lead does get pricing finding", boutique.findings.some(f => f.id === "no_pricing"), JSON.stringify(boutique.findings.map(f => f.id)));

console.log("\n[2] A realistic pool of sites yields three different angles");
/* Production scans up to 9 sites, so the pool - not just the first three
   hits - is what decides whether three distinct angles are available. */
const pool9 = [
    cand(birds),                       // no_call_to_action
    cand(south),                       // no_testimonials
    cand(barbons),                     // no_testimonials
    cand(shed),                        // clean
    cand({ ...birds, hasCTA: true, hasTestimonials: true, hasBooking: false, textLength: 700 }), // barely_any_copy
    cand({ ...south, hasTestimonials: true, hasCTA: true, likelyOldSite: true }),  // stale_copyright
    cand({ ...birds, hasCTA: true, hasTestimonials: true, hasBooking: false }),    // no_online_booking
    cand(south),
    cand(barbons)
];
const withFindings = pool9.filter(c => c.findings[0].id !== "no_defects_found");
const assigned = assignDistinctFindings(withFindings).slice(0, 3);
const labels = assigned.map(a => a.weakness.label);
console.log("  -> " + labels.join("  |  "));
check("three cards", assigned.length === 3);
check("all three angles differ", new Set(labels).size === 3, JSON.stringify(labels));
check("no pricing angle shown to a barber", !labels.includes("No pricing on site"), JSON.stringify(labels));
check("no empty fallback shown", !labels.includes("Nothing broken, nothing tuned"), JSON.stringify(labels));
check("every card has real outreach copy", assigned.every(a => a.weakness.hook.length > 30));

console.log("\n[3] An almost-empty site is flagged, a normal one-pager is not");
const thin = cand({ hasBooking: true, hasPricing: true, hasTestimonials: true, hasCTA: true, linkCount: 2, textLength: 900 });
const thinIds = thin.findings.map(f => f.id);
check("near-empty site flagged", thinIds.includes("barely_any_copy"), JSON.stringify(thinIds));
check("thin finding carries its number", thin.findings.find(f => f.id === "barely_any_copy")?.detail.includes("900"), JSON.stringify(thin.findings.find(f => f.id === "barely_any_copy")?.detail));
check("single-page brochure site NOT called thin", !cand(birds).findings.some(f => f.id === "barely_any_copy"), JSON.stringify(cand(birds).findings.map(f => f.id)));
check("3-link site not called thin", !cand(shed).findings.some(f => f.id === "barely_any_copy"), JSON.stringify(cand(shed).findings.map(f => f.id)));

console.log("\n[4] Markup-measured findings, and no false alarms on old records");
const legacy = cand({ hasBooking: true, hasPricing: true, hasTestimonials: true, hasCTA: true, textLength: 9000 });
const legacyIds = legacy.findings.map(f => f.id);
check("record without the new keys is not accused", !legacyIds.includes("no_mobile_viewport"), JSON.stringify(legacyIds));
check("old record not told it has no contact details", !legacyIds.includes("no_contact_details"), JSON.stringify(legacyIds));
check("old record not told it has no meta description", !legacyIds.includes("no_meta_description"), JSON.stringify(legacyIds));

const modern = cand({ hasBooking: true, hasPricing: true, hasTestimonials: true, hasCTA: true, textLength: 9000, hasViewport: false, hasMetaDescription: false, hasEmail: false, hasPhone: false });
const modernIds = modern.findings.map(f => f.id);
check("missing viewport reported", modernIds.includes("no_mobile_viewport"), JSON.stringify(modernIds));
check("no readable contact reported", modernIds.includes("no_contact_details"), JSON.stringify(modernIds));
check("missing meta description reported", modernIds.includes("no_meta_description"), JSON.stringify(modernIds));
check("missing viewport outranks keyword findings", modern.findings[0].id === "no_mobile_viewport", modern.findings[0].id);

const healthy = cand({ hasBooking: true, hasPricing: true, hasTestimonials: true, hasCTA: true, textLength: 9000, hasViewport: true, hasMetaDescription: true, hasSchemaMarkup: true, hasEmail: true, hasPhone: true });
check("well-built site gets none of them", healthy.findings.length === 1 && healthy.findings[0].id === "no_defects_found", JSON.stringify(healthy.findings.map(f => f.id)));
check("one email is enough to clear contact finding", !cand({ hasBooking: true, hasPricing: true, hasTestimonials: true, hasCTA: true, textLength: 9000, hasViewport: true, hasMetaDescription: true, hasEmail: true, hasPhone: false }).findings.some(f => f.id === "no_contact_details"));

console.log("\n[5] Visitors see sites with real faults before clean ones");
const visitorOrder = assignDistinctFindings([...withFindings, ...pool9.filter(c => c.findings[0].id === "no_defects_found")]).slice(0, 3);
check("clean site never takes an early slot", !visitorOrder.slice(0, 2).some(o => o.weakness.label === "Nothing broken, nothing tuned"), JSON.stringify(visitorOrder.map(o => o.weakness.label)));
check("clean site only appears if the row is short", visitorOrder.every(o => o.weakness.label !== "Nothing broken, nothing tuned") || visitorOrder.length < 3, JSON.stringify(visitorOrder.map(o => o.weakness.label)));

console.log("\n[6] The worst problem is chosen first");
const rich = cand({ ...birds, likelyOldSite: true, hasTestimonials: false, hasCTA: false });
check("stale copyright leads", rich.findings[0].id === "stale_copyright", rich.findings[0].id);

console.log("\n[7] Preview rows expose no identifying data");
const shape = assigned[0];
check("only label + weakness", JSON.stringify(Object.keys(shape).sort()) === '["label","weakness"]', JSON.stringify(Object.keys(shape)));
check("only copy fields", JSON.stringify(Object.keys(shape.weakness).sort()) === '["detail","hook","label"]', JSON.stringify(Object.keys(shape.weakness)));
check("no email/phone/url anywhere", !JSON.stringify(assigned).match(/@|https?:\/\/|\(\d{3}\)|\d{3}[-.]\d{3}[-.]\d{4}/));

console.log(`\n${failures === 0 ? "ALL DEDUP CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
