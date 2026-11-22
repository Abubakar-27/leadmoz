/*
  Regression cover for the complaint that led to the real/inferred split: the
  system used to present guesses as faults, so leads came back tagged with
  things their site was not actually doing wrong.

  Each case here is a site shape that previously produced a wrong headline.
*/

import {
    deriveWeaknesses,
    weaknessesByClass,
    hasRealIssue,
    realIssues,
    primaryWeakness
} from "../src/weaknesses.js";

let failures = 0;
const check = (name, cond, detail = "") => {
    if (cond) console.log(`  PASS  ${name}`);
    else { failures += 1; console.log(`  FAIL  ${name} ${detail}`); }
};

const ids = list => list.map(f => f.id);
const has = (list, id) => ids(list).includes(id);

/* A long, well-built site. textLength is comfortably over the absence floor so
   the only thing these cases vary is the one signal under test. */
const healthy = {
    hasViewport: true,
    hasMetaDescription: true,
    hasBooking: true,
    hasPricing: true,
    hasTestimonials: true,
    hasCTA: true,
    hasEmail: true,
    hasPhone: true,
    likelyOldSite: false,
    linkCount: 40,
    textLength: 9000
};

const lead = (overrides = {}, extra = {}) => ({
    website: "https://shop.example",
    scrapeOk: true,
    niche: "restaurant",
    rawSignals: { ...healthy, ...overrides },
    ...extra
});

const W = "src/weaknesses.js  ";

console.log("\nreal vs inferred tagging");

{
    const f = deriveWeaknesses(lead());
    check("a clean site reports no defect", !hasRealIssue(lead()), ids(f).join(","));
    check("clean site leads with the honest CLEAR finding", f[0].id === "no_defects_found", f[0].id);
    check("CLEAR finding is classed clear", f[0].class === "clear", f[0].class);
}

{
    /* The central bug: a keyword guess scoring 70 outranking a measured fault
       scoring 98, because severity alone decided the order. */
    const brokenForm = lead(
        { hasTestimonials: false, hasBooking: false, hasCTA: false, hasPricing: false },
        {
            leakingFunnelAudit: {
                broken_internal_links: [],
                dead_social_icons: [],
                form_vulnerabilities: { has_contact_form: true, issues: ["Form has no action attribute"] }
            }
        }
    );

    const all = deriveWeaknesses(brokenForm);
    check("broken form is the headline finding", all[0].id === "broken_contact_form", all[0].id);
    check("broken form is classed a defect", all[0].class === "defect", all[0].class);
    check("broken form is marked verified", all[0].evidence === "verified", all[0].evidence);
    check("real issue detected", hasRealIssue(brokenForm));
    check("keyword guesses are demoted below it", all.slice(1).every(f => f.class !== "defect" || f.evidence === "verified"), "");
}

{
    const brokenLinks = lead({}, {
        leakingFunnelAudit: {
            broken_internal_links: [{ url: "https://shop.example/gone", status_code: 404 }],
            dead_social_icons: [],
            form_vulnerabilities: { has_contact_form: false, issues: [] }
        }
    });

    check("broken link is a verified defect", realIssues(brokenLinks).some(f => f.id === "broken_links"));
    check("dead link outranks guesses", primaryWeakness(brokenLinks).id === "broken_links", primaryWeakness(brokenLinks).id);
}

console.log("\ninferred findings never count as faults");

{
    const guessedOnly = lead({
        hasTestimonials: false,
        hasBooking: false,
        hasCTA: false,
        hasPricing: false
    });

    const { defects, opportunities } = weaknessesByClass(guessedOnly);

    check("four keyword misses produce zero defects", defects.length === 0, ids(defects).join(","));
    check("they are all classed opportunity", opportunities.length === 4, String(opportunities.length));
    check("hasRealIssue stays false", !hasRealIssue(guessedOnly));
    check("headline is the honest CLEAR note", primaryWeakness(guessedOnly).id === "no_defects_found");
    check("every guess is marked inferred", opportunities.every(f => f.evidence === "inferred"));
    check("CLEAR explains they are additions, not faults",
        /could add/i.test(primaryWeakness(guessedOnly).detail), primaryWeakness(guessedOnly).detail);
}

console.log("\ninferred findings suppressed by real structural evidence");

{
    /* The audit found a form, so "no call to action" is disproved. */
    const withForm = lead({ hasCTA: false }, {
        leakingFunnelAudit: {
            broken_internal_links: [],
            dead_social_icons: [],
            form_vulnerabilities: { has_contact_form: true, issues: [] }
        }
    });

    check("form in markup kills the no-CTA claim", !has(deriveWeaknesses(withForm), "no_call_to_action"), ids(deriveWeaknesses(withForm)).join(","));
    check("form in markup kills the no-booking claim", !has(deriveWeaknesses(withForm), "no_online_booking"));
}

{
    /* Same reasoning for reachability: a form is a way to make contact, so a
       site with no printed email or phone is still contactable. */
    const formOnly = lead({ hasEmail: false, hasPhone: false, hasCTA: false }, {
        leakingFunnelAudit: {
            broken_internal_links: [],
            dead_social_icons: [],
            form_vulnerabilities: { has_contact_form: true, issues: [] }
        }
    });

    check("form in markup kills the no-contact-details claim", !has(deriveWeaknesses(formOnly), "no_contact_details"), ids(deriveWeaknesses(formOnly)).join(","));
    check("form-only site reports no defect", !hasRealIssue(formOnly), ids(realIssues(formOnly)).join(","));

    /* With no form to carry it, the same site genuinely is unreachable. */
    const noForm = lead({ hasEmail: false, hasPhone: false, hasCTA: false }, {
        leakingFunnelAudit: {
            broken_internal_links: [],
            dead_social_icons: [],
            form_vulnerabilities: { has_contact_form: false, issues: [] }
        }
    });

    check("no form and no contact details is a real defect", has(deriveWeaknesses(noForm), "no_contact_details"), ids(deriveWeaknesses(noForm)).join(","));
    check("and it is classed a defect", hasRealIssue(noForm));
}

console.log("\nthin pages cannot be audited by absence");

{
    const thin = lead({
        textLength: 400,
        hasTestimonials: false,
        hasBooking: false,
        hasCTA: false,
        hasPricing: false,
        hasEmail: false,
        hasPhone: false,
        hasViewport: true,
        hasMetaDescription: true
    });

    const all = deriveWeaknesses(thin);

    check("thin page reports the thin-page fault", has(all, "barely_any_copy"), ids(all).join(","));
    /*
      Deliberately NOT expecting no_contact_details here. We read 400 characters,
      so we cannot tell a page with no contact details from a page whose footer
      we barely captured. The countable fault is the thin page, and claiming the
      contact absence on top of it would be the exact unfounded claim this
      change exists to remove.
    */
    check("thin page withholds the contact-details claim", !has(all, "no_contact_details"), ids(all).join(","));
    check("thin page suppresses testimonials guess", !has(all, "no_testimonials"), ids(all).join(","));
    check("thin page suppresses booking guess", !has(all, "no_online_booking"));
    check("thin page suppresses CTA guess", !has(all, "no_call_to_action"));
    check("thin page suppresses pricing guess", !has(all, "no_pricing"));
    check("thin page still counts as a real defect", hasRealIssue(thin));
}

{
    const empty = lead({ textLength: 0, hasTestimonials: false, hasBooking: false, hasCTA: false, hasPricing: false });

    check("empty text makes no absence claims at all",
        !has(deriveWeaknesses(empty), "no_testimonials") && !has(deriveWeaknesses(empty), "no_pricing"),
        ids(deriveWeaknesses(empty)).join(","));
    check("empty text makes no thin-page claim either", !has(deriveWeaknesses(empty), "barely_any_copy"));
}

console.log("\nunknown niche is not evidence of a missing price list");

{
    const unknownNiche = deriveWeaknesses(lead({ hasPricing: false }, {}) && lead({ hasPricing: false }, { niche: "" }));
    check("blank niche suppresses the pricing claim", !has(unknownNiche, "no_pricing"), ids(unknownNiche).join(","));

    const barbers = lead({ hasPricing: false }, { niche: "barber" });
    check("price-opaque niche suppresses the pricing claim", !has(deriveWeaknesses(barbers), "no_pricing"));

    const restaurant = lead({ hasPricing: false }, { niche: "restaurant" });
    check("price-comparing niche keeps the pricing claim", has(deriveWeaknesses(restaurant), "no_pricing"));
}

console.log("\nwidget detection stops the false accusation at the source");

{
    /* scrape.js now treats a booking widget in the markup as booking present,
       so a Calendly site is no longer reported as having no booking. These
       signal sets are what that detector produces. */
    const calendly = lead({ hasBooking: true, hasTestimonials: false });
    check("calendly site is not told it lacks booking", !has(deriveWeaknesses(calendly), "no_online_booking"));
    check("calendly site still flagged for missing reviews", has(deriveWeaknesses(calendly), "no_testimonials"));
}

console.log("\nranking order within the opportunity class");

{
    const several = deriveWeaknesses(lead({
        hasTestimonials: false,
        hasBooking: false,
        hasPricing: false,
        hasCTA: false,
        hasMetaDescription: false
    }));

    const opportunities = several.filter(f => f.class === "opportunity");
    const verifiedFirst = opportunities.every((f, i) =>
        i === 0 || opportunities[i - 1].evidence !== "inferred" || f.evidence !== "verified");

    check("verified opportunities rank above inferred ones", verifiedFirst,
        opportunities.map(f => `${f.id}:${f.evidence}`).join(","));
    check("missing meta description (verified) leads the opportunities",
        opportunities[0].id === "no_meta_description", opportunities[0].id);
}

console.log("\nmixed lead keeps defects and opportunities separated");

{
    const mixed = lead({ hasTestimonials: false, hasPricing: false }, {
        leakingFunnelAudit: {
            broken_internal_links: [],
            dead_social_icons: [{ url: "https://facebook.com/x", status_code: 404 }],
            form_vulnerabilities: { has_contact_form: false, issues: [] }
        }
    });

    const { defects, opportunities, clear } = weaknessesByClass(mixed);

    check("dead social icon is a defect", defects.length === 1 && defects[0].id === "dead_social_icons", ids(defects).join(","));
    check("no CLEAR note when a real fault exists", clear.length === 0, ids(clear).join(","));
    check("opportunities still collected", opportunities.length >= 2, String(opportunities.length));
    check("defects all rank above opportunities",
        deriveWeaknesses(mixed).findIndex(f => f.class === "opportunity") > deriveWeaknesses(mixed).findIndex(f => f.class === "defect"));
}

console.log("\nevery finding carries a class and an evidence value");

{
    const cases = [
        lead(),
        lead({ hasTestimonials: false, hasBooking: false, hasCTA: false, hasPricing: false }),
        lead({ textLength: 300 }),
        lead({}, {
            leakingFunnelAudit: {
                broken_internal_links: [{ url: "https://x.example", status_code: 404 }],
                dead_social_icons: [{ url: "https://facebook.com/x", status_code: 404 }],
                form_vulnerabilities: { has_contact_form: true, issues: ["no submit button"] }
            },
            seoSchemaAudit: {
                open_graph: { is_valid: false, missing_tags: ["og:image"] },
                schema_markup: { schema_present: false }
            }
        })
    ];

    const everyTagged = cases.every(c =>
        deriveWeaknesses(c).every(f =>
            ["defect", "opportunity", "clear"].includes(f.class) &&
            ["verified", "inferred"].includes(f.evidence) &&
            typeof f.isRealIssue !== "undefined" === false
        ));

    check("all findings tagged across every site shape", everyTagged,
        cases.map(c => ids(deriveWeaknesses(c)).join("|")).join(" // "));

    const noDefectsButClear = deriveWeaknesses(cases[1]);
    check("opportunity-only lead has zero defects in its defect list",
        weaknessesByClass(cases[1]).defects.length === 0);
    check("and exactly one CLEAR note", weaknessesByClass(cases[1]).clear.length === 1);
    check("no_defects_found sits first", noDefectsButClear[0].id === "no_defects_found");
}

console.log(failures === 0 ? "\nAll weakness accuracy checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);