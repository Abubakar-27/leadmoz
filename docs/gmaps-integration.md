# Google Maps enrichment (optional, additive, OFF by default)

This adds extra information — rating, review count, opening hours, "permanently closed" status, address, Google place ID — to leads you **already have**.

It does **not** change search, scraping, scoring, auth, billing, CSV export, or the dashboard. Nothing in `server.js`, `worker.js` or `search.js` was modified for this. Enrichment is written to a new `lead.gmaps` field, so old code keeps seeing the old lead shape.

## Files added

| File | Purpose |
|---|---|
| `src/gmapsSource.js` | Normalizes scraper output, matches entries to leads, launches the sidecar |
| `scripts/gmaps-enrich.mjs` | Standalone command you run by hand (or from cron) |
| `.env.gmaps.example` | Copy these lines into `.env` when you are ready |

No existing file was removed or rewritten by this feature (apart from two one-line crash fixes in `worker.js` and `ai.js`).

## 1. Setup (only when you want to use it)

Copy the contents of `.env.gmaps.example` into your `.env`, then start with the switch **off**:

```
GMAPS_ENABLED=false
```

The scraper runs in Docker as a private container. Install Docker Desktop, then pre-pull the image once:

```
docker pull gosom/google-maps-scraper
```

## 2. Test it with no Docker and no data changes

Create a small file `sample.jsonl` with one line like this:

```json
{"title":"Dream Coffee","web_site":"https://dreamcoffee.com","phone":"+30 210 1234567","review_count":48,"review_rating":4.8,"open_hours":{"Monday":["7 AM–8:30 PM"]},"place_id":"ChIJ123","latitude":38.03,"longitude":23.70}
```

Then run (pick a real job id from `data/store.json`):

```
node scripts/gmaps-enrich.mjs --job <jobId> --from-file ./sample.jsonl --dry-run --force
```

`--dry-run` prints what would be written but does **not** touch `data/store.json`. If the match count looks right, run again without `--dry-run` to actually save it.

## 3. Run it for real

Turn it on in `.env`:

```
GMAPS_ENABLED=true
```

Then:

```
node scripts/gmaps-enrich.mjs --job <jobId>
node scripts/gmaps-enrich.mjs --all --limit 20
```

Each run also writes a separate CSV report under `data/gmaps/` — your existing CSV export is unchanged.

## Useful options

| Option | Meaning |
|---|---|
| `--from-file <path>` | Use scraper JSONL you already have; no Docker call |
| `--dry-run` | No write to `data/store.json` |
| `--force` | Run even if `GMAPS_ENABLED` is not true |
| `--output <path>` | Choose the CSV report path |
| `--limit <n>` | Max jobs for `--all` (default 10) |

## Environment knobs

| Variable | Default | Notes |
|---|---|---|
| `GMAPS_ENABLED` | `false` | Master switch. Old behavior is guaranteed while false. |
| `GMAPS_MODE` | `docker` | `docker` or `binary` |
| `GMAPS_IMAGE` | `gosom/google-maps-scraper` | Docker image |
| `GMAPS_BINARY` | `google-maps-scraper` | Used in binary mode |
| `GMAPS_CACHE_VOLUME` | `gmaps-playwright-cache` | Docker volume for Chromium |
| `GMAPS_WORK_DIR` | `data/gmaps` | Query/result/report files |
| `GMAPS_DEPTH` | `1` | Scroll depth; keep low |
| `GMAPS_CONCURRENCY` | `2` | Parallel pages; keep low to avoid blocks |
| `GMAPS_MAX_QUERIES` | `50` | Cap per job |
| `GMAPS_TIMEOUT_MS` | `900000` | 15-minute kill switch |
| `GMAPS_EXTRA_ARGS` | empty | Extra scraper flags, e.g. `-lang en` |
| `GMAPS_ALLOW_NAME_LOCATION_MATCH` | `true` | Allow medium-confidence name + city match |

## Safety notes

- **Never expose the scraper's own web API** — it has no authentication. This integration uses the CLI in Docker, not that API.
- Telemetry is forced off with `DISABLE_TELEMETRY=1` by the wrapper.
- Google Maps scraping may violate Google's Terms of Service. Get legal approval before using it commercially, and use proxies if you scale up.
- Matching is conservative: domain or phone match = high confidence; name + location = medium. Unmatched leads are left exactly as they were.
- If a run fails or finds nothing, `data/store.json` is not written at all.

## Rollback

Delete the three new files (`src/gmapsSource.js`, `scripts/gmaps-enrich.mjs`, this doc block in `.env`) and set `GMAPS_ENABLED=false`. Your original pipeline is untouched.
