import dns from "node:dns/promises";
import net from "node:net";

/*
  Input safety for enrichment.

  Enrichment takes user-submitted company domains and then fetches those sites.
  That is a textbook SSRF surface, so every domain is normalised and resolved
  BEFORE any request is made, and any hostname that resolves to a private,
  loopback, link-local, CGNAT or metadata address is refused.  Scope note: Leadmoz's scraper follows redirects itself for its normal lead
  crawl, but the enrichment path passes `guardDestinations` (see
  enrichmentProviders.js), which makes the scraper follow redirects MANUALLY
  and re-run this same check on every hop before the request is made. A public
  host that 30x-redirects to an internal address is therefore refused rather
  than followed.
*/

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data"
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp"];

export function isIpLiteral(host = "") {
  return net.isIP(String(host || "").replace(/^\[|\]$/g, "")) !== 0;
}

export function isPrivateIp(ip = "") {
  const value = String(ip || "").replace(/^\[|\]$/g, "");
  const family = net.isIP(value);
  if (family === 4) {
    const parts = value.split(".").map(n => Number(n));
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0 && parts[2] === 0) return true;
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  if (family === 6) {
    const lower = value.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if (net.isIP(mapped) === 4) return isPrivateIp(mapped);
    }
    return false;
  }
  return true;
}

/*
  Turn arbitrary user input into a bare registrable-looking domain.
  Accepts "example.com", "www.example.com/path", "https://Example.com:443/x",
  "user@example.com" (uses the domain). Returns "" when nothing valid remains.
*/
export function normalizeDomain(input = "") {
  let raw = String(input || "").trim();
  if (!raw) return "";

  if (raw.includes("@") && !raw.includes("://")) {
    raw = raw.split("@").pop();
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }

  let host = String(url.hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return "";
  if (host.startsWith("www.")) host = host.slice(4);

  if (BLOCKED_HOSTNAMES.has(host)) return "";
  if (BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) return "";
  if (isIpLiteral(host)) return "";

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return "";
  const tld = host.split(".").pop();
  if (!tld || tld.length < 2 || !/^[a-z]{2,}$/.test(tld)) return "";

  return host;
}

export function isValidDomain(domain = "") {
  return normalizeDomain(domain) === String(domain || "").toLowerCase() && Boolean(normalizeDomain(domain));
}

export function dedupeDomains(inputs = []) {
  const seen = new Set();
  const out = [];
  for (const item of inputs) {
    const domain = normalizeDomain(item);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

/*
  Resolve a normalised domain and refuse it unless EVERY address is public.
  Throws an Error with `.code = "unsafe_destination"` on a private target so the
  caller can report a clear, non-fatal reason instead of retrying.
*/
export async function assertPublicDomain(domain, { resolver = dns } = {}) {
  const host = normalizeDomain(domain);
  if (!host) {
    const err = new Error("Invalid domain");
    err.code = "invalid_domain";
    throw err;
  }

  let addresses = [];
  try {
    addresses = await resolver.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    const e = new Error("Domain could not be resolved");
    e.code = "dns_failed";
    e.cause = err;
    throw e;
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    const e = new Error("Domain could not be resolved");
    e.code = "dns_failed";
    throw e;
  }

  for (const row of addresses) {
    if (isPrivateIp(row.address)) {
      const e = new Error("Destination is not a public web address");
      e.code = "unsafe_destination";
      throw e;
    }
  }

  return { domain: host, addresses };
}

export function domainToUrl(domain) {
  const host = normalizeDomain(domain);
  return host ? `https://${host}` : "";
}
