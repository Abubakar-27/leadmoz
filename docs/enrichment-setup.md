# Company & Contact Enrichment — setup

The add-on lives inside the existing app: same account, same subscription system,
same billing provider (Paddle). It is OFF until the price id below is configured,
and the app keeps working normally either way.

## 1. Required: the add-on prices in Paddle

The add-on is **only sold to holders of a paid plan** and its monthly price
follows their plan tier:

| Base plan | Add-on price | Included credits | Env var (price id) | Env var overrides |
|---|---|---|---|---|
| Starter (incl. 3/6-month) | **$10**/mo | **50**/month | `PADDLE_ENRICHMENT_PRICE_STARTER` | `ENRICHMENT_PRICE_STARTER`, `ENRICHMENT_MONTHLY_CREDITS_STARTER` |
| Pro (incl. 3/6-month) | **$20**/mo | **100**/month | `PADDLE_ENRICHMENT_PRICE_PRO` | `ENRICHMENT_PRICE_PRO`, `ENRICHMENT_MONTHLY_CREDITS_PRO` |
| Agency (incl. 3/6-month) | **$30**/mo | **200**/month | `PADDLE_ENRICHMENT_PRICE_AGENCY` | `ENRICHMENT_PRICE_AGENCY`, `ENRICHMENT_MONTHLY_CREDITS_AGENCY` |
| Free | not available | — | — | — |

The granted tier decides both the price and the allowance, and is derived
server-side (from the plan bought in the transaction or the plan the account
holds). The flat `ENRICHMENT_MONTHLY_CREDITS` remains a legacy override for
tiers without their own value.

1. In Paddle, create a **subscription price** for each tier you want to sell,
   in the same seller account the base plans use.
2. Put the price ids in `.env`:

   ```
   PADDLE_ENRICHMENT_PRICE_STARTER=pri_xxxxxxxxxxxxxxxx
   PADDLE_ENRICHMENT_PRICE_PRO=pri_yyyyyyyyyyyyyyyy
   PADDLE_ENRICHMENT_PRICE_AGENCY=pri_zzzzzzzzzzzzzzzz
   ```

   `PADDLE_ENRICHMENT_PRICE` (the old single id) still works as a fallback for
   any tier without its own id, so an existing deployment keeps working.

The tier is decided **on the server**: from the plan being bought in the
transaction, or from the plan the account already holds. `/checkout` asks the
server which tier applies (`/api/auth/paddle-config?plan=...`) and the webhook
cross-checks the paid price id against the expected tier — a price or plan id
from the frontend is never trusted, and a transaction that paid none of the
add-on price ids grants nothing.

Without any configured price id `enrichmentEnabled()` is false: every
`/api/enrichment/*` route answers `503` and the dashboard section shows
"not available". Nothing else breaks.

Card payments additionally need the existing Paddle setup (`PADDLE_MODE`,
client token, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICES`). If Paddle card payments
are not enabled, the add-on checkbox still appears on `/checkout` and the
customer can buy it through the existing bank-transfer flow — an admin then
grants it from the API (see §5).

## 2. Recommended: cap the provider cost

```
# Built-in email finder - no key, no account, no per-lookup fee.
ENRICHMENT_FREE_EMAIL_ENABLED=true
ENRICHMENT_FREE_EMAIL_DAILY_MAX=1000   # SMTP conversations per day, all users
ENRICHMENT_FREE_EMAIL_VERIFY_MAX=5     # published addresses checked per company
ENRICHMENT_FREE_EMAIL_FIND_MAX=3       # named people looked up per company
ENRICHMENT_FREE_EMAIL_PATTERNS_PER_PERSON=3
ENRICHMENT_FREE_EMAIL_TIMEOUT_MS=6000
HUNTER_API_KEY=                     # OPTIONAL; built-in finder works without it
ENRICHMENT_HUNTER_DAILY_MAX=20      # hard daily cap on Hunter calls
ENRICHMENT_MONTHLY_CREDITS_STARTER=50   # per-tier allowance (defaults shown)
ENRICHMENT_MONTHLY_CREDITS_PRO=100
ENRICHMENT_MONTHLY_CREDITS_AGENCY=200
# Owner research on the wider web - reuses the EXISTING TAVILY_API_KEYS /
# FIRECRAWL_API_KEYS the lead search already uses (no new account, no new cost
# centre). Runs only when the company's own site + built-in/Hunter lookups
# name nobody.
ENRICHMENT_WEB_SEARCH_ENABLED=true
ENRICHMENT_WEB_SEARCH_DAILY_MAX=30
ENRICHMENT_WEB_SEARCH_QUERIES_PER_COMPANY=2
ENRICHMENT_WEB_SEARCH_PAGES_PER_COMPANY=4
ENRICHMENT_WEB_SEARCH_QUERIES_PER_PERSON=2   # per NAMED person
ENRICHMENT_WEB_SEARCH_PAGES_PER_PERSON=3
```

**Built-in email finder (`free_email` provider):** the replacement for a paid
Hunter plan. For each decision-maker already **named** by the company's site or
the public web, it tries the common professional layouts (`first.last@`,
`firstlast@`, `first@`, `f.last@`), then asks the company's own MX server
whether that mailbox exists. The SMTP conversation stops at `RCPT TO` and closes
with `QUIT`, so **no message is ever sent**. A random-address probe detects
catch-all domains, and results there are reported as "risky", never "verified".
Greylisting, blocked port 25 or a timeout becomes "unknown", never "invalid".
Nothing is invented for a person who was not named. Requires outbound TCP 25
(already open on the production VPS); no API key or account is involved.

**Hunter.io (`hunter` provider, optional):** when `HUNTER_API_KEY` is set it
runs alongside the built-in finder. Its database results are used first, then
the keyless finder fills the gaps without spending Hunter quota. Leave it empty
and the add-on still finds and verifies emails.

**Web-search research (`web_research` provider):** when a company's own site
publishes no decision-maker, the add-on searches the public web
(`"Company" founder owner CEO`) and reads the top result pages with the same
SSRF-guarded scraper. LinkedIn/Facebook/Instagram/X are **never fetched** -
a matching public profile URL from search results is recorded as the
contact's profile URL instead. A person only counts when the page names the
company; emails are kept only on the company's own domain. Everything is
labelled `source: web` with a source URL and low confidence. Disable with
`ENRICHMENT_WEB_SEARCH_ENABLED=false` or from the admin provider controls;
no search key configured = provider simply unavailable, nothing breaks.

**Person-level research (same provider):** once a decision-maker is *named*,
the add-on also searches the public internet **for that person** -
`"Name" "Company" founder owner CEO` and `"Name" "Company" LinkedIn profile` -
so their professional profile (LinkedIn/X) is found even when the company's
own site never links it. The profile URL comes from the search result and must
match the person's own name slug; LinkedIn itself is **never fetched** (its
terms forbid automated access). Top result pages are read to re-confirm the
person really is at this company (person **and** company must both appear),
which upgrades the confidence to medium; a name-matched profile URL alone
stays low and a bare company name is never used as a job title. Bounded to
three people per company and reused by the email stage from cache, so one job
cannot drain the daily search cap.

Cost model (all configurable, defaults below): company profile **1**,
decision-maker lookup **2**, email discovery **3**. A step that returns nothing
is refunded, cache reads are free, and the provider's domain search runs at most
once per company even when both email steps are selected.

Full variable list with comments: [.env.example](../.env.example).

## 3. What the customer sees

- `/app` → **Company & Contact Enrichment** tab (also linked from the top nav).
- Without the add-on: a locked preview with the monthly allowance, use cases
  and the tier price list ($10 / $20 / $30). Paid-plan holders see **their**
  tier's price and a purchase button for their own plan; free visitors are told
  the add-on requires a paid plan and get a combined plan + add-on checkout
  (→ `/checkout?plan=starter&addon=enrichment`).
- Free users can never use the tool: `ENRICHMENT_REQUIRE_BASE_PLAN=true`
  (default) makes every route answer 402 until they hold a paid plan, and the
  add-on entitlement is granted only by a confirmed payment.
- With the add-on: the run form, live job progress, the results table with
  source and verification status, per-company detail, retry and CSV export.
- `/checkout` shows the add-on as its **own line item** with the combined total;
  the plan price is never changed.

Access control is server-side (`assertCanUseEnrichment` on every route):
unauthenticated → 401, feature off → 503, no paid base plan / no add-on → 402.

## 4. Billing lifecycle

| Paddle event | Effect |
|---|---|
| `transaction.completed` (add-on price) | Grants 30 days + that month's credits, keyed by transaction id — a replayed webhook changes nothing. |
| `transaction.completed` (plan **and** add-on in one transaction) | Grants both. |
| `subscription.cancelled` / `deleted` | Stops renewing; access continues until the paid `expiresAt` (paid-through, no new credits after). |
| `subscription.payment_failed` / `past_due` | Same paid-through window; a later successful payment renews normally. |

Base-plan subscription handling is untouched: those events only affect an
entitlement whose stored `subscriptionId` matches (or that explicitly carries
`addon: "enrichment"`).

## 5. Admin

All admin controls are API routes under `/api/enrichment/admin/*`
(`requireAdmin`): `summary`, `entitlements/:userId`, `grant`, `revoke`,
`adjust-credits`, `provider/:provider/disable`, `recover`.

```bash
# grant the add-on to a user for 30 days (e.g. after a bank transfer)
curl -X POST -b admin-cookie.jar https://leadmoz.com/api/enrichment/admin/grant \
  -H 'content-type: application/json' \
  -d '{"userId":"user_...","days":30,"reason":"bank_transfer_verified"}'
```

Provider usage, per-day call counts and last errors: `/api/enrichment/admin/summary`.

## 6. What one enrichment actually reads

A company is read **whole, from its own site** — the same `scrape.js` the lead
search uses, told to go further:

- up to `ENRICHMENT_CRAWL_MAX_PAGES` pages (default 12, homepage included) on
  the submitted domain only: contact/about first, then every other internal
  link the homepage publishes (services, company, team, products, legal);
- the deep contact/legal pages are read even when the homepage already shows
  an email, because that is where addresses and people are published;
- every redirect hop is re-checked against private address ranges (SSRF).

From those pages the profile keeps everything the company actually states:
name, description, industry, location/addresses, phones, founding year and
headcount (schema.org `foundingDate` / `numberOfEmployees`, or an explicit
"Founded in 1998"), LinkedIn/X/Facebook/Instagram profiles, every published
email, and the source pages behind it all. Fields the company never publishes
stay **empty** — they are never guessed.

Deep crawls keep their own cache entry (`scrape:<domain>:deep`), so a shallow
lead-search scrape can never satisfy an enrichment read and vice versa.

## 7. Data & cost controls

- Results are cached per domain (`ENRICHMENT_CACHE_TTL_DAYS`, default 30 days) —
  repeat lookups cost 0 credits and 0 provider calls.
- Enrichment data is stored separately from lead data: `data/enrichment.json`
  (entitlements, credits, provider usage) and `data/enrichment-jobs.json`.
  Lead credits and lead records are never touched.
- Every submitted domain is normalised, de-duplicated and DNS-resolved **before**
  any request, and every redirect hop is re-checked, so private/loopback/link-local/
  cloud-metadata destinations are refused (SSRF).

## 8. Known limitations

- Enrichment is single-process: the in-memory job queue and the credit ledger's
  read-modify-write assume one Node process (same assumption as the rest of the
  app). A multi-process deployment needs an external lock.
- No company-name → domain discovery yet: customers submit domains (or import
  them from their existing leads with one click).
- LinkedIn profiles are only reported when a public profile URL is found on a
  page we are allowed to read; there is no LinkedIn integration and none is
  required.
- Analytics events for the add-on are emitted server-side (job created/completed/
  failed, profile/decision-maker/email found, credits exhausted, purchase and
  cancellation) plus two client beacons (section viewed, purchase initiated).
