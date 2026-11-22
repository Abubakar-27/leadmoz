/*
  A landmark is not a place name.

  A live job was asked for "plumbers" in "Dellas, Federal District, Brazil".
  Nominatim resolves that to a beauty salon inside a Brasilia shopping centre
  (addresstype=shop, type=beauty), so the engines were asked for plumbers inside
  a shop. They returned mall pages and city directories: 255 results, 175 dropped
  as directories, 46 failed the gate, 0 of 10 leads saved - twice.

  These tests pin the rule that fixes it: only a genuine place may be searched
  verbatim, and a point of interest is replaced by the city that contains it.
*/
import { localityFromHit } from "../src/areaGate.js";

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed += 1;
        console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || "assertion failed");
}

console.log("\n[1] A point of interest is never searched verbatim");

check("a shop resolves to its city", () => {
    const r = localityFromHit(
        { addresstype: "shop", type: "beauty", address: { city: "Brasília", country: "Brasil" } },
        "Dellas, Federal District, Brazil"
    );
    assert(r.changed === true, "must be rewritten");
    assert(r.location === "Brasília", `expected Brasília, got ${r.location}`);
});

check("a building resolves to its city", () => {
    const r = localityFromHit(
        { addresstype: "building", address: { town: "Leeds" } },
        "Some Tower, Leeds"
    );
    assert(r.changed && r.location === "Leeds", JSON.stringify(r));
});

check("a street resolves to its city", () => {
    const r = localityFromHit(
        { addresstype: "road", address: { city: "Austin" } },
        "1200 Congress Ave"
    );
    assert(r.changed && r.location === "Austin", JSON.stringify(r));
});

check("the reason names what was replaced, for the operator", () => {
    const r = localityFromHit({ addresstype: "shop", address: { city: "Brasília" } }, "Dellas");
    assert(/shop/.test(r.reason) && /Bras[ií]lia/i.test(r.reason), r.reason);
});

console.log("\n[2] A real place is left exactly as typed");

check("a city is untouched", () => {
    const r = localityFromHit({ addresstype: "city", address: { city: "Glasgow" } }, "Glasgow, United Kingdom");
    assert(r.changed === false, JSON.stringify(r));
    assert(r.location === "Glasgow, United Kingdom", r.location);
});

check("a suburb is untouched", () => {
    const r = localityFromHit({ addresstype: "suburb", address: { city: "Lisbon" } }, "Cacilhas");
    assert(r.changed === false, JSON.stringify(r));
});

check("a state is untouched", () => {
    const r = localityFromHit({ addresstype: "state", address: { state: "Texas" } }, "Texas");
    assert(r.changed === false, JSON.stringify(r));
});

check("a country is untouched", () => {
    const r = localityFromHit({ addresstype: "country", address: { country: "Portugal" } }, "Portugal");
    assert(r.changed === false, JSON.stringify(r));
});

console.log("\n[3] Unresolvable input falls back to what the user typed");

check("no geocode hit keeps the typed text", () => {
    const r = localityFromHit(null, "Dellas, Federal District, Brazil");
    assert(r.changed === false, JSON.stringify(r));
    assert(r.location === "Dellas, Federal District, Brazil", r.location);
});

check("a POI with no containing city keeps the typed text", () => {
    const r = localityFromHit({ addresstype: "shop", address: {} }, "Mystery Shop");
    assert(r.changed === false, JSON.stringify(r));
    assert(r.location === "Mystery Shop", r.location);
});

check("a city equal to the typed text keeps the typed text", () => {
    const r = localityFromHit({ addresstype: "shop", address: { city: "Dellas" } }, "Dellas");
    assert(r.changed === false, JSON.stringify(r));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
