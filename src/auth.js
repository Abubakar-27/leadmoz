import nodemailer from "nodemailer";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import {
  createEmailUserWithPassword,
  createOrUpdateGoogleUser,
  createSession,
  deleteSession,
  getSessionUser,
  saveEmailCode,
  verifyEmailCode,
  hasVerifiedCode,
  consumeVerifiedCode,
  normalizeEmail,
  getUserByEmail,
  getUserUsage,
  addUserUsage,
  getAllUsers,
  getAllUsage,
  publicUser,
  updateUserPassword,
  verifyPassword,
  requestUserPlan,
  setLifetimeTier,
  readAuth,
  writeAuth,
  getPlanExpiryInfo,
  ensureRefCode,
  resolveRefCode
} from "./authStore.js";
import { PLANS, PAID_PLANS, getDailyLeadLimitForUser, getPlanForUser, getPlanPrice, planCatalog } from "./plans.js";
import { readDb, dbSummary } from "./store.js";
import { commissionsForReferrer, getRefUrl } from "./referrals.js";
import { validatePromo } from "./promoCodes.js";
import { getSumoCode, claimSumoCode } from "./appsumoCodes.js";
import { creditSnapshot, maybeGrantIntroCredits } from "./creditPolicy.js";
import { trackEvent, attributeEvents } from "./analytics.js";
import { recordIntentEmail } from "./paymentIntent.js";
import { consumeRate, abuseLimits, ensureDeviceCookie, registerDevice, deviceIdFromRequest, hashDeviceId } from "./abuseGuard.js";
import { sendWelcomeEmail } from "./welcomeEmail.js";

const COOKIE_NAME = "cf_session";

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

function canAttributeRef(refCode, refereeEmail, ip) {
  const referrer = refCode ? resolveRefCode(refCode) : null;
  if (!referrer) return { referrer: null, reason: "invalid" };
  if (normalizeEmail(refereeEmail) === referrer.email) return { referrer: null, reason: "self_email" };
  if (referrer.signupIp && ip && referrer.signupIp === ip) return { referrer: null, reason: "self_ip" };
  return { referrer, reason: "" };
}

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header.split(";").map(v => v.trim()).filter(Boolean).map(v => {
      const index = v.indexOf("=");
      return [decodeURIComponent(v.slice(0, index)), decodeURIComponent(v.slice(index + 1))];
    })
  );
}
function setSessionCookie(res, session) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(session.token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${session.maxAgeSeconds}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}
function isValidPassword(password = "") {
  return String(password).length >= 8;
}

/*
  Apply a rate check and, if the caller is over the limit, send a 429 and return
  true so the route can bail. The message never mentions the internal key or
  threshold; it just tells the user to slow down.
*/
function rejectIfRateLimited(res, check, message) {
  if (check.allowed) return false;
  res.status(429).json({
    ok: false,
    code: "RATE_LIMITED",
    error: message,
    retryInMinutes: Math.max(1, Math.ceil(check.retryAfterMs / 60000))
  });
  return true;
}

/*
  Everything that should happen exactly once when an account first comes into
  existence through a verified path: grant the intro credits, tie the account
  to its first-party device signal, and record the funnel events.

  must run AFTER the session cookie is set, because it may append a device
  cookie to the same response header.
*/
function onAccountCreated(user, req, res, { provider }) {
  const grant = maybeGrantIntroCredits(user);
  if (grant.granted) {
    trackEvent("free_credits_granted", { userId: user.id, meta: { amount: grant.amount, provider } });
  }

  const deviceId = ensureDeviceCookie(req, res);
  if (deviceId) {
    const reg = registerDevice(deviceId, user.id);
    /*
      Attribute whatever this visitor did while anonymous (the beacon stores the
      same hashed device handle as its session id) to the account they just
      created, so pricing/checkout steps taken before signup are credited.
    */
    attributeEvents(hashDeviceId(deviceId), user.id);
    const max = abuseLimits().deviceAccountsMax;
    if (max > 0 && reg.accounts > max) {
      console.warn(
        `[abuse] device ${String(reg.deviceHash).slice(0, 12)} now linked to ${reg.accounts} accounts (threshold ${max})`
      );
    }
  }

  trackEvent("signup_completed", { userId: user.id, meta: { provider } });
  trackEvent("email_verified", { userId: user.id, meta: { provider } });

  /*
    Welcome email. Transactional, exactly-once (guarded inside welcomeEmail.js),
    and fire-and-forget: SMTP latency must never hold up the signup response and
    a send failure must never fail the account creation. In dev mode the send is
    printed to the console instead.
  */
  sendWelcomeEmail(user).catch(err => console.error("[welcome] unexpected failure:", err.message));
}
export function getAuthUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  return getSessionUser(token);
}
export function requireAuth(req, res, next) {
  const user = getAuthUser(req);
  if (!user) {
    if (req.path.endsWith(".html") || req.headers.accept?.includes("text/html")) return res.redirect("/auth");
    return res.status(401).json({ error: "Authentication required" });
  }
  req.user = user;
  next();
}
export function requireAdmin(req, res, next) {
  const user = getAuthUser(req);
  if (!user) {
    if (req.path.endsWith(".html") || req.headers.accept?.includes("text/html")) return res.redirect("/auth");
    return res.status(401).json({ error: "Authentication required" });
  }
  if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  req.user = user;
  next();
}

/*
  Server-side payment-intent tracking.

  The marketing "Get Starter/Pro/Agency" buttons link to /auth?plan=<paid>, so a
  buyer has entered the payment flow the moment that page is served. Recording
  it here - rather than only via the client beacon on /checkout - attributes the
  visitor reliably: a signed-in visitor by user id, an anonymous one by the same
  first-party device handle the other beacons use. The device cookie is ensured
  here, so the later /checkout step is attributed to the same person rather than
  counted twice. Free signups never carry a paid plan, so they are ignored.
*/
export function recordPaymentIntent(req, res) {
  const plan = String(req.query?.plan || "").toLowerCase();
  if (!PAID_PLANS.includes(plan)) return;

  const user = getAuthUser(req);
  const token = parseCookies(req)[COOKIE_NAME] || "";
  const sessionId = token
    ? `s_${crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 24)}`
    : hashDeviceId(ensureDeviceCookie(req, res)) || "";

  trackEvent("checkout_started", {
    userId: user?.id || "",
    sessionId,
    source: req.path,
    referrer: req.get("referer") || "",
    plan,
    dedupeMs: 5000
  });
}
async function sendCodeEmail(email, code, purpose = "signup") {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.log("");
    console.log("=================================================");
    console.log(`DEV ${purpose.toUpperCase()} CODE for ${email}: ${code}`);
    console.log("SMTP is not configured, so code is printed here.");
    console.log("=================================================");
    console.log("");
    return;
  }
  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: { user, pass }
  });
  const title = purpose === "reset" ? "Reset your Leadmoz password" : "Verify your Leadmoz email";
  const line = purpose === "reset" ? "Use this code to reset your password:" : "Use this code to verify your email:";
  await transporter.sendMail({
    from: `"${process.env.SMTP_FROM_NAME || "Leadmoz"}" <${process.env.SMTP_FROM_EMAIL || user}>`,
    to: email,
    subject: title,
    text: `${line} ${code}. It expires in 10 minutes.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111"><h2>${title}</h2><p>${line}</p><div style="font-size:28px;font-weight:800;letter-spacing:4px">${code}</div><p>This code expires in 10 minutes.</p></div>`
  });
}
export function registerAuthRoutes(app) {
  app.get("/api/auth/config", (req, res) => {
    ensureDeviceCookie(req, res);
    res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || "", emailPasswordEnabled: true, emailOtpEnabled: true });
  });
  app.get("/api/auth/plans", (req, res) => {
    res.json({ plans: PLANS });
  });
  /*
    Canonical, public plan catalogue. Checkout and the pricing section read
    every displayed amount from here; the client never does its own price math.
  */
  app.get("/api/plans", (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(planCatalog());
  });
  app.get("/api/auth/me", (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ user: null });
    ensureDeviceCookie(req, res);
    /*
      Safety net: if an eligible account somehow reached here without its grant
      (an interrupted verification, a restored backup), hand it the intro
      credits now. Idempotent and eligibility-gated, so it never double-grants
      and never grants to a pre-existing account.
    */
    const grant = maybeGrantIntroCredits(user);
    if (grant.granted) {
      trackEvent("free_credits_granted", { userId: user.id, meta: { amount: grant.amount, provider: "me" } });
    }
    const leadLimit = getDailyLeadLimitForUser(user);
    const usage = getUserUsage(user.id);
    const refCode = ensureRefCode(user);
    const myRefs = commissionsForReferrer(user.id);
    res.json({
      user: publicUser(user),
      usage,
      plan: getPlanForUser(user),
      planExpiry: getPlanExpiryInfo(user),
      limits: {
        dailyLeadLimit: Math.max(1, Number(leadLimit)),
        remainingToday: Math.max(0, Number(leadLimit) - Number(usage.leadsRequested || 0))
      },
      credits: creditSnapshot(user),
      referral: {
        code: refCode,
        url: getRefUrl(refCode, `${req.protocol}://${req.get("host")}`),
        signedUp: getAllUsers().filter(u => u.referredBy === user.id).length,
        paidSignups: new Set(myRefs.map(c => c.refereeId)).size,
        pendingEarnedUsd: Number(myRefs.filter(c => c.status === "pending").reduce((s, c) => s + Number(c.commission || 0), 0).toFixed(2)),
        paidEarnedUsd: Number(myRefs.filter(c => c.status === "paid").reduce((s, c) => s + Number(c.commission || 0), 0).toFixed(2)),
        rate: 20
      }
    });
  });
  app.post("/api/auth/check-email", (req, res) => {
    const email = normalizeEmail(req.body.email || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Valid email is required" });
    const user = getUserByEmail(email);
    res.json({ exists: Boolean(user), hasPassword: Boolean(user?.hasPassword), provider: user?.provider || "" });
  });
  app.post("/api/auth/password-login", async (req, res) => {
    const email = normalizeEmail(req.body.email || "");
    const password = String(req.body.password || "");
    const remember = req.body.remember !== false;
    const user = getUserByEmail(email);
    if (!user || !user.hasPassword) return res.status(400).json({ error: "No password account found for this email" });
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Incorrect password" });
    const session = createSession(user.id, remember);
    setSessionCookie(res, session);
    res.json({ ok: true, user: publicUser(user) });
  });
  app.post("/api/auth/email/start", async (req, res) => {
    const email = normalizeEmail(req.body.email || "");
    const purpose = req.body.purpose === "reset" ? "reset" : "signup";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Valid email is required" });
    if (purpose === "signup") {
      const user = getUserByEmail(email);
      if (user?.hasPassword) return res.status(400).json({ error: "This email already has a password. Please log in." });
    }
    if (purpose === "reset" && !getUserByEmail(email)) return res.status(404).json({ error: "No account found with this email" });

    /*
      Throttle the people who can trigger an outbound email. Two independent
      limits: one per resolved address (stops a script cycling addresses) and
      one per target address (stops a script cycling its own inbox at one
      person). Neither is permanent - both are short windows.
    */
    const limits = abuseLimits();
    const ip = clientIp(req);
    if (rejectIfRateLimited(res, consumeRate(`verify-email:ip:${ip}`, limits.verifyEmailPerIpPerHour),
      "Too many verification emails requested from this connection. Please wait a little while.")) return;
    if (rejectIfRateLimited(res, consumeRate(`verify-email:addr:${email}`, limits.verifyEmailPerAddressPerHour),
      "Too many verification emails requested for this address. Please wait a little while.")) return;

    if (purpose === "signup") {
      trackEvent("signup_started", { meta: { method: "email" } });
      /*
        A paid-plan visitor is identified the moment they submit their email,
        even if they never finish signing up, so the payment-visit tracker can
        show who they are instead of a bare anonymous device.
      */
      const plan = String(req.body.plan || "").toLowerCase();
      if (PAID_PLANS.includes(plan)) {
        recordIntentEmail(hashDeviceId(ensureDeviceCookie(req, res)), email, plan);
      }
    }

    const code = randomCode();
    saveEmailCode(email, code, purpose);
    try {
      await sendCodeEmail(email, code, purpose);
      res.json({ ok: true, message: "Code sent" });
    } catch (err) {
      console.error("Email code send failed:", err);
      res.status(500).json({ error: "Could not send code. Check SMTP settings." });
    }
  });
  app.post("/api/auth/email/verify-code", (req, res) => {
    const email = normalizeEmail(req.body.email || "");
    const code = String(req.body.code || "").trim();
    const purpose = req.body.purpose === "reset" ? "reset" : "signup";
    const result = verifyEmailCode(email, code, purpose);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, message: "Code verified. Set your password." });
  });
  app.post("/api/auth/email/set-password", async (req, res) => {
    const email = normalizeEmail(req.body.email || "");
    const password = String(req.body.password || "");
    const purpose = req.body.purpose === "reset" ? "reset" : "signup";
    const remember = req.body.remember !== false;
    if (!isValidPassword(password)) return res.status(400).json({ error: "Password must be at least 8 characters" });
    if (!hasVerifiedCode(email, purpose)) return res.status(400).json({ error: "Email is not verified. Verify code first." });

    /*
      Signup burst limit, applied only where an account is actually created.
      Five a hour from one address is far above a real household and far below
      what a farming script needs.
    */
    if (purpose === "signup") {
      const limits = abuseLimits();
      if (rejectIfRateLimited(res, consumeRate(`signup:ip:${clientIp(req)}`, limits.signupPerIpPerHour),
        "Too many accounts created from this connection. Please try again later.")) return;
    }

    let user;
    if (purpose === "reset") {
      user = await updateUserPassword(email, password);
      if (!user) return res.status(404).json({ error: "No account found" });
    } else {
      const ref = canAttributeRef(req.body.ref, email, clientIp(req));
      user = await createEmailUserWithPassword({
        email,
        password,
        referredBy: ref.referrer?.id || "",
        signupIp: clientIp(req)
      });
    }
    consumeVerifiedCode(email, purpose);
    const session = createSession(user.id, remember);
    setSessionCookie(res, session);
    if (purpose === "signup") onAccountCreated(user, req, res, { provider: "email" });
    res.json({ ok: true, user: publicUser(user) });
  });
  app.post("/api/auth/google", async (req, res) => {
    const credential = req.body.credential;
    const remember = req.body.remember !== false;
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ error: "GOOGLE_CLIENT_ID is missing" });
    if (!credential) return res.status(400).json({ error: "Missing Google credential" });
    try {
      const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
      const ticket = await client.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload();
      if (!payload?.email || !payload.email_verified) return res.status(400).json({ error: "Google email is not verified" });
      const ref = canAttributeRef(req.body.ref, payload.email, clientIp(req));
      const existing = getUserByEmail(payload.email);
      if (!existing) {
        const limits = abuseLimits();
        if (rejectIfRateLimited(res, consumeRate(`signup:ip:${clientIp(req)}`, limits.signupPerIpPerHour),
          "Too many accounts created from this connection. Please try again later.")) return;
        trackEvent("signup_started", { meta: { method: "google" } });
      }
      const user = createOrUpdateGoogleUser({
        email: payload.email,
        name: payload.name || "",
        avatar: payload.picture || "",
        referredBy: ref.referrer?.id || "",
        signupIp: clientIp(req)
      });
      const session = createSession(user.id, remember);
      setSessionCookie(res, session);
      if (existing) {
        ensureDeviceCookie(req, res);
        maybeGrantIntroCredits(user);
      } else {
        onAccountCreated(user, req, res, { provider: "google" });
      }
      res.json({ ok: true, user: publicUser(user) });
    } catch (err) {
      console.error("Google auth failed:", err);
      res.status(401).json({ error: "Google sign-in failed" });
    }
  });
  app.post("/api/auth/logout", (req, res) => {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) deleteSession(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  /*
    Preview a code before the customer commits. Returns the list price, the
    discount and the amount they would actually pay, so checkout can show a real
    number instead of a placeholder.
  */
  app.get("/api/promo/validate", requireAuth, (req, res) => {
    const code = String(req.query.code || "").trim();
    const plan = String(req.query.plan || "").trim().toLowerCase();
    const billing = String(req.query.billing || "monthly").trim().toLowerCase();

    if (!PLANS[plan]) return res.status(400).json({ ok: false, reason: "Invalid plan" });

    const baseAmount = getPlanPrice(plan, billing);
    const result = validatePromo(code, baseAmount, plan, billing);

    res.json({
      ok: result.ok,
      reason: result.reason || "",
      plan,
      billing,
      listPrice: baseAmount,
      ...(result.ok
        ? { code: result.code, discount: result.discount, finalAmount: result.finalAmount }
        : {})
    });
  });

  app.post("/api/auth/plan-request", requireAuth, (req, res) => {
    const plan = String(req.body.plan || "").trim().toLowerCase();
    const billing = String(req.body.billing || "monthly").trim().toLowerCase();
    const promo = String(req.body.promo || req.body.promoCode || "").trim();
    if (!PLANS[plan]) return res.status(400).json({ error: "Invalid plan" });
    if (plan === req.user.plan) {
      return res.json({ ok: true, note: "already_active", user: publicUser(req.user) });
    }

    /*
      Reject a bad code here rather than after the transfer. Payment is manual,
      so an invalid code discovered at approval means the customer has already
      moved money and has to be told to send a different amount.
    */
    if (promo) {
      const check = validatePromo(promo, getPlanPrice(plan, billing), plan, billing);
      if (!check.ok) return res.status(400).json({ error: check.reason || "Invalid promo code" });
    }

    const user = requestUserPlan(req.user.id, plan, billing, promo);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true, user: publicUser(user) });
  });

  /*
    AppSumo lifetime redemption. Accepts the registration details of a buyer who
    holds an AppSumo code and redeems that code into a permanent account tier.

    Contract with the caller:
      - POST /api/auth/redeem-appsumo
      - body: { email, password, promo_code, ref?, remember? }
      - 400 with "Invalid code. Please double-check your code." when the code
        does not exist (and no account is created)
      - 400 with "This code has already been redeemed." when the code is spent
      - default tier_level 1 = the free plan's five leads a day, lifetime

    The code is pre-validated BEFORE the account is created so a bad code can
    never leave an orphan signup behind; the account is then created (new email)
    or verified (existing email must prove the password), and only then is the
    code claimed atomically. If the claim loses a race, the account just created
    for this request is rolled back and the claim error is returned.
  */
  app.post("/api/auth/redeem-appsumo", async (req, res) => {
    const email = normalizeEmail(req.body.email || "");
    const password = String(req.body.password || "");
    const code = String(req.body.promo_code || req.body.promoCode || "").trim();
    const remember = req.body.remember !== false;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Valid email is required" });
    if (!isValidPassword(password)) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const precheck = getSumoCode(code);
    if (!precheck) return res.status(400).json({ error: "Invalid code. Please double-check your code." });
    if (precheck.is_used) return res.status(400).json({ error: "This code has already been redeemed." });

    const existing = getUserByEmail(email);
    const sessionUser = getAuthUser(req);
    let user;

    if (existing) {
      // Session match is the logged-in upgrade path; otherwise the email must
      // prove itself with its password before an account can be attached to a
      // code, so a leaked code cannot stamp someone else's account by email.
      if (sessionUser && sessionUser.email === existing.email && sessionUser.id === existing.id) {
        user = existing;
      } else if (existing.hasPassword) {
        const ok = await verifyPassword(password, existing.passwordHash);
        if (!ok) return res.status(401).json({ error: "Incorrect password" });
        user = existing;
      } else {
        return res.status(400).json({
          error: "This email is already registered without a password. Please log in to this account, then redeem your code."
        });
      }
    } else {
      const ref = canAttributeRef(req.body.ref, email, clientIp(req));
      user = await createEmailUserWithPassword({
        email,
        password,
        referredBy: ref.referrer?.id || "",
        signupIp: clientIp(req)
      });
    }

    const claim = claimSumoCode(code, user.id);
    if (!claim.ok) {
      // A raced claim: the code went between the pre-check and this write. Only
      // the account this request created is rolled back; a pre-existing account
      // stays untouched.
      if (!existing) {
        const data = readAuth();
        data.users = data.users.filter(u => u.id !== user.id);
        writeAuth(data);
      }
      return res.status(400).json({ error: claim.error });
    }

    const upgraded = setLifetimeTier(user.id, claim.tier_level, claim.code);
    const session = createSession(upgraded.id, remember);
    setSessionCookie(res, session);
    res.json({
      ok: true,
      user: publicUser(upgraded),
      code: claim.code,
      tier: claim.tier_level,
      lifetime: true
    });
  });
  /*
    First-party funnel beacon. Only the three events a page can honestly report
    (pricing seen, upgrade clicked, checkout opened) are accepted from the
    client; everything else is derived server-side from real actions so it
    cannot be faked. Page views are deduplicated within a short window so a
    double-fired listener or a re-render is never counted twice. The endpoint is
    rate-limited and always answers 200 so a dropped beacon never breaks the
    page.
  */
  app.post("/api/analytics/event", (req, res) => {
    const body = req.body || {};
    const name = String(body.name || "");
    const clientEvents = new Set([
      "pricing_page_viewed",
      "upgrade_cta_clicked",
      "checkout_started",
      /* Enrichment: the page itself is the only thing that can report these two */
      "enrichment_section_viewed",
      "enrichment_purchase_initiated"
    ]);
    if (!clientEvents.has(name)) return res.status(400).json({ ok: false });

    const check = consumeRate(`analytics:ip:${clientIp(req)}`, 240);
    if (!check.allowed) return res.json({ ok: false });

    const user = getAuthUser(req);
    /*
      Session identifier: prefer the real session token (hashed, never stored in
      the clear), falling back to the first-party device id so an anonymous
      visitor still gets a stable, non-identifying handle. Neither is PII.
    */
    const token = parseCookies(req)[COOKIE_NAME] || "";
    const sessionId = token
      ? `s_${crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 24)}`
      : hashDeviceId(ensureDeviceCookie(req, res)) || "";

    trackEvent(name, {
      userId: user?.id || "",
      sessionId,
      source: body.source,
      referrer: body.referrer,
      plan: body.plan || user?.plan || "",
      dedupeMs: name === "pricing_page_viewed" || name === "checkout_started" || name === "enrichment_section_viewed" ? 5000 : 0
    });
    res.json({ ok: true });
  });

  /*
    Early intent capture for the checkout page. The /auth step already remembers
    the address a paid-plan visitor types while signing up; this lets the
    checkout page itself capture the address of a visitor who reaches it, so a
    buyer who bounces before signing up is still attributable in the admin
    payment-visit tracker instead of showing only as an anonymous device.

    Public and rate-limited. The value is only ever the address the visitor
    themselves submitted on our own page, keyed by the same first-party device
    handle the tracker uses, and it expires like every other intent record.
  */
  app.post("/api/analytics/intent-email", (req, res) => {
    const body = req.body || {};
    const email = normalizeEmail(body.email || "");
    const plan = String(body.plan || "").toLowerCase().slice(0, 40);

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: "A valid email is required" });
    }

    const check = consumeRate(`intent-email:ip:${clientIp(req)}`, 30);
    if (!check.allowed) return res.json({ ok: false });

    recordIntentEmail(hashDeviceId(ensureDeviceCookie(req, res)), email, plan);
    res.json({ ok: true });
  });

  app.get("/api/admin/stats", requireAdmin, (req, res) => {
    const users = getAllUsers();
    const usage = getAllUsage();
    const summary = dbSummary();
    const today = new Date().toISOString().slice(0, 10);
    const todayUsage = usage.filter(u => u.date === today);
    const smtpConnected = users.filter(u =>
  (u.gmailSender && (u.gmailSender.smtpUser || u.gmailSender.smtpPass || u.gmailSender.email)) ||
  u.smtpConfigured ||
  u.senderConfigured ||
  u.gmailConfigured
).length;

    /*
      `totalUsers`, `totalJobs` and `totalLeads` are lifetime totals. Leads are
      pruned after 24h, so `storedLeads` is deliberately much smaller and is
      reported separately rather than being used as the headline number.
    */
    res.json({
      totalUsers: users.length,
      totalJobs: summary.jobsCreated,
      totalLeads: summary.leadsGenerated,
      storedJobs: summary.storedJobs,
      storedLeads: summary.storedLeads,
      leadsRequestedAllTime: usage.reduce((sum, u) => sum + Number(u.leadsRequested || 0), 0),
      jobsCreatedAllTime: usage.reduce((sum, u) => sum + Number(u.jobsCreated || 0), 0),
      smtpConnected,
      adminUsers: users.filter(u => u.role === "admin").length,
      freeUsers: users.filter(u => u.plan === "free").length,
      leadsToday: todayUsage.reduce((sum, u) => sum + Number(u.leadsRequested || 0), 0),
      jobsToday: todayUsage.reduce((sum, u) => sum + Number(u.jobsCreated || 0), 0),
      recentUsers: users.slice(-10).reverse(),
      todayUsage
    });
  });
}
export function enforceLeadLimit(req, res, targetCount) {
  const user = req.user || getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  if (user.role === "admin") return true;
  const leadLimit = getDailyLeadLimitForUser(user);
  const usage = getUserUsage(user.id);
  const alreadyUsed = Number(usage.leadsRequested || 0);
  const remaining = Math.max(0, leadLimit - alreadyUsed);
  if (Number(targetCount || 0) > remaining) {
    res.status(403).json({ error: `Daily limit reached for your plan. Remaining leads today: ${remaining}.`, limit: leadLimit, used: alreadyUsed, remaining });
    return false;
  }
  addUserUsage(user.id, Number(targetCount || 0));
  return true;
}
