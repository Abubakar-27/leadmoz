import assert from "node:assert/strict";
import { mergeCandidates } from "../src/worker.js";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok -", name);
  } catch (err) {
    console.error("  FAIL -", name);
    console.error("   ", err.message);
    process.exitCode = 1;
  }
}

/*
  OpenStreetMap and web search routinely return the same business. Web results
  almost never carry a city, and they are merged second, so the incoming empty
  string used to overwrite the locality OSM had resolved. A lead with no city
  cannot pass the location check and can never reach verified.
*/
check("keeps OSM locality when a web result with no city merges over it", () => {
  const merged = mergeCandidates(
    [
      {
        businessName: "Taller Mecanico Central",
        source: "osm",
        city: "Ciudad de Mexico",
        state: "Ciudad de Mexico",
        phone: "55 1234 5678",
        placeId: "osm:123"
      }
    ],
    [
      {
        businessName: "Taller Mecanico Central",
        source: "public_web",
        city: "",
        state: "",
        website: "https://tallercentral.mx"
      }
    ]
  );

  assert.equal(merged.length, 1, "the duplicate should collapse into one candidate");
  assert.equal(merged[0].city, "Ciudad de Mexico", "OSM city must survive the merge");
  assert.equal(merged[0].state, "Ciudad de Mexico", "OSM state must survive the merge");
  assert.equal(merged[0].phone, "55 1234 5678", "phone must survive");
  assert.equal(merged[0].website, "https://tallercentral.mx", "website from web must be added");
});

check("prefers the incoming locality when only the incoming record has one", () => {
  const merged = mergeCandidates(
    [{ businessName: "Auto Repair", source: "osm", city: "", state: "" }],
    [{ businessName: "Auto Repair", source: "public_web", city: "Guadalajara", state: "Jalisco" }]
  );
  assert.equal(merged[0].city, "Guadalajara");
  assert.equal(merged[0].state, "Jalisco");
});

check("does not invent a locality when neither record has one", () => {
  const merged = mergeCandidates(
    [{ businessName: "Shop", source: "osm", city: "", state: "" }],
    [{ businessName: "Shop", source: "public_web", city: "", state: "" }]
  );
  assert.equal(merged[0].city, "");
  assert.equal(merged[0].state, "");
});

check("still collapses distinct businesses", () => {
  const merged = mergeCandidates(
    [{ businessName: "Taller Uno", source: "osm", city: "Puebla", state: "Puebla" }],
    [{ businessName: "Taller Dos", source: "public_web", city: "Tijuana", state: "Baja California" }]
  );
  assert.equal(merged.length, 2);
});

/*
  The name fallback must not become a licence to merge unrelated businesses.
  Two different garages that happen to share a name, or one record whose phone
  contradicts the other's, have to stay separate.
*/
check("does not merge same-name businesses that disagree on phone", () => {
  const merged = mergeCandidates(
    [
      {
        businessName: "Taller Central",
        source: "osm",
        city: "Ciudad de Mexico",
        phone: "55 1111 1111"
      }
    ],
    [
      {
        businessName: "Taller Central",
        source: "public_web",
        city: "Guadalajara",
        state: "Jalisco",
        phone: "33 2222 2222"
      }
    ]
  );
  assert.equal(merged.length, 2, "contradictory phones mean two different businesses");
});

check("does not merge same-name businesses that disagree on website domain", () => {
  // Both records carry a website and the domains differ, which is a genuine
  // conflict. A record with no website at all is the complementary case above,
  // not a conflict.
  const merged = mergeCandidates(
    [
      {
        businessName: "Auto Service",
        source: "osm",
        city: "Monterrey",
        website: "https://autoservicio-norte.mx"
      }
    ],
    [
      {
        businessName: "Auto Service",
        source: "public_web",
        city: "Puebla",
        website: "https://autoservice.mx"
      }
    ]
  );
  assert.equal(merged.length, 2, "two different domains mean two different businesses");
});

check("merges an OSM phone-only record with a web website-only record", () => {
  // This is the common real shape: the directory knows the phone, the search
  // engine knows the site, and neither knows the other's identifier.
  const merged = mergeCandidates(
    [
      {
        businessName: "Vulcanizadora Lucero",
        source: "osm",
        city: "Ciudad de Mexico",
        state: "Ciudad de Mexico",
        phone: "55 7623 6036"
      }
    ],
    [
      {
        businessName: "Vulcanizadora Lucero",
        source: "public_web",
        city: "",
        state: "",
        website: "https://vulcanizadoralucero.mx"
      }
    ]
  );
  assert.equal(merged.length, 1, "one business, not two");
  assert.equal(merged[0].phone, "55 7623 6036");
  assert.equal(merged[0].website, "https://vulcanizadoralucero.mx");
  assert.equal(merged[0].city, "Ciudad de Mexico");
  assert.equal(merged[0].source, "mixed");
});

console.log(`\ncandidateMerge: ${passed}/7 passed`);
