// Regression tests for lead quality, built from cases that actually leaked
// into production jobs (dentist/texas and barbers/uk, Sept 2026).
import assert from "node:assert";
import { hasNonLocalTitle, isMarketplaceHost, isBadDomain, looksLikeDirectory } from "../src/search.js";
import { normalizeBusinessName } from "../src/scrape.js";
import { expandRegion, locationAliases } from "../src/geo.js";

const host = (h) => String(h).replace(/^www\./, "");
// Three layers, matching the live pipeline: marketplace hosts and bad domains
// are dropped while links are collected, directory hosts in looksLikeBusinessWebsite,
// and directory titles per result. Any one can disqualify a candidate.
const rejected = (h, t) =>
    isMarketplaceHost(host(h)) || isBadDomain(host(h)) || looksLikeDirectory(host(h)) || hasNonLocalTitle(t);

// --- Directories, aggregators and trade bodies that were saved as leads -----
const NOT_A_BUSINESS = [
    ["menshaircuts.com", "Barber Shops UK The Best Barber Shops in United Kingdom"],
    ["bytescraper.com", "List of 27k+ Barber shops in England / Barber shop directory"],
    ["barberhead.com", "The Best Barbershops in United Kingdom - Barberhead"],
    ["barberspot.net", "Find the best barber shops in United Kingdom"],
    ["www.fresha.com", "Best Barbers near me in the UK - Fresha"],
    ["britishbarbers.com", "Barbershops / British Barbers' Association"],
    ["whatclinic.com", "Dentists in Texas - Check Prices & Reviews - WhatClinic"],
    ["zocdoc.com", "Texas Dentists Practices | Zocdoc"],
    ["findadentist.ada.org", "Dentists in Texas | American Dental Association"],
    ["dentaquest.com", "texas chip - DentaQuest"],
    ["mcnatx.net", "Dentists and Dental Office Staff | MCNA Dental: Texas Medicaid and CHIP"],
    ["southtexasruralhealth.com", "Dentists | South Texas Rural Health Services, Inc."],
    ["bestdentistintexas.com", "Dental Locations - Dallas, Murphy, Springtown & Seven Points"]
];

for (const [h, t] of NOT_A_BUSINESS) {
    assert.ok(rejected(h, t), `should reject directory/aggregator: ${h} "${t}"`);
}

// --- Real businesses that must never be filtered out -----------------------
const REAL_BUSINESS_TITLES = [
    "Avenue Family Dentistry",
    "Mattingly Family Dentistry",
    "Drinski Family & Cosmetic Dentistry",
    "Breeze Oral Care",
    "Cosmetic Dentistry Houston TX",
    "Dental Care",
    "Texas Dental Solutions",
    "George S. Gayle IV DDS",
    "Hollands Barber Shop",
    "Pall Mall Barbers",
    "The Barber Shop Group",
    "Dental Center of Texas Katy TX",
    "Gies Family Dental",
    "Texan Dental",
    "Rivera Dental Associates",
    "Smith Family Dentistry",
    "Best Smile Center of Katy",
    "North Loop Dental",
    "Willow Creek Orthodontics",
    "Sunnyvale Family Dental Care",
    "Elite Barbershop",
    "Downtown Hair Studio"
];

for (const t of REAL_BUSINESS_TITLES) {
    assert.ok(!hasNonLocalTitle(t), `must not filter real business: "${t}"`);
    assert.ok(!rejected("example.com", t), `real business must survive: "${t}"`);
}

// A practice advertising that it accepts Medicaid/CHIP is still a practice.
for (const t of [
    "We accept Medicaid and CHIP",
    "Medicaid & CHIP Welcome - Smith Family Dentistry",
    "Medicaid dentist in Houston TX",
    "Medicaid and most insurance plans accepted"
]) {
    assert.ok(!hasNonLocalTitle(t), `payer acceptance must not disqualify: "${t}"`);
}

// Page titles that name the page, not the business.
const NOT_A_NAME = [
    ["Contact - Hollands Barber Shop", "Hollands Barber Shop"],
    ["Contact Us - Pall Mall Barbers Central London", "Pall Mall Barbers Central London"],
    ["Privacy Policy | Dental Clinics of Texas", "Dental Clinics of Texas"],
    ["Contact - Texas Dental Solutions", "Texas Dental Solutions"],
    ["Dentist Contact - Smiles by Dr. Patel", "Smiles by Dr. Patel"],
    ["2493 South Braeswood Blvd, Suite C Houston Texas 77030 - Texan Dental", "Texan Dental"],
    ["Avenue Family Dentistry", "Avenue Family Dentistry"]
];

for (const [input, want] of NOT_A_NAME) {
    assert.strictEqual(normalizeBusinessName(input), want, `name from "${input}"`);
}

// A bare location phrase is not a business name; empty means "use the fallback".
for (const t of ["Contact Our Office in Richmond, TX", "About Our Office in Houston, TX", "in Katy, TX"]) {
    assert.strictEqual(normalizeBusinessName(t), "", `should yield no name: "${t}"`);
}

// The weakness summary must not stack two "but" clauses.
const ai = await import("../src/ai.js");
const rendered = ai.buildOutreachCopy
    ? await ai.buildOutreachCopy()
    : null;
if (rendered?.weaknessSummary) {
    assert.ok(
        !/\bbut\b.*\bbut\b/i.test(rendered.weaknessSummary),
        `weakness summary has two "but" clauses: ${rendered.weaknessSummary}`
    );
}

// --- Region expansion: a state must fan out into real cities ---------------
assert.ok(expandRegion("texas").includes("Houston"), "texas should expand to its cities");
assert.ok(expandRegion("TX").includes("Dallas"), "state abbreviation should expand");
assert.deepStrictEqual(expandRegion("houston"), [], "a specific city must not expand");
assert.deepStrictEqual(expandRegion("Katy"), [], "an unknown place must not expand");

// A city inside the requested region is the region.
for (const alias of ["texas", "tx", "houston", "austin"]) {
    assert.ok(locationAliases("texas").includes(alias), `texas aliases should include ${alias}`);
}
for (const alias of ["houston", "texas", "tx"]) {
    assert.ok(locationAliases("houston").includes(alias), `houston aliases should include ${alias}`);
}
assert.ok(locationAliases("richmond va").includes("virginia"), "richmond va should map to virginia");

console.log("ALL LEAD QUALITY CHECKS PASSED");
