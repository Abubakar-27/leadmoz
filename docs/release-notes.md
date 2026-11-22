# Leadmoz — SEO / AEO / Trust work

Release notes for the phased project on `leadmoz.com` (Leadmoz), a live product
with paying users. Every phase was additive and never touched the frozen core:
auth, dashboard, API routes, billing/Paddle, scheduling, or existing behavior.

## Status

| # | Phase | Primary files | State |
| --- | --- | --- | --- |
| 0 | Baseline audit | `docs/baseline-audit.md` | done |
| 1 | Trust & copy | `public/index.html`, `public/app.html` | done (local) |
| 2 | Technical SEO | 6 public pages, `robots.txt`, `sitemap.xml` | done (local) |
| 3 | AEO + structured data | `public/index.html`, `public/llms.txt` | done (local) |
| 4 | Pricing clarity | `public/index.html` (compare table) | done (local) |
| 5 | Blog rebuild | `public/blog.html`, `data/blog.json`, `public/rss.xml` | done (local; feature itself deployed earlier) |
| 6 | Template pages | `scripts/build-pages.mjs`, `content/*.json` | done (local) |
| 7 | Trust pages | `public/{compliance,acceptable-use,affiliates}/` | done (local) |
| 8 | Perf & a11y | `public/favicon.svg`, `public/nav.css` | done (local) |
| 9 | Regression + this doc | test suites, `docs/release-notes.md` | done |

Deploy state (from earlier sessions): the **blog feature**, the **job-recovery
fixes**, and the **pricing-paragraph removal** were deployed to the server. All
Phase 3–9 work exists only in the local repo and must be uploaded (see
"Deployment" below).

## Per phase

**P0 — Baseline audit.** Read-only inventory of routes, pages, analytics, and
deployment flow recorded in `docs/baseline-audit.md`; nothing changed.

**P1 — Trust & copy.** RATING fixed to **4.0** (was 4.9) with `★★★★☆` on the
home page and dashboard banner; tour mock renamed to "RapidFlow Plumbing";
pricing marked "Sample data". No invented testimonials were added; two Roman
Urdu testimonial translations were never supplied and were left untranslated.

**P2 — Technical SEO.** Unique title/meta/canonical/OG/Twitter on the six public
pages; `noindex` on auth, checkout, app, settings, admin, and report; created
`robots.txt` and `sitemap.xml` (6 URLs). Open items: no `og:image` asset yet;
canonical host and trailing-slash policy not confirmed.

**P3 — AEO + structured data.** Definition block below the hero with the
approved wording; 8-question FAQ section built on native `<details>` (no JS);
three JSON-LD blocks in `<head>` — Organization, SoftwareApplication (four
offer tiers), FAQPage (matching the FAQ word-for-word); `public/llms.txt`.
`_inline-js-test.mjs` now skips `application/ld+json`.

**P4 — Pricing clarity.** "Compare plans" table (11 feature rows × 4 plans)
below the pricing grid using an inheritance matrix (higher tiers include lower;
Agency adds lead-status tracking). Prices are intentionally left out of the
table so the billing/currency toggles cannot drift. Note: the unused
`periodPrice()` helper disagrees with the Agency 6-month `data-6month` on the
home page ($535 calc vs $534 markup) — not fixed, flagged for the owner.

**P5 — Blog rebuild.** The blog feature (routes, admin, editor) was deployed in
an earlier session. This phase rebuilt content on the existing JSON store with
**no new dependencies and no server changes**: `public/blog.html` gained an
escape-first Markdown-lite renderer, per-slug SEO-head injection, BlogPosting +
FAQPage JSON-LD, an RSS link, and `<noscript>` fallback H1. Content:
`docs/content-pack/post-1.md` (Apollo alternatives) ingested into
`data/blog.json`, `public/rss.xml`, and added to `public/sitemap.xml`.
Consequence of the frozen store: per-post title/canonical/JSON-LD are injected
client-side, so they are present after JS executes rather than in raw HTML.

**P6 — Template pages.** Plain-Node generator `scripts/build-pages.mjs` (no
deps) emits `/compare/<slug>/` and `/leads/<niche>/<city>/` from
`content/compare.json` and `content/leads.json`. Pages are `index` only when
`status:"published"` **and** every required field is present; otherwise
`noindex, nofollow` with a visible Draft banner. Shipped examples are drafts.
Generator keeps sitemap as a manual step; run with `npm run build:pages`.

**P7 — Trust pages.** `/compliance`, `/acceptable-use`, `/affiliates` created as
directory-index pages served by the existing `express.static` mount — **no
server change**. All three carry `noindex, follow`, a visible "In review"
callout, and a `NEEDS LEGAL REVIEW` comment until counsel signs off. Content is
cross-referenced exclusively to the existing Terms/Privacy (data sources,
no review-text storage, user SMTP, exact-count and area rules, CAN-SPAM/GDPR/
PECR obligations). Affiliate commission terms are left as an operator TODO.
Footer links added on home, app, settings, and admin pages; the home FAQ answer
now points at `/compliance` (visible text and FAQPage JSON-LD stay identical).

**P8 — Perf & a11y.** `public/favicon.svg` (brand-gradient spark) replaced a
`/favicon.png` 404 on all 18 pages; "Skip to content" links on home, blog, and
template pages with focus styles in `nav.css`; `decoding="async"` on lazy blog
images. Testimonials avatars remain broken (needs operator-supplied photos).

**P9 — Regression.** Full suite run locally — all green (see below), and this
document written.

## Regression run (local, all passing)

- 24 unit suites (`tests/*.test.mjs`) — exit 0 each (blog, jobRecovery,
  legalPages 23, locationCityGate 14, leadQualityGate 10, rejectionTrace 9,
  candidateMerge 7/7, areaTargetCount 8, areaTargetCount, etc.).
- `_regression.mjs` — 24 passed, 0 failed.
- `_runtime-smoke-test.mjs` — sandboxed module-graph boot: 64 passed, 0 failed.
- `_inline-js-test.mjs` — 27 script blocks, 0 broken.
- `_legal-pages-test.mjs` — 99 passed, 0 failed.
- `_a11y-perf-test.mjs` — 19 passed, 0 failed.
- Phase 6 page validator — 3 generated pages valid, drafts correctly `noindex`;
  a complete `published` page flips to `index, follow` (end-to-end toggle test).
- Static-serve smoke (Express + `express.static`) — `/compliance`,
  `/acceptable-use`, `/affiliates`, `/compare/...`, `/leads/...`,
  `/favicon.svg` all 200 with expected content.
- JSON-LD: Organization + SoftwareApplication + FAQPage all parse; FAQ has 8
  Q&As with the cold-outreach answer matching its JSON-LD text.
- Home FAQ answer links to `/compliance`; skip-link targets exist; `favicon.svg`
  served as the icon on 18/18 pages.

## Known issues / blocked

- **Paddle end-to-end**: inert without a sandbox client token, test URL, and
  `PADDLE_WEBHOOK_SECRET`.
- **Two blog posts pending** (`/blog/how-to-find-web-design-clients/`,
  `/blog/cold-email-templates-for-web-designers/`) — links in the Apollo post
  return "Article not found" until those posts exist.
- **Broken images**: `/avatars/av-daniel.jpg`, `av-ayesha.jpg`, `av-emily.jpg`,
  `/ijlal.jpeg` and `apple-touch-icon` need real assets supplied by the owner.
- **og:image** missing site-wide (TODO on every page).
- **RSS / sitemap are static snapshots** — they must be updated when posts or
  pages are added (or a small `build-blog` generator added if wanted).
- **Trust pages** stay `noindex` until the legal-review banner is removed.
- Canonical constant is `https://leadmoz.com` (non-www); trailing-slash policy
  for `/compliance` vs `/compliance/` not decided.

## Deployment

All Phase 3–9 work touched only `public/`, `scripts/`, `content/`, `data/`,
`docs/` and test files — **no `src/*.js` changes and no server restart
required**: HTML routes are served fresh from disk every request (a no-cache
header middleware, not a cache). Real-point files:

- `public/` — `index.html`, `blog.html`, `app.html`, `settings.html`, `admin.html`,
  `terms/privacy/refund.html`, `auth/checkout/404.html`, `nav.js`, `nav.css`,
  `robots.txt`, `sitemap.xml`, `rss.xml`, `llms.txt`, `favicon.svg`,
  `compliance/`, `acceptable-use/`, `affiliates/`, `compare/`, `leads/`
- `scripts/`, `content/`, `data/blog.json`

Upload with the usual deploy protocol (scp → md5-compare → done; no PM2
restart needed for static-only diffs).