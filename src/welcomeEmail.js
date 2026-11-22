import fs from "fs";
import path from "path";
import { sendPlatformMail, personalizeMail, resolveFirstName, wrapMailHtml, escapeHtml, fillPlaceholders, siteUrl } from "./platformMail.js";
import { introCreditAmount } from "./creditLedger.js";

/*
  Signup welcome email (transactional).

  Fires exactly once, the moment an account first comes into existence through a
  verified path (onAccountCreated in auth.js covers both email and Google).
  Deliverability note: this is a transactional message - it is about the account
  the recipient just created - so it sends immediately and never joins the
  30-minute marketing drizzle.

  Idempotency: the send is recorded in data/welcome-emails.json keyed by user id.
  onAccountCreated already runs once per account, but the guard means a retry,
  a duplicate hook, or an admin replay can never double-welcome a user.
*/

const DATA_DIR = path.join(process.cwd(), "data");
const WELCOME_FILE = path.join(DATA_DIR, "welcome-emails.json");

function emptyLedger() {
  return { version: 1, sent: {} };
}

function readLedger() {
  try {
    const data = JSON.parse(fs.readFileSync(WELCOME_FILE, "utf8"));
    if (data && typeof data.sent === "object" && data.sent) return data;
  } catch {
    /* first run or unreadable file - start clean */
  }
  return emptyLedger();
}

function writeLedger(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = WELCOME_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, WELCOME_FILE);
}

/*
  The welcome copy is written in the SAME {First_Name} template dialect as the
  marketing campaigns and the expiry alerts, so one parsing rule
  (platformMail.personalizeMail) drives every message. The tag resolves per
  recipient at send time from the live user record.
*/
export function welcomeTemplate({ credits = 10 } = {}) {
  const dashboardUrl = `${siteUrl()}/app`;
  const upgradeUrl = `${siteUrl()}/checkout?plan=starter`;

  const subject = `Welcome to Leadmoz, {First_Name}`;

  const body = `Hi {First_Name},

Welcome to Leadmoz - you're in.

Here's what you've got right now:

- ${credits} free lead credits, ready to spend on your first search.
- A live dashboard that fills with verified B2B leads the moment a scrape finishes.
- Leads stay on your dashboard for 24 hours, so you have a full day to work them.

Two things worth knowing up front:

1. Your leads live for 24 hours. Work them, or copy them out, before they expire.
2. CSV export and permanent campaign history are part of Starter ($19/mo) - everything else works on the free tier.

Start your first search: ${dashboardUrl}
See Starter ($19/mo): ${upgradeUrl}

If you ever need a hand, just reply to this email - it comes straight to us.

The Leadmoz team`;

  const preheader = `Your ${credits} free lead credits are ready`;

  const bodyHtml = `
<p style="margin:0 0 14px;line-height:1.6;color:#1a1a1a">Hi {First_Name},</p>
<p style="margin:0 0 16px;line-height:1.6;color:#1a1a1a">Welcome to <strong>Leadmoz</strong> - you're in.</p>
<p style="margin:0 0 6px;line-height:1.6;color:#1a1a1a">Here's what you've got right now:</p>
<p style="margin:0 0 4px;line-height:1.6;color:#1a1a1a">• <strong>${escapeHtml(credits)} free lead credits</strong>, ready to spend on your first search.</p>
<p style="margin:0 0 4px;line-height:1.6;color:#1a1a1a">• A live dashboard that fills with verified B2B leads the moment a scrape finishes.</p>
<p style="margin:0 0 16px;line-height:1.6;color:#1a1a1a">• Leads stay on your dashboard for <strong>24 hours</strong>, so you have a full day to work them.</p>
<p style="margin:0 0 6px;line-height:1.6;color:#1a1a1a">Two things worth knowing up front:</p>
<p style="margin:0 0 4px;line-height:1.6;color:#1a1a1a"><strong>1.</strong> Your leads live for 24 hours. Work them, or copy them out, before they expire.</p>
<p style="margin:0 0 18px;line-height:1.6;color:#1a1a1a"><strong>2.</strong> CSV export and permanent campaign history are part of Starter ($19/mo) - everything else works on the free tier.</p>
<p style="margin:0 0 10px"><a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#181825;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">Start my first search</a></p>
<p style="margin:0 0 4px"><a href="${escapeHtml(upgradeUrl)}" style="display:inline-block;background:#f69251;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">See Starter — $19/mo</a></p>
<p style="margin:18px 0 0;line-height:1.6;color:#1a1a1a">If you ever need a hand, just reply to this email - it comes straight to us.</p>`;

  return { subject, body, preheader, bodyHtml };
}

/*
  Send the welcome email to one freshly-created user. Never throws: a mail
  failure must not roll back or break signup, so it is fire-and-forget from the
  caller's point of view. Returns { sent, reason } for logging and tests.
*/
export async function sendWelcomeEmail(user, { force = false } = {}) {
  if (!user || !user.email) return { sent: false, reason: "no_recipient" };

  const ledger = readLedger();
  if (!force && ledger.sent[user.id]) return { sent: false, reason: "already_sent" };

  const credits = introCreditAmount();
  const tpl = welcomeTemplate({ credits });
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
      purpose: "welcome"
    });
    ledger.sent[user.id] = new Date().toISOString();
    writeLedger(ledger);
    return { sent: true, reason: "sent" };
  } catch (err) {
    console.error(`[welcome] send to ${user.email} failed:`, err.message);
    return { sent: false, reason: "send_failed" };
  }
}
