import * as cheerio from "cheerio";
import { parsePhoneNumberFromString, findPhoneNumbersInText } from "libphonenumber-js";
import { runSiteAudit } from "./siteAudit.js";
import { cacheKeyForScrape, getCached, setCached } from "./domainCache.js";
import { analyzeAeo } from "./aeo.js";

let chromium = null;
let sharedBrowser = null;
let sharedBrowserUses = 0;

try {
    const pw = await import("playwright");
    chromium = pw.chromium;
} catch {
    chromium = null;
}

async function getSharedBrowser() {
    if (!chromium) return null;

    if (sharedBrowser && sharedBrowser.isConnected() && sharedBrowserUses < 300) {
        return sharedBrowser;
    }

    if (sharedBrowser) {
        try { await sharedBrowser.close(); } catch {}
    }

    sharedBrowser = await Promise.race([
        chromium.launch({
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-setuid-sandbox",
                "--disable-gpu"
            ]
        }),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error("chromium launch timed out")), 30000)
        )
    ]);

    sharedBrowserUses = 0;
    return sharedBrowser;
}

/*
  cheerio's .text() concatenates sibling text nodes with no separator, so
  <span>Contact Us</span><a href="mailto:info@shop.com"> becomes
  "Contact Usinfo@shop.com" and <p>Call us</p><p>713-555-0100</p> becomes
  "us713-555-0100". Those corrupt every downstream extraction: emails, phones
  and even the name normalizer. Replacing tags with a space first keeps words
  separate while cheerio still does the entity decoding.
*/
function textWithBoundaries($, el) {
    const html = String($(el).html() || "");
    if (!html) return "";

    return clean(cheerio.load(html.replace(/<[^>]*>/g, " ")).root().text());
}

/*
  EMAIL_RE ends with an unbounded TLD, so in flattened text "info@shop.com the"
  can match as "info@shop.comthe". Repair by trimming back to a real TLD, and
  reject anything that never resolves to one.
*/
const VALID_TLDS = new Set([
    "com", "org", "net", "edu", "gov", "mil", "int", "info", "biz", "name",
    "pro", "coop", "aero", "museum", "intelligence", "jobs", "mobi", "travel",
    "cat", "asia", "tel", "xxx", "post", "app", "dev", "cloud", "online",
    "site", "store", "shop", "tech", "space", "website", "live", "life",
    "world", "today", "media", "agency", "digital", "design", "studio", "group",
    "team", "works", "email", "link", "click", "page", "wiki", "art", "shop",
    "us", "uk", "ca", "mx", "au", "nz", "ie", "nz", "za", "in", "pk", "bd",
    "br", "ar", "cl", "co", "pe", "ve", "eu", "de", "fr", "es", "pt", "it",
    "nl", "be", "ch", "at", "se", "no", "dk", "fi", "pl", "cz", "sk", "hu",
    "ro", "bg", "gr", "tr", "ru", "ua", "il", "ae", "sa", "qa", "kw", "eg",
    "ng", "ke", "gh", "za", "sg", "my", "th", "vn", "ph", "id", "jp", "kr",
    "cn", "hk", "tw", "is", "lt", "lv", "ee", "si", "hr", "rs", "ba", "mk",
    "al", "ge", "am", "az", "kz", "uz"
]);

function repairEmailTld(value) {
    const email = String(value || "").trim().toLowerCase();
    const at = email.lastIndexOf("@");
    if (at <= 0) return "";

    const local = email.slice(0, at);
    let domain = email.slice(at + 1);

    // Strip trailing junk after the TLD, e.g. "shop.comthe" -> "shop.com".
    const parts = domain.split(".");
    if (parts.length < 2) return "";

    const tld = parts[parts.length - 1];
    if (VALID_TLDS.has(tld)) return `${local}@${domain}`;

    for (let len = tld.length - 1; len >= 2; len--) {
        const candidate = tld.slice(0, len);
        if (VALID_TLDS.has(candidate)) {
            return `${local}@${[...parts.slice(0, -1), candidate].join(".")}`;
        }
    }

    return "";
}

const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY || "US";

const EMAIL_RE =
    /[a-zA-Z0-9._%+-]+(?:\s?\[at\]\s?|\s?\(at\)\s?|@)[a-zA-Z0-9.-]+(?:\s?\[dot\]\s?|\s?\(dot\)\s?|\.)[a-zA-Z]{2,}/gi;

const BAD_EMAIL_PARTS = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".css",
    ".js",
    "example.com",
    "domain.com",
    "schema.org",
    "sentry.io",
    "wixpress.com",
    "cloudflare.com",
    "wordpress.org"
];

function clean(value = "") {
    return String(value).replace(/\s+/g, " ").trim();
}

function uniq(arr) {
    const seen = new Set();
    const out = [];

    for (const item of arr) {
        const value = clean(item);
        const key = value.toLowerCase();

        if (!value || seen.has(key)) continue;

        seen.add(key);
        out.push(value);
    }

    return out;
}

function uniqEvidence(items = []) {
    const seen = new Set();
    const out = [];

    for (const item of items) {
        const value = clean(item.value || "");
        const method = clean(item.method || "");
        const pageUrl = clean(item.pageUrl || "");
        const key = `${value.toLowerCase()}|${method}|${pageUrl}`;

        if (!value || seen.has(key)) continue;

        seen.add(key);
        out.push({
            value,
            method: item.method || "unknown",
            pageUrl: item.pageUrl || "",
            context: clean(item.context || "").slice(0, 240)
        });
    }

    return out;
}

function normalizeEmail(email = "") {
    return clean(decodeURIComponentSafe(email))
        .replace(/\s?\[at\]\s?/gi, "@")
        .replace(/\s?\(at\)\s?/gi, "@")
        .replace(/\s?\[dot\]\s?/gi, ".")
        .replace(/\s?\(dot\)\s?/gi, ".")
        .replace(/^mailto:/i, "")
        .split("?")[0]
        .replace(/^%20/, "")
        .replace(/[;,]+$/, "")
        .toLowerCase();
}

function decodeURIComponentSafe(value = "") {
    try {
        return decodeURIComponent(String(value).replace(/\+/g, " "));
    } catch {
        return String(value);
    }
}

function isGoodEmail(email = "") {
    const e = normalizeEmail(email);

    if (!e.includes("@")) return false;
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) return false;
    if (BAD_EMAIL_PARTS.some(x => e.includes(x))) return false;

    return true;
}

/*
  Emails an owner intentionally mangles to dodge scrapers - "name [at] company
  [dot] com" - never match EMAIL_RE, so normalizeEmail's de-obfuscation never
  gets to run on them. This rewrites the small, safe pattern (local [at] domain
  [dot] tld) and hands the result back to the same validator, so only a real,
  well-formed address survives.
*/
function decodeObfuscatedEmails(text = "") {
    const source = String(text || "");
    const replaced = source.replace(
        /([A-Za-z0-9._%+-]+)\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\s+at\s+)\s*([A-Za-z0-9.-]+)\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\s+dot\s+)\s*([A-Za-z]{2,})/gi,
        "$1@$2.$3"
    );

    if (replaced === source) return [];
    return replaced.match(EMAIL_RE) || [];
}

function decodeCloudflareEmail(encodedString) {
    try {
        let email = "";
        const key = parseInt(encodedString.substr(0, 2), 16);

        for (let i = 2; i < encodedString.length; i += 2) {
            email += String.fromCharCode(parseInt(encodedString.substr(i, 2), 16) ^ key);
        }

        return email;
    } catch {
        return "";
    }
}

function normalizePhone(candidate = "") {
    const raw = clean(candidate)
        .replace(/^tel:/i, "")
        .replace(/[^\d+().\-\s]/g, "")
        .trim();

    if (!raw) return "";

    const parsed = parsePhoneNumberFromString(raw, DEFAULT_COUNTRY);

    if (!parsed || !parsed.isValid()) return "";

    return parsed.formatNational();
}

function extractValidPhonesFromText(text = "") {
    const found = [];

    try {
        const matches = findPhoneNumbersInText(text, DEFAULT_COUNTRY);

        for (const match of matches) {
            if (match.number && match.number.isValid()) {
                found.push(match.number.formatNational());
            }
        }
    } catch {}

    return found;
}

function makeContext(text = "", value = "") {
    const cleanText = clean(text);
    const cleanValue = clean(value);

    if (!cleanText || !cleanValue) return "";

    const index = cleanText.toLowerCase().indexOf(cleanValue.toLowerCase());

    if (index === -1) {
        return cleanText.slice(0, 220);
    }

    return cleanText.slice(Math.max(0, index - 80), index + cleanValue.length + 120);
}

function abs(base, href) {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
}

function sameDomain(base, link) {
    try {
        const a = new URL(base).hostname.replace(/^www\./, "");
        const b = new URL(link).hostname.replace(/^www\./, "");
        return a === b;
    } catch {
        return false;
    }
}

/*
  Optional destination guard for callers that fetch hosts a user submitted
  (Company & Contact Enrichment). With no guard the behaviour is byte-for-byte
  what it has always been: `redirect: "follow"`. With one, redirects are
  followed manually and EVERY hop must pass the caller's check before the
  request is made, so a public host that 30x-redirects to an internal address
  is refused instead of followed (the SSRF case the DNS pre-check alone cannot
  cover). The guard may be async; a rejection ends the fetch with a non-200
  status, which every caller already treats as "no content".
*/
async function guardedFetch(url, { guard, ...init }) {
    if (!guard) return fetch(url, { ...init, redirect: "follow" });

    const blocked = () => new Response("", { status: 400 });
    let current = url;

    for (let hop = 0; hop <= 4; hop += 1) {
        const res = await fetch(current, { ...init, redirect: "manual" });
        const status = res.status;
        const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

        if (!isRedirect) return res;

        const location = res.headers.get("location");
        res.body?.cancel?.();
        if (!location) return blocked();

        let next;
        try {
            next = new URL(location, current);
        } catch {
            return blocked();
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") return blocked();

        let allowed = false;
        try {
            allowed = await guard(next.href);
        } catch {
            allowed = false;
        }
        if (!allowed) return blocked();

        current = next.href;
    }

    // Too many hops: refuse rather than fall back to unguarded following.
    return blocked();
}

async function fetchHtmlBasicOnce(url, guard) {
    const attempts = [
        {
            "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "accept-language": "en-US,en;q=0.9",
            "sec-ch-ua": "\"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\", \"Not-A.Brand\";v=\"99\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            referer: "https://www.google.com/"
        },
        {
            "user-agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
            "accept-language": "en-US,en;q=0.9",
            referer: "https://www.google.com/"
        },
        {
            "user-agent":
                "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0",
            "accept-language": "en-US,en;q=0.9"
        }
    ];

    for (const extra of attempts) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 9000);

        try {
            const res = await guardedFetch(url, {
                guard,
                signal: controller.signal,
                headers: {
                    ...extra,
                    accept:
                        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
                }
            });

            if (res.status === 403 || res.status === 429) continue;

            if (res.status !== 200) return "";

            const type = res.headers.get("content-type") || "";

            if (!type.includes("text/html") && !type.includes("application/xhtml")) {
                return "";
            }

            const body = await res.text();

            if (body.length > 0) return body;
        } catch {
        } finally {
            clearTimeout(timeout);
        }
    }

    return "";
}

function hostVariants(url) {
    const variants = [url];
    try {
        const parsed = new URL(url);
        const host = parsed.hostname;

        if (host.startsWith("www.")) {
            parsed.hostname = host.slice(4);
            variants.push(parsed.href);
        } else {
            parsed.hostname = "www." + host;
            variants.push(parsed.href);
        }

        if (parsed.protocol === "https:") {
            parsed.protocol = "http:";
            variants.push(parsed.href);
        } else {
            parsed.protocol = "https:";
            variants.push(parsed.href);
        }
    } catch {}

    return [...new Set(variants)];
}

async function fetchHtmlBasic(url, guard) {
    for (const candidate of hostVariants(url)) {
        const body = await fetchHtmlBasicOnce(candidate, guard);
        if (body) return body;
    }

    return "";
}

/*
  robots.txt is text/plain, which the HTML fetcher deliberately refuses, so it
  needs its own tiny reader. Best-effort with a short timeout: a missing or slow
  robots.txt must never cost the lead, so a failure returns "" and the AEO facts
  simply report that it was not fetched rather than assuming a block.
*/
async function fetchRobotsTxt(url) {
    try {
        const origin = new URL(url).origin;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        try {
            const res = await fetch(`${origin}/robots.txt`, {
                signal: controller.signal,
                redirect: "follow",
                headers: {
                    "user-agent": "Mozilla/5.0 (compatible; LeadAuditBot/1.0)",
                    accept: "text/plain,*/*;q=0.8"
                }
            });

            if (!res.ok) return "";

            const body = await res.text();
            return body.length <= 100000 ? body : body.slice(0, 100000);
        } finally {
            clearTimeout(timeout);
        }
    } catch {
        return "";
    }
}

function rankInternalLinks(baseUrl, links) {
    const keywords = [
        ["contact", 100],
        ["contact us", 100],
        ["about", 80],
        ["location", 70],
        ["locations", 70],
        ["service area", 60],
        ["book", 60],
        ["appointment", 60],
        ["quote", 60],
        ["estimate", 60],
        ["team", 30],
        ["impressum", 70],
        ["imprint", 65],
        ["mentions legales", 70],
        ["mentions-legales", 70],
        ["kontakt", 70],
        ["legal notice", 60]
    ];

    const finalLinks = [];

    for (const link of links) {
        if (!link.href || !sameDomain(baseUrl, link.href)) continue;

        const url = link.href.split("#")[0];
        const path = new URL(url).pathname.toLowerCase();
        const text = clean(link.text).toLowerCase();
        const hay = `${text} ${path}`;

        if (/\.(jpg|png|pdf|zip|mp4|mp3|webp|docx?)$/i.test(path)) continue;

        let score = 0;

        for (const [keyword, points] of keywords) {
            if (hay.includes(keyword)) score += points;
        }

        if (score > 0) {
            finalLinks.push({ href: url, text: link.text, score });
        }
    }

    const map = new Map();

    for (const item of finalLinks.sort((a, b) => b.score - a.score)) {
        if (!map.has(item.href)) map.set(item.href, item);
    }

    return [...map.values()];
}

async function fetchRenderedPages(startUrl) {
    if (!chromium) return [];

    let browser = null;

    try {
        browser = await getSharedBrowser();
    } catch {
        return [];
    }

    let context = null;

    try {
        context = await browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
            viewport: { width: 1366, height: 900 }
        });

        sharedBrowserUses += 1;

        const page = await context.newPage();

        await page.goto(startUrl, {
            waitUntil: "domcontentloaded",
            timeout: 20000
        });

        await page.waitForTimeout(400);

        const pages = [
            {
                url: page.url(),
                html: await page.content()
            }
        ];

        const links = await page.$$eval("a", anchors => {
            return anchors.map(a => ({
                text: (a.innerText || "").trim(),
                href: a.href || ""
            }));
        });

        const ranked = rankInternalLinks(startUrl, links).slice(0, 5);

        for (const link of ranked) {
            try {
                await page.goto(link.href, {
                    waitUntil: "domcontentloaded",
                    timeout: 15000
                });

                await page.waitForTimeout(250);

                pages.push({
                    url: page.url(),
                    html: await page.content()
                });
            } catch {}
        }

        return pages;
    } catch {
        return [];
    } finally {
        if (context) {
            try { await context.close(); } catch {}
        }
    }
}

function isErrorPage(html) {
    if (!html || html.trim().length < 300) return true;

    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";

    if (!title.trim()) return false;

    const t = title.toLowerCase().trim();

    return (
        /^(403|404|401|500|error)/.test(t) ||
        /forbidden|access denied|permission denied|not found|blocked|unavailable/.test(t)
    );
}

function isGoodPage(page) {
    return page && typeof page.html === "string" && !isErrorPage(page.html);
}

/*
  Crawl shape. The default (null) keeps the lead-scrape behaviour it always had:
  homepage + the four best keyword-ranked internal links. Enrichment passes a
  crawl object to read far more of the site - see scrapeWebsite's `crawl` option.
*/
function crawlOptions(crawl) {
    const opts = crawl && typeof crawl === "object" ? crawl : {};
    return {
        /* 5 keeps the historical shape exactly: homepage + 4 ranked links. */
        maxPages: Math.max(1, Math.min(30, Number(opts.maxPages) || 5)),
        includeAll: Boolean(opts.includeAll),
        forceDeep: Boolean(opts.forceDeep)
    };
}

async function fetchPages(startUrl, { render = true, guard = null, crawl = null } = {}) {
    const opts = crawlOptions(crawl);

    for (const candidate of hostVariants(startUrl)) {
        const pages = await fetchPagesOnce(candidate, { render, guard, crawl: opts });

        if (pages.some(isGoodPage)) return pages;
    }

    return [];
}

async function fetchPagesOnce(startUrl, { render = true, guard = null, crawl = null } = {}) {
    const opts = crawlOptions(crawl);
    /*
      render:false skips the headless browser entirely and goes straight to
      plain HTTP. The public free preview uses that path so an anonymous
      request cannot trigger a Chromium launch per candidate.
    */
    const renderedPages = render ? (await fetchRenderedPages(startUrl)).filter(isGoodPage) : [];

    if (renderedPages.length > 0) return renderedPages;

    const homepageHtml = await fetchHtmlBasic(startUrl, guard);
    const pages = [];

    if (!homepageHtml || isErrorPage(homepageHtml)) return pages;

    pages.push({ url: startUrl, html: homepageHtml });

    const $ = cheerio.load(homepageHtml);
    const links = [];

    $("a").each((_, el) => {
        const text = clean($(el).text());
        const href = $(el).attr("href") || "";
        const link = abs(startUrl, href);

        if (!link || !sameDomain(startUrl, link)) return;

        links.push({ text, href: link });
    });

    const ranked = rankInternalLinks(startUrl, links);

    /*
      Whole-site mode (enrichment): the keyword-ranked pages come first, then
      every remaining same-domain link in document order - services, products,
      team, careers, about-story pages - so the crawl reads what the company
      actually published instead of stopping after contact/about. Still capped
      by maxPages, still same-domain and still skipping asset links.
    */
    if (opts.includeAll) {
        const seen = new Set(ranked.map(l => urlKey(l.href)));
        for (const link of links) {
            const href = String(link.href || "").split("#")[0];
            if (!href || /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|mp3|webm|docx?|xlsx?|pptx?)$/i.test(href)) continue;
            const key = urlKey(href);
            if (seen.has(key)) continue;
            seen.add(key);
            ranked.push({ href, text: link.text, score: 0 });
        }
    }

    /* The homepage is page one: the cap counts every page actually read. */
    const wanted = ranked.slice(0, Math.max(0, opts.maxPages - 1));

    const results = await Promise.all(
        wanted.map(link => fetchHtmlBasic(link.href, guard).then(html => ({ link, html })))
    );

    for (const { link, html } of results) {
        if (html) pages.push({ url: link.href, html });
    }

    return pages;
}

/*
  A URL reduced to the form two links share when they point at the same page:
  lowercased, without the hash/query and without a trailing slash. Used to tell
  a deep-contact page we already fetched from one we still need to open.
*/
function urlKey(u) {
    return String(u || "")
        .toLowerCase()
        .replace(/[#?].*$/, "")
        .replace(/\/+$/, "");
}

/*
  Deep contact discovery.

  The standard crawl already ranks "contact"/"about" first, but a business whose
  only email sits on a /privacy-policy or a second contact page is missed, and a
  lead with no reachable address is worth nothing. Given the pages we already
  have, list same-domain contact/about/privacy links we have not fetched yet,
  best-scoring first.
*/
function deepContactCandidates(baseUrl, pages) {
    const fetched = new Set((pages || []).map(p => urlKey(p.url)));
    const home = (pages || [])[0];
    if (!home || !home.html) return [];

    const $ = cheerio.load(home.html);
    const found = [];
    const seen = new Set();

    $("a").each((_, el) => {
        const href = $(el).attr("href") || "";
        const text = clean($(el).text()).toLowerCase();
        const url = abs(baseUrl, href);
        if (!url || !sameDomain(baseUrl, url)) return;

        const hay = `${text} ${url.toLowerCase()}`;
        let score = 0;

        if (/contact/.test(hay)) score = 100;
        else if (/\babout\b/.test(hay)) score = 80;
        else if (/impressum|imprint|mentions[-_ ]?l[ée]gales|kontakt|legal[-_ ]?notice/i.test(hay)) score = 70;
        else if (/privacy|privacy-policy|privacy_policy|\blegal\b/.test(hay)) score = 40;

        if (!score) return;

        const key = urlKey(url);
        if (fetched.has(key) || seen.has(key)) return;

        seen.add(key);
        found.push({ url, score });
    });

    return found.sort((a, b) => b.score - a.score).slice(0, 4);
}

/*
  Runs only when the normal crawl surfaced no email at all. Plain-HTTP fetches
  (no browser), capped, and every failure is ignored, so a slow privacy page can
  never cost the lead — it can only add an address the site kept off its
  homepage.
*/
async function fetchDeepContactPages(baseUrl, pages, guard = null, { force = false, budget = 4 } = {}) {
    if (!pages.length) return;

    /*
      Normally these pages are only worth opening when the crawl found no email
      at all. `force` (enrichment) reads them anyway: the about/legal pages are
      where a company publishes its addresses and people, which is the whole
      point of the enrichment crawl.
    */
    const seenHtml = pages.map(p => p.html || "").join("\n");
    if (!force && (EMAIL_RE.test(seenHtml) || /mailto:/i.test(seenHtml))) return;

    const candidates = deepContactCandidates(baseUrl, pages).slice(0, Math.max(0, budget));
    if (!candidates.length) return;        const results = await Promise.all(
            candidates.map(c =>
                fetchHtmlBasic(c.url, guard)
                .then(html => ({ url: c.url, html }))
                .catch(() => null)
        )
    );

    for (const item of results) {
        if (item && item.html && !isErrorPage(item.html)) {
            pages.push({ url: item.url, html: item.html });
        }
    }
}

function extractJsonLd($) {
    const items = [];

    $('script[type="application/ld+json"]').each((_, el) => {
        const raw = $(el).text();

        try {
            const parsed = JSON.parse(raw);
            const arr = Array.isArray(parsed) ? parsed : [parsed];

            for (const item of arr) {
                if (item && typeof item === "object") items.push(item);

                if (Array.isArray(item?.["@graph"])) {
                    for (const graphItem of item["@graph"]) {
                        if (graphItem && typeof graphItem === "object") {
                            items.push(graphItem);
                        }
                    }
                }
            }
        } catch {}
    });

    return items;
}

function extractJsonLdValues(items, pageUrl) {
    const names = [];
    const emails = [];
    const phones = [];
    const addresses = [];
    const emailEvidence = [];
    const phoneEvidence = [];
    const socials = [];
    const foundingYears = [];
    const employeeCounts = [];

    for (const item of items) {
        const type = Array.isArray(item["@type"])
            ? item["@type"].join(" ")
            : String(item["@type"] || "");

        const likelyBusiness =
            /LocalBusiness|Organization|ProfessionalService|LegalService|AutoRepair|HomeAndConstructionBusiness|Store|Dentist|Plumber|Electrician|Restaurant/i.test(type);

        if (!likelyBusiness && !item.name && !item.telephone && !item.email) {
            continue;
        }

        if (item.name) names.push(item.name);

        /*
          Founding year and headcount are only ever stated by the business
          itself, so schema.org's own fields are the honest source for them.
          Both are optional: a page that omits them simply contributes nothing.
        */
        if (item.foundingDate || item.foundingYear || item.yearFounded) {
            const year = String(item.foundingDate || item.foundingYear || item.yearFounded).match(/\b(?:1[6-9]|20)\d{2}\b/);
            if (year) foundingYears.push(year[0]);
        }

        if (typeof item.numberOfEmployees === "number" && Number.isFinite(item.numberOfEmployees)) {
            employeeCounts.push(item.numberOfEmployees);
        } else if (item.numberOfEmployees && typeof item.numberOfEmployees === "object") {
            const value = Number(item.numberOfEmployees.value);
            if (Number.isFinite(value)) employeeCounts.push(value);
        }

        /*
          sameAs is where a business lists its own profiles. They are as
          official as a profile gets, so they feed the social set directly.
        */
        if (item.sameAs) {
            const links = Array.isArray(item.sameAs) ? item.sameAs : [item.sameAs];
            for (const link of links) {
                if (typeof link === "string" && link) socials.push(link);
            }
        }

        if (item.email) {
            emails.push(item.email);
            emailEvidence.push({
                value: item.email,
                method: "schema_email",
                pageUrl,
                context: "Email found inside JSON-LD schema"
            });
        }

        if (item.telephone) {
            phones.push(item.telephone);
            phoneEvidence.push({
                value: item.telephone,
                method: "schema_telephone",
                pageUrl,
                context: "Phone found inside JSON-LD schema"
            });
        }

        if (item.address) {
            if (typeof item.address === "string") {
                addresses.push(item.address);
            } else {
                const a = item.address;

                addresses.push(
                    clean(
                        [
                            a.streetAddress,
                            a.addressLocality,
                            a.addressRegion,
                            a.postalCode,
                            a.addressCountry
                        ]
                            .filter(Boolean)
                            .join(", ")
                    )
                );
            }
        }
    }

    return { names, emails, phones, addresses, emailEvidence, phoneEvidence, socials, foundingYears, employeeCounts };
}

function extractFromPage(page) {
    const $ = cheerio.load(page.html);

    const jsonLd = extractJsonLd($);
    const jsonValues = extractJsonLdValues(jsonLd, page.url);

    const names = [...jsonValues.names];
    const emails = [...jsonValues.emails];
    const phones = [...jsonValues.phones];
    const addresses = [...jsonValues.addresses];
    const emailEvidence = [...jsonValues.emailEvidence];
    const phoneEvidence = [...jsonValues.phoneEvidence];
    const foundingYears = [...(jsonValues.foundingYears || [])];
    const employeeCounts = [...(jsonValues.employeeCounts || [])];
    const linkedinUrls = [];
    const socialUrls = [];

    /*
      Profiles declared in schema are treated exactly like profiles linked from
      the page: sameAs is the owner's own statement of which profiles are theirs.
    */
    for (const link of jsonValues.socials) {
        const href = String(link || "");
        if (/linkedin\.com\//i.test(href)) linkedinUrls.push(href);
        if (/facebook\.com\//i.test(href) || /instagram\.com\//i.test(href)) socialUrls.push(href);
    }

    const title = clean($("title").first().text());
    const metaDesc = clean($('meta[name="description"]').attr("content") || "");
    const ogSiteName = clean($('meta[property="og:site_name"]').attr("content") || "");
    const ogTitle = clean($('meta[property="og:title"]').attr("content") || "");

    if (ogSiteName) names.push(ogSiteName);
    if (ogTitle) names.push(ogTitle);
    if (title) names.push(title);

    $('[itemprop="name"]').each((_, el) => {
        const value = clean($(el).attr("content") || $(el).text());
        if (value) names.push(value);
    });

    $('[itemprop="email"]').each((_, el) => {
        const value = clean($(el).attr("content") || $(el).text());
        if (value) {
            emails.push(value);
            emailEvidence.push({
                value,
                method: "schema_email",
                pageUrl: page.url,
                context: "Email found from itemprop=email"
            });
        }
    });

    $('[itemprop="telephone"], [itemprop="phone"]').each((_, el) => {
        const value = clean($(el).attr("content") || $(el).text());
        if (value) {
            phones.push(value);
            phoneEvidence.push({
                value,
                method: "schema_telephone",
                pageUrl: page.url,
                context: "Phone found from itemprop=telephone"
            });
        }
    });

    $("[data-cfemail]").each((_, el) => {
        const encoded = $(el).attr("data-cfemail");
        const decoded = decodeCloudflareEmail(encoded);

        if (decoded) {
            emails.push(decoded);
            emailEvidence.push({
                value: decoded,
                method: "cloudflare_email",
                pageUrl: page.url,
                context: "Cloudflare protected email decoded"
            });
        }
    });

    $("a").each((_, el) => {
        const href = $(el).attr("href") || "";
        const anchorText = clean($(el).text());

        if (href.toLowerCase().startsWith("mailto:")) {
            const value = href.replace(/^mailto:/i, "").split("?")[0];

            emails.push(value);
            emailEvidence.push({
                value,
                method: "mailto_link",
                pageUrl: page.url,
                context: anchorText || "Email found in mailto link"
            });
        }

        if (href.toLowerCase().startsWith("tel:")) {
            const value = href.replace(/^tel:/i, "");

            phones.push(value);
            phoneEvidence.push({
                value,
                method: "tel_link",
                pageUrl: page.url,
                context: anchorText || "Phone found in tel link"
            });
        }

        if (href.includes("/cdn-cgi/l/email-protection#")) {
            const encoded = href.split("#")[1];
            const decoded = decodeCloudflareEmail(encoded);

            if (decoded) {
                emails.push(decoded);
                emailEvidence.push({
                    value: decoded,
                    method: "cloudflare_email",
                    pageUrl: page.url,
                    context: anchorText || "Cloudflare protected email decoded from link"
                });
            }
        }

        if (/linkedin\.com\/company\//i.test(href) || /linkedin\.com\/in\//i.test(href)) {
            linkedinUrls.push(href);
        }

        if (/facebook\.com\//i.test(href)) socialUrls.push(href);
        if (/instagram\.com\//i.test(href)) socialUrls.push(href);
        /* x.com/ is only matched at a host boundary so "examplex.com/" never counts. */
        if (/(?:^|\/\/)(?:www\.|m\.)?(?:twitter|x)\.com\//i.test(href)) socialUrls.push(href);
    });

    $("script, style, noscript, svg").remove();

    const visibleText = textWithBoundaries($, "body");

    const textEmails = visibleText.match(EMAIL_RE) || [];

    for (const raw of textEmails) {
        const email = repairEmailTld(raw);
        if (!email) continue;

        emails.push(email);

        emailEvidence.push({
            value: email,
            method: page.url.toLowerCase().includes("contact")
                ? "contact_page_visible"
                : "body_context_visible",
            pageUrl: page.url,
            context: makeContext(visibleText, raw)
        });
    }

    /*
      De-obfuscated emails are added separately so their evidence can honestly
      say the address was masked in the source, not plainly written on the page.
    */
    for (const raw of decodeObfuscatedEmails(visibleText)) {
        const email = repairEmailTld(raw);
        if (!email) continue;

        emails.push(email);
        emailEvidence.push({
            value: email,
            method: "obfuscated_text",
            pageUrl: page.url,
            context: makeContext(visibleText, raw)
        });
    }

    const validTextPhones = extractValidPhonesFromText(visibleText);

    for (const phone of validTextPhones) {
        phones.push(phone);

        phoneEvidence.push({
            value: phone,
            method: page.url.toLowerCase().includes("contact")
                ? "contact_page_visible"
                : "body_context_visible",
            pageUrl: page.url,
            context: makeContext(visibleText, phone)
        });
    }

    return {
        url: page.url,
        title,
        metaDesc,
        names,
        emails,
        phones,
        addresses,
        text: visibleText,
        emailEvidence,
        phoneEvidence,
        linkedinUrls,
        socialUrls,
        foundingYears,
        employeeCounts
    };
}

// Page titles often lead with the page's purpose ("Contact Us - X", "Privacy
// Policy | X"), bury it in the middle ("Dentist Contact - X") or trail with a
// street address. Strip those so the lead is named after the business, not the
// page it was scraped from.
const PAGE_LABEL =
    /^(contact\s+us|contact|about\s+us|about(\s+our)?|home|welcome|privacy\s+policy|privacy|terms(\s+of\s+(use|service))?|disclaimer|location(s)?|our\s+(team|office|story|location(s)?|about|story)|team|services?|service\s+menu|faqs?|directions|reviews?|book(\s+(now|online))?|appointment(s)?|meet(\s+the)?(\s+team)?|(\w+\s+){0,2}contact)\b\s*[–—|:/-]?\s*/i;
const GENERIC_NAME = /^(the\s+)?(dental|medical|clinic|barber|hair|salon|dentist|doctor)(\s+(office|center|centre|care|group|practice|clinic|associates?))?$/i;
const ADDRESS_SEGMENT = /^\d{1,6}\s+\S+.*(blvd|boulevard|st|street|ave|avenue|rd|road|dr|drive|ln|lane|way|hwy|highway|suite|ste|tx|zip|\d{5})/i;
// A leftover prepositional phrase ("in Richmond, TX") or a bare generic noun
// ("Office in Houston, TX") describes where the site is, not who it is, so it
// must not become the lead name.
const LOCATION_ONLY = /^(in|near|at|around|located in|serving)\s+[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,4}(?:,?\s*[A-Z]{2})?\s*$/;
const GENERIC_TAIL = /^(the\s+)?(office|clinic|team|us|contact|location(s)?|page|home|store|shop|dental|medical|barber|hair|salon)(\s+(in|near|at|for|around)\s+[\w\s,'.-]{2,50})?$/i;

function stripPageLabel(seg) {
    let n = seg.trim();
    let prev;
    do {
        prev = n;
        n = n.replace(/^[–—|:\-/]+\s*/, "").replace(PAGE_LABEL, "").trim();
    } while (n && n !== prev);
    return n.replace(/[–—|:\-/]+\s*$/, "").trim();
}

export function normalizeBusinessName(raw) {
    const full = clean(raw);
    if (!full) return "";

    // Split on separators the site uses between a label and the brand. "/" is
    // deliberately excluded: "The Barber Shop Group / Quality Hair Cuts" reads
    // better whole.
    const segments = full
        .split(/\s+[–—|]\s+|\s+-\s+/)
        .map(stripPageLabel)
        .filter(Boolean);

    if (!segments.length) return "";

    const meaningful = segments.filter(s => !ADDRESS_SEGMENT.test(s) && !GENERIC_NAME.test(s));
    const winner = meaningful[0] || segments.find(s => !ADDRESS_SEGMENT.test(s)) || "";
    return LOCATION_ONLY.test(winner.trim()) || GENERIC_TAIL.test(winner.trim()) ? "" : winner.trim();
}

function chooseBusinessName(names, hostname) {
    const bad = [
        "home",
        "contact",
        "contact us",
        "about",
        "about us",
        "services",
        "book now"
    ];

    const cleaned = [];

    for (const name of names) {
        const n = normalizeBusinessName(name)
            .replace(/\s*[-|–—]\s*(Home|Official Site|Contact.*|About.*)$/i, "")
            .replace(/\s*[-|–—]\s*.*$/i, "")
            .replace(/\bHome\b/gi, "")
            .trim();

        if (!n) continue;
        if (n.length < 2 || n.length > 90) continue;
        if (bad.includes(n.toLowerCase())) continue;
        if (GENERIC_NAME.test(n)) continue;
        if (/^(403|404|401|500|error)|forbidden|access denied|permission denied|not found|blocked|unavailable/i.test(n)) continue;

        cleaned.push(n);
    }

    if (cleaned.length) {
        cleaned.sort((a, b) => {
            return businessNameScore(b, hostname) - businessNameScore(a, hostname);
        });

        return cleaned[0];
    }

    return hostname
        .split(".")[0]
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
}

function businessNameScore(name, hostname) {
    let score = 0;

    const n = name.toLowerCase();
    const h = hostname.toLowerCase().split(".")[0].replace(/[-_]/g, " ");
    const domainWords = h.split(/\s+/).filter(w => w.length > 2);

    if (n.includes(h) || h.includes(n)) score += 40;

    const matchedWords = domainWords.filter(w => n.includes(w)).length;
    score += matchedWords * 15;

    if (
        /\b(llc|inc|co|company|services|group|agency|law|plumbing|dental|cleaning|detailing)\b/i.test(name)
    ) {
        score += 20;
    }

    if (name.length <= 45) score += 10;
    if (name.length > 65) score -= 20;

    const wordCount = name.split(/\s+/).length;
    if (wordCount === 1 && matchedWords === 0 && domainWords.length >= 2) score -= 30;

    return score;
}

/*
  Checks that can be answered straight from the markup we already downloaded.
  These are deliberately literal: each one is a fact about a tag that is
  either present or not, so the sales copy can state them without guessing.
*/
function detectHtmlSignals(pages) {
    const html = (pages || []).map(p => p.html || "").join("\n");

    /*
      Counted rather than tested so the finding can quote the number: "12 of
      your 40 images have no alt attribute" is a fault the owner can reproduce
      by opening the page, and every site yields a different count. An image
      with alt="" is a deliberate decorative choice and is NOT counted as
      missing — only a tag with no alt attribute at all qualifies.
    */
    const imgTags = html.match(/<img\b[^>]*>/gi) || [];
    const imageCount = imgTags.length;
    const imagesMissingAlt = imgTags.filter(tag => !/\balt\s*=/i.test(tag)).length;

    /*
      An image that declares neither width nor height gives the markup no way
      to reserve a place for it. Counted rather than tested so the finding can
      quote the number, exactly like the alt count above. This is a fact about
      attributes only - an image sized by CSS is not detected here, and the
      finding is worded about the markup rather than about layout.
    */
    const imagesMissingDimensions = imgTags.filter(
        tag => !(/\bwidth\s*=/i.test(tag) && /\bheight\s*=/i.test(tag))
    ).length;

    /*
      Tracking tags are read straight from the markup we downloaded. A tag is
      either present in the HTML or it is not, so "no analytics installed" is a
      countable fact rather than a guess. Meta Pixel and Google Analytics are
      the two an agency pitch opens with, so each gets its own flag.
    */
    const hasFacebookPixel =
        /connect\.facebook\.net/i.test(html) ||
        /fbevents\.js/i.test(html) ||
        /\bfbq\s*\(/i.test(html);

    const hasGoogleAnalytics =
        /googletagmanager\.com\/gtag\/js/i.test(html) ||
        /google-analytics\.com/i.test(html) ||
        /\bgtag\s*\(/i.test(html) ||
        /\bga\s*\(/i.test(html) ||
        /"UA-\d/i.test(html) ||
        /"G-[A-Z0-9]{6,}"/i.test(html);

    /*
      "No page opened with an H1" is only a fact once we have actually read a
      page. With nothing fetched h1Count is 0 for the wrong reason, so the
      boolean is left null instead of claiming a heading is missing from a site
      we never opened.
    */
    const hasReadablePage = (pages || []).some(
        p => p && typeof p.html === "string" && p.html.trim().length > 0
    );
    const h1Count = (html.match(/<h1\b/gi) || []).length;

    /*
      Per-page facts, counted across the pages we actually downloaded. A page
      with no <title> ships a guessed heading in every search result for it,
      and an <html> with no lang leaves a screen reader to guess the
      pronunciation. Both are reproducible by the prospect opening their own
      page source, which is the bar every finding here has to clear.

      Both are left null when no page was read, so a record from before these
      existed is never accused of a fault we never looked for - the same rule
      missingH1 follows below.
    */
    const pageHtml = (pages || []).map(p => String((p && p.html) || ""));
    const pagesMissingTitle = hasReadablePage
        ? pageHtml.filter(chunk => {
            const m = chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            return !m || !m[1].trim();
        }).length
        : null;
    const htmlTag = html.match(/<html\b[^>]*>/i);
    const htmlLangMissing = hasReadablePage && htmlTag ? !/\slang\s*=/i.test(htmlTag[0]) : null;

    const hasViewportTag = /<meta[^>]+name=["']?viewport["']?/i.test(html);
    const hasTelLink = /<a\b[^>]*href=["']tel:/i.test(html);
    const hasSocialLink = /(?:facebook|instagram|linkedin)\.com\//i.test(html);

    /*
      Search-result and share-preview facts, read from the same downloaded markup
      as the counts above. Each is a presence test on a tag the owner can confirm
      in View Source.

      metaDescriptionLength is the raw character count (0 when the tag is absent),
      so the analyser can tell a missing description from one Google truncates.
      hasOgImage decides whether a shared link shows a picture, and imagesLazy
      counts images that opt into deferred loading. Both are left null when no
      page was read, so a record from before the measurement is never accused of
      a fault we never looked for.
    */
    const metaDescriptionContent = (() => {
        const m = html.match(/<meta[^>]+name=["']?description["']?[^>]*content=["']([^"']*)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']?description["']?/i);
        return m && m[1] ? m[1].trim() : "";
    })();
    const metaDescriptionLength = hasReadablePage ? metaDescriptionContent.length : null;
    const hasOgImage = hasReadablePage
        ? /<meta[^>]+(?:property|name)=["']?og:image["']?/i.test(html)
        : null;
    const imagesLazy = imgTags.filter(tag => /\bloading\s*=\s*["']?lazy/i.test(tag)).length;

    return {
        hasViewport: hasViewportTag,
        hasMetaDescription: Boolean(metaDescriptionContent && metaDescriptionContent.length >= 10),
        metaDescriptionLength,
        hasOgImage,
        imagesLazy,
        hasSchemaMarkup: /<script[^>]+type=["']application\/ld\+json["']/i.test(html),

        /*
          A booking flow or a review wall is very often an embedded widget, and a
          widget contributes almost no readable text. The word "book" or
          "testimonial" would be missing from the page text on a site that has a
          full Calendly scheduler or a live Google reviews feed bolted onto the
          footer, so the keyword test reported a fault that was not there.

          Reading the markup instead of the prose closes that gap: we look for
          the widget's own signature. This is still a presence test rather than
          proof the flow works, but it is presence in the HTML we actually
          downloaded, which is a real observation rather than an inference from
          missing words.
        */
        hasBookingWidget:
            /calendly|booksy|fresha|vagaro|setmore|simplybook|schedulify|acuityscheduling|square\s*booking|mindbody|zenoti|tripleseat|massagebook|bookeo|goodtime|appointlet|skedda|savvycal|jotform\s*appointment/i.test(html) ||
            /<iframe[^>]+src=["'][^"']*(book|schedul|appoint|reserve|calendar)/i.test(html) ||
            /<a[^>]+href=["'][^"']*(calendly|booksy|fresha|vagaro|setmore|simplybook|schedulify|acuityscheduling|massagebook|bookeo)/i.test(html),
        hasReviewWidget:
            /birdeye|podium\.com|grade\.us|reviews\.io|widget\.google|googlesyndication.*review|elfsight|sociablekit|reviewsfeed|okendo|shopperapproved|yotpo/i.test(html) ||
            /<iframe[^>]+src=["'][^"']*(review|testimonial|rating)/i.test(html) ||
            /* An aggregateRating in the page's own structured data puts a star
               rating in front of searchers, so the reputation is being shown
               even when no review prose was scraped. */
            /"@type"\s*:\s*"AggregateRating"/i.test(html) ||
            /"@type"\s*:\s*"Review"/i.test(html),
        hasFacebookPixel,
        hasGoogleAnalytics,
        imageCount,
        imagesMissingAlt,
        /* Alias in the same shape dashboards and exports expect, so the
           measured count is reachable under either name. */
        imagesMissingAltCount: imagesMissingAlt,
        imagesMissingDimensions,
        pagesMissingTitle,
        htmlLangMissing,
        /* Totalled across every crawled page, so 0 means literally no page on
           the site opened with an H1 — a countable markup fact. */
        h1Count,
        /* The boolean form of the above, for the AI prompt and the audit copy. */
        missingH1: hasReadablePage ? h1Count === 0 : null,

        /*
          Sales-hook booleans for the outbound pitch. Each is a fact about the
          markup we actually downloaded, and each is null when no page was read
          so a site we never opened is never accused of the fault - the same
          rule as missingH1 above.
        */
        missingPixel: hasReadablePage ? !(hasFacebookPixel || hasGoogleAnalytics) : null,
        noClickToCall: hasReadablePage ? !hasTelLink : null,
        noSocialsFound: hasReadablePage ? !hasSocialLink : null,
        missingMobileOptimization: hasReadablePage ? !hasViewportTag : null
    };
}

function detectSignals(text, linksCount, htmlSignals = {}) {
    return {
        /*
          These tests decide what we tell a sales prospect is wrong with their
          site. The two ways to be wrong are not equal: claiming a fault that
          is not there loses the deal and the trust, so the patterns aim to
          catch a genuine booking or review element before we accuse a site of
          lacking one. A bare mention of "appointment" or "reviews" in a nav
          is not a booking flow or a testimonial, so those words alone no
          longer count.

          hasBookingWidget / hasReviewWidget come from the downloaded markup
          rather than the prose, and count as the element being present. A
          scheduler or review feed is usually an embed that renders no text we
          can read, so testing the prose alone accused those sites of missing
          something they plainly had.
        */
        hasBooking:
            /book\s*(now|online|a\s+(slot|visit|consultation)|your)|book an?\s+(appointment|slot|visit)|schedule\s*(now|online|an?\s+appointment|a\s+(visit|consultation))|calendly|booksy|fresha|vagaro|square\s*booking|reserve\s*(an?\s+)?(appointment|slot|table)|request\s*(an?\s+)?appointment|appointment\s*(request|booking)/i.test(text) ||
            htmlSignals.hasBookingWidget === true,
        hasPricing:
            /pricing|price list|our prices|packages|rates|starting (at|from|price)|\$\s?\d|free (quote|estimate|consultation)|get a quote|no obligation|estimate|cost guide|service menu|view our menu|our menu\b/i.test(text),
        hasTestimonials:
            /testimonial|what our (clients|customers|patients|guests) say|kind words|client stor(y|ies)|success stor(y|ies)|read (more )?(reviews|testimonials)|see (more )?(reviews|testimonials)|leave us a review|google review|\d(\.\d)?\s*[- ]?star|rated\s*\d|\b\d{2,}\+?\s*(happy\s+)?(clients|customers|patients)\b/i.test(text) ||
            htmlSignals.hasReviewWidget === true,
        hasCTA:
            /call now|call us|call \+?\d|get (a |an )?(quote|estimate|started|quote today)|request (a |an )?(quote|estimate|appointment|consultation|quote online)|contact us|contact now|free estimate|free quote|get started|schedule now|book now|book online|order online|order now|start (your )?(order|booking)|view our (gallery|services|menu|work)|see our (gallery|services|menu|work|prices)|get directions|send (us )?a message|request info|enquir(e|ies|y)\b/i.test(text),
        hasEmail: EMAIL_RE.test(text),
        hasPhone: extractValidPhonesFromText(text).length > 0,
        likelyOldSite: /copyright\s*(©|&copy;)?\s*20(0[0-9]|1[0-8])|©\s*20(0[0-9]|1[0-8])|all rights reserved[^.]{0,40}20(0[0-9]|1[0-8])/i.test(text),
        /*
          The actual year string, not just "it is old": quoting the owner's own
          footer back at them ("your footer still shows © 2013") is a claim only
          that site can satisfy, and it is the difference between an audit that
          reads as templated and one that reads as read.
        */
        copyrightYear: (() => {
            const m = String(text).match(/(?:copyright\s*(?:©|&copy;)?|©|&copy;)\s*(20\d{2})/i);
            return m ? m[1] : "";
        })(),
        linkCount: linksCount,
        textLength: text.length
    };
}

/*
  The decision-maker's name, when a site prints it beside a role ("Owner",
  "Founder", "CEO", ...) or in a meta author tag. Deliberately strict: a name is
  only returned when two or three capitalised words sit directly next to a known
  role, because a wrong name in the opening line of a cold email is worse than no
  name at all.
*/
const OWNER_ROLE_WORDS =
    "chief executive officer|managing director|co-?founder|co-?owner|founder|owner|ceo|president|proprietor|principal|partner|director";

const OWNER_NAME_STOPWORDS = new Set([
    "the", "our", "meet", "contact", "team", "about", "us", "welcome", "your",
    "his", "her", "their", "this", "get", "call", "email", "book", "read",
    "more", "learn", "home", "page", "service", "services", "company",
    "business", "local", "best", "new", "and", "with", "for", "from", "see",
    /* Sentence fragments that read as capitalized words but are never names.
       Verified live: "Peer Groups Are" (a heading) and "I'm Jason" (first-
       person intro) were both returned as the owner of real companies. */
    "are", "is", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "not", "no", "if", "when", "where", "while", "who",
    "what", "how", "why", "all", "any", "one", "two", "next", "just", "also",
    "only", "even", "still", "back", "many", "much", "some", "such", "than",
    "then", "there", "here", "very", "most", "own", "out", "up", "down",
    "over", "under", "peer", "group", "groups", "people", "users", "customers",
    "clients", "readers", "followers", "members", "leadership", "management"
]);

/* First-person contractions are sentence openings, never surnames. */
const CONTRACTION_PART = /^(?:i['’]?m|i['’]?ve|i['’]?d|i['’]?ll|we['’]?re|we['’]?ve|you['’]?re|he['’]?s|she['’]?s|it['’]?s|they['’]?re|there['’]?s|here['’]?s|let['’]?s|don['’]?t|can['’]?t|won['’]?t|what['’]?s|that['’]?s)$/i;

function plausiblePersonName(raw) {
    const name = String(raw || "").replace(/[.,;:]+$/, "").trim();
    if (!name) return "";

    const parts = name.split(/\s+/);
    if (parts.length < 2 || parts.length > 3) return "";

    for (const part of parts) {
        if (part.length < 2 || part.length > 20) return "";
        if (CONTRACTION_PART.test(part)) return "";
        if (!/^(?:[A-Z][a-z'’.-]+|[A-Z]\.?)$/.test(part)) return "";
        if (OWNER_NAME_STOPWORDS.has(part.toLowerCase())) return "";
    }

    return name;
}

/*
  Infoboxes list several names back to back ("Founder Jason Fried Carlos Segura
  Ernest Kim") and the role regex greedily ate the first three as ONE name.
  When another capitalized word immediately follows the matched name, the name
  is part of a list - keep only its first two tokens, which is the person
  (first + last). Verified live on wikipedia.org/wiki/37signals.
*/
function trimNameList(text, index, name) {
    const parts = String(name || "").trim().split(/\s+/);
    if (parts.length < 3) return name;
    const after = String(text || "").slice(index + String(name || "").length);
    if (/^\s+[A-Z][a-z]/.test(after)) return parts.slice(0, 2).join(" ");
    return name;
}

function decodeBasicEntities(text) {
    return String(text || "")
        .replace(/&amp;/gi, "&")
        .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
        .replace(/&nbsp;/gi, " ")
        .replace(/&quot;/gi, '"');
}

function extractOwnerName(pages) {
    const rawHtml = (pages || []).map(p => p.html || "").join("\n");
    if (!rawHtml) return { name: "", role: "" };

    const authorMatch =
        rawHtml.match(/<meta[^>]+name=["']author["'][^>]*content=["']([^"']+)["']/i) ||
        rawHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']author["']/i);
    const authorName = authorMatch ? plausiblePersonName(authorMatch[1]) : "";
    if (authorName) return { name: authorName, role: "Author" };

    const text = decodeBasicEntities(
        rawHtml
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
    ).replace(/\s+/g, " ");

    const roleFirst = new RegExp(
        `\\b(${OWNER_ROLE_WORDS})\\b\\s*(?:[:\\-\\u2013\\u2014]|is|and)?\\s*([A-Z][a-z'’.-]+(?:\\s+[A-Z][a-z'’.-]+){1,2})`,
        "i"
    );
    const nameFirst = new RegExp(
        `([A-Z][a-z'’.-]+(?:\\s+[A-Z][a-z'’.-]+){1,2})\\s*[,:\\-\\u2013\\u2014]?\\s*(?:the\\s+)?(${OWNER_ROLE_WORDS})\\b`,
        "i"
    );

    const byRole = text.match(roleFirst);
    if (byRole) {
        const name = plausiblePersonName(trimNameList(text, text.indexOf(byRole[2]), byRole[2]));
        if (name) return { name, role: byRole[1] };
    }

    const byName = text.match(nameFirst);
    if (byName) {
        const name = plausiblePersonName(trimNameList(text, text.indexOf(byName[1]), byName[1]));
        if (name) return { name, role: byName[2] };
    }

    return { name: "", role: "" };
}

function hostOf(url = "") {
    try {
        return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
        return "";
    }
}

/*
  "Official" is a ranking, not a guarantee: an address on the business's own
  domain beats an otherwise identical gmail one, but both are still returned.
  The domain match is the same domain-vs-subdomain check used elsewhere, so a
  site on www. or a booking subdomain still matches its own mail.
*/
function pickOfficialEmail(emails = [], url = "") {
    if (!emails.length) return "";

    const host = hostOf(url);
    if (!host) return emails[0];

    const sameDomain = emails.find(email => {
        const domain = String(email).split("@")[1] || "";
        return domain === host || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`);
    });

    return sameDomain || emails[0];
}

export async function scrapeWebsite(url, { runAudits = true, render = true, keepPages = false, skipCache = false, guardDestinations = null, crawl = null } = {}) {
    const crawlOpts = crawlOptions(crawl);
    /*
      A deep (enrichment) crawl keeps its own cache entry: without this a
      domain already scraped shallowly by the lead pipeline would keep serving
      its 5-page result to enrichment forever, which is exactly how a company
      ends up "only showing public data".
    */
    const cachedKey = skipCache ? "" : cacheKeyForScrape(url) + (crawlOpts.includeAll ? ":deep" : "");
    if (cachedKey) {
        const cached = getCached(cachedKey);
        if (cached) {
            try {
                return { ...cached, _cached: true };
            } catch {}
        }
    }

    const pages = await fetchPages(url, { render, guard: guardDestinations, crawl: crawlOpts });

    // Nothing on the crawl carried an email, so try the contact/about/privacy
    // pages a site keeps its address on. Runs before extraction so the deep
    // pages are read by exactly the same extractor as the homepage.
    await fetchDeepContactPages(url, pages, guardDestinations, {
        force: crawlOpts.forceDeep,
        /* the deep pages share the same overall page budget as the link crawl */
        budget: Math.max(0, crawlOpts.maxPages - pages.length)
    });

    const hostname = new URL(url).hostname.replace(/^www\./, "");

    const allNames = [];
    const allEmails = [];
    const allPhones = [];
    const allAddresses = [];
    const allTexts = [];
    const titles = [];
    const descriptions = [];
    const allEmailEvidence = [];
    const allPhoneEvidence = [];
    const allLinkedinUrls = [];
    const allSocialUrls = [];
    const allFoundingYears = [];
    const allEmployeeCounts = [];

    for (const page of pages) {
        const extracted = extractFromPage(page);

        allNames.push(...extracted.names);
        allEmails.push(...extracted.emails);
        allPhones.push(...extracted.phones);
        allAddresses.push(...extracted.addresses);
        allTexts.push(extracted.text);
        allEmailEvidence.push(...extracted.emailEvidence);
        allPhoneEvidence.push(...extracted.phoneEvidence);
        allLinkedinUrls.push(...(extracted.linkedinUrls || []));
        allSocialUrls.push(...(extracted.socialUrls || []));
        allFoundingYears.push(...(extracted.foundingYears || []));
        allEmployeeCounts.push(...(extracted.employeeCounts || []));

        if (extracted.title) titles.push(extracted.title);
        if (extracted.metaDesc) descriptions.push(extracted.metaDesc);
    }

    const text = clean(allTexts.join(" ")).slice(0, 18000);

    const emails = uniq(allEmails.map(normalizeEmail))
        .filter(isGoodEmail)
        .slice(0, 10);

    const phones = uniq(allPhones.map(normalizePhone))
        .filter(Boolean)
        .slice(0, 10);

    const emailEvidence = uniqEvidence(
        allEmailEvidence
            .map(item => ({
                ...item,
                value: normalizeEmail(item.value)
            }))
            .filter(item => isGoodEmail(item.value))
    ).slice(0, 25);

    const phoneEvidence = uniqEvidence(
        allPhoneEvidence
            .map(item => ({
                ...item,
                value: normalizePhone(item.value)
            }))
            .filter(item => item.value)
    ).slice(0, 25);

    const businessName = chooseBusinessName(allNames, hostname);

    const rawLinks = allLinkedinUrls
        .map(u => abs(url, u))
        .filter(u => /linkedin\.com\/(company|in)\//i.test(u));

    const linkedinUrl = [...new Set(rawLinks)][0] || "";

    /*
      The social profiles a rep actually opens before calling. First match
      wins so a page that links a profile from every footer still yields one URL.
    */
    const socialLinks = { linkedin: linkedinUrl, facebook: "", instagram: "", twitter: "" };

    for (const raw of allSocialUrls) {
        const socialUrl = abs(url, raw);
        if (!socialLinks.facebook && /facebook\.com\//i.test(socialUrl)) socialLinks.facebook = socialUrl;
        else if (!socialLinks.instagram && /instagram\.com\//i.test(socialUrl)) socialLinks.instagram = socialUrl;
        else if (!socialLinks.twitter && /(?:^|\/\/)(?:www\.|m\.)?(?:twitter|x)\.com\//i.test(socialUrl)) socialLinks.twitter = socialUrl;
    }

    /*
      Founded year and headcount, only when the site states them (schema.org
      above, or an explicit "Founded in 1998" in the page text). An empty
      string means "not published", never a guess.
    */
    const foundedMatch = text.match(/\b(?:founded|established|established in|est\.?|incorporated)\s*(?:in|in the year)?\s*[:\-]?\s*((?:1[6-9]|20)\d{2})\b/i);
    const founded = allFoundingYears[0] || (foundedMatch ? foundedMatch[1] : "");
    const companySize = allEmployeeCounts.length ? String(Math.max(...allEmployeeCounts)) : "";

    let siteAudit;

    if (!runAudits) {
      siteAudit = {
        leaking_funnel_audit: null,
        seo_schema_audit: null,
        auditedAt: ""
      };
    } else {
      try {
        siteAudit = await runSiteAudit({ pages, baseUrl: url });
      } catch (err) {
      console.warn(`siteAudit failed for ${url}:`, err.message);
      siteAudit = {
        leaking_funnel_audit: {
          broken_internal_links: [],
          dead_social_icons: [],
          form_vulnerabilities: { has_contact_form: false, issues: ["Audit failed"] }
        },
        seo_schema_audit: {
          open_graph: {
            is_valid: false,
            found_tags: {},
            missing_tags: [],
            preview_warning: ""
          },
          schema_markup: { schema_present: false, detected_types: [], host: "" }
        },
        auditedAt: ""
      };
      }
    }

    const owner = extractOwnerName(pages);

    /*
      AEO runs here rather than inside detectHtmlSignals because it needs the
      robots.txt, which is a network read of its own (text/plain, so the HTML
      fetcher will not touch it). Best-effort: if robots.txt cannot be read the
      facts report robotsFetched=false and nothing is claimed about the crawlers.
    */
    const robotsTxt = runAudits ? await fetchRobotsTxt(url) : "";
    const aeo = analyzeAeo({ html: pages.map(p => p.html || "").join("\n"), robotsTxt });

    const officialEmail = pickOfficialEmail(emails, url);

    for (const evidence of emailEvidence) {
        if (normalizeEmail(evidence.value) === normalizeEmail(officialEmail)) {
            evidence.official = true;
            break;
        }
    }

    const result = {
        website: url,
        businessName,
        linkedinUrl,
        socialLinks,
        title: titles[0] || "",
        ownerName: owner.name,
        ownerRole: owner.role,
        description: descriptions[0] || "",
        emails,
        phones,
        primaryEmail: officialEmail || emails[0] || "",
        officialEmail,
        primaryPhone: phones[0] || "",
        emailEvidence,
        phoneEvidence,
        addresses: uniq(allAddresses).slice(0, 5),
        founded,
        companySize,
        text,
        pagesScraped: pages.map(p => p.url),
        scrapeOk: text.length >= 100 || emails.length > 0 || phones.length > 0,
        signals: { ...detectSignals(text, pages.length, detectHtmlSignals(pages)), ...detectHtmlSignals(pages), ownerName: owner.name, officialEmail, ...aeo },
        leakingFunnelAudit: siteAudit.leaking_funnel_audit,
        seoSchemaAudit: siteAudit.seo_schema_audit,
        /*
          The preview scrapes a wide pool quickly and only then audits the few
          it will actually show. Handing back the fetched HTML lets that second
          pass reuse this work instead of re-downloading every page, which is
          the difference between one slow search and a very slow one. Only
          populated when the caller opts in, since it is heavy to hold.
        */
        pages: keepPages ? pages : undefined
    };

    if (cachedKey) {
        // The fetched HTML is deliberately left out: it is by far the largest
        // part of the payload and no later caller reads it from the cache.
        const { pages: _droppedPages, ...toCache } = result;
        setCached(cachedKey, toCache);
    }

    return result;
}

/*
  Second-pass audit for a site that was already scraped with keepPages. Returns
  the same two audit fields scrapeWebsite would have produced, so callers can
  drop them straight into a lead and re-derive findings.

  A failed audit resolves to empty findings rather than throwing: a slow or
  unreachable page must not cost the visitor the whole search, and the
  signal-tier findings from the first pass are still perfectly usable.
*/
export async function auditScrapedSite(scraped) {
    const empty = {
        leaking_funnel_audit: { broken_internal_links: [], dead_social_icons: [], form_vulnerabilities: { has_contact_form: false, issues: [] } },
        seo_schema_audit: {
            open_graph: { is_valid: false, found_tags: {}, missing_tags: [], preview_warning: "" },
            schema_markup: { schema_present: false, detected_types: [], host: "" }
        }
    };

    if (!scraped?.pages?.length || !scraped.website) return empty;

    try {
        return await runSiteAudit({ pages: scraped.pages, baseUrl: scraped.website });
    } catch (err) {
        console.warn(`preview audit failed for ${scraped.website}: ${err.message}`);
        return empty;
    }
}