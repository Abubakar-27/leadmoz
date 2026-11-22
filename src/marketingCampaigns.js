import fs from "fs";
import path from "path";
import crypto from "crypto";
import { requireAdmin } from "./auth.js";
import { readAuthStore } from "./authStore.js";
import { getEffectivePlanId, PAID_PLANS } from "./plans.js";
import { sendPlatformMail, platformSmtpConfigured, personalizeMail, wrapMailHtml, escapeHtml, siteUrl } from "./platformMail.js";

/*
  Admin marketing campaigns with a throttled drizzle.

  A campaign snapshots its target segment into a per-recipient queue at create
  time, then drizzleMarketingQueue() sends one BATCH of emails and waits for
  the configured gap before the next batch. The server calls the drainer once a
  minute (server.js), so the cadence is enforced by nextSendAt, not by the
  caller - pausing, restarting, or double-firing the interval cannot burst the
  queue, because a second invocation returns immediately while one is running.

  Batch size and gap are editable from the admin dashboard and stored in
  marketing.json, so throughput can be raised without a redeploy. The defaults
  (15 minutes, 2 emails per batch) work out to ~8 emails/hour, which stays well
  inside Hostinger's outbound limits while draining a 500-user list in a few
  days instead of weeks.

  This is deliberately separate from transactional mail (leadExpiryAlerts.js):
  marketing is throttled, transactional is immediate.
*/

const DATA_DIR = path.join(process.cwd(), "data");
const MARKETING_FILE = path.join(DATA_DIR, "marketing.json");

export const MARKETING_SETTINGS_DEFAULTS = { drizzleMinutes: 15, batchSize: 2 };

const BATCH_MAX = 5;
const MINUTES_MIN = 5;
const MINUTES_MAX = 120;

// Hard ceiling on simultaneously running campaigns. Each one draws from the
// same per-tick budget, so this is a safety rail against a pile-up of paused or
// forgotten campaigns rather than a throughput limit.
const MAX_ACTIVE_CAMPAIGNS = 5;

// Recipients emailed by any campaign inside this window are skipped by a new
// campaign, so two broadcasts created minutes apart cannot hit the same inbox.
const RECENTLY_MAILED_MS = 24 * 60 * 60 * 1000;

const SEGMENTS = ["all", "free", "paid"];

/*
  Guards against a second drainer invocation starting while the first is still
  waiting on SMTP. Without it, two overlapping ticks could both read the same
  pending entry and send it twice.
*/
let drizzleInFlight = false;

const DEFAULT_TEMPLATES = [
  {
    id: "tpl_comparison",
    name: "Comparison Positioning Broadcast",
    subject: "Stop funding Apollo\u2019s bloated enterprise bill ($19 alternative inside)",
    body: `Hi {First_Name},

Let's be honest about the B2B sales stack. Most tech platforms force you into a "tech stack tax." They force you to pay Provider A to scrape data, Provider B to enrich it, and Provider C to find a valid business email.

By the time you get one qualified lead into an outreach sequence, you're looking at a $99/month minimum bill.

Leadmoz was built to change that.

We stripped out the enterprise bloat to bring you clean, premium B2B lead data in a lean, hyper-efficient workflow for just $19/month.

- Same premium contact intelligence.
- Native scraping, processing, and delivery.
- Zero overlapping software subscriptions.

Your budget should go toward scaling operations and closing deals - not overpaying for data access.

${siteUrl()}/checkout?plan=starter

The Leadmoz team`,
    updatedAt: ""
  },
  {
    id: "tpl_feature_drop",
    name: "Feature Drop / Re-engagement",
    subject: "{First_Name}, are you still building lead lists manually?",
    body: `Hi {First_Name},

If you signed up for Leadmoz but haven't fully streamlined your system yet, you're missing out on pure automation.

New competitors like Leadoraa online and other basic scrapers push fragmented files that bounce your emails and destroy your domain reputation. Leadmoz gives you built-in verification, custom sender architecture, and automated openers out of the box.

We just optimized our core scraping engines so you can secure high-intent accounts in under two clicks.

Log back in today, test out your 10 free trial credits, and scale up seamlessly whenever you're ready.

${siteUrl()}/app

The Leadmoz team`,
    updatedAt: ""
  }
];

function emptyData() {
  return { version: 1, templates: [], campaigns: [], sendLog: [], settings: { ...MARKETING_SETTINGS_DEFAULTS } };
}

function readData() {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(MARKETING_FILE, "utf8"));
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object") data = emptyData();
  if (!Array.isArray(data.templates)) data.templates = [];
  if (!Array.isArray(data.campaigns)) data.campaigns = [];
  if (!Array.isArray(data.sendLog)) data.sendLog = [];
  if (!data.settings || typeof data.settings !== "object") data.settings = { ...MARKETING_SETTINGS_DEFAULTS };

  if (data.templates.length === 0) {
    const now = new Date().toISOString();
    data.templates = DEFAULT_TEMPLATES.map(t => ({ ...t, updatedAt: now }));
    writeData(data);
  }
  return data;
}

function writeData(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = MARKETING_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, MARKETING_FILE);
}

function segmentLabel(segment) {
  return segment === "free" ? "Free users only" : segment === "paid" ? "Paid users only" : "All users";
}

function normalizeMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MARKETING_SETTINGS_DEFAULTS.drizzleMinutes;
  return Math.min(MINUTES_MAX, Math.max(MINUTES_MIN, Math.round(n)));
}

function normalizeBatch(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MARKETING_SETTINGS_DEFAULTS.batchSize;
  return Math.min(BATCH_MAX, Math.max(1, Math.round(n)));
}

/*
  Sending cadence, dashboard choice first.

  A saved choice always wins, including when an operator deliberately picks a
  slower gap than the env default. The env vars only seed a fresh install, so
  the deployed .env can set a conservative starting point without silently
  overriding later changes made in the UI.
*/
function readSettings(data) {
  const saved = (data && data.settings) || {};

  const envMinutes = Number(process.env.MARKETING_DRIZZLE_MINUTES);
  const envBatch = Number(process.env.MARKETING_BATCH_SIZE);

  const minutes = saved.drizzleMinutes !== undefined
    ? saved.drizzleMinutes
    : (Number.isFinite(envMinutes) && envMinutes > 0 ? envMinutes : MARKETING_SETTINGS_DEFAULTS.drizzleMinutes);

  const batch = saved.batchSize !== undefined
    ? saved.batchSize
    : (Number.isFinite(envBatch) && envBatch > 0 ? envBatch : MARKETING_SETTINGS_DEFAULTS.batchSize);

  return { drizzleMinutes: normalizeMinutes(minutes), batchSize: normalizeBatch(batch) };
}

function emailsPerHour(settings) {
  return Math.round((settings.batchSize * 60) / settings.drizzleMinutes);
}

/*
  Snapshot the users a campaign will email. Segment rules:
    free - effective plan is free (expired paid plans fall back here too)
    paid - any active paid plan (starter/pro/agency, monthly or multi-month)
    all  - everyone with an email, admins included, minus marketing opt-outs
  A user who bans themselves or sets marketingOptOut is skipped in every
  segment; the snapshot happens once at create time so later plan changes do
  not rewrite a running campaign's audience.
*/
function targetUsersForSegment(segment) {
  const users = readAuthStore().users || [];
  const out = [];
  for (const u of users) {
    if (!u || !u.email) continue;
    if (u.marketingOptOut === true) continue;
    if (u.status === "banned" || u.status === "suspended") continue;

    const effective = getEffectivePlanId(u);
    const isPaid = PAID_PLANS.includes(effective);

    if (segment === "free" && (isPaid || u.role === "admin")) continue;
    if (segment === "paid" && !isPaid) continue;

    out.push({
      userId: u.id,
      email: u.email,
      first_name: u.first_name || "",
      username: u.username || "",
      name: u.name || ""
    });
  }
  return out;
}

function campaignOverdue(campaign, now) {
  if (!campaign.nextSendAt) return true;
  return Date.parse(campaign.nextSendAt) <= now;
}

function finalizeIfDone(campaign) {
  const pending = (campaign.queue || []).some(e => e.status === "pending");
  if (!pending && campaign.status === "sending") {
    campaign.status = "completed";
    campaign.completedAt = new Date().toISOString();
  }
}

function logSend(data, entry) {
  data.sendLog.push(entry);
  if (data.sendLog.length > 2000) data.sendLog = data.sendLog.slice(-2000);
}

function campaignHtml(subject, text) {
  return wrapMailHtml({
    preheader: subject,
    bodyHtml: text
      .split(/\n{2,}/)
      .map(par => `<p style="margin:0 0 14px;line-height:1.6;color:#1a1a1a">${escapeHtml(par).replace(/\n/g, "<br>")}</p>`)
      .join("")
  });
}

/*
  Runs async tasks with at most `limit` in flight.

  Each email opens its own SMTP connection (platformMail builds a fresh
  transporter per message), so the batch size doubles as the peak number of
  concurrent connections to the mail provider. Keeping it small avoids the
  provider's per-connection throttle, which is what turns a burst into a wall
  of "too many connections" failures.
*/
async function runWithLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  });

  await Promise.all(workers);
  return results;
}

/*
  The drizzle itself. One call sends at most `batchSize` emails, spread across
  every campaign whose gap has elapsed, then sets each campaign's nextSendAt.
  Safe to invoke every minute: a second call while one is still sending returns
  immediately, so a slow SMTP handshake cannot double-send a batch.

  The whole state change is written once at the end. That matters because the
  queue lives in a JSON file: reading, sending and writing once per email would
  let two parallel sends clobber each other's bookkeeping.
*/
export async function drizzleMarketingQueue() {
  if (drizzleInFlight) return { sent: 0, reason: "already_running" };

  drizzleInFlight = true;
  try {
    return await runDrizzle();
  } finally {
    drizzleInFlight = false;
  }
}

async function runDrizzle() {
  const data = readData();
  const now = Date.now();
  const settings = readSettings(data);
  const gapMs = settings.drizzleMinutes * 60000;

  const active = data.campaigns.filter(c => c.status === "queued" || c.status === "sending");
  if (active.length === 0) return { sent: 0, reason: "no_active_campaign" };

  let dirty = false;
  for (const campaign of active) {
    if (campaign.status === "queued") {
      campaign.status = "sending";
      campaign.startedAt = campaign.startedAt || new Date(now).toISOString();
      dirty = true;
    }
  }

  const due = active.filter(campaign => campaignOverdue(campaign, now));

  /*
    Round-robin, not sequential: with two campaigns running, a 500-recipient
    one would otherwise consume the entire per-tick budget every minute and the
    small one would never send.
  */
  const pools = due.map(campaign => ({
    campaign,
    entries: (campaign.queue || []).filter(e => e.status === "pending")
  }));

  const jobs = [];
  for (let round = 0; jobs.length < settings.batchSize; round++) {
    let picked = false;
    for (const pool of pools) {
      if (jobs.length >= settings.batchSize) break;
      const entry = pool.entries[round];
      if (!entry) continue;
      jobs.push({ campaign: pool.campaign, entry });
      picked = true;
    }
    if (!picked) break;
  }

  if (jobs.length === 0) {
    for (const campaign of active) {
      const before = campaign.status;
      finalizeIfDone(campaign);
      if (campaign.status !== before) dirty = true;
    }
    if (dirty) writeData(data);
    return {
      sent: 0,
      reason: due.length ? "queue_empty" : "waiting_for_next_slot",
      nextSendAt: due[0] ? due[0].nextSendAt : ""
    };
  }

  /*
    Two campaigns can address the same person (an "all users" broadcast created
    next to a "free users" one). Send once per tick and retire the duplicate
    entry, so nobody receives the same email twice in the same minute.
  */
  const seenEmails = new Set();
  const sendJobs = [];
  for (const job of jobs) {
    const key = String(job.entry.email || "").toLowerCase();
    if (key && seenEmails.has(key)) {
      job.entry.status = "skipped";
      job.entry.sentAt = new Date(now).toISOString();
      job.entry.error = "duplicate address in another active campaign";
      dirty = true;
      continue;
    }
    if (key) seenEmails.add(key);
    sendJobs.push(job);
  }

  /*
    Personalize from the LIVE user record, not the snapshot taken when the
    campaign was queued. A campaign can run for days, so a recipient who
    changed their name - or whose name was blank at snapshot time - must still
    get their current first name. We fall back to the queue entry's own name
    (kept for exactly this case: a user deleted from the store) and then to the
    shared "there" default.
  */
  const usersById = new Map((readAuthStore().users || []).map(u => [u.id, u]));

  const results = await runWithLimit(
    sendJobs.map(job => async () => {
      const recipient = usersById.get(job.entry.userId) || job.entry;
      const { subject, text } = personalizeMail(
        { subject: job.campaign.subject, body: job.campaign.body },
        recipient
      );

      try {
        await sendPlatformMail({
          to: job.entry.email,
          subject,
          text,
          html: campaignHtml(subject, text),
          purpose: "campaign",
          unsubscribe: true
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err.message || err).slice(0, 200) };
      }
    }),
    sendJobs.length
  );

  const sentAt = new Date().toISOString();
  const touched = new Set();

  sendJobs.forEach((job, index) => {
    const result = results[index] || { ok: false, error: "send did not run" };
    const campaign = job.campaign;

    job.entry.status = result.ok ? "sent" : "failed";
    job.entry.sentAt = sentAt;
    job.entry.error = result.ok ? "" : result.error;

    campaign.sent = (campaign.sent || 0) + (result.ok ? 1 : 0);
    campaign.failed = (campaign.failed || 0) + (result.ok ? 0 : 1);
    campaign.lastSentAt = sentAt;
    touched.add(campaign.id);

    logSend(data, {
      campaignId: campaign.id,
      userId: job.entry.userId,
      email: job.entry.email,
      status: job.entry.status,
      sentAt,
      error: job.entry.error
    });
  });

  const nextSendAt = new Date(Date.now() + gapMs).toISOString();
  for (const campaign of active) {
    if (touched.has(campaign.id)) campaign.nextSendAt = nextSendAt;
    finalizeIfDone(campaign);
  }

  writeData(data);

  const sent = sendJobs.filter((_job, index) => results[index] && results[index].ok).length;

  return {
    sent,
    failed: sendJobs.length - sent,
    batch: sendJobs.length,
    campaigns: [...touched],
    nextSendAt
  };
}

export function registerMarketingRoutes(app) {
  app.get("/api/admin/email-templates", requireAdmin, (_req, res) => {
    const data = readData();
    res.json({ ok: true, templates: data.templates });
  });

  app.put("/api/admin/email-templates/:id", requireAdmin, (req, res) => {
    const data = readData();
    const template = data.templates.find(t => t.id === req.params.id);
    if (!template) return res.status(404).json({ error: "Template not found" });

    const { name, subject, body } = req.body || {};
    if (name !== undefined) template.name = String(name).slice(0, 120);
    if (subject !== undefined) {
      const s = String(subject).trim();
      if (!s) return res.status(400).json({ error: "Subject cannot be empty" });
      template.subject = s.slice(0, 200);
    }
    if (body !== undefined) {
      const b = String(body).trim();
      if (!b) return res.status(400).json({ error: "Body cannot be empty" });
      template.body = b.slice(0, 20000);
    }
    template.updatedAt = new Date().toISOString();
    writeData(data);
    res.json({ ok: true, template });
  });

  app.post("/api/admin/email-templates", requireAdmin, (req, res) => {
    const { name, subject, body } = req.body || {};
    const s = String(subject || "").trim();
    const b = String(body || "").trim();
    if (!s || !b) return res.status(400).json({ error: "Subject and body are required" });

    const data = readData();
    const template = {
      id: "tpl_" + crypto.randomBytes(6).toString("hex"),
      name: String(name || "Untitled template").slice(0, 120),
      subject: s.slice(0, 200),
      body: b.slice(0, 20000),
      updatedAt: new Date().toISOString()
    };
    data.templates.push(template);
    writeData(data);
    res.json({ ok: true, template });
  });

  app.post("/api/admin/email-campaigns", requireAdmin, (req, res) => {
    const { templateId, segment, subject, body } = req.body || {};
    const seg = SEGMENTS.includes(segment) ? segment : "all";

    let finalSubject = String(subject || "").trim();
    let finalBody = String(body || "").trim();

    if (templateId) {
      const data0 = readData();
      const template = data0.templates.find(t => t.id === templateId);
      if (!template) return res.status(404).json({ error: "Template not found" });
      finalSubject = template.subject;
      finalBody = template.body;
    }
    if (!finalSubject || !finalBody) {
      return res.status(400).json({ error: "Subject and body are required (pick a template or write inline)" });
    }

    const targets = targetUsersForSegment(seg);
    if (targets.length === 0) {
      return res.status(400).json({ error: `No users match the "${segmentLabel(seg)}" segment` });
    }

    const data = readData();
    const now = Date.now();

    const activeCampaigns = data.campaigns.filter(
      c => c.status === "queued" || c.status === "sending" || c.status === "paused"
    );
    if (activeCampaigns.length >= MAX_ACTIVE_CAMPAIGNS) {
      return res.status(429).json({
        error: `${activeCampaigns.length} campaigns are already in flight (max ${MAX_ACTIVE_CAMPAIGNS}). Finish or cancel one first.`
      });
    }

    /*
      Concurrent campaigns share one per-tick sending budget, so they are only
      useful for different audiences. Trim anyone this campaign would reach
      twice: a pending entry in another running campaign, or a campaign email
      delivered in the last day. Without this, an "all users" and a "free users"
      broadcast started together would hit every free user twice within minutes,
      which is the fastest way to land in spam.
    */
    const queuedElsewhere = new Set();
    for (const campaign of activeCampaigns) {
      for (const entry of campaign.queue || []) {
        if (entry.status === "pending") queuedElsewhere.add(String(entry.email || "").toLowerCase());
      }
    }

    const recentlyMailed = new Set(
      (data.sendLog || [])
        .filter(entry => entry.status === "sent" && now - Date.parse(entry.sentAt || 0) < RECENTLY_MAILED_MS)
        .map(entry => String(entry.email || "").toLowerCase())
    );

    const recipients = targets.filter(target => {
      const key = String(target.email || "").toLowerCase();
      return !queuedElsewhere.has(key) && !recentlyMailed.has(key);
    });
    const skipped = targets.length - recipients.length;

    if (recipients.length === 0) {
      return res.status(400).json({
        error: `Every user in "${segmentLabel(seg)}" is already in a running campaign or was emailed in the last 24 hours. Nothing new to send.`
      });
    }

    const campaign = {
      id: "camp_" + crypto.randomBytes(8).toString("hex"),
      templateId: templateId || "",
      segment: seg,
      subject: finalSubject.slice(0, 200),
      body: finalBody.slice(0, 20000),
      status: "queued",
      createdAt: new Date(now).toISOString(),
      startedAt: "",
      completedAt: "",
      total: recipients.length,
      skipped,
      sent: 0,
      failed: 0,
      lastSentAt: "",
      nextSendAt: new Date(now).toISOString(),
      queue: recipients.map(t => ({ ...t, status: "pending", sentAt: "", error: "" }))
    };

    data.campaigns.push(campaign);
    writeData(data);

    const settings = readSettings(data);
    res.json({
      ok: true,
      campaign: publicCampaign(campaign),
      skipped,
      settings,
      drizzle: `Sends up to ${settings.batchSize} email${settings.batchSize === 1 ? "" : "s"} every ${settings.drizzleMinutes} minutes (~${emailsPerHour(settings)}/hour). SMTP ${platformSmtpConfigured() ? "configured" : "not configured (DEV mode - emails print to the server console)"}`
    });
  });

  /*
    Sending cadence controls. Stored in marketing.json rather than .env so the
    dashboard can change throughput while a campaign is mid-flight; the drainer
    reads the settings fresh on every tick.
  */
  app.put("/api/admin/email-campaign-settings", requireAdmin, (req, res) => {
    const data = readData();
    const current = readSettings(data);
    const { drizzleMinutes, batchSize } = req.body || {};

    const next = {
      drizzleMinutes: drizzleMinutes === undefined ? current.drizzleMinutes : normalizeMinutes(drizzleMinutes),
      batchSize: batchSize === undefined ? current.batchSize : normalizeBatch(batchSize)
    };

    data.settings = next;
    writeData(data);

    res.json({ ok: true, settings: next, perHour: emailsPerHour(next) });
  });

  app.get("/api/admin/email-campaigns", requireAdmin, (_req, res) => {
    const data = readData();
    const settings = readSettings(data);
    res.json({
      ok: true,
      smtpConfigured: platformSmtpConfigured(),
      settings,
      perHour: emailsPerHour(settings),
      drizzleMinutes: settings.drizzleMinutes,
      batchSize: settings.batchSize,
      maxActiveCampaigns: MAX_ACTIVE_CAMPAIGNS,
      campaigns: data.campaigns
        .slice()
        .reverse()
        .map(publicCampaign)
    });
  });

  app.post("/api/admin/email-campaigns/:id/pause", requireAdmin, (req, res) => {
    const data = readData();
    const campaign = data.campaigns.find(c => c.id === req.params.id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status !== "queued" && campaign.status !== "sending") {
      return res.status(400).json({ error: "Only active campaigns can be paused" });
    }
    campaign.status = "paused";
    writeData(data);
    res.json({ ok: true, campaign: publicCampaign(campaign) });
  });

  app.post("/api/admin/email-campaigns/:id/resume", requireAdmin, (req, res) => {
    const data = readData();
    const campaign = data.campaigns.find(c => c.id === req.params.id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status !== "paused") return res.status(400).json({ error: "Only paused campaigns can be resumed" });
    campaign.status = "queued";
    campaign.nextSendAt = new Date().toISOString();
    writeData(data);
    res.json({ ok: true, campaign: publicCampaign(campaign) });
  });

  app.post("/api/admin/email-campaigns/:id/cancel", requireAdmin, (req, res) => {
    const data = readData();
    const campaign = data.campaigns.find(c => c.id === req.params.id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status === "completed" || campaign.status === "cancelled") {
      return res.status(400).json({ error: "Campaign already finished" });
    }
    campaign.status = "cancelled";
    campaign.completedAt = new Date().toISOString();
    writeData(data);
    res.json({ ok: true, campaign: publicCampaign(campaign) });
  });
}

function publicCampaign(c) {
  return {
    id: c.id,
    templateId: c.templateId,
    segment: c.segment,
    segmentLabel: segmentLabel(c.segment),
    subject: c.subject,
    status: c.status,
    createdAt: c.createdAt,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
    total: c.total,
    skipped: c.skipped || 0,
    sent: c.sent,
    failed: c.failed,
    lastSentAt: c.lastSentAt,
    nextSendAt: c.nextSendAt,
    pending: (c.queue || []).filter(e => e.status === "pending").length
  };
}
