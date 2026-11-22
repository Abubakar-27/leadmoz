import nodemailer from "nodemailer";

/*
  Platform-owned outbound email.

  Two traffic classes share this sender but never share a queue:
    - transactional  (expiry alerts, etc.) send immediately; they are about the
                      user's own data and must not wait behind marketing.
    - marketing       (campaign broadcasts) go through the 30-minute drizzle in
                      marketingCampaigns.js, which calls sendPlatformMail one
                      recipient at a time.

  In development (SMTP_* unset) every send is printed to the console with a
  clear DEV banner instead of silently disappearing, mirroring how auth OTP
  codes degrade (src/auth.js sendCodeEmail).
*/

export function platformSmtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function platformFrom() {
  const name = process.env.SMTP_FROM_NAME || "Leadmoz";
  const user = process.env.SMTP_USER || "";
  const email = process.env.SMTP_FROM_EMAIL || user;
  return `"${name}" <${email}>`;
}

/*
  The address replies land on. Defaults to the configured sender so at least
  it is a monitored inbox; can be overridden with SMTP_REPLY_TO.
*/
export function platformReplyTo() {
  return String(process.env.SMTP_REPLY_TO || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "").trim();
}

/*
  Public site base for every link we put in an email. NEVER emit a localhost
  URL in an outbound message - it is one of the strongest spam heuristics Gmail
  applies. Falls back to the canonical production host, not the dev port.
*/
export const CANONICAL_SITE_URL = "https://leadmoz.com";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bodyToHtml(text) {
  const safe = escapeHtml(String(text || "").trim());
  const linked = safe.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#f69251;font-weight:600">$1</a>'
  );
  return linked
    .split(/\n{2,}/)
    .map(par => `<p style="margin:0 0 14px;line-height:1.6;color:#1a1a1a">${par.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/*
  Wrap a plain-text marketing/transactional body in a minimal branded shell.
  Callers pass the human-written copy; this only adds the letterhead.
*/
export function wrapMailHtml({ preheader = "", bodyHtml = "" }) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f7">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(preheader)}</div>
  <div style="max-width:560px;margin:0 auto;padding:28px 20px;font-family:Arial,Helvetica,sans-serif">
    <div style="font-size:20px;font-weight:800;color:#181825;margin-bottom:18px">Lead<span style="color:#f69251"> io</span></div>
    <div style="background:#ffffff;border:1px solid #e7e7ee;border-radius:14px;padding:26px 24px">
      ${bodyHtml}
    </div>
    <p style="font-size:11px;color:#8a8a99;margin-top:16px;line-height:1.5">
      You are receiving this email because you have a Leadmoz account.
      <a href="${escapeHtml(siteUrl())}/settings" style="color:#8a8a99">Email preferences</a> ·
      <a href="${escapeHtml(siteUrl())}/refund" style="color:#8a8a99">Refunds</a>
    </p>
  </div>
</body></html>`;
}

export function siteUrl() {
  const explicit = String(process.env.SITE_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  return CANONICAL_SITE_URL;
}

/*
  Send one email now. Throws on SMTP failure so the caller can record the
  per-recipient failure; in dev mode it always resolves with dev:true.
*/
export async function sendPlatformMail({ to, subject, text, html, purpose = "mail", unsubscribe = false }) {
  if (!to) throw new Error("sendPlatformMail: missing recipient");

  if (!platformSmtpConfigured()) {
    console.log("");
    console.log("=================================================");
    console.log(`DEV ${purpose.toUpperCase()} EMAIL to ${to}`);
    console.log(`Subject: ${subject}`);
    console.log("-------------------------------------------------");
    console.log(String(text || "").slice(0, 2000));
    console.log("=================================================");
    console.log("");
    return { ok: true, dev: true };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  /*
    Deliverability hygiene. Multipart (text + html) is a positive signal, so we
    never send html-only. Reply-To points at a monitored inbox. Bulk/marketing
    mail carries a List-Unsubscribe one-click header, which Gmail and Outlook
    weigh heavily when deciding to file a message under Promotions vs Spam.
  */
  const headers = {};
  const replyTo = platformReplyTo();
  if (replyTo) headers["Reply-To"] = replyTo;
  if (unsubscribe) {
    const unsubUrl = `${siteUrl()}/settings`;
    headers["List-Unsubscribe"] = `<${unsubUrl}>, <mailto:${replyTo || (process.env.SMTP_USER || "")}?subject=unsubscribe>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  await transporter.sendMail({
    from: platformFrom(),
    to,
    subject,
    text: text || "",
    html: html || wrapMailHtml({ preheader: subject, bodyHtml: bodyToHtml(text || "") }),
    headers
  });

  return { ok: true, dev: false };
}

/*
  Replace {First_Name} / {first_name} style placeholders. Matching is
  case-insensitive (\{tag\} is rewritten regardless of case) and every
  occurrence is replaced. Anything not present in `vars` is left untouched so
  a typo stays visible in the admin preview instead of silently blanking.
*/
export function fillPlaceholders(template, vars) {
  let out = String(template ?? "");
  for (const [name, value] of Object.entries(vars)) {
    const pattern = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const replacement = String(value ?? "").replace(/\$/g, "$$$$");
    out = out.replace(new RegExp(`\\{${pattern}\\}`, "gi"), replacement);
  }
  return out;
}

const FIRST_NAME_FALLBACK = "there";

/*
  Resolve the personalization name for a user record, in strict precedence:
    first_name  ->  username  ->  name  ->  "there"

  Every value is trimmed and only accepted if non-blank, so a record that
  carries an empty string in one field still falls through to the next. This is
  the single source of truth for per-recipient salutations; both the marketing
  drizzle and the expiry alerts call it, which guarantees every outgoing
  message is addressed to the specific user or the neutral fallback.
*/
export function resolveFirstName(user) {
  const candidates = [user?.first_name, user?.firstName, user?.username, user?.name];
  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim();
    if (value) return value.split(/\s+/)[0];
  }
  return FIRST_NAME_FALLBACK;
}

export function firstNameOf(user) {
  return resolveFirstName(user);
}

/*
  Build the placeholder map shared by every template render. Callers pass the
  full user record (transactional) or a queue entry (marketing); either way the
  salutation resolves through resolveFirstName so the behaviour is identical
  across both mail classes.
*/
export function personalizationVars(user, extra = {}) {
  return { First_Name: resolveFirstName(user), ...extra };
}

/*
  Render a {First_Name} template with a per-recipient substitution applied to
  BOTH the subject and the body. Returns { subject, text } ready to hand to
  sendPlatformMail, so no caller can accidentally personalize one and not the
  other.
*/
export function personalizeMail({ subject, body }, user, extra = {}) {
  const vars = personalizationVars(user, extra);
  return {
    subject: fillPlaceholders(subject, vars),
    text: fillPlaceholders(body, vars)
  };
}
