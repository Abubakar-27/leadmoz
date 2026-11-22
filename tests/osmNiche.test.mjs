/*
  Regression tests for two production zero-lead jobs (2026-10-28/29):

  1. "resturants" / Lahore, Pakistan - 400 OpenStreetMap restaurants were
     fetched and every one was discarded, because the food check compared
     against a singular-only word list with exact equality.
  2. "Kraft paper roll importers" / Türkiye - the location was country-sized
     but "Türkiye" did not match any ASCII country name, so the job tiled the
     national centroid into ~24 chunks instead of querying the city list that
     already holds Istanbul and Ankara.
*/
import assert from "node:assert/strict";
import { bareCountryCode, countryHint, isFoodConflict, tagFiltersForNiche } from "../src/apis/osm.js";

function test(name, fn) {
  try {
    fn();
    console.log("ok - " + name);
  } catch (err) {
    console.error("not ok - " + name);
    throw err;
  }
}

test("a country name with diacritics resolves to its ISO code", () => {
  assert.equal(countryHint("Türkiye"), "tr");
  assert.equal(countryHint("Turkey"), "tr");
  assert.equal(bareCountryCode("Türkiye"), "tr");
  assert.equal(bareCountryCode("México"), "mx");
});

test("a city keeps its country hint but is not a bare country", () => {
  assert.equal(countryHint("Lahore, Pakistan"), "pk");
  assert.equal(bareCountryCode("Lahore, Pakistan"), "");
});

test("plural food niches map to the same OSM tags as the singular", () => {
  const singular = tagFiltersForNiche("restaurant");
  assert.ok(singular.includes("amenity=restaurant"));
  assert.deepEqual(tagFiltersForNiche("restaurants"), singular);
  assert.deepEqual(tagFiltersForNiche("cafes"), tagFiltersForNiche("cafe"));
  assert.deepEqual(tagFiltersForNiche("bakeries"), tagFiltersForNiche("bakery"));
});

test("a misspelled food niche still maps to restaurant tags", () => {
  assert.ok(tagFiltersForNiche("resturants").includes("amenity=restaurant"));
});

test("plural and misspelled food niches are not treated as food conflicts", () => {
  const restaurant = { amenity: "restaurant" };

  assert.equal(isFoodConflict(restaurant, ["restaurant"]), false);
  assert.equal(isFoodConflict(restaurant, ["restaurants"]), false);
  assert.equal(isFoodConflict(restaurant, ["resturants"]), false);
  assert.equal(isFoodConflict(restaurant, ["cafes"]), false);
});

test("a non-food niche still rejects food venues", () => {
  assert.equal(isFoodConflict({ amenity: "restaurant" }, ["plumbers"]), true);
  assert.equal(isFoodConflict({ amenity: "restaurant" }, ["roofers"]), true);
});

test("typo tolerance does not leak across trades", () => {
  /*
    "car" -> "bar" and "barber" -> "bar" are one and two edits apart. The
    bounded matcher must not turn a car wash or a barber into a pub.
  */
  assert.ok(!tagFiltersForNiche("car wash").includes("amenity=bar"));
  assert.ok(!tagFiltersForNiche("barber").includes("amenity=bar"));
  assert.ok(tagFiltersForNiche("barber").includes("shop=barber") || tagFiltersForNiche("barber").includes("shop=hairdresser"));
});
