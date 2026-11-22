/*
  Company & Contact Enrichment - configuration.

  One place for every tunable so the monthly allowance, per-operation costs and
  safety limits can be adjusted by editing env vars only - no code change and no
  duplicated constants across the app.

  The add-on is OFF until at least one tier has a valid Paddle price id
  (PADDLE_ENRICHMENT_PRICE_STARTER/_PRO/_AGENCY, or the legacy
  PADDLE_ENRICHMENT_PRICE) AND ENRICHMENT_ENABLED is not "false". A missing optional provider (Hunter) never
  disables the feature: the website-based stages still run and the unavailable
  steps are reported honestly.
*/

const STAGES = ["profile", "decision_maker", "email"];

/*
  Tiered add-on pricing: the add-on is only sold to holders of a paid plan and
  its monthly price follows their plan tier - Starter $10, Pro $20, Agency $30.

  Each tier can be overridden with ENRICHMENT_PRICE_<TIER> and priced through
  its own Paddle price id PADDLE_ENRICHMENT_PRICE_<TIER>. The legacy flat vars
  (ENRICHMENT_PRICE_MONTHLY / PADDLE_ENRICHMENT_PRICE) still apply as a
  fallback so an existing single-price deployment keeps working unchanged.
*/
const TIERS = ["starter", "pro", "agency"];
const TIER_LABELS = { starter: "Starter", pro: "Pro", agency: "Agency" };
const TIER_DEFAULT_PRICE = { starter: 10, pro: 20, agency: 30 };
/*
  Monthly allowance is tiered with the price: 50 credits on Starter, 100 on
  Pro, 200 on Agency. Override per tier with ENRICHMENT_MONTHLY_CREDITS_<TIER>;
  the flat ENRICHMENT_MONTHLY_CREDITS still applies to every tier that has no
  per-tier value, so an existing single-value deployment keeps working.
*/
const TIER_DEFAULT_CREDITS = { starter: 50, pro: 100, agency: 200 };

/*
  Map any plan id (including the 3/6-month variants) to its add-on tier.
  Free and unknown plans return "" - there is no add-on price for them.
*/
export function enrichmentTierForPlan(planId) {
  const id = String(planId || "").toLowerCase();
  if (id.startsWith("agency")) return "agency";
  if (id.startsWith("pro")) return "pro";
  if (id.startsWith("starter")) return "starter";
  return "";
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function intMin(name, fallback, min = 0) {
  const n = Math.floor(num(name, fallback));
  return n < min ? min : n;
}

export function enrichmentStageCost(stage) {
  switch (stage) {
    case "profile":
      return intMin("ENRICHMENT_COST_PROFILE", 1, 0);
    case "decision_maker":
      return intMin("ENRICHMENT_COST_DECISION_MAKER", 2, 0);
    case "email":
      return intMin("ENRICHMENT_COST_EMAIL", 3, 0);
    default:
      return 0;
  }
}

export function enrichmentCosts() {
  const out = {};
  for (const stage of STAGES) out[stage] = enrichmentStageCost(stage);
  return out;
}

/*
  Monthly enrichment allowance for a plan's tier. No tier (free viewer, or an
  entitlement granted before tiers existed) falls back to the flat env value
  and then to the Starter default.
*/
export function enrichmentMonthlyCredits(planId) {
  const tier = enrichmentTierForPlan(planId);
  const flat = intMin("ENRICHMENT_MONTHLY_CREDITS", NaN, 1);
  if (!tier) return Number.isFinite(flat) ? flat : TIER_DEFAULT_CREDITS.starter;
  const perTier = intMin(`ENRICHMENT_MONTHLY_CREDITS_${tier.toUpperCase()}`, NaN, 1);
  if (Number.isFinite(perTier)) return perTier;
  if (Number.isFinite(flat)) return flat;
  return TIER_DEFAULT_CREDITS[tier];
}

/* Monthly price for the tier a plan belongs to. Free/unknown plans: 0. */
export function enrichmentPriceMonthly(planId) {
  const tier = enrichmentTierForPlan(planId);
  if (!tier) return 0;
  const perTier = num(`ENRICHMENT_PRICE_${tier.toUpperCase()}`, NaN);
  if (Number.isFinite(perTier) && perTier >= 0) return Math.round(perTier);
  const flat = num("ENRICHMENT_PRICE_MONTHLY", NaN);
  if (Number.isFinite(flat) && flat >= 0) return Math.round(flat);
  return TIER_DEFAULT_PRICE[tier];
}

/* Paddle price id for the tier a plan belongs to. Empty for free plans. */
export function enrichmentPriceId(planId) {
  const tier = enrichmentTierForPlan(planId);
  if (!tier) return "";
  const perTier = String(process.env[`PADDLE_ENRICHMENT_PRICE_${tier.toUpperCase()}`] || "").trim();
  if (/^pri_[A-Za-z0-9]+$/.test(perTier)) return perTier;
  const legacy = String(process.env.PADDLE_ENRICHMENT_PRICE || "").trim();
  return /^pri_[A-Za-z0-9]+$/.test(legacy) ? legacy : "";
}

/* Every tier with its label, price and (if configured) price id. */
export function enrichmentPriceTiers() {
  return TIERS.map(tier => ({
    tier,
    label: TIER_LABELS[tier],
    price: enrichmentPriceMonthly(tier),
    priceId: enrichmentPriceId(tier)
  }));
}

export function enrichmentEnabled() {
  const flag = String(process.env.ENRICHMENT_ENABLED || "").trim().toLowerCase();
  if (flag === "false") return false;
  /*
    An explicit `true` turns the feature on even without a Paddle price id:
    deployments that only accept bank transfers sell the add-on manually and
    the admin grants it from the admin dashboard, so no card price must be
    required. With no flag set we stay conservative and need at least one
    configured price id before exposing paid functionality.
  */
  if (flag === "true") return true;
  return enrichmentPriceTiers().some(t => Boolean(t.priceId));
}

/*
  Requiring a paid base plan keeps the product honest: this is an add-on to an
  existing subscription, not a standalone product. Configurable so a future
  promotion can open it up without a code change.
*/
export function enrichmentRequireBasePlan() {
  return String(process.env.ENRICHMENT_REQUIRE_BASE_PLAN || "true").toLowerCase() !== "false";
}

export function enrichmentLimits() {
  return {
    maxDomainsPerJob: intMin("ENRICHMENT_MAX_DOMAINS_PER_JOB", 50, 1),
    maxBatchCsvRows: intMin("ENRICHMENT_MAX_CSV_ROWS", 200, 1),
    concurrency: intMin("ENRICHMENT_CONCURRENCY", 2, 1),
    perHour: intMin("ENRICHMENT_JOBS_PER_HOUR", 30, 1),
    providerTimeoutMs: intMin("ENRICHMENT_PROVIDER_TIMEOUT_MS", 20000, 1000),
    scrapeTimeoutMs: intMin("ENRICHMENT_SCRAPE_TIMEOUT_MS", 60000, 5000),
    /*
      How many pages of one company's own site one enrichment read may fetch,
      homepage included (the deep contact/legal pages share this budget).
      Raise for deeper coverage, lower on a small server; the crawl is
      same-domain, non-recursive and always capped.
    */
    crawlMaxPages: intMin("ENRICHMENT_CRAWL_MAX_PAGES", 12, 1),
    cacheTtlDays: intMin("ENRICHMENT_CACHE_TTL_DAYS", 30, 1),
    maxRetries: intMin("ENRICHMENT_MAX_RETRIES", 2, 0),
    /*
      Hunter's free tier is small and per-account, so the integration is capped
      well below it by default. Raise these only after checking the current
      plan's allowance in the provider dashboard.
    */
    hunterDailyMax: intMin("ENRICHMENT_HUNTER_DAILY_MAX", 20, 0),
    hunterEmailsPerCompany: intMin("ENRICHMENT_HUNTER_EMAILS_PER_COMPANY", 10, 1),
    /*
      Built-in email finder (no API key, no paid plan). It uses the company's
      own MX servers to confirm whether a mailbox exists, so the caps below
      bound how many SMTP conversations one company can open. The daily max
      keeps a single account from hammering mail servers all day.
    */
    freeEmailDailyMax: intMin("ENRICHMENT_FREE_EMAIL_DAILY_MAX", 1000, 0),
    freeEmailVerifyMaxPerCompany: intMin("ENRICHMENT_FREE_EMAIL_VERIFY_MAX", 5, 1),
    freeEmailFindMaxPerCompany: intMin("ENRICHMENT_FREE_EMAIL_FIND_MAX", 3, 1),
    freeEmailPatternsPerPerson: intMin("ENRICHMENT_FREE_EMAIL_PATTERNS_PER_PERSON", 3, 1),
    freeEmailTimeoutMs: intMin("ENRICHMENT_FREE_EMAIL_TIMEOUT_MS", 6000, 1000),
    emailsPerCompany: intMin("ENRICHMENT_EMAILS_PER_COMPANY", 15, 1),
    /*
      Web-search research (owner/decision-maker discovery beyond the company's
      own site). It reuses the EXISTING Tavily/Firecrawl keys the lead search
      already pays for, so the caps here bound the extra spend on those
      accounts. Queries per company and result pages read per company are kept
      small; each search call counts toward the daily max.
    */
    webSearchDailyMax: intMin("ENRICHMENT_WEB_SEARCH_DAILY_MAX", 30, 0),
    webSearchQueriesPerCompany: intMin("ENRICHMENT_WEB_SEARCH_QUERIES_PER_COMPANY", 2, 1),
    webSearchPagesPerCompany: intMin("ENRICHMENT_WEB_SEARCH_PAGES_PER_COMPANY", 4, 1),
    /*
      Person-level research: once a decision-maker is NAMED, search the public
      web for THAT person - their LinkedIn/X profile, interviews, directory
      entries - instead of only the company. Fewer pages than a company crawl;
      the goal is the person's professional profile, not another site read.
      LinkedIn itself is never fetched (its terms forbid it); the profile URL
      comes from the search result and must match the person's name.
    */
    webSearchQueriesPerPerson: intMin("ENRICHMENT_WEB_SEARCH_QUERIES_PER_PERSON", 2, 1),
    webSearchPagesPerPerson: intMin("ENRICHMENT_WEB_SEARCH_PAGES_PER_PERSON", 3, 1)
  };
}

export function enrichmentProviderConfig() {
  const hunterKey = String(process.env.HUNTER_API_KEY || "").trim();
  return {
    hunter: {
      configured: Boolean(hunterKey && hunterKey !== "your_hunter_key_here"),
      label: "Hunter.io"
    },
    website: {
      configured: true,
      label: "Official website & public pages"
    },
    freeEmail: {
      configured: String(process.env.ENRICHMENT_FREE_EMAIL_ENABLED || "").trim().toLowerCase() !== "false",
      label: "Built-in email finder & mailbox check (no API key)"
    },
    webResearch: {
      configured: Boolean(
        String(process.env.TAVILY_API_KEYS || process.env.TAVILY_API_KEY || "").trim()
        || String(process.env.FIRECRAWL_API_KEYS || process.env.FIRECRAWL_API_KEY || "").trim()
      ),
      label: "Web search (news, directories, public profiles)"
    }
  };
}

/*
  Public, non-secret view for the client. Never includes API keys.
*/
export function enrichmentPublicConfig() {
  return {
    enabled: enrichmentEnabled(),
    tiers: enrichmentPriceTiers(),
    /* cheapest tier's allowance, kept for older callers that expect one number */
    monthlyCredits: enrichmentMonthlyCredits("starter"),
    costs: enrichmentCosts(),
    requireBasePlan: enrichmentRequireBasePlan(),
    limits: {
      maxDomainsPerJob: enrichmentLimits().maxDomainsPerJob,
      maxBatchCsvRows: enrichmentLimits().maxBatchCsvRows
    },
    providers: enrichmentProviderConfig()
  };
}
