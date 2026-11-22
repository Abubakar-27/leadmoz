/*
  Public free preview for signed-out visitors.

  Hard rules for this pipeline, because it runs without authentication:
    - no AI providers, so it never spends the shared Gemini/Groq quota
    - no site audits, so it never probes a prospect's server with extra requests
    - no headless browser, so one request cannot launch Chromium repeatedly
    - the response is assembled field by field from a whitelist, so a business
      name, domain, email or phone number cannot reach an anonymous visitor
*/

import { searchPublicWeb, isMarketplaceHost, hasNonLocalTitle } from "./search.js";
import { searchOsmPlaces } from "./apis/osm.js";
import { scrapeWebsite, auditScrapedSite } from "./scrape.js";
import { detectNonBusinessSite } from "./advancedVerifier.js";
import { weaknessesForPreview, categoryLabel } from "./weaknesses.js";

/*
  OpenStreetMap is a free public source, so it is allowed here under the same
  hard rules as the web engines: no AI, no browser, no extra probes. It matters
  most for exactly the markets the public form is likely to try first - a
  scraped Bing returns mostly directory pages for a non-Western city, while OSM
  carries the real single-business websites, which is why the preview used to
  show one lead for "restaurants, Pakistan" while a paid job for the same query
  saved fifteen.
*/
function osmPreviewEnabled() {
    return String(process.env.OSM_ENABLED || "false") === "true";
}

const PREVIEW_COUNT = 3;
const SEARCH_TARGET = 14;
/*
  We deliberately look at more sites than we show. Sites in one niche often
  share the same single fault, so three cards taken from the first three hits
  all say the same thing. Scanning a few extra lets us pick three that make
  three different points, and the budget check below stops us going overboard.
*/
const MAX_SCRAPES = 9;
const HARD_BUDGET_MS = 90 * 1000;
const SCRAPE_BUDGET_MS = 45 * 1000;

/*
  Paid users get the full audit tier, and the brief is that a signed-out visitor
  should see the same depth. That is worth doing, but only for the cards we
  actually show, so the cost stays at three audits per search rather than nine.

  The second pass still needs room to finish, and a visitor who has already
  waited through the search is the worst place to discover a spinner that keeps
  going. Below this much headroom we skip the audit and ship the signal-tier
  findings we already have, which is slower to explain but faster to show.
*/
const AUDIT_TOP_LEADS = true;
const AUDIT_MIN_BUDGET_MS = 20 * 1000;

/*
  How many apparently-clean sites we are willing to audit before giving up on a
  city, and the hard ceiling on how many sites one audit pass may touch.

  A site that passes the single-pass signal checks is not necessarily healthy,
  so auditing a few of them is the difference between "we found a real fault"
  and "we found nothing we could prove". Both numbers are kept small because
  each audit is a batch of real HTTP requests against a stranger's server, and
  this runs on anonymous traffic.
*/
const CLEAN_AUDIT_POOL = 6;
const AUDIT_POOL_MAX = 9;
/*
  A browser tab is not a batch job. The background pipeline can spend 90s
  searching, but somebody who just typed "barber / austin" is looking at a
  spinner, so searching is capped hard and any shortfall is made up for with
  concurrent page loads instead of more waiting.
*/
const SEARCH_BUDGET_MS = 22 * 1000;
/* Slack for an in-flight engine call that overshoots its own deadline. */
const SEARCH_GRACE_MS = 8 * 1000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const cache = new Map();

const ALLOWED_CHARS = /[^a-z0-9 ,.'&()-]/gi;

export function sanitizePreviewInput(value = "", maxLength = 60) {
    const cleaned = String(value || "")
        .replace(/[<>{}[\]\\/]/g, " ")
        .replace(ALLOWED_CHARS, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);

    return cleaned;
}

export function normalizePreviewInput(niche, location) {
    const cleanNiche = sanitizePreviewInput(niche, 50);
    const cleanLocation = sanitizePreviewInput(location, 50);

    if (cleanNiche.length < 2 || cleanLocation.length < 1) return null;

    return {
        niche: cleanNiche,
        location: cleanLocation,
        key: `${cleanNiche.toLowerCase()}|${cleanLocation.toLowerCase()}`
    };
}

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;

    if (Date.now() - hit.at > CACHE_TTL_MS) {
        cache.delete(key);
        return null;
    }

    return hit.value;
}

function cacheSet(key, value) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), value });
}

function hostOf(url = "") {
    try {
        return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
        return "";
    }
}

/*
  Only fields a signed-out visitor is allowed to see. The city is deliberately
  left out because the visitor typed it into the form anyway. Returns every
  finding rather than just the top one, so the caller can give each card a
  different angle.
*/
export function toPreviewCandidate(scraped, niche) {
    const findings = weaknessesForPreview({ ...scraped, rawSignals: scraped.signals, niche });
    if (findings.length === 0) return null;

    /*
      No identity leaves this module. The business name, contacts and domain stay
      on the scrape object, which never reaches a response: the label is the
      category alone and assignDistinctFindings copies across only the label and
      the three finding strings. Unlocking a real name or contact on the landing
      page was tried and pulled, so this stays a single choke point rather than
      something the response layer has to remember to strip.
    */
    return {
        label: `A ${categoryLabel(niche)}`,
        findings,
        scraped
    };
}

function shapeFinding(finding) {
    return {
        label: String(finding.label || "").slice(0, 120),
        detail: String(finding.detail || "").slice(0, 300),
        hook: String(finding.hook || "").slice(0, 300),
        /* Carried so the preview can separate "we found a fault" from "this
           site could add something". See the ranking note in weaknesses.js. */
        kind: String(finding.class || "").slice(0, 20),
        verified: finding.evidence === "verified"
    };
}

/*
  Three cards all reading "No online booking" looks broken and wastes most of
  what we found. Each business has its own full list, so hand every card the
  best finding nobody else is already showing.

  Cards that got a finding of their own come back first and the repeats are
  appended, so the caller can take the first three and be sure they are three
  different points whenever the pool contained three different problems. A
  repeat is still truthful for its own business; it is simply never used while
  a fresher angle is available.
*/
export function assignDistinctFindings(candidates) {
    const used = new Set();
    const distinct = [];
    const repeats = [];

    for (const candidate of candidates) {
        const fresh = candidate.findings.find(f => !used.has(f.id));
        const chosen = fresh || candidate.findings[0];
        if (!chosen) continue;

        used.add(chosen.id);

        const row = { label: candidate.label, weakness: shapeFinding(chosen), scraped: candidate.scraped };
        if (fresh) distinct.push(row);
        else repeats.push(row);
    }

    return [...distinct, ...repeats];
}

/*
  Circuit breaker for the shared search provider. Three useless runs in a row
  means the provider is refusing us, not that the user's keywords were bad, so
  we stop searching for a few minutes instead of making every visitor pay for
  the same failure.
*/
const BREAKER_FAILURES = 3;
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;
let breaker = { failures: 0, until: 0 };

export function breakerOpen() {
    return Date.now() < breaker.until;
}

export function breakerTrip() {
    breaker.failures += 1;

    if (breaker.failures >= BREAKER_FAILURES) {
        breaker.until = Date.now() + BREAKER_COOLDOWN_MS;
        breaker.failures = 0;
    }
}

export function breakerReset() {
    breaker = { failures: 0, until: 0 };
}

export async function runPreview({ niche, location } = {}) {
    const input = normalizePreviewInput(niche, location);
    if (!input) {
        return { ok: false, error: "Enter a business type and a city or region." };
    }

    const cached = cacheGet(input.key);
    if (cached) return { ...cached, cached: true };

    /*
      Circuit breaker. Our search capacity is shared and finite, and a public
      form will always have someone hammering it. When the provider starts
      refusing, retrying per visitor turns a throttle into an outage, so a run
      of empty searches pauses the endpoint for everyone and says so honestly
      instead of making every visitor wait for a search that will also fail.
    */
    if (breakerOpen()) {
        return {
            ok: false,
            busy: true,
            error: "Our search is busy at the moment. Please try again in a few minutes."
        };
    }

    const startedAt = Date.now();
    const hardDeadline = startedAt + HARD_BUDGET_MS;

    /*
      Both sources are raced against the same budget and settled together, the
      same way a real job settles them (worker.js runs searchPublicWeb and
      searchOsmPlaces in parallel). Racing each on its own means a slow OSM
      mirror cannot hold the page past the budget, and a failed web engine no
      longer empties the result when OSM still has real businesses to show.
    */
    const budgetMs = SEARCH_BUDGET_MS + SEARCH_GRACE_MS;

    const [webSearch, osmSearch] = await Promise.all([
        Promise.race([
            searchPublicWeb({
                niche: input.niche,
                location: input.location,
                targetCount: SEARCH_TARGET,
                passOffset: 0,
                deadlineMs: SEARCH_BUDGET_MS
            }),
            sleep(budgetMs).then(() => null)
        ]),
        osmPreviewEnabled()
            ? Promise.race([
                searchOsmPlaces({
                    niche: input.niche,
                    location: input.location,
                    targetCount: SEARCH_TARGET
                }),
                sleep(budgetMs).then(() => null)
            ])
            : Promise.resolve(null)
    ]);

    const webResults = (webSearch && webSearch.results) || [];
    const osmResults = (osmSearch && osmSearch.results) || [];
    /* OSM first so a business that appears in both sources keeps its resolved
       locality and phone, which the web row usually lacks. The URL builder
       below de-duplicates by host, so a domain listed twice is still one site. */
    const rawResults = [...osmResults, ...webResults];

    if (rawResults.length === 0) {
        breakerTrip();
        return {
            ok: false,
            busy: true,
            error: "Our search is busy at the moment. Please try again in a few minutes."
        };
    }

    /*
      The scraping window is measured from the moment searching finished, not
      from the start of the request. Sharing one budget across both meant a slow
      search left nothing to open any page with, and we then told the visitor
      their city was the problem when ours was the slow part.
    */
    const deadline = Math.min(Date.now() + SCRAPE_BUDGET_MS, hardDeadline);
    const outOfTime = () => Date.now() > deadline;
    const elapsed = () => Date.now() - startedAt;

    const urls = [];
    const seenHosts = new Set();

    for (const item of rawResults) {
        const url = item.url || item.website || "";
        const host = hostOf(url);

        if (!host || seenHosts.has(host)) continue;
        if (isMarketplaceHost(host)) continue;
        if (hasNonLocalTitle(item.title || "")) continue;

        seenHosts.add(host);
        urls.push({ url, title: item.title || "" });

        if (urls.length >= MAX_SCRAPES) break;
    }

    const withFindings = [];
    let clean = 0;
    /*
      Sites that passed the first-pass signal checks but have not yet been
      audited. Kept so the audit pass can decide whether they really are clean,
      rather than us asserting it from a single read of the markup.
    */
    const cleanCandidates = [];
    const covered = new Set();
    let scanned = 0;
    let rejected = 0;

    /*
      Fetched in small batches rather than one at a time. Nine sequential
      page loads cannot fit in any budget a person will wait through, but nine
      in three batches of three comfortably can, which is the difference
      between showing three leads and showing an error.
    */
    const SCRAPE_CONCURRENCY = 3;

    for (let i = 0; i < urls.length; i += SCRAPE_CONCURRENCY) {
        if (outOfTime()) break;

        const batch = urls.slice(i, i + SCRAPE_CONCURRENCY);
        const settled = await Promise.all(
            batch.map(async candidate => {
                try {
                    /*
                      keepPages holds onto the HTML so the second pass can audit
                      these sites without downloading them all a second time.
                    */
                    return { candidate, scraped: await scrapeWebsite(candidate.url, { runAudits: false, render: false, keepPages: true }) };
                } catch {
                    return { candidate, scraped: null };
                }
            })
        );

        for (const { scraped } of settled) {
            scanned += 1;

            if (!scraped || !scraped.scrapeOk) {
                rejected += 1;
                continue;
            }

            const verdict = detectNonBusinessSite(scraped, { niche: input.niche, location: input.location });
            if (verdict.hardReject) {
                rejected += 1;
                continue;
            }

            const previewCandidate = toPreviewCandidate(scraped, input.niche);
            if (!previewCandidate) {
                rejected += 1;
                continue;
            }

            // A site with nothing wrong cannot sell the product, so it is never
            // shown to an anonymous visitor. Padding the row with one would
            // undercut the promise the page makes: "the specific weakness we
            // found on their site". A short row is honest; a clean card is not.
            //
            // Held rather than discarded. "Nothing wrong at the signal tier"
            // only means nothing wrong with the markup we could read from one
            // pass: a dead internal link or a contact form that submits nowhere
            // is invisible until the audit pass makes HTTP requests. Counting
            // these sites as clean before that audit has run is how a search
            // ended up reporting "nothing we could prove" about seven sites
            // while the one thing that would have proved something sat
            // unaudited in the discarded pile.
            const topId = previewCandidate.findings[0].id;
            if (topId === "no_defects_found") {
                clean += 1;
                if (cleanCandidates.length < CLEAN_AUDIT_POOL) {
                    cleanCandidates.push(previewCandidate);
                }
                continue;
            }

            if (covered.has(topId) && withFindings.length >= PREVIEW_COUNT) continue;

            covered.add(topId);
            withFindings.push(previewCandidate);
        }
    }

    let leads = assignDistinctFindings(withFindings).slice(0, PREVIEW_COUNT);

    /*
      Second pass. Only the handful of businesses that will actually be shown
      get audited, never the whole candidate pool.

      This is the expensive part of a search: each audit chases down to ten
      extra pages to find dead links and dead social buttons. Running it across
      all nine candidates would roughly triple the wait and would often push a
      search past the point where a visitor closes the tab, so we pay for the
      three we chose and nothing else. Reusing the HTML from the first pass
      means this costs the extra requests only, not a second full crawl.

      Findings are then re-derived so an audit result can replace a weaker
      signal-tier angle, and distinctness is re-applied because the audit may
      have handed two cards the same problem. A failed or slow audit leaves the
      first-pass findings exactly as they were, so this can only add detail.

      The pool is the cards we intend to show *plus* the sites that looked clean
      on signals alone, and it is deliberately not gated on having any leads
      already. That gate used to sit here, and it made the audit unreachable in
      exactly the case it matters most: a search where every site passed the
      first pass had nothing to show, skipped the audit, and told the visitor no
      site had a provable weakness without ever asking the HTTP side.
    */
    const auditPool = [...leads, ...cleanCandidates].filter(row => row.scraped?.pages?.length).slice(0, AUDIT_POOL_MAX);

    if (AUDIT_TOP_LEADS && auditPool.length > 0) {
        const auditBudget = outOfTime() ? 0 : Math.max(0, HARD_BUDGET_MS - elapsed());

        if (auditBudget > AUDIT_MIN_BUDGET_MS) {
            const audited = await Promise.all(
                auditPool.map(async row => {
                    try {
                        const siteAudit = await auditScrapedSite(row.scraped);
                        const findings = weaknessesForPreview({
                            ...row.scraped,
                            rawSignals: row.scraped.signals,
                            niche: input.niche,
                            leakingFunnelAudit: siteAudit?.leaking_funnel_audit ?? null,
                            seoSchemaAudit: siteAudit?.seo_schema_audit ?? null
                        });
                        if (findings.length === 0) return row;
                        return { label: row.label, findings, scraped: row.scraped };
                    } catch {
                        return row;
                    }
                })
            );

            /*
              Only rows that now lead with a real defect are eligible for the
              row we show. An audited row whose best finding is still a guess is
              dropped again here, so paying for the audit can never let a
              keyword inference back onto a card as though the HTTP pass had
              confirmed it.
            */
            const showable = audited.filter(row => row.findings[0]?.class !== "clear");
            const promoted = showable.filter(row => row.findings[0]?.class === "defect");

            leads = assignDistinctFindings([...showable, ...withFindings]).slice(0, PREVIEW_COUNT);

            /*
              A site counted as clean above is only truly clean if the audit
              agreed. Crediting it back lets the honest "we could not find
              something we could prove" message report a number that reflects
              what was actually checked, instead of counting sites we then
              quietly went on to audit.
            */
            clean = Math.max(0, clean - promoted.length);
        }
    }

    if (leads.length < PREVIEW_COUNT) {
        rejected += Math.max(0, SEARCH_TARGET - scanned - leads.length);
    }

    if (leads.length === 0) {
        /*
          Running out of time is our problem, not a sign the city has no
          businesses in it. Saying "we could not verify any" after a timeout
          would be inventing a conclusion out of a slow request, so we say
          what actually happened and let the visitor retry.
        */
        if (outOfTime() && scanned < PREVIEW_COUNT) {
            breakerTrip();
            return {
                ok: false,
                busy: true,
                error: "That search took too long to finish. Please try again in a moment."
            };
        }

        /*
          Two very different situations end up here, and telling a visitor the
          wrong one costs their trust. If we opened sites and they were all
          healthy, that is a real answer about the city, and the breaker should
          not fire for it. If we never got a usable site at all, the provider
          handed back a poor page, which does count towards the breaker.
        */
        if (clean > 0) {
            return {
                ok: false,
                error: `We checked ${clean} ${categoryLabel(input.niche).toLowerCase()} sites in ${input.location} and could not find a weakness we could prove, so we are not going to invent one. Try a nearby city or a broader service term.`,
                niche: input.niche,
                location: input.location
            };
        }

        breakerTrip();

        return {
            ok: false,
            error: `We could not verify 3 open ${categoryLabel(input.niche).toLowerCase()} businesses in ${input.location} right now. Try a nearby city or a broader service term.`,
            niche: input.niche,
            location: input.location
        };
    }

    breakerReset();

    /*
      The cards still carry the scrape they were built from, which is how the
      audit pass got at it. That object holds the business name, the contacts
      and the full page HTML, so it is dropped here, once, on the way into the
      cached value.

      This is the only place the internal card stops being internal, and it
      matters: what goes into cacheSet is what every later visitor is served, so
      anything left attached here is sitting in memory for six hours waiting for
      a serialiser to change its mind.
    */
    const publicLeads = leads.map(lead => ({
        label: lead.label,
        weakness: lead.weakness
    }));

    const value = {
        ok: true,
        niche: input.niche,
        location: input.location,
        label: categoryLabel(input.niche),
        leads: publicLeads,
        stats: {
            candidatesFound: rawResults.length,
            sitesScanned: scanned,
            filteredOut: rejected,
            seconds: Math.round((Date.now() - startedAt) / 100) / 10
        }
    };

    cacheSet(input.key, value);

    return { ...value, cached: false };
}

/*
  Per-IP allowance. In-memory on purpose: it resets on restart, which is
  acceptable for an abuse brake and avoids adding a dependency.
*/
const quota = new Map();
const QUOTA_WINDOW_MS = 60 * 60 * 1000;
const QUOTA_MAX = 5;
export const PREVIEW_HOURLY_LIMIT = QUOTA_MAX;

/*
  Lets the HTTP layer answer from cache without spending the visitor's
  allowance, and without paying for a second trip through runPreview.
*/
export function previewCachePeek(niche, location) {
    const input = normalizePreviewInput(niche, location);
    if (!input) return null;
    return cacheGet(input.key);
}

export function consumePreviewQuota(ip = "unknown") {
    const now = Date.now();
    const entry = quota.get(ip);

    if (!entry || now - entry.start > QUOTA_WINDOW_MS) {
        quota.set(ip, { start: now, count: 1 });
        return { allowed: true, remaining: QUOTA_MAX - 1 };
    }

    if (entry.count >= QUOTA_MAX) {
        const retryInMinutes = Math.max(1, Math.ceil((QUOTA_WINDOW_MS - (now - entry.start)) / 60000));
        return { allowed: false, retryInMinutes };
    }

    entry.count += 1;
    return { allowed: true, remaining: QUOTA_MAX - entry.count };
}

export function previewQuotaRemaining(ip = "unknown") {
    const entry = quota.get(ip);
    if (!entry) return QUOTA_MAX;
    if (Date.now() - entry.start > QUOTA_WINDOW_MS) return QUOTA_MAX;
    return Math.max(0, QUOTA_MAX - entry.count);
}

/*
  Warm-up for the queries a first-time visitor is most likely to type.

  Searching costs roughly 25 seconds because the one search source we can rely
  on is slow to answer, and a stranger will not sit through that behind a
  spinner. These are the obvious demo searches for a handful of verticals, so
  we build them ahead of time and the visitor gets an instant, cached answer.
  Anything outside this list is still searched live, just more slowly.
*/
const WARM_PAIRS = [
    { niche: "barber", location: "austin" },
    { niche: "plumber", location: "phoenix" },
    { niche: "dentist", location: "chicago" },
    { niche: "restaurant", location: "miami" },
    { niche: "salon", location: "portland" },
    { niche: "landscaper", location: "denver" },
    { niche: "electrician", location: "atlanta" },
    { niche: "florist", location: "seattle" }
];

const WARM_GAP_MS = 8 * 1000;
let warming = false;

export async function warmPreviewCache({ pairs = WARM_PAIRS, gapMs = WARM_GAP_MS } = {}) {
    // Only one pass at a time, however many times this gets called.
    if (warming) return { skipped: "already running" };
    warming = true;

    const summary = { warmed: 0, failed: 0, skipped: 0 };

    try {
        for (const pair of pairs) {
            // Respect the breaker rather than joining a provider that is
            // already refusing us and burning the one search quota we have.
            if (breakerOpen()) {
                summary.skipped += 1;
                continue;
            }

            try {
                const result = await runPreview(pair);
                if (result.ok) summary.warmed += 1;
                else summary.failed += 1;
            } catch {
                summary.failed += 1;
            }

            await sleep(gapMs);
        }
    } finally {
        warming = false;
    }

    return summary;
}
