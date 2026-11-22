import fs from "fs";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { registerAdminToolRoutes } from "./adminTools.js";
import { loadEnv } from "./config.js";
import { initGemini } from "./ai.js";
import { sortLeadsByPriority } from "./leadScore.js";
import { normalizeServiceFilter } from "./serviceFilter.js";
import { registerUserGmailSettingsRoutes } from "./userGmailSettings.js";
import { saveJob, getJob, getUserPastLeads, flushExpiredLeads } from "./store.js";
import { runLeadJob } from "./worker.js";
import { leadsToCsv } from "./csv.js";
import { runPreview, consumePreviewQuota, previewQuotaRemaining, previewCachePeek, warmPreviewCache, PREVIEW_HOURLY_LIMIT } from "./preview.js";
import { registerCampaignEmailRoutes } from "./campaignEmail.js";
import { mountEnrichment } from "./enrichmentRoutes.js";
import { recoverEnrichmentJobs } from "./enrichment.js";

import { expireExpiredPlans } from "./authStore.js";
import {
  publicStats,
  allowPublicStatsRequest,
  renderLandingPage
} from "./landingStats.js";
import { createAuditRoutes } from "./auditServer.js";
import { reapStaleJobs, recoverInterruptedJobsOnBoot } from "./jobRecovery.js";
import { registerPaddleRoutes } from "./paddle.js";
import { registerRatesRoute } from "./rates.js";
import { registerBlogRoutes, listPublishedPosts } from "./blog.js";
import {
  registerAuthRoutes,
  requireAuth,
  requireAdmin,
  recordPaymentIntent
} from "./auth.js";
import {
  planGeneration,
  reserveForJob,
  creditSnapshot,
  trackCreditMilestones
} from "./creditPolicy.js";
import { trackEvent } from "./analytics.js";
import { consumeRate, abuseLimits, rejectIfRateLimited } from "./abuseGuard.js";
import { registerLocationRoutes } from "./locations.js";
import { getEffectivePlanId, PAID_PLANS } from "./plans.js";
import { registerMarketingRoutes, drizzleMarketingQueue } from "./marketingCampaigns.js";
import { registerExpiryAlertRoutes, runExpiryAlertSweep } from "./leadExpiryAlerts.js";
import { DEFAULT_SITE_URL, DEFAULT_LEGACY_HOSTS, legacyHostSet, resolveRedirect, redirectEnabled } from "./domainRedirect.js";

loadEnv();
initGemini();

const app = express();
const PORT = Number(process.env.PORT || 5050);

// One proxy (nginx) sits in front of this process and sets the real address.
app.set("trust proxy", 1);

/*
  Canonical origin. Everything absolute that the app emits (sitemap, robots,
  emails, referral links) is built from this, so it is the single place to
  change a domain.
*/
const SITE_URL = String(process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, "");

/*
  Domain migration: the product moved from leadio.site to leadmoz.com. The old
  host keeps resolving and every URL answers with one permanent redirect, so
  bookmarks, search results, links inside already-sent emails and in-flight
  referrals keep working. Path and query string are preserved verbatim.

  GET/HEAD use 301 (cacheable, what crawlers want). Other methods use 308 so a
  POST is replayed with its body intact instead of being turned into a GET.
  nginx also carries this redirect (see docs/domain-migration.md); this copy is
  the safety net for traffic that reaches Node directly.
*/
const LEGACY_HOSTS = legacyHostSet(process.env.LEGACY_HOSTS || DEFAULT_LEGACY_HOSTS.join(","));
const REDIRECT_ON = redirectEnabled(process.env.DOMAIN_REDIRECT);

if (!REDIRECT_ON) {
  console.warn("[domain] redirects disabled by DOMAIN_REDIRECT=off - old host keeps serving");
}

app.use((req, res, next) => {
  if (!REDIRECT_ON) return next();

  const hop = resolveRedirect({
    host: req.headers.host,
    path: req.path,
    method: req.method,
    originalUrl: req.originalUrl,
    siteUrl: SITE_URL,
    legacyHosts: LEGACY_HOSTS
  });

  if (!hop) return next();
  return res.redirect(hop.status, hop.location);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "..", "public");

/*
  Paddle signs webhooks with HMAC-SHA256 over the raw request bytes, so the
  unmodified body must be kept for the verifier. The capture only runs for the
  webhook route; everything else keeps the parsed JSON and no extra buffer.
*/
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      if (String(req.originalUrl || "").startsWith("/v1/webhooks/paddle")) req.rawBody = buf;
    }
  })
);

registerAuthRoutes(app);
registerUserGmailSettingsRoutes(app);
registerCampaignEmailRoutes(app);
mountEnrichment(app);
createAuditRoutes(app);
registerAdminToolRoutes(app);
registerPaddleRoutes(app);
registerRatesRoute(app);
registerBlogRoutes(app, { publicDir: PUBLIC_DIR });
registerMarketingRoutes(app);
registerExpiryAlertRoutes(app);

app.use((req, res, next) => {
  const isHtml = req.path.endsWith(".html") || req.path === "/" || req.path === "/app" || req.path === "/app.html" || req.path === "/auth" || req.path === "/checkout" || req.path === "/admin" || req.path === "/dashboard" || req.path === "/settings" || req.path === "/login" || req.path === "/signup" || req.path === "/blog" || req.path.startsWith("/blog/");
  if (isHtml) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});

app.get("/app.html", requireAuth, (req, res) => {
  res.redirect(301, req.originalUrl.replace(/\.html$/i, ""));
});
app.get("/app", requireAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "app.html"));
});
app.get("/checkout.html", (req, res) => {
  res.redirect(301, req.originalUrl.replace(/\.html$/i, ""));
});
app.get("/checkout", (req, res) => {
  recordPaymentIntent(req, res);
  res.sendFile(path.join(PUBLIC_DIR, "checkout.html"));
});
app.get("/settings.html", requireAuth, (req, res) => {
  res.redirect(301, req.originalUrl.replace(/\.html$/i, ""));
});
app.get("/settings", requireAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "settings.html"));
});

app.get("/admin.html", requireAdmin, (req, res) => {
  res.redirect(301, req.originalUrl.replace(/\.html$/i, ""));
});
app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});
/*
  Public, aggregate-only counters for the landing page trust band. No auth and
  no personal data, rate limited and cached so it cannot be used to scrape.
*/
app.get("/api/public/stats", (req, res) => {
  if (!allowPublicStatsRequest(req.ip)) {
    return res.status(429).json({ error: "Too many requests" });
  }

  res.set("Cache-Control", "public, max-age=5");
  res.json(publicStats());
});

/*
  Location typeahead for the search form. Public and cheap: it returns place
  names only, no personal data, and is cached, rate limited and fail-open, so it
  can never block the form it supports.
*/
registerLocationRoutes(app);

app.get("/", (req, res) => {
  res.type("html").send(renderLandingPage(path.join(PUBLIC_DIR, "index.html")));
});
app.get("/index.html", (req, res) => {
  res.redirect(301, "/");
});

app.get("/auth.html", (req, res) => {
  res.redirect(301, req.originalUrl.replace(/\.html$/i, ""));
});
app.get("/auth", (req, res) => {
  recordPaymentIntent(req, res);
  res.sendFile(path.join(PUBLIC_DIR, "auth.html"));
});

app.get("/login", (req, res) => {
  recordPaymentIntent(req, res);
  res.sendFile(path.join(PUBLIC_DIR, "auth.html"));
});

/*
  Legal pages. Each one is served at a clean path and its .html form redirects,
  matching the convention used for /auth and /checkout above. They are public
  because a privacy notice and refund policy have to be readable by anyone,
  including a customer deciding whether to pay, without an account.
*/
const LEGAL_PAGES = [
  { slug: "terms", file: "terms.html" },
  { slug: "privacy", file: "privacy.html" },
  { slug: "refund", file: "refund.html" }
];

for (const { slug, file } of LEGAL_PAGES) {
  app.get(`/${slug}.html`, (req, res) => {
    res.redirect(301, `/${slug}`);
  });
  app.get(`/${slug}`, (req, res) => {
    res.type("html").sendFile(path.join(PUBLIC_DIR, file));
  });
}

app.get("/signup", (req, res) => {
  recordPaymentIntent(req, res);
  res.sendFile(path.join(PUBLIC_DIR, "auth.html"));
});

/*
  Blog. One page renders both the index and a single article; the client reads
  the path to decide which view to show, and /blog.html redirects like the
  other .html slugs.
*/
app.get("/blog.html", (req, res) => {
  res.redirect(301, "/blog");
});
app.get("/blog", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "blog.html"));
});
app.get("/blog/:slug", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "blog.html"));
});

app.get("/dashboard", requireAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "app.html"));
});

/*
  Dynamic robots.txt and sitemap.xml. Both are generated on every request by
  scanning public/, so adding a new public page picks it up automatically with
  no static file to maintain. The routes are registered before express.static,
  so the historical public/sitemap.xml and public/robots.txt files (removed) are
  shadowed rather than served.

  Sitemap policy mirrors the repo's clean-URL convention: index.html maps to the
  root and every other public page keeps its extensionless path (auth.html ->
  /auth, compliance/index.html -> /compliance). Three classes of files are never
  emitted: the private app shell (app/admin/dashboard/success.html), 404.html (a
  not-found page must never be listed), and stale "index1*" duplicates of
  the landing page nothing links to). The root gets priority 1.0 and every other
  page 0.8, all with a weekly change frequency.
*/
const SITEMAP_EXCLUDES = new Set(["app.html", "admin.html", "dashboard.html", "success.html", "404.html", "index1.html"]);

function publicSitePath(absPath) {
  const rel = path.relative(PUBLIC_DIR, absPath).split(path.sep).join("/");
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"index.html".length)}`.replace(/\/$/, "");
  return `/${rel.replace(/\.html$/, "")}`;
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildSitemapXml() {
  const urls = [];

  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".html")) continue;
      if (SITEMAP_EXCLUDES.has(entry.name)) continue;
      if (entry.name.startsWith("index1")) continue; // stale duplicate landing pages (index1.html, index1.backup.html, ...)
      const loc = `${SITE_URL}${publicSitePath(full)}`;
      let lastmod = "";
      try {
        lastmod = fs.statSync(full).mtime.toISOString();
      } catch {
        /* a stat failure just drops the lastmod, never the URL */
      }
      urls.push({ loc, lastmod, priority: loc === `${SITE_URL}/` ? "1.0" : "0.8" });
    }
  };
  walk(PUBLIC_DIR);

  /*
    Client-side blog articles live in data/blog.json, not as .html files, so the
    filesystem scan can never see them. Append every published post's URL from
    the same source the blog page renders (listPublishedPosts) so articles stay
    in the sitemap permanently and new posts appear automatically. The trailing
    slash matches the article URLs the site has always used. Entries are
    de-duplicated against the scanned URLs and share the 0.8 priority.
  */
  const seen = new Set(urls.map(u => u.loc));
  for (const post of listPublishedPosts()) {
    const slug = String(post.slug || "");
    if (!slug) continue;
    const loc = `${SITE_URL}/blog/${encodeURIComponent(slug)}/`;
    if (seen.has(loc)) continue;
    seen.add(loc);
    urls.push({ loc, lastmod: "", priority: "0.8" });
  }

  urls.sort((a, b) => a.loc.localeCompare(b.loc));

  const body = urls.map(u =>
    ["  <url>", `    <loc>${escapeXml(u.loc)}</loc>`, u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>` : "", "    <changefreq>weekly</changefreq>", `    <priority>${u.priority}</priority>`, "  </url>"]
      .filter(Boolean)
      .join("\n")
  );

  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...body, "</urlset>", ""].join("\n");
}

function buildRobotsTxt() {
  return [
    "# Leadmoz robots.txt - generated dynamically by src/server.js",
    "User-agent: *",
    "Disallow: /app",
    "Disallow: /admin",
    "Disallow: /dashboard",
    "Disallow: /data/",
    "Disallow: /api/",
    "",
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    ""
  ].join("\n");
}

app.get("/sitemap.xml", (req, res) => {
  try {
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(buildSitemapXml());
  } catch (err) {
    console.error("Sitemap generation failed:", err.message);
    res.status(500).set("Content-Type", "text/plain").send("Sitemap generation failed.");
  }
});

app.get("/robots.txt", (req, res) => {
  try {
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(buildRobotsTxt());
  } catch (err) {
    console.error("robots.txt generation failed:", err.message);
    res.status(500).set("Content-Type", "text/plain").send("robots.txt generation failed.");
  }
});

/*
  Clean extensionless routing for public pages. A crawler or a human visiting
  /audit or /report gets the matching public/<name>.html file (sent via
  res.sendFile) instead of the 404 handler - the same convention the explicit
  routes above already use for /auth, /terms, etc.

  Placement rules keep this fallback from stepping on anything:
  - It is registered after every explicit route, so real routes win.
  - It only fires for extensionless paths (anything with an extension flows on
    to express.static) and skips the private app shell and the 404/landing-page
    duplicates, mirroring SITEMAP_EXCLUDES.
  - Lookups stay inside PUBLIC_DIR, and directory-style paths such as
    /compliance or /compare/leadmoz-vs-apollo (which resolve through
    express.static's index.html handling) fall through untouched.
*/
const EXTENSIONLESS_HTML_EXCLUDES = new Set(["app", "admin", "dashboard", "success", "404", "index1"]);
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const cleanPath = req.path.replace(/\/+$/, "");
  if (!cleanPath || cleanPath === "/") return next();
  const lastSegment = cleanPath.split("/").pop() || "";
  if (lastSegment.includes(".")) return next();
  if (EXTENSIONLESS_HTML_EXCLUDES.has(lastSegment)) return next();

  const candidate = path.join(PUBLIC_DIR, `${cleanPath}.html`);
  if (!candidate.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`)) return next();
  if (!fs.existsSync(candidate)) return next();

  res.sendFile(candidate, err => {
    if (err) next();
  });
});

/*
  Landing-page newsletter signup. One JSON line per subscriber, deduped by
  email, so the list needs no database and stays easy to read.
*/
app.post("/api/subscribe", async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    const limits = abuseLimits();
    if (rejectIfRateLimited(res, consumeRate(`subscribe:ip:${clientIp(req)}`, limits.subscribePerIpPerHour),
      "Too many subscription attempts from this connection. Please wait a little while.")) return;
    const dir = path.join(__dirname, "..", "data");
    const file = path.join(dir, "newsletter.jsonl");
    await fs.promises.mkdir(dir, { recursive: true });
    let already = false;
    try {
      const current = await fs.promises.readFile(file, "utf8");
      already = current.split("\n").some(line => {
        if (!line.trim()) return false;
        try { return String(JSON.parse(line).email || "").toLowerCase() === email; } catch { return false; }
      });
    } catch { /* first subscriber */ }
    if (!already) {
      await fs.promises.appendFile(file, JSON.stringify({ email, at: new Date().toISOString() }) + "\n");
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Subscription failed. Try again." });
  }
});
app.use(express.static(PUBLIC_DIR));

/*
  nginx fronts this app and sets X-Forwarded-For. Express is told to trust
  exactly one hop (see "trust proxy" above), which makes req.ip resolve to the
  visitor's real address instead of 127.0.0.1 - without that, every request on
  the internet shared a single five-per-hour preview allowance.

  Reading the headers by hand would be worse, not better: nginx appends the
  real address to whatever a client sent, so the leftmost entry is whatever
  the client chose. req.ip already skips past the proxy hop and the spoofed
  entries, so the headers are only a last resort.
*/
function clientIp(req) {
    if (req.ip) return String(req.ip);
    if (req.socket?.remoteAddress) return String(req.socket.remoteAddress);

    const real = String(req.headers["x-real-ip"] || "").trim();
    return real || "unknown";
}

/*
  The response is rebuilt from a fixed key list rather than passed through, so
  no field that happens to be on a lead - now or later - can widen what an
  anonymous visitor receives.
*/
function decoratePreview(result, ip, cached) {
    /*
      The one place a signed-out response is built. Every card is masked: the
      category label plus the three finding strings, nothing else.

      There is deliberately no unlock path here. Revealing a real name or
      contact on the landing page was built and then removed, and leaving the
      branch out of this function is what guarantees it cannot be re-enabled by
      a field turning up on a lead. Anything extra a lead happens to carry is
      dropped, not passed through.
    */
    return {
        ok: true,
        cached: Boolean(cached),
        niche: result.niche,
        location: result.location,
        label: result.label,
        leads: (result.leads || []).map(lead => ({
            label: String(lead.label || "").slice(0, 90),
            /*
              `kind` and `verified` ride along so the preview can label the card
              honestly instead of presenting every observation as a fault.
              "verified" means we measured the fault; an unverified item is
              something the site could add, not something it is doing wrong.

              preview.js renames the finding's `class` to `kind` on the way out,
              so both spellings are accepted here. Reading only `class` made
              every card report kind="" verified=false, which silently
              discarded the tagging at exactly the boundary it exists to cross.
            */
            isRealIssue: (lead.weakness?.kind || lead.weakness?.class) === "defect",
            weakness: {
                label: String(lead.weakness?.label || "").slice(0, 120),
                detail: String(lead.weakness?.detail || "").slice(0, 300),
                hook: String(lead.weakness?.hook || "").slice(0, 300),
                kind: String(lead.weakness?.kind || lead.weakness?.class || "").slice(0, 20),
                verified: lead.weakness?.verified === true
            }
        })),
        stats: {
            candidatesFound: result.stats.candidatesFound,
            sitesScanned: result.stats.sitesScanned,
            filteredOut: result.stats.filteredOut,
            seconds: result.stats.seconds
        },
        remaining: previewQuotaRemaining(ip)
    };
}

app.post("/api/preview", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const payload = {
    niche: req.body?.niche,
    location: req.body?.location
  };
  const ip = clientIp(req);

  /*
    A cached answer costs no search and no page loads, so it is not worth
    charging for. Charging it meant that anyone repeating a search - including
    our own testing - burned the allowance they had left.
  */
  const hit = previewCachePeek(payload.niche, payload.location);
  if (hit) {
    return res.json(decoratePreview(hit, ip, true));
  }

  const allowance = consumePreviewQuota(ip);
  if (!allowance.allowed) {
    // Worth recording: if the resolved address is ever the proxy again, the
    // limit has silently gone global and every visitor is sharing one.
    console.warn(`Preview limit reached for ${ip}`);
    return res.status(429).json({
      ok: false,
      error: `You have used all ${PREVIEW_HOURLY_LIMIT} free previews this hour. Create a free account to keep searching.`,
      retryInMinutes: allowance.retryInMinutes
    });
  }

  try {
    const result = await runPreview(payload);

    if (!result.ok) {
      // A busy upstream is a temporary server condition, not a missing page,
      // and the status code is what tells a client to retry.
      return res.status(result.busy ? 503 : 404).json(result);
    }

    return res.json(decoratePreview(result, ip, Boolean(result.cached)));
  } catch (err) {
    console.error("Preview failed:", err.message);
    return res.status(500).json({
      ok: false,
      error: "The preview could not be generated right now. Please try again."
    });
  }
});
app.post("/api/jobs", requireAuth, async (req, res) => {
  const niche = String(req.body.niche || "").trim();
  const location = String(req.body.location || "").trim();
  const serviceOffer = String(req.body.serviceOffer || "").trim();
  const serviceFilter = normalizeServiceFilter(req.body.serviceFilter);
  const requestedCount = Math.min(Math.max(Number(req.body.targetCount || 25), 1), 1000);

  if (!niche || !location || !serviceOffer) {
    return res.status(400).json({
      error: "niche, location, and serviceOffer are required"
    });
  }

  /*
    Generation is a burst limit per resolved client address. It is deliberately
    high enough that an office or household behind one NAT address is never
    affected, and it does not ban - it only slows a script.
  */
  const limits = abuseLimits();
  const rate = consumeRate(`gen:ip:${clientIp(req)}`, limits.generationsPerIpPerHour);
  if (!rate.allowed) {
    return res.status(429).json({
      ok: false,
      code: "RATE_LIMITED",
      error: "Too many searches from this connection right now. Please try again in a little while.",
      retryInMinutes: Math.max(1, Math.ceil(rate.retryAfterMs / 60000))
    });
  }

  /*
    Decide the meter BEFORE creating anything: credits for free users, the
    day's allowance for paid/lifetime, nothing for admins. The reservation is
    capped by what the account actually has, so a user with 3 credits asking
    for 25 runs a 3-lead search instead of being rejected outright.
  */
  const authorization = planGeneration(req.user, requestedCount);
  if (!authorization.ok) {
    return res.status(authorization.status || 402).json({
      ok: false,
      code: authorization.code,
      error: authorization.error,
      credits: creditSnapshot(req.user)
    });
  }

  const job = {
    id: uuidv4(),
    userId: req.user.id,
    userEmail: req.user.email,
    niche,
    location,
    serviceOffer,
    serviceFilter,
    targetCount: authorization.targetCount,
    status: "queued",
    progressMessage: "Queued",
    diagnostics: {},
    leads: [],
    billing: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  /*
    Reserve now, settle on completion. If the reservation fails (a race lost
    between the check above and here) the job is never saved or run.
  */
  const reserved = reserveForJob({
    user: req.user,
    jobId: job.id,
    mode: authorization.mode,
    reserved: authorization.reserved
  });
  if (!reserved.ok) {
    return res.status(402).json({
      ok: false,
      code: "CREDITS_EXHAUSTED",
      error: `You do not have enough free lead credits left to run this search.`,
      credits: creditSnapshot(req.user)
    });
  }
  job.billing = reserved.billing;

  saveJob(job);

  trackEvent("first_generation_attempt", { userId: req.user.id, meta: { mode: authorization.mode } });
  trackCreditMilestones(req.user, authorization.remaining, reserved.balance ?? authorization.remaining);

  runLeadJob(job.id).catch(err => console.error("Job crashed:", err));

  res.json({ jobId: job.id, credits: creditSnapshot(req.user) });
});

/*
  Audit data is no longer stripped for free users.

  This used to null leakingFunnelAudit / seoSchemaAudit and drop audit-tier
  weaknesses for anyone without a paid plan, on all four read paths. Combined
  with the paid-only audit gate in worker.js, a free search returned bare contact
  records with no analysis and no way to tell whether the leads were any good -
  37% of free searches returned nothing at all.

  Both gates had to go. Leaving this one in place while opening the worker gate
  would have computed audits and then hidden them, so the change would look
  deployed and do nothing.
*/

app.get("/api/jobs/:id", requireAuth, (req, res) => {
  const job = getJob(req.params.id);

  if (!job) return res.status(404).json({ error: "Job not found" });

  if (req.user.role !== "admin" && job.userId !== req.user.id) {
    return res.status(403).json({ error: "Not allowed" });
  }

  res.json({
    ...job,
    leads: sortLeadsByPriority(job.leads || [])
  });
});

/*
  CSV export is a paid feature as of the free-tier reduction. Free accounts can
  still view and copy leads in the dashboard for the full 24h TTL; only the
  file export requires Starter. Admins bypass the gate.
*/
function csvExportLocked(user) {
  if (!user || user.role === "admin") return false;
  return !PAID_PLANS.includes(getEffectivePlanId(user));
}

app.get("/api/jobs/:id/export", requireAuth, (req, res) => {
  if (csvExportLocked(req.user)) {
    return res.status(402).json({
      error: "CSV export is included with the Starter plan ($19/mo).",
      upgradeRequired: true,
      requiredPlan: "starter",
      checkoutUrl: "/checkout?plan=starter"
    });
  }

  const job = getJob(req.params.id);

  if (!job) return res.status(404).send("Job not found");

  if (req.user.role !== "admin" && job.userId !== req.user.id) {
    return res.status(403).send("Not allowed");
  }

  const csv = leadsToCsv(job.leads || []);

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="leads-${job.id}.csv"`);

  res.send(csv);
});

app.get("/api/past-leads", requireAuth, (req, res) => {
  const leads = getUserPastLeads(req.user.id);

  res.json({
    ok: true,
    ttlHours: 24,
    expiresInMs: 24 * 60 * 60 * 1000,
    count: leads.length,
    leads
  });
});

app.get("/api/past-leads/export", requireAuth, (req, res) => {
  if (csvExportLocked(req.user)) {
    return res.status(402).json({
      error: "CSV export is included with the Starter plan ($19/mo).",
      upgradeRequired: true,
      requiredPlan: "starter",
      checkoutUrl: "/checkout?plan=starter"
    });
  }

  const leads = getUserPastLeads(req.user.id);

  const csv = leadsToCsv(leads);

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="past-leads-${new Date().toISOString().slice(0, 10)}.csv"`);

  res.send(csv);
});
/*
  Google Places was removed: it is a paid API this account cannot buy, and the
  key only ever returned 403 PERMISSION_DENIED. The debug route used to call it
  on every hit, so it is now a 410 explaining that rather than a live call.
*/
app.get("/api/debug/places", requireAuth, (req, res) => {
  res.status(410).json({
    error: "Google Places has been removed. It is a paid API and is not used by this app.",
    searchSources: ["public_web", "osm"]
  });
});
app.use((req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }

  res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

app.listen(PORT, () => {
  /*
    Recover jobs a previous process left mid-search before anything else runs.
    Interrupted jobs are re-queued and run again (capped at two re-runs) so a
    deploy no longer kills whatever the user had running; jobs over the cap are
    failed with their leads kept.
  */
  try {
    const recovered = recoverInterruptedJobsOnBoot();
try { recoverEnrichmentJobs(); } catch (err) { console.error("[enrichment] boot recovery failed:", err.message); }
    for (const jobId of recovered.resumed) {
      runLeadJob(jobId).catch(err => console.error("Job crashed:", err));
    }
  } catch (err) {
    console.error("Stale job recovery failed:", err.message);
  }

  expireExpiredPlans();
  setInterval(() => {
    try {
      expireExpiredPlans();
    } catch (err) {
      console.error("Plan expiry sweep failed:", err.message);
    }
  }, 1000 * 60 * 5);

  try {
    flushExpiredLeads();
  } catch (err) {
    console.error("Initial lead flush failed:", err.message);
  }

  setInterval(() => {
    try {
      const flushed = flushExpiredLeads();
      if (flushed > 0) console.log(`Flushed ${flushed} expired leads (24h TTL).`);
    } catch (err) {
      console.error("Lead flush sweep failed:", err.message);
    }
  }, 1000 * 60 * 30);

  /*
    The boot sweep only helps after a restart. A job can also die without one:
    a search pass that never returns leaves the process healthy and the job in
    "searching" forever, and a restart that happens to land within the boot
    sweep's grace window used to spare it with nothing ever coming back for it.
    So the same sweep runs on a timer too. The 90-minute age floor makes it
    safe for live jobs: every candidate and pass writes a progress message, so
    an actively-running search never comes close to 90 minutes without touching
    updatedAt - only a job whose runner is gone reaches the threshold.
  */
  setInterval(() => {
    try {
      const reaped = reapStaleJobs();
      for (const job of reaped) {
        console.warn(
          `[job-recovery] swept "${job.niche}"/${job.location} after ${job.ageMin}min ` +
          `with no progress (kept ${job.kept} leads)`
        );
      }
      if (reaped.length) {
        console.warn(`[job-recovery] swept ${reaped.length} stalled job(s)`);
      }
    } catch (err) {
      console.error("Stale job sweep failed:", err.message);
    }
  }, 1000 * 60 * 10);

  /*
    Marketing campaign drizzle: the interval fires every minute, but
    drizzleMarketingQueue itself enforces the configured gap (default 15
    minutes) and batch size via the campaign's nextSendAt, so a duplicate or
    early tick cannot burst the queue. A tick that is still sending when the
    next one fires is skipped rather than overlapped.
  */
  setInterval(() => {
    drizzleMarketingQueue().catch(err => console.error("[marketing] drizzle failed:", err.message));
  }, 1000 * 60);
  setTimeout(() => {
    drizzleMarketingQueue().catch(err => console.error("[marketing] boot drizzle failed:", err.message));
  }, 45 * 1000);

  /*
    20-hour lead expiry alerts: hourly, transactional, immediate - never
    behind the marketing drizzle. First run is delayed so boot recovery and
    the initial lead flush settle first.
  */
  setInterval(() => {
    runExpiryAlertSweep()
      .then(r => {
        if (r.alerted > 0 || r.checked > 0) {
          console.log(`[expiry-alert] sweep: ${r.checked} user(s) with expiring leads, ${r.alerted} alerted, ${r.skipped} skipped`);
        }
      })
      .catch(err => console.error("[expiry-alert] sweep failed:", err.message));
  }, 1000 * 60 * 60);
  setTimeout(() => {
    runExpiryAlertSweep()
      .then(r => {
        if (r.alerted > 0) console.log(`[expiry-alert] boot sweep alerted ${r.alerted} user(s)`);
      })
      .catch(err => console.error("[expiry-alert] boot sweep failed:", err.message));
  }, 5 * 60 * 1000);

  console.log("");
  console.log("Leadmoz running.");
  console.log(`Landing:   http://localhost:${PORT}/`);
  console.log(`Auth:      http://localhost:${PORT}/auth`);
  console.log(`Dashboard: http://localhost:${PORT}/app`);
  console.log(`Admin:     http://localhost:${PORT}/admin`);
  console.log("");

  /*
    The public preview answers from a pre-built cache wherever it can, so the
    obvious demo searches are instant instead of sitting behind a spinner for
    half a minute. Warm-up is delayed so it never competes with a real
    visitor arriving at boot, and repeats every few hours because entries
    expire. Search runs one at a time either way.
  */
  const WARM_STARTUP_DELAY_MS = 30 * 1000;
  const WARM_REPEAT_MS = 5 * 60 * 60 * 1000;

  const warm = () => {
    warmPreviewCache()
      .then(result => console.log(`Preview warm-up: ${JSON.stringify(result)}`))
      .catch(err => console.error("Preview warm-up failed:", err.message));
  };

  setTimeout(warm, WARM_STARTUP_DELAY_MS);
  setInterval(warm, WARM_REPEAT_MS).unref?.();
});
