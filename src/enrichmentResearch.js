/*
  Web-search research provider - owner/decision-maker discovery BEYOND the
  company's own website.

  Uses the SAME Tavily/Firecrawl keys the lead search already uses (no new
  account, no new cost centre), searches the public web for the company's
  founder/owner/CEO, then reads the top public result pages with the SAME
  SSRF-guarded scraper used everywhere else in enrichment.

  Rules that keep this honest and lawful:
    - LinkedIn / Facebook / Instagram / X / YouTube are NEVER fetched (their
      terms forbid automated access); a matching public profile URL found in
      search results is RECORDED as the contact's profileUrl, not scraped.
    - A person only counts as this company's decision-maker when the page
      actually names the company (or its domain) - a random "John Smith,
      CEO" from an unrelated page is dropped.
    - Emails are only kept when they are on the COMPANY's own domain;
      freemail found on third-party pages is discarded (it is usually a
      personal address we cannot attribute).
    - Everything is labelled source "web" with confidence low and a source
      URL, so the UI shows where it came from.
    - Bounded: a couple of queries and a few pages per company, a hard daily
      cap shared with admin controls, provider timeout on every call.
*/
import { scrapeWebsite } from "./scrape.js";
import { firecrawlKeys, tavilyKeys } from "./search.js";
import { recordProviderCall } from "./enrichmentStore.js";
import { enrichmentLimits } from "./enrichmentConfig.js";
import { normalizeDomain, assertPublicDomain } from "./enrichmentSafety.js";
import {
  extractRolePatternPeople,
  looksLikePersonName,
  cleanCompanyName,
  withTimeout,
  webSearchAvailable
} from "./enrichmentProviders.js";

/*
  Hosts we never fetch. Their published terms forbid automated reading, and
  their pages are login-walled anyway. Profile URLs on these hosts are still
  RECORDED (a public LinkedIn URL is a fact about where the person publishes
  themselves) - we just never request them.
*/
const NEVER_FETCH_HOSTS = [
  "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "tiktok.com", "google.com", "bing.com", "duckduckgo.com"
];

/* Hosts whose pages are pure aggregators/login walls - low value to read. */
const LOW_VALUE_HOSTS = [
  "crunchbase.com", "rocketreach.co", "zoominfo.com", "signalhire.com",
  "glassdoor.com", "indeed.com", "yelp.com"
];

function hostOf(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function matchesAnyHost(hostname, list) {
  return list.some(h => hostname === h || hostname.endsWith("." + h));
}

/* Public profile hosts we record but never fetch. */
function profileUrlFor(url = "") {
  const h = hostOf(url);
  if (/linkedin\.com$/.test(h) && /\/in\//.test(url)) return url;
  if (/(^|\.)twitter\.com$|(^|\.)x\.com$/.test(h)) return url;
  return "";
}

/* ---------------------------------------------------------------- search */

let tavilyIndex = 0;
let firecrawlIndex = 0;

async function tavilySearch(query, limit) {
  const keys = tavilyKeys();
  if (!keys.length) return null;
  const key = keys[tavilyIndex++ % keys.length];
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query,
      max_results: limit,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      include_images: false
    }),
    signal: AbortSignal.timeout(Number(process.env.TAVILY_TIMEOUT_MS || 25000))
  });
  if (res.status !== 200) return null;
  const json = await res.json().catch(() => null);
  const items = Array.isArray(json?.results) ? json.results : [];
  return items
    .map(i => ({ url: String(i.url || "").trim(), title: String(i.title || ""), snippet: String(i.content || "") }))
    .filter(i => i.url && /^https?:\/\//i.test(i.url));
}

async function firecrawlSearch(query, limit) {
  const keys = firecrawlKeys();
  if (!keys.length) return null;
  const key = keys[firecrawlIndex++ % keys.length];
  const res = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, limit }),
    signal: AbortSignal.timeout(Number(process.env.FIRECRAWL_TIMEOUT_MS || 40000))
  });
  if (res.status !== 200) return null;
  const json = await res.json().catch(() => null);
  const payload = json && json.success === false ? null : json?.data;
  const data = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? Object.values(payload).flat().filter(x => x && typeof x === "object")
      : [];
  return data
    .map(i => ({
      url: String(i.url || "").trim(),
      title: String(i.title || ""),
      snippet: String(i.description || i.snippet || i.content || "")
    }))
    .filter(i => i.url && /^https?:\/\//i.test(i.url));
}

async function webSearch(query, limit) {
  let items = null;
  try {
    items = await tavilySearch(query, limit);
  } catch {
    items = null;
  }
  recordProviderCall("web_research", { ok: Boolean(items && items.length), error: items ? "" : "search_failed" });
  if (items && items.length) return items;
  try {
    items = await firecrawlSearch(query, limit);
  } catch {
    items = null;
  }
  recordProviderCall("web_research", { ok: Boolean(items && items.length), error: items ? "" : "search_failed" });
  return items || [];
}

/* ---------------------------------------------------------------- pages */

async function assertSafeDestination(href) {
  const host = normalizeDomain(href);
  if (!host) return false;
  await assertPublicDomain(host);
  return true;
}

/*
  Reads ONE third-party page through the shared guarded scraper. Never uses the
  lead-search cache (skipCache) so research reads cannot pollute lead data.
*/
async function readPublicPage(url) {
  const limits = enrichmentLimits();
  try {
    const scraped = await withTimeout(
      scrapeWebsite(url, {
        runAudits: false,
        render: false,
        skipCache: true,
        guardDestinations: assertSafeDestination,
        crawl: { maxPages: 1, includeAll: false, forceDeep: false }
      }),
      limits.providerTimeoutMs
    );
    return scraped && scraped.scrapeOk ? scraped : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- research */

/*
  Builds the search queries for one company. The company name gives the
  tightest results; the domain catches companies whose legal name differs
  from what people write about them.
*/
export function researchQueries(companyName, host) {
  const name = cleanCompanyName(companyName, host) || host.replace(/^www\./, "");
  const base = name.replace(/\s+/g, " ").trim();
  const queries = [];
  if (base && base.toLowerCase() !== host) {
    queries.push(`"${base}" founder owner CEO`);
  }
  queries.push(`"${host}" founder owner`);
  return queries.slice(0, enrichmentLimits().webSearchQueriesPerCompany);
}

/*
  Keeps a person only when the page names this company. Deterministic check -
  no model, no guessing. Also returns the person's title.
*/
/* Legal suffixes are stripped for matching: a page that writes "Acme Robotics
   LLC" still names "Acme Robotics". */
const LEGAL_SUFFIX = /\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|pte)\b\.?/g;

/*
  Keeps a person only when the page names this company. Deterministic check -
  no model, no guessing. The FULL company name (minus legal suffixes) or the
  domain is required; a single generic first word ("downtown", "united") is
  NOT enough, because it attributes another company's founder to this one -
  verified live: "Downtown Plumbing" matched downtownmusic.com's founder page.
*/
export function peopleFromResearchPage(scraped, companyName, host) {
  const out = [];
  if (!scraped) return out;
  const text = String(scraped.text || "");
  const haystack = (text + " " + String(scraped.title || "")).toLowerCase();
  const raw = cleanCompanyName(companyName, host).toLowerCase() || host.replace(/^www\./, "").toLowerCase();
  const label = raw.replace(LEGAL_SUFFIX, "").replace(/\s+/g, " ").trim();
  const mentionsCompany = (label.length > 2 && haystack.includes(label))
    || haystack.includes(host)
    || (raw.length > 2 && haystack.includes(raw));
  if (!mentionsCompany) return out;

  for (const person of extractRolePatternPeople(text, 5)) {
    if (!looksLikePersonName(person.name)) continue;
    out.push({ name: person.name, title: person.title });
  }
  const owner = String(scraped.ownerName || "").trim();
  if (owner && looksLikePersonName(owner) && !out.some(p => p.name.toLowerCase() === owner.toLowerCase())) {
    out.push({ name: owner, title: scraped.ownerRole || "" });
  }
  return out;
}

/*
  Company-domain emails published on a third-party page are attributable to
  the company; anything else (other domains, freemail) is not kept here.
*/
export function emailsFromResearchPage(scraped, host) {
  const out = [];
  if (!scraped) return out;
  for (const email of scraped.emails || []) {
    const value = String(email || "").trim().toLowerCase();
    if (!value.includes("@")) continue;
    const domainPart = value.split("@")[1] || "";
    if (domainPart !== host && !domainPart.endsWith("." + host)) continue;
    out.push(value);
  }
  return out;
}

/*
  Main entry. Returns { contacts, emails, sources, notes, pagesRead } and never
  throws. Contacts carry source "web", low confidence and the exact page they
  were read from. Available only when a search key is configured, the provider
  is enabled and the daily cap allows.
*/
export async function researchPeopleOnWeb(domain, { companyName = "" } = {}) {
  const limits = enrichmentLimits();
  const host = normalizeDomain(domain);
  const out = { contacts: [], emails: [], sources: [], notes: [], pagesRead: 0, queriesRun: 0 };
  if (!host) return out;

  if (!webSearchAvailable()) {
    out.notes.push("web_search: not available (no search key configured, disabled, or daily cap reached)");
    return out;
  }

  /* ---- search */
  const seenUrls = new Set();
  const candidates = [];
  for (const query of researchQueries(companyName, host)) {
    const results = await withTimeout(webSearch(query, 8), limits.providerTimeoutMs * 2);
    out.queriesRun += 1;
    for (const item of results) {
      const h = hostOf(item.url);
      if (!h || seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      /* The company's own site is the website provider's job, not this one. */
      if (h === host || h.endsWith("." + host)) continue;
      candidates.push({ ...item, host: h });
    }
  }

  /* ---- profile URLs are recorded without ever fetching them */
  const contactProfiles = [];
  for (const item of candidates) {
    const p = profileUrlFor(item.url);
    if (p) contactProfiles.push({ url: p, text: `${item.title} ${item.snippet}`.toLowerCase() });
  }

  /* ---- read the top pages */
  const fetchable = candidates
    .filter(item => !matchesAnyHost(item.host, NEVER_FETCH_HOSTS))
    .sort((a, b) => (matchesAnyHost(a.host, LOW_VALUE_HOSTS) ? 1 : 0) - (matchesAnyHost(b.host, LOW_VALUE_HOSTS) ? 1 : 0))
    .slice(0, limits.webSearchPagesPerCompany);

  const byName = new Map();
  const emailSet = new Set();
  const sourceSet = new Set();

  for (const item of fetchable) {
    const scraped = await readPublicPage(item.url);
    if (!scraped) continue;
    out.pagesRead += 1;

    for (const person of peopleFromResearchPage(scraped, companyName, host)) {
      const key = person.name.toLowerCase();
      if (byName.has(key)) continue;
      /* Attach a matching public profile URL by name-in-slug, no fetching. */
      const slug = person.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const profile = contactProfiles.find(p => p.text.includes(slug))?.url || "";
      byName.set(key, {
        name: person.name,
        title: person.title,
        company: cleanCompanyName(companyName, host) || host,
        domain: host,
        profileUrl: profile,
        source: "web",
        sourceUrl: item.url,
        confidence: "low",
        status: "reported",
        verification: "unverified"
      });
      sourceSet.add(item.url);
    }

    for (const email of emailsFromResearchPage(scraped, host)) {
      if (emailSet.has(email)) continue;
      emailSet.add(email);
      sourceSet.add(item.url);
    }
  }

  out.contacts = [...byName.values()].slice(0, 8);
  out.emails = [...emailSet].slice(0, limits.emailsPerCompany);
  out.sources = [...sourceSet].slice(0, 10);

  if (out.queriesRun > 0 && out.pagesRead === 0 && out.contacts.length === 0) {
    out.notes.push("web_search: no readable public pages (results were social/login-walled or timed out)");
  }
  return out;
}

/* --------------------------------------------------- person-level search */

/* "Jason Fried" -> "jason-fried", for matching LinkedIn/X profile slugs. */
function slugOf(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/*
  Does this URL belong to this person? Matches BOTH slug styles - LinkedIn's
  hyphenated "/in/jason-fried" and X's flat "/jasonfried" - by comparing
  letter/digit-only forms, so a profile for anyone else never attaches.
*/
function urlNamesPerson(url, name) {
  const u = String(url || "").toLowerCase();
  const slug = slugOf(name);
  if (slug && u.includes(slug)) return true;
  const flatUrl = u.replace(/[^a-z0-9]/g, "");
  const flatName = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return flatName.length > 3 && flatUrl.includes(flatName);
}

/*
  Queries for ONE named person. The first anchors them to this company (a
  bare name matches every same-named person on earth); the second asks the
  SEARCH ENGINE for their professional profile - LinkedIn is the place a
  person publishes themselves professionally, and we query it through the
  search provider, never by fetching LinkedIn directly.
*/
export function personQueries(name, company, host) {
  const who = String(name || "").trim();
  if (!who) return [];
  const co = cleanCompanyName(company, host) || String(host || "").replace(/^www\./, "");
  if (!co) return [`"${who}" LinkedIn profile`];
  return [`"${who}" ${co} founder owner CEO`, `"${who}" ${co} LinkedIn profile`];
}

/*
  A read page confirms the person only when it names BOTH the person and
  this company - the same misattribution guard as company research, applied
  per person. Returns the person's stated role title when the page gives one.
*/
export function peopleFromPersonPage(scraped, personName, companyName, host) {
  const out = [];
  if (!scraped) return out;
  const label = String(personName || "").trim().toLowerCase();
  /* Single-word "names" are page chrome ("Contact", "Services") - never
     treat them as a person we just found. */
  if (!label.includes(" ")) return out;
  const text = String(scraped.text || "");
  const haystack = (text + " " + String(scraped.title || "")).toLowerCase();
  if (!haystack.includes(label)) return out;
  const hostLabel = String(host || "").replace(/^www\./, "").toLowerCase();
  const companyLabel = cleanCompanyName(companyName, host).toLowerCase() || hostLabel;
  if (companyLabel.length <= 2 || !(haystack.includes(companyLabel) || (hostLabel && haystack.includes(hostLabel)))) return out;

  for (const person of extractRolePatternPeople(text, 5)) {
    if (!looksLikePersonName(person.name)) continue;
    if (person.name.toLowerCase() !== label) continue;
    out.push({ name: person.name, title: person.title || "" });
  }
  const owner = String(scraped.ownerName || "").trim();
  if (owner && owner.toLowerCase() === label && !out.length) {
    out.push({ name: owner, title: scraped.ownerRole || "" });
  }
  /* Person + company confirmed even without a role pattern - the identity
     is established, only the title is missing. */
  if (!out.length) out.push({ name: String(personName).trim(), title: "" });
  return out;
}

/*
  Public professional profile URLs found in the search RESULTS for this
  person. Only LinkedIn /in/ and X/Twitter profile URLs qualify, and the URL
  slug must contain the person's own name slug, so a profile for someone else
  never attaches. The URL is RECORDED, never fetched.
*/
export function publicPersonProfiles(items, personName) {
  const slug = slugOf(personName);
  if (!slug) return [];
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const url = profileUrlFor(item.url);
    if (!url) continue;
    if (!urlNamesPerson(url, personName)) continue;
    /* www / trailing-slash variants of one profile count once. */
    const norm = url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(url);
  }
  return out;
}

/*
  "Jason Fried - Founder at Basecamp | LinkedIn" -> "Founder at Basecamp".
  A remainder that is just the network's own name (or page chrome) means no
  title - a missing title is honest, an invented one is not.
*/
export function titleFromSearchResult(item, personName) {
  const raw = String(item?.title || "");
  const name = String(personName || "").trim();
  if (!raw || !name) return "";
  const idx = raw.toLowerCase().indexOf(name.toLowerCase());
  if (idx < 0) return "";
  const after = raw.slice(idx + name.length)
    .split("|")[0]
    .replace(/^[\s\-–—:,·@]+/, "")
    .replace(/[\s\-–—:,·@]+$/, "")
    .trim();
  if (after.length < 3 || after.length > 80) return "";
  if (/^(linkedin|facebook|instagram|twitter|youtube|tiktok|home|official|profile|homepage|about)$/i.test(after)) return "";
  if (!/^[A-Za-z0-9]/.test(after)) return "";
  /*
    A bare company name is not a job title ("Randy Gitli - Aladdin Plumbing
    Corp." would otherwise put the COMPANY in the Job title column). Only a
    remainder that carries no role word AND ends like a company is dropped.
  */
  const hasRole = /\b(founder|co-?founder|owner|co-?owner|ceo|cto|cfo|coo|cmo|chief|president|vice president|director|managing|head|lead|partner|manager|editor|author|investor|operator|host|attorney|consultant|engineer|designer|sales|marketing)\b/i.test(after);
  if (!hasRole && /\b(inc|llc|ltd|limited|corp|corporation|gmbh|plc|pte|co|company)\b\.?$/i.test(after)) return "";
  return after;
}

/*
  Main person entry. Once a decision-maker is NAMED, search the public web
  for that person: their professional profile (LinkedIn/X via search
  results), interviews, news, directory entries - anywhere on the internet
  they are publicly documented. The top result pages are read to confirm the
  person really is at THIS company (person + company must both appear).

  Returns { contacts, emails, profiles, sources, notes, queriesRun,
  pagesRead } and never throws. Empty means "nothing public found" - a
  guessed profile or an invented title is never returned.
*/
export async function researchPersonByName(personName, { company = "", domain = "" } = {}) {
  const limits = enrichmentLimits();
  const host = normalizeDomain(domain);
  const name = String(personName || "").trim();
  const out = { contacts: [], emails: [], profiles: [], sources: [], notes: [], queriesRun: 0, pagesRead: 0 };
  if (!name || !host) return out;

  if (!webSearchAvailable()) {
    out.notes.push("web_search: not available (no search key configured, disabled, or daily cap reached)");
    return out;
  }

  /* ---- search: this person at this company, then their profile */
  const seenUrls = new Set();
  const candidates = [];
  const queries = personQueries(name, company, host).slice(0, limits.webSearchQueriesPerPerson);
  for (const query of queries) {
    const results = await withTimeout(webSearch(query, 8), limits.providerTimeoutMs * 2);
    out.queriesRun += 1;
    for (const item of results) {
      const h = hostOf(item.url);
      if (!h || seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      /* The company's own site was already crawled by the website provider. */
      if (h === host || h.endsWith("." + host)) continue;
      const hay = `${item.title} ${item.snippet}`.toLowerCase();
      if (!hay.includes(name.toLowerCase()) && !urlNamesPerson(item.url, name)) continue;
      candidates.push({ ...item, host: h });
    }
  }

  /* ---- profile URLs come from the RESULTS themselves, never fetched */
  out.profiles = publicPersonProfiles(candidates, name).slice(0, 4);

  /* ---- read the top result pages to confirm person + company together */
  const fetchable = candidates
    .filter(item => !matchesAnyHost(item.host, NEVER_FETCH_HOSTS))
    .sort((a, b) => (matchesAnyHost(a.host, LOW_VALUE_HOSTS) ? 1 : 0) - (matchesAnyHost(b.host, LOW_VALUE_HOSTS) ? 1 : 0))
    .slice(0, Math.min(limits.webSearchPagesPerPerson, limits.webSearchPagesPerCompany));

  const sourceSet = new Set();
  const emailSet = new Set();
  let confirmed = null;
  for (const item of fetchable) {
    const scraped = await readPublicPage(item.url);
    if (!scraped) continue;
    out.pagesRead += 1;
    const people = peopleFromPersonPage(scraped, name, company, host);
    if (!people.length) continue;
    if (!confirmed) confirmed = { title: people[0].title || "", url: item.url };
    else if (!confirmed.title && people[0].title) confirmed.title = people[0].title;
    sourceSet.add(item.url);
    if (out.profiles.length === 0) {
      const p = profileUrlFor(item.url);
      if (p) out.profiles.push(p);
    }
    for (const email of emailsFromResearchPage(scraped, host)) {
      if (emailSet.has(email)) continue;
      emailSet.add(email);
      sourceSet.add(item.url);
    }
  }

  out.sources = [...sourceSet];
  out.emails = [...emailSet].slice(0, limits.emailsPerCompany);

  const profileUrl = out.profiles[0] || "";
  if (confirmed || profileUrl) {
    const profileResult = candidates.find(c => profileUrl && c.url === profileUrl) || null;
    out.contacts.push({
      name,
      title: confirmed?.title || titleFromSearchResult(profileResult, name) || titleFromSearchResult(candidates[0], name),
      company: cleanCompanyName(company, host) || host,
      domain: host,
      profileUrl,
      source: "web",
      sourceUrl: confirmed?.url || profileUrl,
      /* "medium" only when a page we actually read confirms the person at
         this company; a name-matched profile URL alone stays low. */
      confidence: confirmed ? "medium" : "low",
      status: "reported",
      verification: "unverified"
    });
  } else if (out.queriesRun > 0) {
    out.notes.push(`web_search: no public page found for "${name}"`);
  }
  if (out.contacts.length && !profileUrl) {
    out.notes.push(`web_search: no public professional profile found for "${name}"`);
  }
  return out;
}
