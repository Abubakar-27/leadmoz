# Leadmoz

**Local lead generation with evidence-backed outreach.**

[Leadmoz](https://leadmoz.com) turns a niche and a city — say "plumbers, Dallas" — into a shortlist of real local businesses, checks their websites for measurable problems, and writes a personalized email, LinkedIn DM, and call opener for each one. Every finding retains the raw evidence that produced it, so a claim can be verified rather than trusted.

## What it does

- **Discovery** — finds businesses by niche + location using public web search and OpenStreetMap (Overpass / Nominatim). Businesses with no website are kept as leads too.
- **Website audit** — visits each site with Playwright and records measurable facts: viewport tag, meta description, image `alt` attributes, H1 count, outbound/broken links, embedded booking widgets, and more.
- **Honest findings** — only claims what was actually measured. If nothing is measurably wrong, it says so instead of inventing a problem.
- **Outreach** — AI (Gemini / Groq) scores priority and writes three variants grounded in the specific finding. If the model is unavailable, a deterministic template built from the same evidence is used, so a lead never ships with empty copy.
- **Product plumbing** — accounts, free credits, Paddle billing, CSV export, enrichment, referrals, and a 24-hour lead TTL.

## Stack

Node.js + Express · Playwright · Gemini / Groq · Paddle · JSON file persistence with atomic temp-file writes and `.bak` recovery (no database) · Next.js-style pages under `pages/` and generated static pages in `public/`.

Persistent state lives in `data/`, which is **not** included in this repository. The app creates it on first run.

## Getting started

Requires Node.js 20+ (22 recommended).

```bash
npm install
cp .env.example .env      # then fill in the keys you actually need
npm start                 # http://localhost:5050/
```

`npm run dev` is an alias for `npm start`. Additional scripts:

| Command | Purpose |
| --- | --- |
| `npm run build:pages` | Regenerate the static pages in `public/` |
| `npm run ui:dev` | Next.js UI dev server on port 3100 |
| `npm run ui:build` / `npm run ui:start` | Build / serve the Next.js UI |

Configuration is grouped and documented in `.env.example`: AI providers, search providers, SMTP, billing, enrichment limits, and feature flags. **Never commit your real `.env`.**

The test suite uses Node's built-in runner:

```bash
node --test tests/*.test.mjs
```

## Optional: Google Maps enrichment

`src/gmapsSource.js` and `scripts/gmaps-enrich.mjs` add an opt-in Google Maps sidecar. It is **off by default** (`GMAPS_ENABLED=false`) and writes only inside `data/gmaps/`. See [docs/gmaps-integration.md](docs/gmaps-integration.md) and `.env.gmaps.example`.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | Express server, discovery, scraping, AI, auth, billing, jobs |
| `public/` | Generated static marketing/legal pages |
| `pages/`, `components/`, `lib/` | Next.js UI |
| `content/` | Blog and marketing content |
| `scripts/` | Build, seeding, and enrichment utilities |
| `tests/` | Node test suite |
| `docs/` | Setup and integration notes |

## License

Copyright © Leadmoz. All rights reserved.
