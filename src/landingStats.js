import fs from "fs";
import path from "path";
import { dbSummary } from "./store.js";
import { getAllUsers } from "./authStore.js";
import { planCatalog } from "./plans.js";

/*
  The landing page shows how many leads the tool has generated all time. Those
  numbers come from the lifetime counters in store.json, which never decrease,
  and are cached here so a burst of visitors does not read the store per hit.
*/

const CACHE_MS = 5000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60;
const RATE_MAX_KEYS = 5000;

let cache = { at: 0, value: null };
const rateHits = new Map();

function clampFloor(previous, next) {
  if (!previous) return next;
  return {
    ...next,
    leadsGenerated: Math.max(previous.leadsGenerated, next.leadsGenerated),
    jobsCreated: Math.max(previous.jobsCreated, next.jobsCreated),
    usersRegistered: Math.max(previous.usersRegistered, next.usersRegistered)
  };
}

export function publicStats() {
  const now = Date.now();

  if (cache.value && now - cache.at < CACHE_MS) {
    return cache.value;
  }

  const users = getAllUsers();
  const summary = dbSummary();
  const value = clampFloor(cache.value, {
    leadsGenerated: summary.leadsGenerated,
    jobsCreated: summary.jobsCreated,
    usersRegistered: users.length,
    smtpConnected: users.filter(u => u.gmailSender && (u.gmailSender.smtpUser || u.gmailSender.smtpPass || u.gmailSender.email)).length,
    updatedAt: new Date().toISOString()
  });

  cache = { at: now, value };
  return value;
}

export function allowPublicStatsRequest(ip) {
  const key = String(ip || "unknown");
  const now = Date.now();
  const hit = rateHits.get(key);

  if (!hit || now - hit.startedAt > RATE_WINDOW_MS) {
    if (rateHits.size > RATE_MAX_KEYS) rateHits.clear();
    rateHits.set(key, { startedAt: now, count: 1 });
    return true;
  }

  hit.count += 1;
  return hit.count <= RATE_MAX;
}

export function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US");
}

/*
  Placeholders are replaced server side so the first paint already shows the
  real number, which also means the page is correct with JavaScript disabled.
*/
const PLACEHOLDERS = {
  "{{LEADS_GENERATED}}": () => formatCount(publicStats().leadsGenerated),
  "{{JOBS_CREATED}}": () => formatCount(publicStats().jobsCreated),
  "{{USERS_REGISTERED}}": () => formatCount(publicStats().usersRegistered),
  "{{SMTP_CONNECTED}}": () => formatCount(publicStats().smtpConnected),
  /*
    The pricing section is hydrated from the same server-side catalogue the
    checkout uses. `<` is escaped so a plan description can never end the
    inline script tag.
  */
  "{{PLAN_CATALOG_JSON}}": () => JSON.stringify(planCatalog()).replace(/</g, "\\u003c")
};

export function renderPlaceholders(html) {
  return html.replace(
    /\{\{([A-Z0-9_]+)\}\}/g,
    (match) => {
      const render = PLACEHOLDERS[match];
      return render ? render() : match;
    }
  );
}

let template = { path: "", mtimeMs: 0, html: "" };

export function renderLandingPage(file) {
  const stat = fs.statSync(file);

  if (template.path !== file || template.mtimeMs !== stat.mtimeMs) {
    template = {
      path: file,
      mtimeMs: stat.mtimeMs,
      html: fs.readFileSync(file, "utf8")
    };
  }

  return renderPlaceholders(template.html);
}

export function landingPageFile(publicDir) {
  return path.join(publicDir, "index.html");
}
