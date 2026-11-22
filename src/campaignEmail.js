import { requireAuth } from "./auth.js";
import { getJob } from "./store.js";
import { getCampaignSmtpForUser, getUserGeminiKey } from "./userGmailSettings.js";
import { abuseLimits, clientIp, consumeRate, rejectIfRateLimited } from "./abuseGuard.js";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const CAMPAIGN_FILE = path.join(DATA_DIR, "campaign-history.json");

function readCampaignHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(CAMPAIGN_FILE, "utf8"));
    return {
      sends: Array.isArray(data.sends) ? data.sends : []
    };
  } catch {
    return { sends: [] };
  }
}

function writeCampaignHistory(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CAMPAIGN_FILE, JSON.stringify(data, null, 2));
}

function isCampaignSendingEnabled(user) {
  if (String(process.env.CAMPAIGN_EMAIL_ENABLED || "false") !== "true") {
    return false;
  }

  if (user.role === "admin") return true;

  const plan = String(user.plan || "free").toLowerCase();
  return plan === "pro";
}

function lockedPayload(user) {
  const sender = getCampaignSmtpForUser(user);
  const geminiKeySet = Boolean(getUserGeminiKey(user.id));

  return {
    enabled: false,
    locked: true,
    feature: "campaign_sending",
    title: "Campaign sending requires the Pro plan",
    message:
      "Campaign sending is a Pro plan feature. Connect your Gmail SMTP and your free Gemini API key, then upgrade to Pro to start sending outreach automatically.",
    hasSender: Boolean(sender),
    hasGemini: geminiKeySet,
    requiredPlan: "Pro",
    currentPlan: user.plan || "free"
  };
}

function getDailySendLimit(user) {
  if (user.role === "admin") {
    const adminLimit = Number(process.env.ADMIN_DAILY_SEND_LIMIT);
    if (adminLimit > 0) return adminLimit;
  }

  const proLimit = Number(process.env.PRO_DAILY_SEND_LIMIT);
  if (proLimit > 0) return proLimit;

  return 50;
}

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function countSendsToday(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const history = readCampaignHistory();
  return history.sends.filter(s => s.userId === userId && String(s.sentAt || "").slice(0, 10) === today).length;
}

async function generateCampaignEmail({ lead, job, geminiApiKey }) {
  if (lead.coldEmail && String(lead.coldEmail).trim().length > 20) {
    return String(lead.coldEmail).trim();
  }

  // Fallback template when no coldEmail was pre-generated.
  const businessName = lead.businessName || "your business";
  const weak = lead.weaknessSummary || "the website could be improved to turn more visitors into inquiries";
  const angle = lead.personalizationAngle || `You offer ${job.niche || "services"} in ${job.location || "your area"}`;

  if (!geminiApiKey) {
    return `Subject: Quick idea for ${businessName}

Hi,

I found ${businessName} while looking at ${job.niche} in ${job.location}.

${angle}. One thing that stood out: ${weak}.

${job.serviceOffer || "I help local businesses with their online presence."}

Would you like me to send 2 quick suggestions?

Best,`;
  }

  const {
    GoogleGenerativeAI
  } = await import("@google/generative-ai");

  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-flash-latest"
  });

  const prompt = `You are a skilled B2B cold email writer. Write ONE short, friendly cold-email for a local business outreach campaign. Return ONLY the raw email text (no markdown, no code fences). Keep it under 120 words.

Business name: ${businessName}
Niche: ${job.niche}
Location: ${job.location}
What the sender offers: ${job.serviceOffer || "website design and local SEO help"}
Weakness noticed: ${weak}
Personalization angle: ${angle}
Known email of recipient: ${lead.email || "unknown"}
	`;

  const result = await model.generateContent(prompt);
  const text = (result.response && result.response.text()) || "";

  return text.trim();
}

export function registerCampaignEmailRoutes(app) {
  app.get("/api/campaign/status", requireAuth, (req, res) => {
    const sender = getCampaignSmtpForUser(req.user);
    const geminiKeySet = Boolean(getUserGeminiKey(req.user.id));
    const enabled = isCampaignSendingEnabled(req.user);

    if (!enabled) {
      return res.json(lockedPayload(req.user));
    }

    res.json({
      enabled: true,
      locked: false,
      feature: "campaign_sending",
      hasSender: Boolean(sender),
      hasGemini: geminiKeySet,
      sendLimit: getDailySendLimit(req.user),
      sentToday: countSendsToday(req.user.id),
      requiredPlan: "Pro",
      currentPlan: req.user.plan || "free",
      message: sender && geminiKeySet
        ? "Campaign sending is available."
        : "Connect Gmail SMTP and your Gemini key before sending campaign emails."
    });
  });

  app.post("/api/jobs/:id/campaign/preview", requireAuth, async (req, res) => {
    const job = getJob(req.params.id);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (req.user.role !== "admin" && job.userId !== req.user.id) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const enabled = isCampaignSendingEnabled(req.user);

    if (!enabled) {
      return res.status(402).json(lockedPayload(req.user));
    }

    const geminiApiKey = getUserGeminiKey(req.user.id);

    if (!geminiApiKey) {
      return res.status(400).json({
        error: "Add your free Gemini API key in Settings before generating campaign emails."
      });
    }

    const limit = Number(req.body.limit || 3);

    const eligible = (job.leads || []).filter(
      l => normalizeEmail(l.email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(l.email)
    );

    const selected = eligible.slice(0, Math.max(1, Math.min(Number(limit), eligible.length)));

    const drafts = [];

    for (const lead of selected) {
      try {
        const body = await generateCampaignEmail({ lead, job, geminiApiKey });
        drafts.push({ leadId: lead.id || "", businessName: lead.businessName, email: lead.email, subject: body.split("\n")[0].replace(/^Subject:\s*/i, ""), body });
      } catch (err) {
        drafts.push({ leadId: lead.id || "", businessName: lead.businessName, email: lead.email, subject: "", body: "", error: err.message });
      }
    }

    res.json({
      ok: true,
      totalEligible: eligible.length,
      drafted: drafts
    });
  });

  app.post("/api/jobs/:id/campaign/send", requireAuth, async (req, res) => {
    const job = getJob(req.params.id);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (req.user.role !== "admin" && job.userId !== req.user.id) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const enabled = isCampaignSendingEnabled(req.user);

    if (!enabled) {
      return res.status(402).json(lockedPayload(req.user));
    }

    const sender = getCampaignSmtpForUser(req.user);

    if (!sender) {
      return res.status(400).json({
        error: "Connect your Gmail SMTP sender before sending campaign emails."
      });
    }

    const geminiApiKey = getUserGeminiKey(req.user.id);

    if (!geminiApiKey) {
      return res.status(400).json({
        error: "Add your free Gemini API key in Settings before generating campaign emails."
      });
    }

    const requested = Math.max(1, Number(req.body.limit || 5));
    const toEmail = normalizeEmail(req.body.toEmail || "");

    const eligible = (job.leads || []).filter(
      l => normalizeEmail(l.email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(l.email)
    );

    const candidates = toEmail
      ? eligible.filter(l => normalizeEmail(l.email) === toEmail)
      : eligible;

    const dailyLimit = getDailySendLimit(req.user);
    const alreadySent = countSendsToday(req.user.id);
    const remaining = Math.max(0, dailyLimit - alreadySent);
    const allowed = toEmail
      ? (candidates.length > 0 ? Math.min(1, remaining) : 0)
      : Math.min(requested, remaining, eligible.length);

    if (allowed <= 0) {
      if (toEmail && candidates.length === 0) {
        return res.status(400).json({
          error: "No email found for this lead."
        });
      }

      return res.status(429).json({
        error: `Daily send limit reached. Pro plan lets you send ${dailyLimit} campaign emails per day.`
      });
    }

    const selected = toEmail ? candidates.slice(0, 1) : eligible.slice(0, allowed);

    /*
      The daily plan limit is the product quota; this is the abuse burst limit
      on the same form, so a script cannot burn the whole day's mail in one
      second or route sending through many jobs.
    */
    const limits = abuseLimits();
    if (rejectIfRateLimited(res, consumeRate(`campaign-send:user:${req.user.id}`, limits.emailSendPerUserPerHour),
      "Too many campaign sends from this account right now. Please wait a little while.")) return;
    if (rejectIfRateLimited(res, consumeRate(`campaign-send:ip:${clientIp(req)}`, limits.emailSendPerIpPerHour),
      "Too many campaign sends from this connection right now. Please wait a little while.")) return;

    const transporter = nodemailer.createTransport({
      host: sender.host,
      port: sender.port,
      secure: Boolean(sender.secure),
      auth: {
        user: sender.user,
        pass: sender.pass
      }
    });

    const results = [];
    let sent = 0;

    for (const lead of selected) {
      try {
        const body = await generateCampaignEmail({ lead, job, geminiApiKey });
        const subjectLine = String(body.match(/^Subject:\s*(.+)$/im)?.[1] || `Opportunity for ${lead.businessName || "your business"}`).trim();
        const cleanBody = body.replace(/^Subject:\s*.+$/im, "").trim();

        await transporter.sendMail({
          from: `"${sender.fromName}" <${sender.fromEmail}>`,
          to: lead.email,
          subject: subjectLine,
          text: cleanBody
        });

        sent += 1;

        const record = {
          id: `send_${Date.now()}_${sent}`,
          userId: req.user.id,
          jobId: job.id,
          leadId: lead.id || "",
          businessName: lead.businessName || "",
          to: lead.email,
          subject: subjectLine,
          status: "sent",
          sentAt: new Date().toISOString()
        };

        const history = readCampaignHistory();
        history.sends.push(record);
        writeCampaignHistory(history);

        results.push(record);
      } catch (err) {
        console.error(`Campaign send failed for ${lead.businessName || lead.email}:`, err.message);

        const record = {
          id: `send_${Date.now()}_${sent}`,
          userId: req.user.id,
          jobId: job.id,
          leadId: lead.id || "",
          businessName: lead.businessName || "",
          to: lead.email,
          subject: "",
          status: "failed",
          error: err.message,
          sentAt: new Date().toISOString()
        };

        const history = readCampaignHistory();
        history.sends.push(record);
        writeCampaignHistory(history);

        results.push(record);
      }
    }

    res.json({
      ok: true,
      sent,
      failed: results.length - sent,
      remainingToday: Math.max(0, dailyLimit - alreadySent - sent),
      results
    });
  });

  app.get("/api/campaign/history", requireAuth, (req, res) => {
    const history = readCampaignHistory();
    const sends = history.sends
      .filter(s => s.userId === req.user.id)
      .sort((a, b) => String(b.sentAt || "").localeCompare(String(a.sentAt || "")))
      .slice(0, 100);

    res.json({ sends });
  });
}