/*
  The second batch of markup findings.

  They exist because missing alt text was winning the headline on almost every
  modern site - viewport, contact details and copyright were all fine, so the
  same sentence led every card. This file pins down the two properties that
  make the new checks safe to ship:

    1. A record that predates the measurement is never accused. Every new
       finding is gated on its signal being present, so an absent key must
       produce no finding at all.
    2. When they do fire, their copy is trade-neutral and claims nothing we
       did not measure - the same bar copy.test.mjs holds the original
       findings to.

  Plus the ranking rule the whole batch exists for: alt text must stop
  leading when a higher-severity fault is present.
*/

import { deriveWeaknesses, weaknessesByClass } from "../src/weaknesses.js";

let failures = 0;
const check = (name, cond, detail = "") => {
    if (cond) console.log(`  PASS  ${name}`);
    else { failures += 1; console.log(`  FAIL  ${name} ${detail}`); }
};

const ids = list => list.map(f => f.id);

/* A modern site that is genuinely tidy: viewport, meta description, schema,
   contact details, copyright current, plenty of copy. Only the new signals
   vary between cases. */
const tidy = {
    hasBooking: true,
    hasPricing: true,
    hasTestimonials: true,
    hasCTA: true,
    hasEmail: true,
    hasPhone: true,
    likelyOldSite: false,
    hasViewport: true,
    hasMetaDescription: true,
    hasSchemaMarkup: true,
    linkCount: 12,
    textLength: 9000
};

const lead = (overrides = {}, extra = {}) => ({
    website: "https://shop.example",
    scrapeOk: true,
    niche: "restaurant",
    rawSignals: { ...tidy, ...overrides },
    ...extra
});

const NEW_IDS = [
    "pages_missing_title",
    "images_missing_dimensions",
    "no_html_lang",
    "phone_not_tappable",
    "no_social_links",
    "no_canonical_url",
    "no_faq_schema",
    "schema_no_profile_links"
];

console.log("\n[1] A record from before these measurements is never accused");

{
    /* The exact shape every stored lead had before this change: none of the
       new keys exist at all. */
    const legacy = deriveWeaknesses(lead());
    check("no new finding fires on a legacy record",
        !ids(legacy).some(id => NEW_IDS.includes(id)), ids(legacy).join(","));

    check("legacy tidy site still reports only the honest CLEAR note",
        legacy.length === 1 && legacy[0].id === "no_defects_found",
        ids(legacy).join(","));

    /* The counts read as 0 behind the scenes, but 0 must never be shipped as
       a finding we claim to have taken. */
    check("legacy record has no defect at all", weaknessesByClass(lead()).defects.length === 0);

    /* A legacy record that ALSO has the old alt-text measurement keeps that
       finding - only the new ones stay silent. */
    const legacyWithAlt = deriveWeaknesses(lead({ imageCount: 26, imagesMissingAlt: 9, h1Count: 5 }));
    check("old alt-text finding still works on a legacy record",
        ids(legacyWithAlt).includes("images_missing_alt"), ids(legacyWithAlt).join(","));
    check("but no new finding rides along with it",
        !ids(legacyWithAlt).some(id => NEW_IDS.includes(id)), ids(legacyWithAlt).join(","));
}

console.log("\n[2] Each new finding fires only on its own measured signal");

{
    const cases = [
        ["pages_missing_title", { pagesMissingTitle: 2, linkCount: 6 }, f => f.id === "pages_missing_title"],
        ["images_missing_dimensions", { imageCount: 30, imagesMissingDimensions: 11, h1Count: 4 }, f => f.id === "images_missing_dimensions"],
        ["no_html_lang", { htmlLangMissing: true }, f => f.id === "no_html_lang"],
        ["phone_not_tappable", { noClickToCall: true }, f => f.id === "phone_not_tappable"],
        ["no_social_links", { noSocialsFound: true }, f => f.id === "no_social_links"],
        ["no_canonical_url", { hasCanonical: false }, f => f.id === "no_canonical_url"],
        ["no_faq_schema", { hasFaqSchema: false }, f => f.id === "no_faq_schema"],
        ["schema_no_profile_links", { hasOrganizationSchema: true, schemaSameAsCount: 0 }, f => f.id === "schema_no_profile_links"]
    ];

    for (const [name, sig, want] of cases) {
        const found = deriveWeaknesses(lead(sig)).find(want);
        check(`${name} fires when measured`, Boolean(found), ids(deriveWeaknesses(lead(sig))).join(","));
        /* The inverse: with the signal absent or reporting healthy, it must
           not fire. This is what stops a stale record being accused. */
        const healthySig = { ...sig };
        if ("pagesMissingTitle" in healthySig) healthySig.pagesMissingTitle = 0;
        if ("imagesMissingDimensions" in healthySig) healthySig.imagesMissingDimensions = 0;
        if ("htmlLangMissing" in healthySig) healthySig.htmlLangMissing = false;
        if ("noClickToCall" in healthySig) healthySig.noClickToCall = false;
        if ("noSocialsFound" in healthySig) healthySig.noSocialsFound = false;
        if ("hasCanonical" in healthySig) healthySig.hasCanonical = true;
        if ("hasFaqSchema" in healthySig) healthySig.hasFaqSchema = true;
        if ("schemaSameAsCount" in healthySig) healthySig.schemaSameAsCount = 3;
        check(`${name} stays silent when the site passes`, !deriveWeaknesses(lead(healthySig)).find(want));
    }
}

console.log("\n[3] Floors and gates hold");

{
    /* Same floors as the alt finding: a four-image site with one tag missing
       is not worth pitching. */
    const small = deriveWeaknesses(lead({ imageCount: 4, imagesMissingDimensions: 1, h1Count: 2 }));
    check("tiny image count never fires the size finding",
        !ids(small).includes("images_missing_dimensions"), ids(small).join(","));

    const fewMissing = deriveWeaknesses(lead({ imageCount: 30, imagesMissingDimensions: 2, h1Count: 4 }));
    check("two missing out of thirty stays under the floor",
        !ids(fewMissing).includes("images_missing_dimensions"), ids(fewMissing).join(","));

    /* No pages read => no title claim, exactly like the H1 finding. */
    const noPages = deriveWeaknesses(lead({ pagesMissingTitle: 1, linkCount: 0, pagesScraped: [] }));
    check("no pages read means no title claim",
        !ids(noPages).includes("pages_missing_title"), ids(noPages).join(","));

    /* A phone number that is tappable is not a fault, and a site with no
       phone at all belongs to no_contact_details instead. */
    const tappable = deriveWeaknesses(lead({ noClickToCall: false }));
    check("tap-to-call present means no phone finding",
        !ids(tappable).includes("phone_not_tappable"), ids(tappable).join(","));

    const noPhone = deriveWeaknesses(lead({ hasPhone: false, hasEmail: false, noClickToCall: true }));
    check("site with no phone at all is not blamed for an untappable one",
        !ids(noPhone).includes("phone_not_tappable"), ids(noPhone).join(","));

    /* The profile-links finding needs the Organization data to exist first;
       the missing-entirely case is already covered by no_organization_schema. */
    const noOrg = deriveWeaknesses(lead({ hasOrganizationSchema: false, schemaSameAsCount: 0 }));
    check("absent Organization data uses the existing finding, not the new one",
        ids(noOrg).includes("no_organization_schema") && !ids(noOrg).includes("schema_no_profile_links"),
        ids(noOrg).join(","));
}

console.log("\n[4] Alt text stops leading when a higher-severity fault is present");

{
    /* The complaint this batch exists for: every card led with alt text
       because it was the only verified defect a tidy modern site had. */
    const altOnly = deriveWeaknesses(lead({
        imageCount: 26, imagesMissingAlt: 9, h1Count: 5
    }));
    check("alt text still found when it is the only fault",
        ids(altOnly).includes("images_missing_alt"), ids(altOnly).join(","));

    const withTitleFault = deriveWeaknesses(lead({
        imageCount: 26, imagesMissingAlt: 9, h1Count: 5,
        pagesMissingTitle: 3, linkCount: 8
    }));
    check("a page with no title outranks alt text",
        withTitleFault[0].id === "pages_missing_title", withTitleFault[0].id);
    check("alt text is still reported underneath",
        ids(withTitleFault).includes("images_missing_alt"), ids(withTitleFault).join(","));

    const withPhoneFault = deriveWeaknesses(lead({
        imageCount: 26, imagesMissingAlt: 9, h1Count: 5,
        noClickToCall: true
    }));
    check("an untappable phone number outranks alt text",
        withPhoneFault[0].id === "phone_not_tappable", withPhoneFault[0].id);

    /* Three tidy modern sites must not produce the same finding list any more.
       The defect-led one leads with its fault; the two opportunity-only sites
       still lead with the honest CLEAR note (clear ranks first by design), so
       the whole list is compared rather than just the headline. */
    const a = deriveWeaknesses(lead({ htmlLangMissing: true }));
    const b = deriveWeaknesses(lead({ noSocialsFound: true }));
    const c = deriveWeaknesses(lead({ hasCanonical: false }));
    const shapes = [ids(a), ids(b), ids(c)].map(list => list.join("|"));
    check("different sites now produce different finding lists",
        new Set(shapes).size === 3, shapes.join("  //  "));
    check("a language fault leads its own card", a[0].id === "no_html_lang", a[0].id);
    check("social and canonical gaps still reach the card",
        ids(b).includes("no_social_links") && ids(c).includes("no_canonical_url"),
        `${ids(b).join(",")} // ${ids(c).join(",")}`);
}

console.log("\n[5] New copy is trade-neutral and claims nothing unmeasured");

{
    /* Transcribed from copy.test.mjs so both batches are held to one bar. */
    const FORBIDDEN = [
        "chair", "salon", "barber", "shop ", "spa", "groom", "fade", "shave",
        "restaurant", "menu", "table", "diner", "clinic", "patient", "doctor",
        "hair", "nail", "massage", "plumber", "pipe", "roofer", "truck"
    ];
    const BANNED = [/lighthouse/i, /page ?speed/i, /load(ed|ing) in \d/i, /score of \d/i, /pixels?/i, /https|certificate|ssl/i];

    /* Every new finding, plus the healthy variants, so the whole batch is
       exercised rather than only the first one that fires. */
    const all = deriveWeaknesses(lead({
        pagesMissingTitle: 3, linkCount: 8,
        imageCount: 30, imagesMissingDimensions: 11, imagesMissingAlt: 9, h1Count: 4,
        htmlLangMissing: true,
        noClickToCall: true,
        noSocialsFound: true,
        hasCanonical: false,
        hasFaqSchema: false,
        hasOrganizationSchema: true,
        schemaSameAsCount: 0
    }));

    const newOnes = all.filter(f => NEW_IDS.includes(f.id));
    check("every new finding was produced", newOnes.length === NEW_IDS.length,
        `${newOnes.length}/${NEW_IDS.length}: ${ids(newOnes).join(",")}`);

    for (const f of newOnes) {
        const text = `${f.label} ${f.detail} ${f.hook}`.toLowerCase();
        const hits = FORBIDDEN.filter(w => text.includes(w));
        check(`"${f.id}" is trade-neutral`, hits.length === 0, `-> found: ${hits.join(", ")}`);

        const raw = `${f.label} ${f.detail} ${f.hook}`;
        const hit = BANNED.find(re => re.test(raw));
        check(`"${f.id}" claims nothing unmeasured`, !hit, `-> ${hit}`);

        check(`"${f.id}" carries class and evidence`,
            ["defect", "opportunity", "clear"].includes(f.class) &&
            ["verified", "inferred"].includes(f.evidence) &&
            typeof f.hook === "string" && f.hook.length > 30,
            `${f.class}/${f.evidence}`);

        /* Copy must be specific to this site, not a placeholder. */
        check(`"${f.id}" quotes a number or a named element`,
            /\d/.test(f.detail) || /<title>|lang|tel:|canonical|FAQ|sameAs|Facebook/i.test(f.detail),
            f.detail.slice(0, 90));
    }
}

console.log("\n[6] Findings stay classed honestly");

{
    const mixedLead = lead({
        pagesMissingTitle: 3, linkCount: 8,
        noSocialsFound: true,
        hasCanonical: false
    });
    const mixed = deriveWeaknesses(mixedLead);

    /* weaknessesByClass re-derives from a LEAD, not from a findings array -
       handed an array it reads no rawSignals and reports the no-website fault.
       The lead goes in, the same derivation comes out. */
    const { defects, opportunities, clear } = weaknessesByClass(mixedLead);

    check("title and phone faults are defects", ids(defects).includes("pages_missing_title"), ids(defects).join(","));
    check("missing links are opportunities, not faults",
        ids(opportunities).includes("no_social_links") && ids(opportunities).includes("no_canonical_url"),
        ids(opportunities).join(","));
    check("no CLEAR note while a real fault exists", clear.length === 0, ids(clear).join(","));

    /* Class order must survive: defects before opportunities. */
    const firstOpp = mixed.findIndex(f => f.class === "opportunity");
    const lastDefect = mixed.map(f => f.class).lastIndexOf("defect");
    check("every defect ranks above every opportunity", firstOpp > lastDefect,
        ids(mixed).join(","));

    /* The inferred keyword guesses must still never be promoted above a
       measured fault - that was the original bug this file guards. */
    const withGuesses = deriveWeaknesses(lead({
        pagesMissingTitle: 3, linkCount: 8,
        hasTestimonials: false, hasBooking: false, hasCTA: false, hasPricing: false
    }));
    const firstInferred = withGuesses.findIndex(f => f.evidence === "inferred");
    const lastVerifiedDefect = withGuesses.map(f => `${f.evidence}:${f.class}`).lastIndexOf("verified:defect");
    check("measured faults still outrank keyword guesses", firstInferred > lastVerifiedDefect,
        withGuesses.map(f => `${f.id}:${f.evidence}:${f.class}`).join(","));
}

console.log(failures === 0 ? "\nAll new-finding checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
