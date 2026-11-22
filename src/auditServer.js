import crypto from "crypto";
import { scrapeWebsite, auditScrapedSite } from "./scrape.js";
import { deriveWeaknesses } from "./weaknesses.js";

const auditRate = new Map();

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;

function checkRateLimit(ip = "") {
  const key = String(ip || "unknown");
  const now = Date.now();
  const entry = auditRate.get(key) || { count: 0, window: now };
  if (now - entry.window > WINDOW_MS) {
    auditRate.set(key, { count: 1, window: now });
    return true;
  }
  if (entry.count >= MAX_PER_WINDOW) return false;
  auditRate.set(key, { count: entry.count + 1, window: entry.window });
  return true;
}

function generateToken() {
  return crypto.randomBytes(12).toString("hex");
}

const reportTokens = new Map();

export function createAuditRoutes(app) {
  app.get("/audit", (_req, res) => {
    res.sendFile("audit.html", { root: "public" }, err => {
      if (err) res.status(500).send("Error loading audit page");
    });
  });

  app.post("/api/audit", async (req, res) => {
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "";
    if (!checkRateLimit(String(ip))) {
      return res.status(429).json({ error: "Too many audit requests. Try again in a minute." });
    }
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ error: "URL is required" });
    try {
      const u = new URL(url.startsWith("http") ? url : `https://${url}`);
      const scraped = await scrapeWebsite(u.toString(), { runAudits: false });
      const audits = await auditScrapedSite(scraped);
      const full = { ...scraped, ...audits };
      const weaknesses = deriveWeaknesses(full);
      const token = generateToken();
      reportTokens.set(token, {
        url: u.toString(),
        scraped: full,
        weaknesses,
        createdAt: Date.now()
      });
      setTimeout(() => reportTokens.delete(token), 24 * 60 * 60 * 1000);
      res.json({ success: true, token, url: u.toString(), weaknesses });
    } catch (err) {
      res.status(400).json({ error: err.message.slice(0, 200) });
    }
  });

  app.get("/reports/:token", (req, res) => {
    const t = String(req.params.token || "");
    const data = reportTokens.get(t);
    if (!data) return res.status(404).send("Report not found or expired");
    res.sendFile("report.html", { root: "public" }, err => {
      if (err) res.status(500).send("Error loading report");
    });
  });

  app.get("/api/reports/:token", (req, res) => {
    const t = String(req.params.token || "");
    const data = reportTokens.get(t);
    if (!data) return res.status(404).json({ error: "Report not found or expired" });
    res.json({ url: data.url, weaknesses: data.weaknesses });
  });
}
