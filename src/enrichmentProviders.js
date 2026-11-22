import { scrapeWebsite } from "./scrape.js";
import { findEmailsWithHunterDomain, findEmailWithHunter, verifyEmailWithHunter } from "./apis/hunter.js";
import { findEmailWithFreePatterns, verifyEmailFree } from "./apis/freeEmail.js";
import { recordProviderCall, providerCallsToday, isProviderDisabled, providerUsageStats } from "./enrichmentStore.js";
import { enrichmentProviderConfig, enrichmentLimits } from "./enrichmentConfig.js";
import { normalizeDomain, domainToUrl, assertPublicDomain } from "./enrichmentSafety.js";
import { firecrawlKeys, tavilyKeys } from "./search.js";

/*
  Provider abstraction for Company & Contact Enrichment.

  Two providers implement the same small contract so another can be added later
  without touching the workflow:
    - website : the company's own public pages, via the EXISTING scraper
                (scrape.js) - always available, no key, no cost.
    - hunter  : the EXISTING Hunter.io adapter (src/apis/hunter.js) - optional,
                only used when HUNTER_API_KEY is set and the daily cap allows.

  Nothing here invents data. A missing field stays empty and the stage reports
  "not_found"; a low-confidence contact keeps a low confidence and a source URL.
*/

export const EMAIL_STATUS = {
  VERIFIED: "verified",
  LIKELY: "likely",
  UNVERIFIED: "unverified",
  INVALID: "invalid",
  NOT_FOUND: "not_found"
};

/* Free webmail domains are usually personal, not company, contacts. They are
   NOT dropped when the company publishes them on its own official site: for
   many small businesses a published Gmail IS the business contact point, and
   hiding it made the results say "no email found" while the site displayed
   one. Instead each address carries `freemail: true` so the UI labels it and
   the customer can judge. Never applies to guessed/pattern addresses. */
const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com",
  "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com",
  "protonmail.com", "proton.me", "gmx.com", "gmx.net", "mail.com", "yandex.com",
  "zoho.com", "qq.com", "163.com"
]);

const ROLE_PATTERN = new RegExp(
  "\\b([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,2})\\s*[,\\-\\u2013|]\\s*" +
  "(Chief Executive Officer|CEO|Founder|Co-?Founder|Owner|Co-?Owner|Managing Director|President|Partner|Principal|Director|Head of [A-Za-z ]{2,30})\\b",
  "g"
);

function hasKey(key) {
  return Boolean(key && key !== "your_hunter_key_here");
}

export function hunterConfigured() {
  return hasKey(String(process.env.HUNTER_API_KEY || "").trim());
}

export function hunterAvailable() {
  if (!hunterConfigured()) return false;
  if (isProviderDisabled("hunter")) return false;
  const max = enrichmentLimits().hunterDailyMax;
  if (max <= 0) return false;
  return providerCallsToday("hunter") < max;
}

export function websiteAvailable() {
  return !isProviderDisabled("website");
}

/*
  Built-in email provider: no key, no account, no per-lookup fee. It finds a
  named person's likely address from common layouts and confirms it against the
  company's own MX server (RCPT only - no message is ever sent). It is the
  default fallback when Hunter is not configured, and works alongside Hunter
  when a key exists.
*/
export function freeEmailConfigured() {
  return String(process.env.ENRICHMENT_FREE_EMAIL_ENABLED || "").trim().toLowerCase() !== "false";
}

export function freeEmailAvailable() {
  if (!freeEmailConfigured()) return false;
  if (isProviderDisabled("free_email")) return false;
  const max = enrichmentLimits().freeEmailDailyMax;
  if (max <= 0) return false;
  return providerCallsToday("free_email") < max;
}

/*
  Web-search research provider: uses the SAME Tavily/Firecrawl keys the lead
  search already uses (src/search.js) to find public pages about the company's
  owner - news, directories, interviews, registry mentions - and reads those
  pages with the same SSRF-guarded scraper. Never fetches LinkedIn/Facebook/
  Instagram (they block bots and their ToS forbid it); those URLs are only
  skipped, never bypassed.
*/
export function webSearchKeysConfigured() {
  return firecrawlKeys().length > 0 || tavilyKeys().length > 0;
}

export function webSearchAvailable() {
  if (String(process.env.ENRICHMENT_WEB_SEARCH_ENABLED || "").toLowerCase() === "false") return false;
  if (isProviderDisabled("web_research")) return false;
  if (!webSearchKeysConfigured()) return false;
  return providerCallsToday("web_research") < enrichmentLimits().webSearchDailyMax;
}

export function providerStatus() {
  const cfg = enrichmentProviderConfig();
  const usage = providerUsageStats();
  return {
    website: {
      id: "website",
      label: cfg.website.label,
      configured: true,
      disabled: isProviderDisabled("website"),
      available: websiteAvailable(),
      calls: usage.website?.calls || 0,
      failed: usage.website?.failed || 0
    },
    hunter: {
      id: "hunter",
      label: cfg.hunter.label,
      configured: hunterConfigured(),
      disabled: isProviderDisabled("hunter"),
      available: hunterAvailable(),
      callsToday: providerCallsToday("hunter"),
      dailyMax: enrichmentLimits().hunterDailyMax,
      calls: usage.hunter?.calls || 0,
      failed: usage.hunter?.failed || 0,
      lastError: usage.hunter?.lastError || ""
    },
    free_email: {
      id: "free_email",
      label: cfg.freeEmail.label,
      configured: freeEmailConfigured(),
      disabled: isProviderDisabled("free_email"),
      available: freeEmailAvailable(),
      callsToday: providerCallsToday("free_email"),
      dailyMax: enrichmentLimits().freeEmailDailyMax,
      calls: usage.free_email?.calls || 0,
      failed: usage.free_email?.failed || 0,
      lastError: usage.free_email?.lastError || ""
    },
    web_research: {
      id: "web_research",
      label: cfg.webResearch.label,
      configured: webSearchKeysConfigured(),
      disabled: isProviderDisabled("web_research"),
      available: webSearchAvailable(),
      callsToday: providerCallsToday("web_research"),
      dailyMax: enrichmentLimits().webSearchDailyMax,
      calls: usage.web_research?.calls || 0,
      failed: usage.web_research?.failed || 0,
      lastError: usage.web_research?.lastError || ""
    }
  };
}

export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Provider timed out"), { code: "timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function classifyHunterFailure(result) {
  const status = Number(result?.status || 0);
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (/missing hunter_api_key/i.test(String(result?.reason || ""))) return "not_configured";
  return "error";
}

/* --------------------------------------------------------------- website */

/*
  Redirect guard passed into the shared scraper (see guardedFetch in scrape.js).
  The submitted host is already resolved and checked before the first request;
  this re-runs the same check on EVERY redirect hop, so a public site that
  redirects to localhost, an RFC1918 address or a cloud metadata endpoint is
  refused instead of followed. enrichmentSafety throws `unsafe_destination` for
  private targets, which the scraper treats as "do not fetch".
*/
async function assertSafeDestination(href) {
  const host = normalizeDomain(href);
  if (!host) return false;
  await assertPublicDomain(host);
  return true;
}

export async function scrapeCompanySite(domain, { companyName = "" } = {}) {
  const host = normalizeDomain(domain);
  if (!host || !websiteAvailable()) return null;

  const url = domainToUrl(host);
  const limits = enrichmentLimits();
  try {
    const scraped = await withTimeout(
      /*
        Whole-site crawl: read the company's own pages (about, team, services,
        contact, legal) up to crawlMaxPages instead of only the homepage plus
        four links, and pull in the deep contact pages even when the homepage
        already shows an email. Nothing here is a second scraper - it is the
        same scrape.js used by lead search, told to read further.
      */
      scrapeWebsite(url, {
        runAudits: false,
        render: false,
        guardDestinations: assertSafeDestination,
        crawl: { maxPages: limits.crawlMaxPages, includeAll: true, forceDeep: true }
      }),
      limits.scrapeTimeoutMs
    );
    const ok = Boolean(scraped && scraped.scrapeOk);
    recordProviderCall("website", { ok });
    if (!ok) return null;
    return { ...scraped, _companyNameHint: companyName };
  } catch (err) {
    recordProviderCall("website", { ok: false, error: err.code || err.message });
    return null;
  }
}

/*
  Titles arrive as "Prefix · Brand" (e.g. "Avox company · GitLab" - page
  furniture from <title>/og:title). When one segment equals the domain's own
  label, that segment is the company and the rest is noise.
*/
export function cleanCompanyName(rawName, host) {
  const name = String(rawName || "").trim();
  const hostStr = String(host || "");
  if (!name || !hostStr) return name;
  if (!/\s[·|]\s|\s[—–]\s/.test(name)) return name;
  const label = hostStr.replace(/^www\./, "").split(".")[0].toLowerCase();
  const segments = name.split(/\s[·|]\s|\s[—–]\s/).map(s => s.trim()).filter(Boolean);
  const match = segments.find(s => s.toLowerCase() === label);
  return match || name;
}

/*
  Industry is a deterministic keyword map over the company's own name and
  description - no model, no quota, nothing invented. scrape.js does not emit
  an industry signal, so without this the column stayed empty for every
  company. Order matters: specific verticals first, generic tech last (most
  descriptions mention "platform" or "software" somewhere).
*/
const INDUSTRY_RULES = [
  [/(plumb|roof|hvac|\belectrician\b|contractor|construction|landscap|pest control|garage door|flooring|handyman)/, "Home & Construction Services"],
  [/(restaurant|\bcafe\b|bakery|catering|pizzeria|food truck|\bkitchen\b|\bdiner\b)/, "Food & Dining"],
  [/(dentist|dental|\bclinic\b|medical|healthcare|physio|therapy|veterinar|pharmacy|\bdoctor\b)/, "Health & Medical"],
  [/(attorney|lawyer|\blegal\b|law firm)/, "Legal"],
  [/(realtor|real estate|property management|\brealty\b)/, "Real Estate"],
  [/(marketing agency|\bseo\b|advertising|\bbranding\b|digital marketing)/, "Marketing & Advertising"],
  [/(\bgym\b|fitness|\byoga\b|personal trainer|wellness)/, "Fitness & Wellness"],
  [/(\bhotel\b|\blodging\b|travel agency|airline|\btour\b)/, "Travel & Hospitality"],
  [/(\bschool\b|academy|university|\btutor\b|\bcourse\b|\beducation\b|\blearning\b)/, "Education"],
  [/(\bbank\b|insurance|mortgage|accounting|financial advis|\binvest\b)/, "Finance & Insurance"],
  [/(boutique|\bretail\b|ecommerce|online store)/, "Retail & E-commerce"],
  [/(\bchurch\b|nonprofit|charity)/, "Non-profit & Community"],
  [/(salon|\bbarber\b|\bspa\b|\bbeauty\b)/, "Beauty & Personal Care"],
  [/(logistic|freight|trucking|\bshipping\b|courier)/, "Logistics & Transportation"],
  [/(software|\bsaas\b|developer|\bplatform\b|open source|\bcloud\b|\bapi\b|artificial intelligence|machine learning)/, "Software & Technology"]
];

export function inferIndustry(description, name) {
  const hay = `${name || ""} ${description || ""}`.toLowerCase().trim();
  if (!hay) return "";
  for (const [re, label] of INDUSTRY_RULES) if (re.test(hay)) return label;
  return "";
}

export function mapWebsiteProfile(scraped, domain) {
  const host = normalizeDomain(domain);
  if (!scraped || !host) return null;

  const signals = scraped.signals || {};
  const rawName = String(scraped.businessName || scraped._companyNameHint || host).trim();
  const name = cleanCompanyName(rawName, host) || host;
  const description = String(scraped.description || "").trim().slice(0, 600);
  const location = Array.isArray(scraped.addresses) && scraped.addresses.length ? String(scraped.addresses[0]).slice(0, 200) : "";
  const industry = String(signals.industry || signals.category || signals.businessType || "").trim().slice(0, 80)
    || inferIndustry(description, name);
  const website = String(scraped.website || domainToUrl(host));
  const profileUrl = /linkedin\.com\/company\//i.test(String(scraped.linkedinUrl || "")) ? scraped.linkedinUrl : "";

  const sourceUrls = [];
  const addSource = (u) => {
    const value = String(u || "").trim();
    if (value && !sourceUrls.includes(value)) sourceUrls.push(value);
  };
  addSource(website);
  for (const page of scraped.pagesScraped || []) addSource(page);
  if (profileUrl) addSource(profileUrl);

  /* Everything else the crawl actually found, kept when present and empty when
     not - a blank field means "not published", never a placeholder. */
  const phones = (Array.isArray(scraped.phones) ? scraped.phones : [])
    .map(p => String(p || "").trim()).filter(Boolean).slice(0, 3);
  const addresses = (Array.isArray(scraped.addresses) ? scraped.addresses : [])
    .map(a => String(a || "").trim()).filter(Boolean).slice(0, 3);
  const socials = {};
  const rawSocials = scraped.socialLinks && typeof scraped.socialLinks === "object" ? scraped.socialLinks : {};
  for (const key of ["linkedin", "twitter", "facebook", "instagram"]) {
    const value = String(rawSocials[key] || "").trim();
    if (value) socials[key] = value;
  }
  const founded = String(scraped.founded || "").trim();
  const size = String(scraped.companySize || "").trim();
  const pagesCrawled = Array.isArray(scraped.pagesScraped) ? scraped.pagesScraped.length : 0;

  const hasAny = Boolean(description) || Boolean(location) || Boolean(industry) || Boolean(profileUrl)
    || phones.length > 0 || addresses.length > 0 || Object.keys(socials).length > 0
    || Boolean(founded) || Boolean(size)
    || (Boolean(name) && name !== host);

  /*
    Nothing beyond the bare domain: report not-found instead of "ok" so the
    stage refunds its credit rather than charging for an empty result.
  */
  if (!hasAny) return null;

  return {
    name,
    domain: host,
    description,
    industry,
    country: location,
    location,
    addresses,
    phones,
    socials,
    founded,
    size,
    pagesCrawled,
    website,
    profileUrl,
    sourceUrls: sourceUrls.slice(0, 8),
    source: "website",
    retrievedAt: new Date().toISOString(),
    confidence: hasAny ? "medium" : "low",
    verifiedMatch: Boolean(name && name !== host)
  };
}

/*
  Rejects role words wearing a person's clothes. docker.com's job-posting
  metadata yielded ownerName="Product Marketing Manager", ownerRole="Principal"
  - a contact row no human would believe, and exactly the fabricated-looking
  result the spec forbids. A real published contact is First-Last shaped and
  never contains the very title it is supposed to be paired with.
*/
const ROLE_WORD_RE = /\b(manager|director|founder|co-founder|chief|ceo|cto|cfo|coo|cmo|vp|vice president|president|principal|head of|\blead\b|\bowner\b|partner|senior|junior|staff|engineer|marketing|sales|recruiter|talent|analyst|specialist|coordinator|executive|officer|architect|consultant|editor|general counsel|\bdoctor\b|\bnurse\b|\battorney\b|lawyer)\b/i;

export function looksLikePersonName(name) {
  const s = String(name || "").trim();
  if (!s || s.length > 60) return false;
  if (ROLE_WORD_RE.test(s)) return false;
  const words = s.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every(w => /^\p{Lu}/u.test(w) && /^[\p{L}’'.-]+$/u.test(w));
}

/*
  "Name ,|-| Title" extraction from page text, shared by the own-site stage and
  the web-research stage so both apply the same person-name guard. A role word
  is required and the name must look like a person's name, so prose cannot
  become a contact.
*/
/* Page furniture that glues itself onto a name when a heading sits directly
   above it ("Leadership" + "Justin Kalifowitz" became one "name"). Stripped
   from the front of an extracted name before the person check. */
const NAME_FURNITURE = /^(leadership|meet\s+the|our\s+team|team|about|founder|founders|owner|owners|management|executive|executives|people|staff|bio|bios|profile|profiles|the)\s+/i;

export function extractRolePatternPeople(text = "", limit = 5) {
  const out = [];
  const str = String(text || "").slice(0, 20000);
  let match;
  let count = 0;
  ROLE_PATTERN.lastIndex = 0;
  while ((match = ROLE_PATTERN.exec(str)) !== null && count < limit) {
    let name = String(match[1] || "").trim().replace(NAME_FURNITURE, "").trim();
    if (!looksLikePersonName(name)) continue;
    out.push({ name, title: String(match[2] || "").trim() });
    count += 1;
  }
  return out;
}

export function mapWebsiteDecisionMakers(scraped, domain) {
  const host = normalizeDomain(domain);
  if (!scraped || !host) return [];

  const website = String(scraped.website || domainToUrl(host));
  const contacts = [];
  const seen = new Set();
  const push = (name, title, confidence) => {
    const cleanName = String(name || "").trim();
    const key = cleanName.toLowerCase();
    if (!cleanName || seen.has(key)) return false;
    if (!looksLikePersonName(cleanName)) return false;
    seen.add(key);
    contacts.push({
      name: cleanName,
      title: String(title || "").trim(),
      company: cleanCompanyName(scraped.businessName, host) || host,
      domain: host,
      profileUrl: "",
      source: "website",
      sourceUrl: website,
      confidence,
      status: "published",
      verification: "unverified"
    });
    return true;
  };

  if (scraped.ownerName) push(scraped.ownerName, scraped.ownerRole || "Owner", "medium");

  /*
    A light second pass over the page text for "Name, Title" / "Name - Title"
    patterns. It is deliberately conservative: a role word is required and the
    name must look like a person's name, so it does not turn prose into contacts.
  */
  for (const person of extractRolePatternPeople(scraped.text, 5)) {
    if (push(person.name, person.title, "low")) { /* counted by slice below */ }
  }

  return contacts.slice(0, 8);
}

export function mapWebsiteEmails(scraped, domain) {
  const host = normalizeDomain(domain);
  if (!scraped || !host) return [];

  const website = String(scraped.website || domainToUrl(host));
  const out = [];
  const seen = new Set();

  const add = (email, { published = true } = {}) => {
    const value = String(email || "").trim().toLowerCase();
    if (!value || !value.includes("@") || seen.has(value)) return;
    const emailDomain = value.split("@")[1] || "";
    const freemail = FREEMAIL_DOMAINS.has(emailDomain);
    seen.add(value);
    out.push({
      email: value,
      contactName: "",
      title: "",
      domain: host,
      provider: "website",
      source: "website",
      sourceUrl: website,
      status: EMAIL_STATUS.UNVERIFIED,
      published,
      freemail,
      confidence: freemail ? 50 : 60,
      verifiedAt: "",
      retrievedAt: new Date().toISOString()
    });
  };

  for (const email of scraped.emails || []) add(email);
  for (const item of scraped.emailEvidence || []) add(item.value);

  return out.slice(0, enrichmentLimits().emailsPerCompany);
}

/* ---------------------------------------------------------------- hunter */

async function hunterCall(fn, { attempts = 2, backoffMs = 500 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await withTimeout(fn(), enrichmentLimits().providerTimeoutMs);
      last = result;
      const kind = result?.ok ? "" : classifyHunterFailure(result);
      if (result?.ok || kind === "auth" || kind === "not_configured") break;
      if (attempt < attempts - 1) await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
    } catch (err) {
      last = { ok: false, reason: err.code || err.message, status: 0 };
      if (attempt < attempts - 1) await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }
  return last || { ok: false, reason: "no_result" };
}

export async function hunterDomainSearch(domain) {
  const host = normalizeDomain(domain);
  if (!host || !hunterAvailable()) return { ok: false, reason: "hunter_unavailable", emails: [] };

  const result = await hunterCall(() => findEmailsWithHunterDomain(domainToUrl(host)));
  const ok = Boolean(result?.ok);
  recordProviderCall("hunter", { ok, error: ok ? "" : result?.reason || "failed" });
  if (!ok) return { ok: false, reason: result?.reason || "hunter_failed", emails: [] };

  const emails = (result.emails || [])
    .filter(item => item.value && item.value.includes("@"))
    .map(item => ({
      email: item.value,
      contactName: [item.firstName, item.lastName].filter(Boolean).join(" ").trim(),
      firstName: item.firstName || "",
      lastName: item.lastName || "",
      title: item.position || "",
      domain: host,
      provider: "hunter",
      source: "hunter",
      sourceUrl: Array.isArray(item.sources) && item.sources[0]?.uri ? item.sources[0].uri : "",
      status: Number(item.confidence) >= 90 ? EMAIL_STATUS.LIKELY : EMAIL_STATUS.UNVERIFIED,
      published: false,
      confidence: Number(item.confidence) || 0,
      verifiedAt: "",
      retrievedAt: new Date().toISOString()
    }))
    .slice(0, enrichmentLimits().hunterEmailsPerCompany);

  return { ok: true, emails };
}

export async function hunterFindEmail(domain, firstName, lastName) {
  const host = normalizeDomain(domain);
  if (!host || !hunterAvailable() || !firstName || !lastName) {
    return { ok: false, reason: "hunter_unavailable" };
  }

  const result = await hunterCall(() => findEmailWithHunter(domainToUrl(host), firstName, lastName));
  const ok = Boolean(result?.ok && result?.email);
  recordProviderCall("hunter", { ok, error: ok ? "" : result?.reason || "failed" });
  if (!ok) return { ok: false, reason: result?.reason || "not_found" };

  return {
    ok: true,
    email: {
      email: result.email,
      contactName: [firstName, lastName].filter(Boolean).join(" "),
      firstName,
      lastName,
      title: result.position || "",
      domain: host,
      provider: "hunter",
      source: "hunter",
      sourceUrl: "",
      status: Number(result.confidence) >= 90 ? EMAIL_STATUS.LIKELY : EMAIL_STATUS.UNVERIFIED,
      published: false,
      confidence: Number(result.confidence) || 0,
      verifiedAt: "",
      retrievedAt: new Date().toISOString()
    }
  };
}

export async function hunterVerifyEmail(email) {
  if (!hunterAvailable()) return { ok: false, status: EMAIL_STATUS.UNVERIFIED, reason: "hunter_unavailable" };

  const result = await hunterCall(() => verifyEmailWithHunter(email), { attempts: 1 });
  const ok = Boolean(result?.ok);
  recordProviderCall("hunter", { ok, error: ok ? "" : result?.reason || "failed" });
  if (!ok) return { ok: false, status: EMAIL_STATUS.UNVERIFIED, reason: result?.reason || "verify_failed" };

  const raw = String(result.result || "").toLowerCase();
  let status = EMAIL_STATUS.UNVERIFIED;
  if (raw === "deliverable") status = EMAIL_STATUS.VERIFIED;
  else if (raw === "risky") status = EMAIL_STATUS.LIKELY;
  else if (raw === "undeliverable") status = EMAIL_STATUS.INVALID;
  else status = EMAIL_STATUS.UNVERIFIED;

  return { ok: true, status, score: result.score || 0, raw, verifiedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------- free email */

function emailRecordFromPattern(found, host) {
  return {
    email: found.email,
    contactName: [found.firstName, found.lastName].filter(Boolean).join(" ").trim(),
    firstName: found.firstName || "",
    lastName: found.lastName || "",
    title: found.position || "",
    domain: host,
    provider: "free_email",
    source: "smtp_pattern",
    sourceUrl: "",
    status: EMAIL_STATUS.VERIFIED,
    published: false,
    confidence: Number(found.confidence) || 0,
    verifiedAt: new Date().toISOString(),
    retrievedAt: new Date().toISOString()
  };
}

export async function freeFindEmail(domain, firstName, lastName) {
  const host = normalizeDomain(domain);
  if (!host || !freeEmailAvailable() || !firstName || !lastName) {
    return { ok: false, reason: freeEmailAvailable() ? "free_email_unavailable" : "free_email_disabled" };
  }

  let result;
  try {
    result = await findEmailWithFreePatterns(domainToUrl(host), firstName, lastName, {
      maxCandidates: enrichmentLimits().freeEmailPatternsPerPerson,
      timeoutMs: enrichmentLimits().freeEmailTimeoutMs
    });
  } catch (err) {
    result = { ok: false, reason: err.code || err.message };
  }

  const ok = Boolean(result?.ok && result?.email);
  recordProviderCall("free_email", { ok, error: ok ? "" : result?.reason || "not_found" });
  if (!ok) return { ok: false, reason: result?.reason || "not_found" };

  return { ok: true, email: emailRecordFromPattern(result, host) };
}

export async function freeVerifyEmail(email) {
  if (!freeEmailAvailable()) {
    return { ok: false, status: EMAIL_STATUS.UNVERIFIED, reason: "free_email_unavailable" };
  }

  let result;
  try {
    result = await verifyEmailFree(email, { timeoutMs: enrichmentLimits().freeEmailTimeoutMs });
  } catch (err) {
    result = { ok: false, result: "unknown", reason: err.code || err.message };
  }

  const ok = Boolean(result?.ok);
  recordProviderCall("free_email", { ok, error: ok ? "" : result?.reason || "verify_failed" });
  if (!ok) {
    return { ok: false, status: EMAIL_STATUS.UNVERIFIED, reason: result?.reason || "verify_failed" };
  }

  const raw = String(result.result || "").toLowerCase();
  let status = EMAIL_STATUS.UNVERIFIED;
  if (raw === "deliverable") status = EMAIL_STATUS.VERIFIED;
  else if (raw === "risky") status = EMAIL_STATUS.LIKELY;
  else if (raw === "undeliverable" || raw === "invalid") status = EMAIL_STATUS.INVALID;

  return {
    ok: true,
    status,
    score: Number(result.score) || 0,
    raw,
    catchAll: Boolean(result.catchAll),
    verifiedAt: new Date().toISOString()
  };
}
