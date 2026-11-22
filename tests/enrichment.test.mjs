/*
  Company & Contact Enrichment add-on - tests.

  Covers the parts of the feature spec that must never regress:
    - the add-on gate (401/402/503) and base-plan requirement
    - webhook-driven entitlement, idempotent replays, lifecycle events
    - a SEPARATE credit ledger: allowances, idempotency, no overspend
    - cache reads costing nothing
    - unsafe domains / private addresses refused (SSRF)
    - the app still working with no provider keys configured
    - CSV export and job data isolation between users
    - existing plan prices and lead-credit behaviour untouched

  Every data file is isolated: the modules resolve their directory from
  process.cwd() at import time, so this suite changes into a throwaway temp
  directory BEFORE importing anything and never touches the real data/ folder.
*/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const startCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leadmoz-enrichment-"));
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
process.chdir(tmp);

process.env.PADDLE_ENRICHMENT_PRICE = "pri_testenrich01";
process.env.ENRICHMENT_ENABLED = "true";
process.env.ENRICHMENT_MONTHLY_CREDITS = "200";
/* no ENRICHMENT_PRICE_MONTHLY: the tier defaults (10/20/30) must apply */
delete process.env.HUNTER_API_KEY;

const config = await import("../src/enrichmentConfig.js");
const store = await import("../src/enrichmentStore.js");
const cache = await import("../src/enrichmentCache.js");
const safety = await import("../src/enrichmentSafety.js");
const providers = await import("../src/enrichmentProviders.js");
const freeEmail = await import("../src/apis/freeEmail.js");
const paddle = await import("../src/paddle.js");
const enr = await import("../src/enrichment.js");
const plans = await import("../src/plans.js");
const authStore = await import("../src/authStore.js");
const analytics = await import("../src/analytics.js");
const cryptoMod = await import("node:crypto");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`not ok - ${name}`);
    console.log(`  ${err.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`not ok - ${name}`);
    console.log(`  ${err.message}`);
  }
}

const freeUser = { id: "u_free", role: "user", plan: "free" };
const paidUser = { id: "u_paid", role: "user", plan: "starter" };
const adminUser = { id: "u_admin", role: "admin", plan: "admin" };

/* ------------------------------------------------------- configuration */
check("allowance, price and step costs are configurable in one place", () => {
  assert.equal(config.enrichmentMonthlyCredits(), 200);
  assert.deepEqual(config.enrichmentCosts(), { profile: 1, decision_maker: 2, email: 3 });
  assert.equal(config.enrichmentEnabled(), true);
  assert.equal(config.enrichmentRequireBasePlan(), true);
});

check("add-on price is tiered by base plan: $10 / $20 / $30", () => {
  assert.equal(config.enrichmentPriceMonthly("starter"), 10);
  assert.equal(config.enrichmentPriceMonthly("pro"), 20);
  assert.equal(config.enrichmentPriceMonthly("agency"), 30);
  /* cycle variants map to their base tier */
  assert.equal(config.enrichmentPriceMonthly("starter3"), 10);
  assert.equal(config.enrichmentPriceMonthly("pro6"), 20);
  assert.equal(config.enrichmentPriceMonthly("agency3"), 30);
  /* free users have no add-on price at all */
  assert.equal(config.enrichmentTierForPlan("free"), "");
  assert.equal(config.enrichmentPriceMonthly("free"), 0);
  assert.equal(config.enrichmentPriceId("free"), "");
  /* legacy single price id applies to every configured tier */
  assert.equal(config.enrichmentPriceId("starter"), "pri_testenrich01");
  assert.equal(config.enrichmentPriceId("agency"), "pri_testenrich01");
  assert.deepEqual(
    config.enrichmentPriceTiers().map(t => [t.tier, t.price]),
    [["starter", 10], ["pro", 20], ["agency", 30]]
  );
  /* a per-tier env var overrides the default for that tier only */
  process.env.ENRICHMENT_PRICE_PRO = "25";
  try {
    assert.equal(config.enrichmentPriceMonthly("pro"), 25);
    assert.equal(config.enrichmentPriceMonthly("starter"), 10);
  } finally {
    delete process.env.ENRICHMENT_PRICE_PRO;
  }
});

check("monthly allowance is tiered: 50 / 100 / 200 credits", () => {
  const flat = process.env.ENRICHMENT_MONTHLY_CREDITS;
  try {
    delete process.env.ENRICHMENT_MONTHLY_CREDITS;
    assert.equal(config.enrichmentMonthlyCredits("starter"), 50);
    assert.equal(config.enrichmentMonthlyCredits("pro"), 100);
    assert.equal(config.enrichmentMonthlyCredits("agency"), 200);
    assert.equal(config.enrichmentMonthlyCredits("pro3"), 100, "cycle variants use their base tier");

    /* per-tier env beats the flat value for that tier; flat covers the rest */
    process.env.ENRICHMENT_MONTHLY_CREDITS_PRO = "150";
    process.env.ENRICHMENT_MONTHLY_CREDITS = "200";
    assert.equal(config.enrichmentMonthlyCredits("pro"), 150);
    assert.equal(config.enrichmentMonthlyCredits("starter"), 200);
    assert.equal(config.enrichmentMonthlyCredits("free"), 200, "no tier falls back to the flat value");
  } finally {
    delete process.env.ENRICHMENT_MONTHLY_CREDITS_PRO;
    if (flat === undefined) delete process.env.ENRICHMENT_MONTHLY_CREDITS;
    else process.env.ENRICHMENT_MONTHLY_CREDITS = flat;
  }
});

check("a grant credits that tier's own allowance and records the tier", () => {
  const flat = process.env.ENRICHMENT_MONTHLY_CREDITS;
  delete process.env.ENRICHMENT_MONTHLY_CREDITS;
  try {
    const s = store.grantEnrichmentAddon("u_tiered_s", { days: 30, transactionId: "tx_tiered_s", tier: "starter" });
    assert.equal(s.credits, 50);
    assert.equal(store.enrichmentBalance("u_tiered_s"), 50);
    assert.equal(store.getEnrichmentEntitlement("u_tiered_s").tier, "starter");

    const a = store.grantEnrichmentAddon("u_tiered_a", { days: 30, transactionId: "tx_tiered_a", tier: "agency" });
    assert.equal(a.credits, 200);
    assert.equal(store.enrichmentBalance("u_tiered_a"), 200);
  } finally {
    if (flat !== undefined) process.env.ENRICHMENT_MONTHLY_CREDITS = flat;
    else delete process.env.ENRICHMENT_MONTHLY_CREDITS;
  }
});

check("feature reports disabled without a PADDLE_ENRICHMENT_PRICE id", () => {
  const saved = process.env.PADDLE_ENRICHMENT_PRICE;
  const savedFlag = process.env.ENRICHMENT_ENABLED;
  process.env.PADDLE_ENRICHMENT_PRICE = "";
  process.env.ENRICHMENT_ENABLED = "";
  try {
    assert.equal(config.enrichmentPriceId("starter"), "");
    assert.ok(config.enrichmentPriceTiers().every(t => !t.priceId), "no tier may keep a price id");
    assert.equal(config.enrichmentEnabled(), false);
    const gate = enr.assertCanUseEnrichment(paidUser);
    assert.equal(gate.ok, false);
    assert.equal(gate.status, 503);
  } finally {
    process.env.PADDLE_ENRICHMENT_PRICE = saved;
    if (savedFlag === undefined) delete process.env.ENRICHMENT_ENABLED;
    else process.env.ENRICHMENT_ENABLED = savedFlag;
  }
});

check("explicit ENRICHMENT_ENABLED=true works without a price id (bank-only deployment)", () => {
  const saved = process.env.PADDLE_ENRICHMENT_PRICE;
  const savedFlag = process.env.ENRICHMENT_ENABLED;
  process.env.PADDLE_ENRICHMENT_PRICE = "";
  process.env.ENRICHMENT_ENABLED = "true";
  try {
    assert.equal(config.enrichmentEnabled(), true);
    const gate = enr.assertCanUseEnrichment(paidUser);
    assert.notEqual(gate.status, 503, "the feature flag must bypass the price-id requirement");
  } finally {
    process.env.PADDLE_ENRICHMENT_PRICE = saved;
    if (savedFlag === undefined) delete process.env.ENRICHMENT_ENABLED;
    else process.env.ENRICHMENT_ENABLED = savedFlag;
  }
});

/* ------------------------------------------------------------- gating */
check("anonymous user is rejected", () => {
  const gate = enr.assertCanUseEnrichment(null);
  assert.equal(gate.ok, false);
  assert.equal(gate.status, 401);
});

check("free user without a paid base plan gets 402", () => {
  const gate = enr.assertCanUseEnrichment(freeUser);
  assert.equal(gate.ok, false);
  assert.equal(gate.status, 402);
  assert.match(gate.error, /add-on to a paid plan/i);
});

check("paid user WITHOUT the add-on gets 402", () => {
  const gate = enr.assertCanUseEnrichment(paidUser);
  assert.equal(gate.ok, false);
  assert.equal(gate.status, 402);
  assert.match(gate.error, /Add Company Enrichment/i);
});

check("admin bypasses the add-on gate", () => {
  assert.equal(enr.assertCanUseEnrichment(adminUser).ok, true);
});

/* --------------------------------------------------- entitlement + credits */
check("granting the add-on grants that month's credits exactly once", () => {
  const first = store.grantEnrichmentAddon(paidUser.id, { days: 30, transactionId: "tx_first" });
  assert.equal(first.ok, true);
  assert.equal(first.granted, true);
  assert.equal(first.credits, 200);
  assert.equal(store.enrichmentBalance(paidUser.id), 200);

  const replay = store.grantEnrichmentAddon(paidUser.id, { days: 30, transactionId: "tx_first" });
  assert.equal(replay.duplicate, true);
  assert.equal(store.enrichmentBalance(paidUser.id), 200, "a replayed grant must not double the allowance");
});

check("renewal extends expiry instead of stacking from now", () => {
  const before = store.getEnrichmentEntitlement(paidUser.id).expiresAt;
  store.grantEnrichmentAddon(paidUser.id, { days: 30, transactionId: "tx_second" });
  const after = store.getEnrichmentEntitlement(paidUser.id).expiresAt;
  assert.ok(Date.parse(after) - Date.parse(before) >= 29 * 86400000, "renewal should add ~30 days");
  assert.equal(store.enrichmentBalance(paidUser.id), 400);
});

check("reserve is atomic, idempotent and refuses to overspend", () => {
  const burstUser = { id: "u_burst" };
  store.adjustEnrichmentCredits(burstUser.id, 5, { reason: "test_grant" });
  assert.equal(store.enrichmentBalance(burstUser.id), 5);

  const first = store.reserveEnrichmentCredits(burstUser.id, 5, { idempotencyKey: "job:dom:stage" });
  assert.equal(first.ok, true);
  assert.equal(first.reserved, 5);
  assert.equal(store.enrichmentBalance(burstUser.id), 0);

  const dup = store.reserveEnrichmentCredits(burstUser.id, 5, { idempotencyKey: "job:dom:stage" });
  assert.equal(dup.duplicate, true);
  assert.equal(store.enrichmentBalance(burstUser.id), 0, "same idempotency key must not charge twice");

  /* 50 back-to-back requests against a balance that cannot cover them: the
     ledger is a synchronous read-modify-write, so nothing can overspend. */
  store.adjustEnrichmentCredits(burstUser.id, 5, { reason: "test_topup" });
  let reservedTotal = 0;
  for (let i = 0; i < 50; i += 1) {
    const r = store.reserveEnrichmentCredits(burstUser.id, 1, { idempotencyKey: `burst:${i}` });
    if (r.ok && r.reserved) reservedTotal += r.reserved;
    if (!r.ok) assert.equal(r.error, "insufficient_credits");
  }
  assert.equal(reservedTotal, 5, "more credits than the balance must never be reserved");
  assert.equal(store.enrichmentBalance(burstUser.id), 0);

  const poor = store.reserveEnrichmentCredits("u_nobody", 1, { idempotencyKey: "x" });
  assert.equal(poor.ok, false);
  assert.equal(poor.error, "insufficient_credits");
});

check("refund returns credits once and is idempotent", () => {
  const before = store.enrichmentBalance(paidUser.id);
  const r = store.refundEnrichmentCredits(paidUser.id, 5, { idempotencyKey: "paid:job:dom:stage:refund" });
  assert.equal(r.ok, true);
  assert.equal(r.refunded, 5);
  assert.equal(store.enrichmentBalance(paidUser.id), before + 5);
  const dup = store.refundEnrichmentCredits(paidUser.id, 5, { idempotencyKey: "paid:job:dom:stage:refund" });
  assert.equal(dup.duplicate, true);
  assert.equal(store.enrichmentBalance(paidUser.id), before + 5);
});

check("enrichment ledger is separate from lead credits", () => {
  const acct = store.getEnrichmentAccount(paidUser.id);
  assert.ok(Array.isArray(acct.transactions) && acct.transactions.length > 0);
  assert.ok(acct.lifetimeGranted >= 400);
  // lead-credit module must be untouched by any of the above
  const leadBalance = authStore.getUserById(paidUser.id);
  assert.equal(leadBalance, null, "test user was never written to the auth/lead store");
});

/* ---------------------------------------------------------- Paddle webhook */
check("webhook signature verification rejects a wrong secret", () => {
  const raw = JSON.stringify({ event_type: "transaction.completed" });
  const ts = Math.floor(Date.now() / 1000);
  const good = `ts=${ts},h1=${cryptoMod.createHmac("sha256", "s3cret").update(`${ts}:${raw}`).digest("hex")}`;
  assert.equal(paddle.verifyPaddleSignature(good, "s3cret", raw), true);
  assert.equal(paddle.verifyPaddleSignature(good, "wrong-secret", raw), false);
  assert.equal(paddle.verifyPaddleSignature("", "s3cret", raw), false);
});

await (async () => {
  const buyer = await authStore.createEmailUserWithPassword({ email: "buyer@test.local", password: "password123" });

  const addonPayload = tx => ({
    event_type: "transaction.completed",
    data: {
      id: tx,
      status: "completed",
      subscription_id: "sub_link01",
      custom_data: { leadio_user_id: buyer.id, addon: "enrichment" },
      items: [{ price: { id: "pri_testenrich01" } }],
      customer: { email: "buyer@test.local" }
    }
  });

  await checkAsync("verified webhook grants the add-on", async () => {
    const res = paddle.handlePaddleEvent(addonPayload("tx_web1"));
    assert.ok(res.action === "enrichment_granted" || res.addon === "granted", JSON.stringify(res));
    assert.equal(store.isEnrichmentEntitled({ id: buyer.id, role: "user" }), true);
    assert.equal(store.enrichmentBalance(buyer.id), 200);
  });

  await checkAsync("duplicate webhook does not grant twice", async () => {
    const res = paddle.handlePaddleEvent(addonPayload("tx_web1"));
    assert.equal(res.action, "already_processed");
    assert.equal(store.enrichmentBalance(buyer.id), 200);
  });

  await checkAsync("a transaction that paid none of the add-on price ids grants nothing", async () => {
    const res = paddle.handlePaddleEvent({
      event_type: "transaction.completed",
      data: {
        id: "tx_forged1",
        status: "completed",
        custom_data: { leadio_user_id: buyer.id, addon: "enrichment" },
        items: [{ price: { id: "pri_someotherprice" } }],
        customer: { email: "buyer@test.local" }
      }
    });
    assert.equal(res.action, "ignored", JSON.stringify(res));
    assert.equal(store.enrichmentBalance(buyer.id), 200, "forged custom_data must not grant credits");
  });

  await checkAsync("one transaction carrying plan + add-on grants both", async () => {
    const res = paddle.handlePaddleEvent({
      event_type: "transaction.completed",
      data: {
        id: "tx_combo1",
        status: "completed",
        subscription_id: "sub_link01",
        custom_data: { leadio_user_id: buyer.id, plan: "starter", cycle: "monthly", addon: "enrichment" },
        items: [{ price: { id: "pri_testenrich01" } }],
        customer: { email: "buyer@test.local" }
      }
    });
    assert.equal(res.action, "granted");
    assert.equal(res.plan, "starter");
    assert.equal(res.addon, "granted");
    assert.equal(authStore.getUserById(buyer.id).plan, "starter", "base plan must be granted too");
    assert.equal(store.enrichmentBalance(buyer.id), 400);
    assert.equal(
      store.getEnrichmentEntitlement(buyer.id).tier, "starter",
      "the paid tier must be derived from the base plan, not the client"
    );
  });

  await checkAsync("cancelled subscription keeps access until the paid period ends", async () => {
    const res = paddle.handlePaddleEvent({
      event_type: "subscription.cancelled",
      data: { id: "sub_link01", customer: { email: "buyer@test.local" } }
    });
    assert.equal(res.action, "canceled");
    const ent = store.getEnrichmentEntitlement(buyer.id);
    assert.ok(ent.canceledAt, "cancellation must be recorded");
    assert.equal(store.isEnrichmentEntitled({ id: buyer.id, role: "user" }), true, "paid-through access stays");
  });

  await checkAsync("payment failure marks the add-on past due without instant lockout", async () => {
    const res = paddle.handlePaddleEvent({
      event_type: "subscription.payment_failed",
      data: { id: "sub_link01", customer: { email: "buyer@test.local" } }
    });
    assert.equal(res.action, "past_due");
    assert.ok(store.getEnrichmentEntitlement(buyer.id).pastDueAt);
  });

  await checkAsync("a base-plan subscription event never touches the add-on", async () => {
    const res = paddle.handlePaddleEvent({
      event_type: "subscription.cancelled",
      data: { id: "sub_unrelated", custom_data: { leadio_user_id: buyer.id } }
    });
    assert.equal(res.action, "ignored");
    assert.equal(store.isEnrichmentEntitled({ id: buyer.id, role: "user" }), true);
  });

  await checkAsync("failed payment / unknown buyer does not grant access", async () => {
    const res = paddle.handlePaddleEvent({
      event_type: "transaction.completed",
      data: {
        id: "tx_nobody",
        status: "completed",
        custom_data: { leadio_user_id: "u_does_not_exist", addon: "enrichment" },
        customer: { email: "ghost@test.local" }
      }
    });
    assert.equal(res.action, "ignored");
    assert.equal(res.reason, "no_user");
    assert.equal(store.isEnrichmentEntitled({ id: "u_does_not_exist", role: "user" }), false);
  });
})();

/* --------------------------------------------------------------- cache */
check("cached enrichment is readable, then expires", () => {
  cache.setCachedEnrichment("cached-co.test", {
    profile: { name: "Cached Co" },
    contacts: [],
    emails: [],
    sources: [],
    retrievedAt: new Date().toISOString()
  });
  const hit = cache.getCachedEnrichment("cached-co.test");
  assert.ok(hit && hit.data, "a fresh cache entry must be returned for free");
  assert.equal(hit.cached, true);
  assert.equal(cache.cacheStats().entries, 1);
  assert.equal(cache.purgeCacheForDomain("cached-co.test"), true);
  assert.equal(cache.getCachedEnrichment("cached-co.test"), null);
});

/* ---------------------------------------------------------------- SSRF */
check("unsafe hosts are rejected before any request is made", () => {
  for (const bad of [
    "localhost",
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.10",
    "169.254.169.254",
    "metadata.google.internal",
    "foo.local",
    "http://127.0.0.1/admin",
    "user@localhost",
    "not a domain",
    "javascript:alert(1)"
  ]) {
    assert.equal(safety.normalizeDomain(bad), "", `expected rejection of ${bad}`);
  }
  assert.equal(safety.normalizeDomain("https://www.Example.com/about?x=1"), "example.com");
  assert.equal(safety.dedupeDomains(["example.com", "www.example.com", "https://example.com/"]).length, 1);
});

await checkAsync("private DNS answers are refused with unsafe_destination", async () => {
  const privateResolver = { lookup: async () => [{ address: "10.1.2.3", family: 4 }] };
  await assert.rejects(
    () => safety.assertPublicDomain("internal.test.example", { resolver: privateResolver }),
    err => err.code === "unsafe_destination"
  );

  const metadataResolver = { lookup: async () => [{ address: "169.254.169.254", family: 4 }] };
  await assert.rejects(
    () => safety.assertPublicDomain("metadata.test.example", { resolver: metadataResolver }),
    err => err.code === "unsafe_destination"
  );

  const publicResolver = { lookup: async () => [{ address: "93.184.216.34", family: 4 }] };
  const ok = await safety.assertPublicDomain("public.test.example", { resolver: publicResolver });
  assert.equal(ok.domain, "public.test.example");
});

/* ------------------------------------------------- providers / missing keys */
await checkAsync("missing Hunter key degrades gracefully instead of crashing", async () => {
  assert.equal(providers.hunterConfigured(), false);
  assert.equal(providers.hunterAvailable(), false);
  const status = providers.providerStatus();
  assert.equal(status.hunter.configured, false);
  assert.equal(status.website.configured, true);

  const search = await providers.hunterDomainSearch("example.com");
  assert.equal(search.ok, false);
  assert.equal(search.reason, "hunter_unavailable");

  const verify = await providers.hunterVerifyEmail("someone@example.com");
  assert.equal(verify.ok, false);
  assert.equal(verify.status, providers.EMAIL_STATUS.UNVERIFIED);

  const find = await providers.hunterFindEmail("example.com", "Jane", "Doe");
  assert.equal(find.ok, false);
});

check("the built-in email finder works with no API key", () => {
  const status = providers.providerStatus();
  assert.equal(status.free_email.configured, true);
  assert.equal(status.free_email.available, true);
  assert.equal(status.free_email.dailyMax > 0, true);
  assert.equal(providers.freeEmailConfigured(), true);
  assert.equal(providers.freeEmailAvailable(), true);
});

check("email patterns are ordered from most to least likely", () => {
  const rows = freeEmail.emailPatterns("Ada", "Lovelace", "example.com");
  assert.deepEqual(rows.map(r => r.email), [
    "ada.lovelace@example.com",
    "adalovelace@example.com",
    "ada@example.com",
    "alovelace@example.com",
    "ada_lovelace@example.com",
    "ada.a@example.com"
  ]);
  assert.ok(rows[0].confidence > rows[rows.length - 1].confidence);
  assert.deepEqual(freeEmail.emailPatterns("", "Lovelace", "example.com"), []);
  assert.deepEqual(freeEmail.emailPatterns("Ada", "Lovelace", "not a domain"), []);
});

check("names are cleaned before building an address", () => {
  const rows = freeEmail.emailPatterns("José", "O'Brien", "example.com");
  assert.deepEqual(rows.slice(0, 2).map(r => r.email), [
    "jose.obrien@example.com",
    "joseobrien@example.com"
  ]);
});

await checkAsync("the keyless finder refuses to guess at consumer mailbox providers", async () => {
  const row = await freeEmail.findEmailWithFreePatterns("https://gmail.com", "Ada", "Lovelace");
  assert.equal(row.ok, false);
  assert.equal(row.reason, "personal_domain");
});

await checkAsync("disabling the website provider stops scraping cleanly", async () => {
  store.setProviderDisabled("website", true);
  const res = await providers.scrapeCompanySite("example.com");
  assert.equal(res, null);
  store.setProviderDisabled("website", false);
  assert.equal(store.getDisabledProviders().includes("website"), false);
});

/* --------------------------------------------------- profile mapping quality */
check("<title> junk is reduced to the domain's own brand", () => {
  const scraped = {
    scrapeOk: true,
    businessName: "Avox company · GitLab",
    description: "Teams ship trusted software faster.",
    addresses: [],
    linkedinUrl: "",
    pagesScraped: [],
    signals: {}
  };
  const profile = providers.mapWebsiteProfile(scraped, "gitlab.com");
  assert.equal(profile.name, "GitLab");
  assert.equal(profile.verifiedMatch, true);
});

check("an unrelated title without a domain match is kept as-is", () => {
  const profile = providers.mapWebsiteProfile({
    scrapeOk: true,
    businessName: "Bob's Plumbing — Dallas",
    description: "",
    addresses: [],
    pagesScraped: [],
    signals: {}
  }, "bobsplumbing.com");
  assert.equal(profile.name, "Bob's Plumbing — Dallas");
});

check("industry is inferred from the company's own name and description", () => {
  assert.equal(
    providers.inferIndustry("24/7 plumbing repairs in Dallas", "Bob's Plumbing"),
    "Home & Construction Services"
  );
  assert.equal(
    providers.inferIndustry("Join the world's most widely adopted developer platform", "GitHub"),
    "Software & Technology"
  );
  assert.equal(providers.inferIndustry("", ""), "", "no text means no claim");
  assert.equal(providers.inferIndustry("we sell nice tables", "Craft Co"), "", "unknown stays empty");
});

check("an empty scrape reports not-found instead of an ok profile", () => {
  const profile = providers.mapWebsiteProfile({
    scrapeOk: true,
    businessName: "",
    description: "",
    addresses: [],
    linkedinUrl: "",
    pagesScraped: [],
    signals: {}
  }, "example.com");
  assert.equal(profile, null, "no usable field must not be reported as a found profile");
});

check("the profile carries everything the whole-site crawl found", () => {
  const profile = providers.mapWebsiteProfile({
    scrapeOk: true,
    businessName: "Acme Robotics",
    description: "Warehouse automation for factories.",
    addresses: ["500 Industrial Way, Akron, OH", "Unit 4, Berlin"],
    phones: ["+1 555 0100"],
    socialLinks: {
      linkedin: "https://www.linkedin.com/company/acme",
      twitter: "https://x.com/acme",
      facebook: "https://www.facebook.com/acme",
      instagram: ""
    },
    founded: "1998",
    companySize: "250",
    pagesScraped: ["https://acme.test/", "https://acme.test/about"],
    linkedinUrl: "https://www.linkedin.com/company/acme",
    signals: {}
  }, "acme.test");

  assert.deepEqual(profile.phones, ["+1 555 0100"]);
  assert.equal(profile.addresses.length, 2);
  assert.equal(profile.founded, "1998");
  assert.equal(profile.size, "250");
  assert.equal(profile.pagesCrawled, 2);
  assert.equal(profile.socials.linkedin, "https://www.linkedin.com/company/acme");
  assert.equal(profile.socials.twitter, "https://x.com/acme");
  assert.equal(profile.socials.facebook, "https://www.facebook.com/acme");
  assert.ok(!("instagram" in profile.socials), "an empty social must stay absent, not blank-filled");
  assert.ok(profile.sourceUrls.includes("https://acme.test/about"), "every crawled page stays attributable");
});

check("fields the company never published stay empty", () => {
  const profile = providers.mapWebsiteProfile({
    scrapeOk: true,
    businessName: "Quiet Co",
    description: "We make things.",
    addresses: [],
    phones: [],
    socialLinks: {},
    pagesScraped: ["https://quiet.test/"],
    signals: {}
  }, "quiet.test");

  assert.deepEqual(profile.phones, []);
  assert.deepEqual(profile.addresses, []);
  assert.deepEqual(profile.socials, {});
  assert.equal(profile.founded, "");
  assert.equal(profile.size, "");
  assert.equal(profile.pagesCrawled, 1);
});

check("a job title is never reported as a decision-maker", () => {
  assert.equal(providers.looksLikePersonName("Product Marketing Manager"), false);
  assert.equal(providers.looksLikePersonName("Alan Hohn"), true);
  assert.equal(providers.looksLikePersonName("Sarah O'Neil"), true);
  assert.equal(providers.looksLikePersonName("Founder"), false);

  const contacts = providers.mapWebsiteDecisionMakers({
    businessName: "Docker",
    ownerName: "Product Marketing Manager",
    ownerRole: "Principal",
    text: "",
    website: "https://docker.com"
  }, "docker.com");
  assert.equal(contacts.length, 0, "the owner-name path must apply the same guard");
});

/* --------------------------------------------------- jobs, isolation, export */
await checkAsync("job creation validates domains, batches and entitlement", async () => {
  const garbage = await enr.createEnrichmentJob(adminUser, { domains: ["localhost", "127.0.0.1", "x"] });
  assert.equal(garbage.ok, false);
  assert.equal(garbage.status, 400);

  const tooMany = await enr.createEnrichmentJob(adminUser, {
    domains: Array.from({ length: 60 }, (_, i) => `co${i}.example`)
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /per job/);

  const noStages = await enr.createEnrichmentJob(adminUser, { domains: ["example.com"], stages: [] });
  assert.equal(noStages.ok, false);

  /* Paid plan but no add-on grant: the entitlement gate, not the plan gate. */
  const paidNoAddon = { id: "u_paid_no_addon", role: "user", plan: "starter" };
  const forbidden = await enr.createEnrichmentJob(paidNoAddon, { domains: ["example.com"] });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.status, 402, "a user whose grant has not been paid cannot enqueue work");

  const noEntitlementAtAll = await enr.createEnrichmentJob(freeUser, { domains: ["example.com"] });
  assert.equal(noEntitlementAtAll.ok, false);
  assert.equal(noEntitlementAtAll.status, 402);
});

await checkAsync("jobs, results and CSV are isolated per user", async () => {
  /* .invalid is a reserved TLD: the DNS check fails before any HTTP request,
     so the job reaches a terminal state without hitting the network. */
  const created = await enr.createEnrichmentJob(adminUser, {
    domains: ["does-not-exist.invalid"],
    stages: ["profile"]
  });
  assert.equal(created.ok, true);
  const jobId = created.job.id;

  let job = null;
  for (let i = 0; i < 20; i += 1) {
    job = enr.getEnrichmentJob(adminUser, jobId);
    if (["completed", "partial", "failed", "canceled"].includes(job.status)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.ok(["completed", "partial", "failed"].includes(job.status), `job should finish, got ${job.status}`);

  assert.equal(enr.getEnrichmentJob(freeUser, jobId), null, "another user must not read this job");
  assert.equal(enr.getEnrichmentJob(null, jobId), null);
  assert.equal(enr.enrichCsvRows(jobId, freeUser), null, "CSV export must not leak across users");

  const list = enr.listEnrichmentJobs(freeUser, 10);
  assert.equal(list.length, 0, "a user sees only their own jobs");

  const csv = enr.enrichCsvRows(jobId, adminUser);
  assert.ok(typeof csv === "string" && csv.startsWith("domain,company_name,"), "owner gets real CSV");
  assert.ok(csv.includes("does-not-exist.invalid"));

  const canceled = enr.cancelEnrichmentJob(adminUser, jobId);
  assert.equal(canceled.ok, true, "cancel on a finished job is harmless");
  const retry = enr.retryEnrichmentJob(adminUser, jobId);
  assert.equal(retry.ok, true, "a failed step can be retried");
});

/* ----------------------------------------- analytics + existing behaviour */
check("enrichment analytics events are declared and recordable", () => {
  for (const name of [
    "enrichment_section_viewed",
    "enrichment_purchase_initiated",
    "enrichment_addon_purchased",
    "enrichment_addon_canceled",
    "enrichment_job_created",
    "enrichment_job_completed",
    "enrichment_job_failed",
    "enrichment_company_profile_found",
    "enrichment_decision_maker_found",
    "enrichment_email_found",
    "enrichment_email_verified",
    "enrichment_credits_exhausted"
  ]) {
    assert.ok(analytics.EVENTS.includes(name), `${name} should be an allowed event`);
    const res = analytics.trackEvent(name, { userId: "u_metrics" });
    assert.equal(res.ok, true, `${name} should be recordable`);
  }
  assert.equal(analytics.trackEvent("not_a_real_event", {}).ok, false);
});

check("existing plan prices and lead limits are unchanged", () => {
  assert.equal(plans.PLANS.free.priceMonth, 0);
  assert.equal(plans.PLANS.starter.priceMonth, 19);
  assert.equal(plans.PLANS.pro.priceMonth, 49);
  assert.equal(plans.PLANS.agency.priceMonth, 99);
  assert.equal(plans.PLANS.starter.leadsPerDay, 150);
  assert.ok(plans.PAID_PLANS.includes("starter") && plans.PAID_PLANS.includes("pro"));
  assert.equal(config.enrichmentPriceMonthly("starter"), 10, "add-on price is separate from plan prices");
  assert.ok(
    ["starter", "pro", "agency"].every(p => config.enrichmentPriceMonthly(p) !== plans.PLANS[p].priceMonth),
    "no add-on price may silently equal a base plan price"
  );
});

check("admin summary reports usage without touching user data", () => {
  const summary = enr.enrichmentAdminSummary();
  assert.equal(typeof summary.totalJobs, "number");
  assert.equal(summary.featureEnabled, true);
  assert.equal(typeof summary.creditsCharged, "number");
  const usage = store.providerUsageStats();
  assert.equal(typeof usage, "object");
});

check("a provider error is cleared once that provider succeeds again", () => {
  const before = store.providerUsageStats().hunter || {};
  store.recordProviderCall("hunter", { ok: false, error: "bad_key" });
  assert.equal(store.providerUsageStats().hunter.lastError, "bad_key");
  store.recordProviderCall("hunter", { ok: true });
  const after = store.providerUsageStats().hunter;
  assert.equal(after.lastError, "", "a recovered provider must not keep showing the old error");
  assert.equal(after.calls, (Number(before.calls) || 0) + 2);
});

/* Leave the temp dir before deleting it - Windows refuses to remove the
   directory the process is still working in. */
process.chdir(startCwd);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* a locked temp file is not a test failure */
}
console.log(failures === 0 ? "\nall enrichment tests passed" : `\n${failures} enrichment test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
