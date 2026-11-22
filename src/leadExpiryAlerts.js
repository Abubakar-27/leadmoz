import fs from "fs";
import path from "path";
import { requireAdmin } from "./auth.js";
import { readAuthStore } from "./authStore.js";
import { readDb, LEAD_TTL_MS } from "./store.js";
import { sendPlatformMail, personalizeMail, resolveFirstName, wrapMailHtml, escapeHtml, fillPlaceholders, siteUrl } from "./platformMail.js";

/*
  20-hour lead expiry alerts (transactional, immediate).

  Every hour, find users whose dashboard leads are exactly 20 hours old -
  four hours before the 24h TTL wipes them - and email THAT user directly.
  This is a user's own data alert, not marketing: it sends immediately and
  never joins the throttled campaign drizzle (marketingCampaigns.js).

  Dedupe: one alert per user per 20 hours, recorded in
  data/expiry-alerts.json. Without it the hourly sweep would re-email the
  same user for every hour the leads stay inside the 20h-24h window.
*/

const DATA_DIR = path.join(process.cwd(), "data");
const ALERTS_FILE = path.join(DATA_DIR, "expiry-alerts.json");

const ALERT_WINDOW_START_MS = 20 * 60 * 60 * 1000;
const ALERT_RESEND_GUARD_MS = 20 * 60 * 60 * 1000;

function emptyAlerts() {
  return { version: 1, sent: {} };
}

function readAlerts() {
  try {
    const data = JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8"));
    if (data && typeof data.sent === "object" && data.sent) return data;
  } catch {
    /* first run or unreadable file - start clean */
  }
  return emptyAlerts();
}

function writeAlerts(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ALERTS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, ALERTS_FILE);
}

function leadAgeMs(lead, job, now) {
  const value = new Date(lead?.createdAt || job?.createdAt || 0).getTime();
  return Number.isFinite(value) ? now - value : Infinity;
}

/*
  The alert body is written in the SAME {First_Name} template dialect as the
  marketing campaigns, so a single parsing rule (platformMail.personalizeMail)
  drives every transactional and bulk message. The tag is substituted per
  recipient immediately before send.
*/
function alertTemplate({ leadCount }) {
  const upgradeUrl = `${siteUrl()}/checkout?plan=starter`;
  const dashboardUrl = `${siteUrl()}/app`;
  const body = `Hi {First_Name},

The ${leadCount} premium B2B leads you generated are scheduled to wipe from your dashboard in exactly 4 hours.

Don't let your prospecting workflow go to waste. If you leave them there, they disappear forever. You have two options right now:

- Option A: Log into your dashboard and manually copy them row-by-row before they expire.
- Option B: Upgrade to Starter for just $19 and instantly unlock permanent campaign history and clean CSV exports.

Why pay an enterprise tax to Apollo or ZoomInfo when you can get the exact same verified data right here for a fraction of the price?

Save my leads: ${dashboardUrl}
Upgrade to Starter: ${upgradeUrl}

The Leadmoz team`;

  const subject = `\u26a0\ufe0f Your ${leadCount} premium leads are about to expire...`;
  const preheader = `Your ${leadCount} premium leads are about to expire`;

  const bodyHtml = `
<p style="margin:0 0 14px;line-height:1.6;color:#1a1a1a">Hi {First_Name},</p>
<p style="margin:0 0 14px;line-height:1.6;color:#1a1a1a">The <strong>${escapeHtml(leadCount)} premium B2B leads</strong> you generated are scheduled to wipe from your dashboard in <strong>exactly 4 hours</strong>.</p>
<p style="margin:0 0 14px;line-height:1.6;color:#1a1a1a">Don't let your prospecting workflow go to waste. If you leave them there, they disappear forever. You have two options right now:</p>
<p style="margin:0 0 6px;line-height:1.6;color:#1a1a1a"><strong>Option A:</strong> Log into your dashboard and manually copy them before they expire.</p>
<p style="margin:0 0 16px;line-height:1.6;color:#1a1a1a"><strong>Option B:</strong> Upgrade to Starter for just $19 and instantly unlock permanent campaign history and clean CSV exports.</p>
<p style="margin:0 0 18px;line-height:1.6;color:#1a1a1a">Why pay an enterprise tax to Apollo or ZoomInfo when you can get the exact same verified data right here for a fraction of the price?</p>
<p style="margin:0 0 10px"><a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#181825;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">Open my dashboard</a></p>
<p style="margin:0 0 4px"><a href="${escapeHtml(upgradeUrl)}" style="display:inline-block;background:#f69251;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">Save my leads &amp; upgrade — $19</a></p>`;

  return { subject, body, preheader, bodyHtml };
}

/*
  The hourly sweep. Returns { checked, alerted, skipped } and never throws -
  the interval caller in server.js only logs the summary.
*/
export async function runExpiryAlertSweep() {
  const db = readDb();
  const now = Date.now();
  const alerts = readAlerts();
  const users = readAuthStore().users || [];
  const usersById = new Map(users.map(u => [u.id, u]));

  const perUser = new Map();

  for (const jobId of Object.keys(db.jobs || {})) {
    const job = db.jobs[jobId];
    if (!job || !job.userId) continue;

    for (const lead of job.leads || []) {
      const age = leadAgeMs(lead, job, now);
      if (age < ALERT_WINDOW_START_MS || age >= LEAD_TTL_MS) continue;
      perUser.set(job.userId, (perUser.get(job.userId) || 0) + 1);
    }
  }

  let alerted = 0;
  let skipped = 0;

  for (const [userId, leadCount] of perUser) {
    const last = alerts.sent[userId];
    if (last && now - Date.parse(last) < ALERT_RESEND_GUARD_MS) {
      skipped += 1;
      continue;
    }

    const user = usersById.get(userId);
    if (!user || !user.email) {
      skipped += 1;
      continue;
    }

    /*
      Personalize from the live user record at send time. The salutation and
      any {First_Name} tag in the body resolve through the shared engine, so
      this transactional alert personalizes identically to the marketing
      broadcasts.
    */
    const tpl = alertTemplate({ leadCount });
    const { subject, text } = personalizeMail({ subject: tpl.subject, body: tpl.body }, user);
    const vars = { First_Name: resolveFirstName(user) };
    const html = wrapMailHtml({
      preheader: fillPlaceholders(tpl.preheader, vars),
      bodyHtml: fillPlaceholders(tpl.bodyHtml, vars)
    });

    try {
      await sendPlatformMail({
        to: user.email,
        subject,
        text,
        html,
        purpose: "lead-expiry-alert"
      });
      alerts.sent[userId] = new Date(now).toISOString();
      alerted += 1;
    } catch (err) {
      console.error(`[expiry-alert] send to ${user.email} failed:`, err.message);
      skipped += 1;
    }
  }

  writeAlerts(alerts);
  return { checked: perUser.size, alerted, skipped };
}

export function registerExpiryAlertRoutes(app) {
  /*
    Manual trigger for development and ops: runs the sweep immediately and
    reports what it found. Admin-only; the interval in server.js runs the
    same function every hour.
  */
  app.post("/api/admin/expiry-alerts/run", requireAdmin, async (_req, res) => {
    try {
      const result = await runExpiryAlertSweep();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });
}
