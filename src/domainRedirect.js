/*
  Domain migration helpers.

  The product moved from leadio.site to leadmoz.com. Old URLs must keep working
  forever: bookmarks, search results, links inside emails that were already
  sent, and referrals still in flight all point at the old host or the old
  brand-bearing slugs.

  The decision is pure and lives here so it can be tested without booting the
  server. nginx carries the same redirect for speed; the Express middleware is
  the safety net for traffic that reaches Node directly.
*/

export const DEFAULT_SITE_URL = "https://leadmoz.com";
export const DEFAULT_LEGACY_HOSTS = ["leadio.site", "www.leadio.site"];

/*
  Paths whose slug contained the old brand, plus the old logo asset. Keys are
  compared without a trailing slash so /compare/x and /compare/x/ both match.
*/
export const LEGACY_PATHS = new Map([
    ["/compare/leadio-vs-apollo", "/compare/leadmoz-vs-apollo/"],
    ["/compare/leadio-vs-hunter-io", "/compare/leadmoz-vs-hunter-io/"],
    ["/leadio-logo.png", "/leadmoz-logo.png"]
]);

export function normalizeHost(host) {
    return String(host || "").toLowerCase().replace(/:\d+$/, "");
}

/*
  Kill switch. While the new domain's DNS is not pointed at the server yet, a
  301 would send every live visitor to a host that does not resolve, which is
  an outage. DOMAIN_REDIRECT=off keeps the old host serving normally; flip it
  to on (the default) once leadmoz.com resolves to this server.
*/
export function redirectEnabled(raw) {
    return String(raw ?? "on").trim().toLowerCase() !== "off";
}

export function legacyHostSet(raw = "") {
    const list = String(raw)
        .split(",")
        .map((h) => normalizeHost(h.trim()))
        .filter(Boolean);
    return new Set(list.length ? list : DEFAULT_LEGACY_HOSTS);
}

export function canonicalHostOf(siteUrl = DEFAULT_SITE_URL) {
    try {
        return new URL(siteUrl).host.toLowerCase();
    } catch {
        return new URL(DEFAULT_SITE_URL).host.toLowerCase();
    }
}

/*
  Returns null when the request already points at the canonical location,
  otherwise { status, location }. GET/HEAD use 301 (cacheable); every other
  method uses 308 so a POST is replayed with its body instead of being
  downgraded to a GET by the client.
*/
export function resolveRedirect({
    host,
    path = "/",
    method = "GET",
    originalUrl = "",
    siteUrl = DEFAULT_SITE_URL,
    legacyHosts = DEFAULT_LEGACY_HOSTS
} = {}) {
    const site = String(siteUrl || DEFAULT_SITE_URL).replace(/\/+$/, "");
    const canonical = canonicalHostOf(site);
    const requested = normalizeHost(host);
    const legacy = legacyHosts instanceof Set ? legacyHosts : legacyHostSet(Array.isArray(legacyHosts) ? legacyHosts.join(",") : legacyHosts);

    const trimmed = String(path || "/").replace(/\/+$/, "") || "/";
    const legacyPath = LEGACY_PATHS.get(trimmed);

    // An IP address, a health probe or a missing Host must never be redirected.
    const hostIsLegacy = Boolean(requested) && requested !== canonical && (legacy.has(requested) || requested === `www.${canonical}`);

    if (!legacyPath && !hostIsLegacy) return null;

    const qs = String(originalUrl || "").indexOf("?");
    const query = qs === -1 ? "" : String(originalUrl).slice(qs);
    const target = legacyPath || String(path || "/");
    const status = method === "GET" || method === "HEAD" ? 301 : 308;

    return { status, location: site + target + query };
}
