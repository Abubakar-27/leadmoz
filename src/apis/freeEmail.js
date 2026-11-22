import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";
import { assertPublicDomain, normalizeDomain } from "../enrichmentSafety.js";

/*
  Built-in, keyless email discovery and verification.

  This replaces the parts of Hunter.io the enrichment add-on actually used,
  without an API key, a paid plan or a third-party account:

    1. MX discovery       - find the company's real mail servers (DNS, free).
    2. SMTP RCPT check    - ask the mail server whether a mailbox exists.
                            No message is ever sent: the conversation stops at
                            RCPT TO and closes with QUIT, so no DATA is issued.
    3. Catch-all detection- if the server accepts a random address too, it
                            cannot verify anything, so results are downgraded
                            to "risky" instead of pretending to be verified.
    4. Pattern candidates - for a NAMED decision-maker (first + last name) try
                            the common professional layouts (first.last@,
                            firstlast@, first@, f.last@) in that order.

  Honesty rules:
    - A connection failure, greylisting (4xx) or blocked port is "unknown",
      never "invalid".
    - A mailbox is only reported as found when the server accepts it AND the
      domain is not catch-all.
    - Nothing is invented for a person who was not already named by the
      company's site or the public web.
*/

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_REPLY_LINES = 60;

const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com", "guerrillamail.com", "mailinator.com", "tempmail.com",
  "temp-mail.org", "yopmail.com", "trashmail.com", "sharklasers.com",
  "getnada.com", "dispostable.com", "throwawaymail.com", "fakeinbox.com"
]);

/* Consumer mailboxes do not follow company address patterns, so guessing
   there produces noise. Verification still works; discovery does not. */
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "aol.com", "icloud.com",
  "me.com", "mac.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net",
  "mail.com", "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com"
]);

const verifyCache = new Map();
const catchAllCache = new Map();

function normalizeEmail(email = "") {
  return String(email || "")
    .trim()
    .toLowerCase()
    .replace(/^mailto:/i, "")
    .split("?")[0]
    .replace(/[;,<>]+$/g, "");
}

function getDomain(website = "") {
  const raw = String(website || "").trim();
  if (!raw) return "";
  if (raw.includes("@") && !raw.includes("://")) return normalizeDomain(raw.split("@").pop());
  return normalizeDomain(raw);
}

function cacheGet(map, key) {
  const row = map.get(key);
  if (!row) return null;
  if (Date.now() - row.at > CACHE_TTL_MS) {
    map.delete(key);
    return null;
  }
  return row.value;
}

function cacheSet(map, key, value) {
  map.set(key, { at: Date.now(), value });
  if (map.size > 5000) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  return value;
}

/* ---------------------------------------------------------- SMTP plumbing */

class LineReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.lines = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;

    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      this.buffer += chunk;
      this.pump();
    });
    socket.on("error", err => {
      this.error = err;
      this.pump();
    });
    socket.on("close", () => {
      this.closed = true;
      this.pump();
    });
  }

  pump() {
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    }
    if ((this.closed || this.error) && this.waiters.length) {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(this.error || new Error("smtp connection closed"));
      }
    }
  }

  read() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.closed || this.error) return Promise.reject(this.error || new Error("smtp connection closed"));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(label || "smtp timeout"), { code: "timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readReply(reader, timeoutMs, deadline) {
  const lines = [];
  for (let i = 0; i < MAX_REPLY_LINES; i += 1) {
    if (Date.now() > deadline) throw Object.assign(new Error("smtp deadline"), { code: "timeout" });
    const line = await withTimeout(reader.read(), Math.max(500, deadline - Date.now()), "smtp read timeout");
    lines.push(line);
    const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
    if (!match) continue;
    if (match[2] === " ") return { code: Number(match[1]), text: lines.join(" | ") };
  }
  throw Object.assign(new Error("smtp reply too long"), { code: "bad_reply" });
}

async function safeMxHost(host) {
  if (!host) return false;
  try {
    await assertPublicDomain(host);
    return true;
  } catch {
    return false;
  }
}

/*
  One RCPT probe against one MX host. Returns a classification, never throws.
*/
async function probeHost(host, email, { timeoutMs = 6000, mailFrom = "" } = {}) {
  if (!(await safeMxHost(host))) {
    return { result: "unknown", reason: "unsafe_mx" };
  }

  const domain = email.split("@").pop();
  const socket = net.createConnection({ host, port: 25 });
  const reader = new LineReader(socket);
  const deadline = Date.now() + Math.max(timeoutMs, 3000) * 4;

  try {
    const greeting = await readReply(reader, timeoutMs, deadline);
    if (greeting.code !== 220) {
      return { result: "unknown", code: greeting.code, reason: `greeting_${greeting.code}` };
    }

    socket.write("EHLO leadio-verify.local\r\n");
    let hello = await readReply(reader, timeoutMs, deadline);
    if (hello.code >= 400) {
      socket.write("HELO leadio-verify.local\r\n");
      hello = await readReply(reader, timeoutMs, deadline);
      if (hello.code >= 400) {
        return { result: "unknown", code: hello.code, reason: "helo_rejected" };
      }
    }

    socket.write(`MAIL FROM:<${mailFrom || `postmaster@${domain}`}>\r\n`);
    const mail = await readReply(reader, timeoutMs, deadline);
    if (mail.code >= 400) {
      return {
        result: mail.code === 421 ? "tempfail" : "unknown",
        code: mail.code,
        reason: "mail_from_rejected"
      };
    }

    socket.write(`RCPT TO:<${email}>\r\n`);
    const rcpt = await readReply(reader, timeoutMs, deadline);
    if (rcpt.code >= 200 && rcpt.code < 300) {
      return { result: "accepted", code: rcpt.code, text: rcpt.text };
    }
    if (rcpt.code >= 500) {
      return { result: "rejected", code: rcpt.code, text: rcpt.text };
    }
    if (rcpt.code >= 400) {
      return { result: "tempfail", code: rcpt.code, text: rcpt.text };
    }
    return { result: "unknown", code: rcpt.code, text: rcpt.text };
  } catch (err) {
    return { result: "unknown", reason: err.code || err.message || "smtp_error" };
  } finally {
    try { socket.write("QUIT\r\n"); } catch { /* socket already gone */ }
    setTimeout(() => {
      try { socket.destroy(); } catch { /* ignore */ }
    }, 50);
  }
}

export async function mxHostsFor(domain) {
  const host = normalizeDomain(domain);
  if (!host) return [];
  try {
    const rows = await dns.resolveMx(host);
    return (Array.isArray(rows) ? rows : [])
      .filter(row => row && row.exchange)
      .sort((a, b) => Number(a.priority) - Number(b.priority))
      .map(row => String(row.exchange).replace(/\.$/, "").toLowerCase());
  } catch {
    return [];
  }
}

async function probeMailbox(email, { timeoutMs } = {}) {
  const domain = email.split("@").pop();
  const hosts = await mxHostsFor(domain);
  if (!hosts.length) return { result: "undeliverable", reason: "no_mx" };

  let last = { result: "unknown", reason: "smtp_unreachable" };
  for (const host of hosts.slice(0, 2)) {
    const result = await probeHost(host, email, { timeoutMs });
    if (result.result === "accepted" || result.result === "rejected") return result;
    if (result.result === "tempfail") last = result;
    else last = result;
  }
  return last;
}

/*
  A domain that accepts a random mailbox tells us nothing about real addresses.
  The answer is cached per domain so one company costs at most one extra probe.
*/
async function domainIsCatchAll(domain, { timeoutMs } = {}) {
  const cached = cacheGet(catchAllCache, domain);
  if (cached !== null) return cached;

  const token = `no-such-mailbox-${crypto.randomBytes(4).toString("hex")}@${domain}`;
  const result = await probeMailbox(token, { timeoutMs });

  /* Only a definite answer is cached. A timeout or blocked port must be
     retried next time instead of teaching the app a false catch-all. */
  if (result.result === "accepted") return cacheSet(catchAllCache, domain, true);
  if (result.result === "rejected") return cacheSet(catchAllCache, domain, false);
  return false;
}

function cleanNamePart(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/*
  Ordered professional-email layouts. Confidence is the base score before the
  SMTP result; a server-confirmed mailbox adds a large bonus in the caller.
*/
export function emailPatterns(firstName, lastName, domain) {
  const first = cleanNamePart(firstName);
  const last = cleanNamePart(lastName);
  const host = normalizeDomain(domain);
  if (!first || !last || !host) return [];

  const initial = first.slice(0, 1);
  const rows = [
    { local: `${first}.${last}`, confidence: 62 },
    { local: `${first}${last}`, confidence: 58 },
    { local: first, confidence: 50 },
    { local: `${initial}${last}`, confidence: 45 },
    { local: `${first}_${last}`, confidence: 40 },
    { local: `${first}.${initial}`, confidence: 35 }
  ];

  const seen = new Set();
  return rows
    .filter(row => {
      if (!row.local || seen.has(row.local)) return false;
      seen.add(row.local);
      return true;
    })
    .map(row => ({ email: `${row.local}@${host}`, confidence: row.confidence }));
}

/* -------------------------------------------------------------- public API */

export async function verifyEmailFree(email, { timeoutMs = 6000 } = {}) {
  const clean = normalizeEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
    return { ok: false, email: clean, result: "invalid", score: 0, reason: "invalid_email" };
  }

  const cached = cacheGet(verifyCache, clean);
  if (cached) return cached;

  const domain = clean.split("@").pop();
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return cacheSet(verifyCache, clean, {
      ok: true,
      email: clean,
      result: "undeliverable",
      score: 0,
      disposable: true,
      reason: "disposable_domain"
    });
  }

  const probe = await probeMailbox(clean, { timeoutMs });
  let value;

  if (probe.result === "accepted") {
    const catchAll = await domainIsCatchAll(domain, { timeoutMs });
    value = catchAll
      ? { ok: true, email: clean, result: "risky", score: 45, catchAll: true, reason: "catch_all_domain" }
      : { ok: true, email: clean, result: "deliverable", score: 95, catchAll: false, reason: "smtp_accepted" };
  } else if (probe.result === "undeliverable" || probe.result === "rejected") {
    value = { ok: true, email: clean, result: "undeliverable", score: 0, reason: probe.reason || "smtp_rejected" };
  } else {
    /* 4xx, timeout or blocked port: unknown is the only honest answer. */
    value = {
      ok: false,
      email: clean,
      result: "unknown",
      score: 0,
      reason: probe.result === "tempfail" ? "smtp_greylisted" : (probe.reason || "smtp_unreachable")
    };
  }

  return cacheSet(verifyCache, clean, value);
}

export async function findEmailWithFreePatterns(website, firstName, lastName, { maxCandidates = 3, timeoutMs = 6000 } = {}) {
  const domain = getDomain(website);
  if (!domain) return { ok: false, domain: "", email: "", reason: "No domain" };
  if (PERSONAL_DOMAINS.has(domain)) {
    return { ok: false, domain, email: "", reason: "personal_domain" };
  }
  if (!cleanNamePart(firstName) || !cleanNamePart(lastName)) {
    return { ok: false, domain, email: "", reason: "Missing first or last name" };
  }

  const hosts = await mxHostsFor(domain);
  if (!hosts.length) return { ok: false, domain, email: "", reason: "no_mx" };

  /* A catch-all domain cannot confirm any single layout, so trying patterns
     there would only manufacture false positives. Report it and stop. */
  if (await domainIsCatchAll(domain, { timeoutMs })) {
    return { ok: false, domain, email: "", reason: "catch_all_domain" };
  }

  const candidates = emailPatterns(firstName, lastName, domain).slice(0, Math.max(1, maxCandidates));
  for (const candidate of candidates) {
    const probe = await probeHost(hosts[0], candidate.email, { timeoutMs });
    if (probe.result === "accepted") {
      return {
        ok: true,
        domain,
        email: candidate.email,
        confidence: Math.min(99, candidate.confidence + 30),
        firstName: String(firstName || "").trim(),
        lastName: String(lastName || "").trim(),
        position: "",
        sources: []
      };
    }
  }

  return { ok: false, domain, email: "", reason: "not_found" };
}
