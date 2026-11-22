# Company & Contact Enrichment — complete roadmap

Status of every part of the spec, what is live today, and what comes next.
Setup instructions live in [enrichment-setup.md](./enrichment-setup.md).

## 0. What "whole information" means, honestly

One enrichment reads a company **whole from its own published site**: up to
`ENRICHMENT_CRAWL_MAX_PAGES` pages (default 12) on the submitted domain —
homepage, contact/about/team/services/product/legal pages — plus Hunter.io when
a key is configured. Everything the company states is kept: name, description,
industry, addresses, phones, founding year, headcount, social profiles, every
published email, decision-makers named on team/leadership pages, and the source
page behind each field.

The data is public because the spec (and the law) require it: we do not bypass
logins, CAPTCHAs, anti-bot walls or platform terms, and we never invent a
contact or guess an email. Fields a company does not publish stay **empty and
labelled not-found**, and a stage that finds nothing refunds its credits.
Non-public or cross-referenced data (company registries, licensed contact
databases) only comes from optional external providers — see Roadmap R2/R3.

## 1. Built and verified (Phases 1–5 of the spec)

| Spec area | Status | Where |
|---|---|---|
| Dashboard section + nav, locked preview for non-buyers | ✅ | `public/app.html`, `public/nav.js` |
| Tiered add-on billing: Starter $10 / Pro $20 / $30 Agency, own Paddle price id per tier, separate checkout line item, combined total | ✅ | `src/enrichmentConfig.js`, `src/paddle.js`, `public/checkout.html` |
| Entitlement only from confirmed payment / admin grant; idempotent webhooks; paid-through cancellation | ✅ | `src/paddle.js`, `src/enrichmentStore.js` |
| Server-side access control on every route (401/402/503) | ✅ | `src/enrichmentRoutes.js` (`assertCanUseEnrichment`) |
| Separate enrichment credit ledger: per-tier allowance 50/100/200, per-stage costs 1/2/3, refunds, idempotency keys, no overspend, cache reads free | ✅ | `src/enrichmentStore.js`, `src/enrichment.js` |
| Stage A domain input: single, batch, CSV import (200 rows), import from existing leads, normalize + dedupe | ✅ | `src/enrichmentRoutes.js`, `src/enrichmentSafety.js` |
| Stage B company profile — **whole-site crawl** (12 pages default, contact/legal forced, deep cache key `scrape:<domain>:deep`) | ✅ | `src/scrape.js` (`crawl:{maxPages,includeAll,forceDeep}`), `src/enrichmentProviders.js` |
| Stage C decision-makers (site team/leadership pages + Hunter), explicit "not found" | ✅ | `src/enrichment.js` |
| Stage D professional profiles: public LinkedIn/X URL from readable pages **or** from person-level web search once the person is named (LinkedIn itself never fetched) | ✅ | `src/enrichmentProviders.js`, `src/enrichmentResearch.js` (`researchPersonByName`) |
| Stage E email discovery: site mailto/text → Hunter domain search (once per company), statuses verified/likely/unverified/invalid/not-found | ✅ | `src/enrichmentProviders.js` |
| Stage F results: unified table, search/filter, detail view, retry failed stages, CSV export | ✅ | `public/app.html` |
| Background jobs: in-process queue, per-provider rate caps, partial success, restart recovery | ✅ | `src/enrichment.js` |
| SSRF: DNS pre-check + re-check on every redirect hop, private/metadata ranges blocked | ✅ | `src/enrichmentSafety.js` |
| Admin dashboard section: grant/revoke, adjust credits, provider usage & disable, recover jobs | ✅ | `public/admin.html`, `/api/enrichment/admin/*` |
| Analytics events (server-side + 2 client beacons) | ✅ | `src/enrichment.js`, `public/app.html` |
| Docs: env vars, setup, lifecycle, limitations | ✅ | `.env.example`, `docs/enrichment-setup.md` |
| Tests: gate, webhook idempotency, credits/concurrency, SSRF, crawl shape, person research, no-key fallback, CSV, existing features untouched | ✅ | `tests/enrichment*.test.mjs` — **29/29 files pass** |

## 2. Required before launch (manual, outside the repo)

1. Create three Paddle subscription prices ($10/$20/$30) and put their ids in
   `.env`: `PADDLE_ENRICHMENT_PRICE_STARTER/_PRO/_AGENCY`.
   Without them the feature answers 503 (safe default) — or set
   `ENRICHMENT_ENABLED=true` to sell via bank transfer + admin grant only.
2. Optional: `HUNTER_API_KEY` (domain search / verification). The website
   stages work fully without it.
3. Deploy the changed files to the VPS and restart pm2.

## 3. Roadmap — not built, in priority order

### R1 — Company-name → domain discovery (Stage A gap)
Customers type domains today. Next: resolve a company name to a domain via
the existing lead-search scrapers + a free search tier, so users can submit
"Acme Corp" directly. Reuses `src/scrape.js`; ~0 credits when resolved from
existing lead records.

### R2 — Registry data for founders/directors
Official company registries / OpenCorporates would add directors and officers
that never appear on a website. **Blocked on a license review**: verify API
access, attribution and commercial-redistribution terms before integrating;
free personal access does not authorize SaaS use.

### R2b — Web-search owner research (`web_research`) — BUILT
When a company's own site + Hunter name nobody, the add-on now searches the
public web (`"Company" founder owner CEO` via the EXISTING Tavily/Firecrawl
keys the lead search already uses) and reads the top result pages with the
same SSRF-guarded scraper. LinkedIn/Facebook/Instagram/X are never fetched —
a matching public profile URL from results is recorded instead. A person only
counts when the page names the company; only company-domain emails from
those pages are kept. Labelled `source: web` with a source URL, low
certainty, capped per company and daily (`ENRICHMENT_WEB_SEARCH_*`).

### R2c — Person-level research (LinkedIn-first) — BUILT
Once a decision-maker is **named**, a second search targets *that person*:
`"Name" "Company" founder owner CEO` + `"Name" "Company" LinkedIn profile`.
Their LinkedIn/X profile URL is taken from the search result (name-slug
matched, never fetched), top result pages re-confirm person + company
(medium confidence upgrade), and company-domain emails published on those
pages feed the email stage. Title extraction refuses junk: page chrome, the
network's own name, and bare company names are never a job title. Max 3
people per company, results shared with the email stage from cache.
Live-verified: Jason Fried @ Basecamp got `linkedin.com/in/jason-fried` with a
confirmed source page; a small-business owner (Randy Gitli @ Aladdin
Plumbing) was found by name search alone, LinkedIn never fetched.

### R3 — Second email/contact provider
Hunter's free tier (20 calls/day capped by default) limits coverage. Evaluate
Snov.io / Apollo free allowances and terms; the provider abstraction
(`enrichmentProviders.js`) is built so adding one is configuration + one file,
no workflow rewrite. Email **verification** statuses beyond Hunter's also land
here.

### R4 — Cost & coverage telemetry dashboard
Provider cost per job and success rates are recorded
(`/api/enrichment/admin/summary`); next step is a charted view in the admin
dashboard to decide when to raise `ENRICHMENT_MONTHLY_CREDITS_*`.

### R5 — Multi-process queue & ledger locking
Jobs and the credit ledger assume a single Node process (documented
limitation). Needed only if the VPS ever runs more than one worker.

### Deliberately out of scope
- No LinkedIn Sales Navigator integration, no authenticated/bypass scraping.
- No new payment provider; no changes to base plan prices or lead credits.
- Future add-on tiers (Enrichment Pro/Agency at other prices) are NOT launched
  — the current model is one add-on whose price/allowance follows the base plan
  tier, all configurable via env vars.
