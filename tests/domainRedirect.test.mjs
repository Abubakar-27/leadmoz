/*
  Domain migration: leadio.site -> leadmoz.com.

  The old host must keep working forever, because links inside already-sent
  emails, search results, bookmarks and referral links cannot be edited. These
  checks pin the contract: one permanent hop, path and query preserved, and
  nothing redirected that should not be.
*/

import { resolveRedirect, legacyHostSet, canonicalHostOf, LEGACY_PATHS, redirectEnabled } from "../src/domainRedirect.js";

let failed = 0;
const check = (name, cond, detail = "") => {
    if (cond) console.log(`  ok   ${name}`);
    else {
        failed += 1;
        console.log(`  FAIL ${name} ${detail}`);
    }
};

const hop = (opts) => resolveRedirect({ siteUrl: "https://leadmoz.com", ...opts });

console.log("\n[1] Old host lands on the new one, path and query intact");
const app = hop({ host: "leadio.site", path: "/app", originalUrl: "/app" });
check("301 status", app && app.status === 301, JSON.stringify(app));
check("canonical origin", app && app.location === "https://leadmoz.com/app", app && app.location);

const ref = hop({ host: "leadio.site", path: "/auth", originalUrl: "/auth?ref=partner123&plan=starter" });
check("query string preserved", ref && ref.location === "https://leadmoz.com/auth?ref=partner123&plan=starter", ref && ref.location);

const www = hop({ host: "www.leadio.site", path: "/blog", originalUrl: "/blog" });
check("www of the old host also moves", www && www.location === "https://leadmoz.com/blog", www && www.location);

console.log("\n[2] www of the NEW host collapses onto the apex, once");
const wwwNew = hop({ host: "www.leadmoz.com", path: "/", originalUrl: "/" });
check("www.leadmoz.com -> apex", wwwNew && wwwNew.location === "https://leadmoz.com/", wwwNew && wwwNew.location);
const again = hop({ host: "leadmoz.com", path: "/", originalUrl: "/" });
check("apex is never redirected (no loop)", again === null, JSON.stringify(again));

console.log("\n[3] Ports and case in the Host header cannot defeat it");
const port = hop({ host: "LEADIO.SITE:8080", path: "/terms", originalUrl: "/terms" });
check("case + port stripped", port && port.location === "https://leadmoz.com/terms", port && port.location);

console.log("\n[4] Legacy slugs move to the rebranded slug");
const apollo = hop({ host: "leadmoz.com", path: "/compare/leadio-vs-apollo", originalUrl: "/compare/leadio-vs-apollo" });
check("old compare slug", apollo && apollo.location === "https://leadmoz.com/compare/leadmoz-vs-apollo/", apollo && apollo.location);
const apolloSlash = hop({ host: "leadmoz.com", path: "/compare/leadio-vs-apollo/", originalUrl: "/compare/leadio-vs-apollo/" });
check("trailing slash matches too", apolloSlash && apolloSlash.location.includes("leadmoz-vs-apollo"), apolloSlash && apolloSlash.location);
const hunter = hop({ host: "leadmoz.com", path: "/compare/leadio-vs-hunter-io", originalUrl: "/compare/leadio-vs-hunter-io" });
check("second compare slug", hunter && hunter.location === "https://leadmoz.com/compare/leadmoz-vs-hunter-io/", hunter && hunter.location);
const logo = hop({ host: "leadmoz.com", path: "/leadio-logo.png", originalUrl: "/leadio-logo.png" });
check("old logo asset", logo && logo.location === "https://leadmoz.com/leadmoz-logo.png", logo && logo.location);

console.log("\n[5] Method semantics: a POST must not become a GET");
const post = hop({ host: "leadio.site", path: "/api/auth/login", method: "POST", originalUrl: "/api/auth/login" });
check("308 for non-GET", post && post.status === 308, JSON.stringify(post));
const head = hop({ host: "leadio.site", path: "/", method: "HEAD", originalUrl: "/" });
check("301 for HEAD", head && head.status === 301, JSON.stringify(head));

console.log("\n[6] Nothing that should stay put is redirected");
check("canonical host, normal path", hop({ host: "leadmoz.com", path: "/pricing", originalUrl: "/pricing" }) === null);
check("IP access (health probe) untouched", hop({ host: "203.0.113.10", path: "/", originalUrl: "/" }) === null);
check("missing Host untouched", hop({ host: "", path: "/", originalUrl: "/" }) === null);
check("unrelated host untouched", hop({ host: "staging.example.com", path: "/", originalUrl: "/" }) === null);
check("new compare slug untouched", hop({ host: "leadmoz.com", path: "/compare/leadmoz-vs-apollo/", originalUrl: "/compare/leadmoz-vs-apollo/" }) === null);

console.log("\n[7] Host defaults honour LEGACY_HOSTS");
const custom = legacyHostSet("old.test, legacy.test");
check("custom list parsed", custom.has("old.test") && custom.has("legacy.test"), [...custom].join(","));
check("defaults when empty", legacyHostSet("").has("leadio.site"));
check("canonical host derived", canonicalHostOf("https://leadmoz.com") === "leadmoz.com");
check("every legacy path has a target", [...LEGACY_PATHS.values()].every((v) => v.startsWith("/")), [...LEGACY_PATHS.values()].join(","));

console.log("\n[8] Kill switch, so the flip waits for DNS");
check("defaults to on", redirectEnabled(undefined) === true);
check("explicit on", redirectEnabled("on") === true);
check("off disables", redirectEnabled("off") === false);
check("case/space tolerant", redirectEnabled(" OFF ") === false);
check("anything else stays on", redirectEnabled("yes") === true);

console.log(`\n${failed} failed`);
if (failed > 0) process.exit(1);
console.log("all domain redirect tests passed");
