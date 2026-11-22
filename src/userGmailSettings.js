import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";
import { getAuthUser, requireAuth } from "./auth.js";
import { abuseLimits, clientIp, consumeRate, rejectIfRateLimited } from "./abuseGuard.js";

const DATA_DIR = path.join(process.cwd(), "data");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");

function readAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch {
    return { users: [], sessions: [], emailCodes: [], usage: [] };
  }
}

function writeAuth(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}

function allowedPlatformUsers() {
  return String(process.env.PLATFORM_SMTP_ALLOWED_USERS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
}

function maskEmail(email = "") {
  const e = String(email || "");
  const [name, domain] = e.split("@");
  if (!name || !domain) return e;
  return `${name.slice(0, 2)}***@${domain}`;
}

function cleanAppPassword(value = "") {
  return String(value || "").replace(/\s+/g, "").trim();
}

function safeSender(sender) {
  if (!sender) return null;

  return {
    provider: sender.provider || "gmail",
    fromName: sender.fromName || "",
    fromEmail: sender.fromEmail || "",
    smtpUser: sender.smtpUser || "",
    smtpHost: sender.smtpHost || "smtp.gmail.com",
    smtpPort: Number(sender.smtpPort || 587),
    smtpSecure: Boolean(sender.smtpSecure),
    configured: Boolean(sender.smtpUser && sender.smtpPass),
    updatedAt: sender.updatedAt || ""
  };
}

function maskKey(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 8) return "********";
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

export function getUserGeminiKey(userId) {
  const data = readAuth();
  const user = (data.users || []).find(u => u.id === userId);
  return user?.geminiApiKey || "";
}

export function getUserGmailSender(userId) {
  const data = readAuth();
  const user = (data.users || []).find(u => u.id === userId);
  return user?.gmailSender || null;
}

export function userCanUsePlatformSmtp(user) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return allowedPlatformUsers().includes(normalizeEmail(user.email));
}

export function getCampaignSmtpForUser(user) {
  const data = readAuth();
  const freshUser = (data.users || []).find(u => u.id === user.id) || user;

  if (freshUser.gmailSender?.smtpUser && freshUser.gmailSender?.smtpPass) {
    return {
      source: "user_gmail",
      fromName: freshUser.gmailSender.fromName || freshUser.name || freshUser.email,
      fromEmail: freshUser.gmailSender.fromEmail || freshUser.gmailSender.smtpUser,
      host: freshUser.gmailSender.smtpHost || "smtp.gmail.com",
      port: Number(freshUser.gmailSender.smtpPort || 587),
      secure: Boolean(freshUser.gmailSender.smtpSecure),
      user: freshUser.gmailSender.smtpUser,
      pass: freshUser.gmailSender.smtpPass
    };
  }

  if (userCanUsePlatformSmtp(freshUser)) {
    return {
      source: "platform_smtp",
      fromName: process.env.SMTP_FROM_NAME || "Leadmoz",
      fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "false") === "true",
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    };
  }

  return null;
}

async function testGmailSmtp({ smtpUser, smtpPass, fromName, fromEmail, testTo }) {
  const cleanPass = cleanAppPassword(smtpPass);

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: smtpUser,
      pass: cleanPass
    }
  });

  await transporter.verify();

  await transporter.sendMail({
    from: `"${fromName || "Leadmoz"}" <${fromEmail || smtpUser}>`,
    to: testTo || smtpUser,
    subject: "Leadmoz Gmail SMTP test",
    text: "Your Gmail SMTP sender is connected successfully.",
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
        <h2>Gmail SMTP connected</h2>
        <p>Your Gmail SMTP sender is connected successfully.</p>
        <p>You can now use this sender for campaign emails after review limits are enabled.</p>
      </div>
    `
  });
}

export function registerUserGmailSettingsRoutes(app) {
  app.get("/api/settings/gmail-smtp", requireAuth, (req, res) => {
    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.user.id);

    res.json({
      canUsePlatformSmtp: userCanUsePlatformSmtp(req.user),
      platformSmtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
      platformSmtpUser: userCanUsePlatformSmtp(req.user) ? maskEmail(process.env.SMTP_USER || "") : "",
      sender: safeSender(user?.gmailSender || null)
    });
  });

  app.post("/api/settings/gmail-smtp/test", requireAuth, async (req, res) => {
    const smtpUser = normalizeEmail(req.body.smtpUser || "");
    const smtpPass = cleanAppPassword(req.body.smtpPass || "");
    const fromName = String(req.body.fromName || "").trim();
    const fromEmail = normalizeEmail(req.body.fromEmail || smtpUser);
    const testTo = normalizeEmail(req.body.testTo || smtpUser);

    if (!smtpUser || !/^[^\s@]+@gmail\.com$/i.test(smtpUser)) {
      return res.status(400).json({ error: "A valid Gmail address is required" });
    }

    if (!fromEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(fromEmail)) {
      return res.status(400).json({ error: "Valid from email is required" });
    }

    if (!smtpPass || smtpPass.length < 16) {
      return res.status(400).json({
        error: "Gmail App Password must be 16 characters. Remove spaces before saving."
      });
    }

    /*
      These two forms make the server open an SMTP connection and send mail.
      Count them per account and per address so the same form cannot be used
      as a mail relay.
    */
    const limits = abuseLimits();
    if (rejectIfRateLimited(res, consumeRate(`email-test:user:${req.user.id}`, limits.emailTestPerUserPerHour),
      "Too many email tests from this account. Please wait a little while.")) return;
    if (rejectIfRateLimited(res, consumeRate(`email-test:ip:${clientIp(req)}`, limits.emailTestPerIpPerHour),
      "Too many email tests from this connection. Please wait a little while.")) return;

    try {
      await testGmailSmtp({
        smtpUser,
        smtpPass,
        fromName,
        fromEmail,
        testTo
      });

      res.json({ ok: true, message: "Test email sent successfully" });
    } catch (err) {
      console.error("Gmail SMTP test failed:", err);
      res.status(400).json({
        error:
          "Gmail SMTP test failed. Check that 2-Step Verification is enabled and the App Password is correct.",
        details: err.message
      });
    }
  });

  app.post("/api/settings/gmail-smtp/save", requireAuth, async (req, res) => {
    const smtpUser = normalizeEmail(req.body.smtpUser || "");
    const smtpPass = cleanAppPassword(req.body.smtpPass || "");
    const fromName = String(req.body.fromName || "").trim();
    const fromEmail = normalizeEmail(req.body.fromEmail || smtpUser);

    if (!smtpUser || !/^[^\s@]+@gmail\.com$/i.test(smtpUser)) {
      return res.status(400).json({ error: "A valid Gmail address is required" });
    }

    if (!fromEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(fromEmail)) {
      return res.status(400).json({ error: "Valid from email is required" });
    }

    if (!smtpPass || smtpPass.length < 16) {
      return res.status(400).json({
        error: "Gmail App Password must be 16 characters. Remove spaces before saving."
      });
    }

    const limits = abuseLimits();
    if (rejectIfRateLimited(res, consumeRate(`email-test:user:${req.user.id}`, limits.emailTestPerUserPerHour),
      "Too many email tests from this account. Please wait a little while.")) return;
    if (rejectIfRateLimited(res, consumeRate(`email-test:ip:${clientIp(req)}`, limits.emailTestPerIpPerHour),
      "Too many email tests from this connection. Please wait a little while.")) return;

    try {
      await testGmailSmtp({
        smtpUser,
        smtpPass,
        fromName,
        fromEmail,
        testTo: smtpUser
      });
    } catch (err) {
      console.error("Gmail SMTP save test failed:", err);
      return res.status(400).json({
        error:
          "Could not verify Gmail SMTP. Fix the App Password first, then save.",
        details: err.message
      });
    }

    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.user.id);

    if (!user) return res.status(404).json({ error: "User not found" });

    user.gmailSender = {
      provider: "gmail",
      fromName: fromName || user.name || smtpUser,
      fromEmail: fromEmail || smtpUser,
      smtpHost: "smtp.gmail.com",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser,
      smtpPass,
      updatedAt: new Date().toISOString()
    };

    user.updatedAt = new Date().toISOString();

    writeAuth(data);

    res.json({
      ok: true,
      sender: safeSender(user.gmailSender)
    });
  });

  app.post("/api/settings/gmail-smtp/remove", requireAuth, (req, res) => {
    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.user.id);

    if (!user) return res.status(404).json({ error: "User not found" });

    delete user.gmailSender;
    user.updatedAt = new Date().toISOString();

    writeAuth(data);

    res.json({ ok: true });
  });

  app.get("/api/settings/gemini-key", requireAuth, (req, res) => {
    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.user.id);

    res.json({
      keySet: Boolean(user?.geminiApiKey),
      maskedKey: user?.geminiApiKey ? maskKey(user.geminiApiKey) : "",
      updatedAt: user?.geminiKeyUpdatedAt || ""
    });
  });

  app.post("/api/settings/gemini-key/test", requireAuth, async (req, res) => {
    const apiKey = String(req.body.apiKey || "").trim();

    if (!apiKey || apiKey.length < 10) {
      return res.status(400).json({ error: "A valid Gemini API key is required" });
    }

    try {
      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: String(process.env.GEMINI_MODEL || "gemini-flash-latest")
      });
      const result = await model.generateContent("Reply with the single word OK.");
      const text = (result.response && result.response.text()) || "";

      if (text.trim().toUpperCase().includes("OK")) {
        return res.json({ ok: true, message: "Gemini key is valid and working" });
      }

      return res.status(400).json({ error: "Gemini key responded unexpectedly.", details: String(text).slice(0, 200) });
    } catch (err) {
      console.error("Gemini key test failed:", err);
      res.status(400).json({
        error: "Gemini key test failed. Check that the key is valid.",
        details: err.message
      });
    }
  });

  app.post("/api/settings/gemini-key/save", requireAuth, async (req, res) => {
    const apiKey = String(req.body.apiKey || "").trim();

    if (!apiKey || apiKey.length < 10) {
      return res.status(400).json({ error: "A valid Gemini API key is required" });
    }

    try {
      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: String(process.env.GEMINI_MODEL || "gemini-flash-latest")
      });
      const result = await model.generateContent("Reply with the single word OK.");
      const text = (result.response && result.response.text()) || "";

      if (!text.trim().toUpperCase().includes("OK")) {
        return res.status(400).json({ error: "Gemini key responded unexpectedly. Try again." });
      }
    } catch (err) {
      console.error("Gemini key save validation failed:", err);
      return res.status(400).json({
        error: "Could not verify the Gemini key. It will not be saved.",
        details: err.message
      });
    }

    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.user.id);

    if (!user) return res.status(404).json({ error: "User not found" });

    user.geminiApiKey = apiKey;
    user.geminiKeyUpdatedAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();

    writeAuth(data);

    res.json({
      ok: true,
      keySet: true,
      maskedKey: maskKey(user.geminiApiKey),
      updatedAt: user.geminiKeyUpdatedAt
    });
  });

  app.post("/api/settings/gemini-key/remove", requireAuth, (req, res) => {
    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.user.id);

    if (!user) return res.status(404).json({ error: "User not found" });

    delete user.geminiApiKey;
    delete user.geminiKeyUpdatedAt;
    user.updatedAt = new Date().toISOString();

    writeAuth(data);

    res.json({ ok: true });
  });
}
