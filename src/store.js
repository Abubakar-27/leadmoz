import fs from "fs";
import path from "path";
import { leadKey, leadMatches } from "./dedup.js";
import { sortLeadsByPriority } from "./leadScore.js";
import { parseJsonFile, writeJsonAtomic } from "./atomicJson.js";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "store.json");
const dbTmpPath = path.join(dataDir, "store.json.tmp");
const dbBackupPath = path.join(dataDir, "store.json.bak");

/*
  Crash safety.

  The store used to be written in place with a single writeFileSync. That
  truncates the file first, so any interruption mid-write (a full disk, an
  OOM kill, a restart) left a half-written file that JSON.parse cannot read,
  which destroyed every job and lead at once. A 440KB truncation actually
  happened in production on a box where another app's log file ate the disk.

  Rules now:
  1. Never write in place. Write a temp file, fsync it, then rename it over
     the target. rename() is atomic within a filesystem, so readers only ever
     see the old file or the new one, never a partial one.
  2. Keep the last known-good file as .bak before replacing it.
  3. Never throw on a read. Fall back to .bak, then to an empty store, so a
     damaged file degrades instead of taking the server down.
*/
function emptyDb() {
  return { jobs: {}, meta: { jobsCreated: 0, leadsGenerated: 0 } };
}

function parseDbFile(filePath) {
  const parsed = parseJsonFile(filePath);
  if (!parsed || !parsed.jobs) return null;
  return parsed;
}


/*
  `jobsCreated` and `leadsGenerated` are lifetime totals: they only ever go up.
  They must never be recomputed from the stored jobs, because leads are pruned
  after 24h, so the stored sum is a rolling window and would make the lifetime
  total collapse downwards. A maintenance script that rewrote meta from the
  current jobs once reset a 1,800+ total to 80.
*/
const LIFETIME_COUNTERS = ["jobsCreated", "leadsGenerated"];

function ensureDb() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(dbPath) && !fs.existsSync(dbBackupPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(emptyDb(), null, 2));
  }
}

function readMetaFromDisk() {
  const db = parseDbFile(dbPath) || parseDbFile(dbBackupPath);
  return db?.meta || null;
}

export function readDb() {
  ensureDb();

  let db = parseDbFile(dbPath);

  if (!db) {
    db = parseDbFile(dbBackupPath);

    if (db) {
      console.error("[store] store.json is unreadable, recovered from store.json.bak");

      try {
        db = writeDbAndReturn(db);
      } catch (err) {
        console.error("[store] could not rewrite recovered store:", err.message);
      }
    }
  }

  if (!db) {
    console.error("[store] no readable store found, starting from an empty store");
    db = emptyDb();
  }

  if (!db.meta) {
    const jobs = Object.values(db.jobs || {});
    db.meta = {
      jobsCreated: jobs.filter(j => j && j.id).length,
      leadsGenerated: jobs.reduce((sum, j) => sum + Number(Array.isArray(j.leads) ? j.leads.length : 0), 0)
    };
    writeDb(db);
  }

  return db;
}

function writeDbAndReturn(db) {
  return writeJsonAtomic(dbPath, db);
}

export function writeDb(db) {
  ensureDb();

  const onDisk = readMetaFromDisk();

  if (!db.meta) db.meta = { jobsCreated: 0, leadsGenerated: 0 };

  for (const key of LIFETIME_COUNTERS) {
    const incoming = Number(db.meta[key]) || 0;
    const persisted = Number(onDisk?.[key]) || 0;

    db.meta[key] = Math.max(incoming, persisted);
  }

  return writeDbAndReturn(db);
}

export function dbSummary() {
  const db = readDb();
  const jobs = Object.values(db.jobs || {});

  return {
    jobsCreated: Number(db.meta?.jobsCreated) || 0,
    leadsGenerated: Number(db.meta?.leadsGenerated) || 0,
    storedJobs: jobs.filter(job => Boolean(job && job.id)).length,
    storedLeads: jobs.reduce(
      (sum, job) => sum + Number(Array.isArray(job?.leads) ? job.leads.length : 0),
      0
    )
  };
}

/*
  Create a job, or merge into an existing one.

  This used to overwrite the stored record wholesale: `db.jobs[job.id] = job`.
  That is safe when the only caller is job creation, but if any code path ever
  calls saveJob with a partial or stale job object on an id that already exists,
  it silently destroys what is already stored - the leads array, the billing
  reservation and the createdAt/updatedAt timestamps all vanish. That exact
  bug wiped the leads of a paid customer's completed job: the worker had saved
  ten, then a later write replaced the record with a copy that had none of the
  creation metadata, so the job read "completed, 0 leads".

  A job that already exists is now merged, and the fields that must never go
  backwards (leads, billing, createdAt) are preserved unless the caller supplies
  a real replacement. Creation keeps its old behaviour and still stamps
  createdAt/updatedAt so every new record is complete from the first write.
*/
export function saveJob(job) {
  const db = readDb();
  const existing = db.jobs[job.id];

  if (!existing) {
    const now = new Date().toISOString();
    db.jobs[job.id] = {
      ...job,
      leads: Array.isArray(job.leads) ? job.leads : [],
      createdAt: job.createdAt || now,
      updatedAt: job.updatedAt || now
    };
    db.meta.jobsCreated = Number(db.meta.jobsCreated || 0) + 1;
    writeDb(db);
    return db.jobs[job.id];
  }

  const merged = { ...existing, ...job };

  // Never let a re-save shrink or blank the stored lead list.
  if (!Array.isArray(job.leads) || job.leads.length === 0) {
    merged.leads = Array.isArray(existing.leads) ? existing.leads : [];
  }
  // Never drop a billing reservation that was already taken.
  if (!job.billing && existing.billing) merged.billing = existing.billing;
  // Never lose the original creation time.
  if (!job.createdAt && existing.createdAt) merged.createdAt = existing.createdAt;
  merged.updatedAt = new Date().toISOString();

  db.jobs[job.id] = merged;
  writeDb(db);
  return merged;
}

export function getJob(id) {
  const db = readDb();
  return db.jobs[id] || null;
}

export function updateJob(id, patch) {
  const db = readDb();
  const job = db.jobs[id];
  if (!job) return null;

  db.jobs[id] = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  writeDb(db);
  return db.jobs[id];
}

export function addLead(id, lead) {
  const db = readDb();
  const job = db.jobs[id];
  if (!job) return null;

  job.leads.push(lead);
  job.updatedAt = new Date().toISOString();
  db.meta.leadsGenerated = Number(db.meta.leadsGenerated || 0) + 1;

  writeDb(db);
  return lead;
}

export function findGlobalDuplicateLead(newLead, excludeJobId = null, withinMs = LEAD_TTL_MS) {
  const key = leadKey(newLead);
  if (!key || key === "name:") return null;

  const db = readDb();
  const now = Date.now();

  for (const jobId of Object.keys(db.jobs || {})) {
    if (excludeJobId && jobId === excludeJobId) continue;

    const job = db.jobs[jobId];
    if (!job) continue;

    for (const lead of job.leads || []) {
      const createdMs = leadCreatedAtMs(lead, job, now);
      if (now - createdMs > withinMs) continue;

      const matchedOn = leadMatches(lead, key);

      if (matchedOn) {
        return {
          jobId,
          lead,
          reason: "already exists",
          matchedOn
        };
      }
    }
  }

  return null;
}

export function addLeadIfUnique(id, lead) {
  const db = readDb();
  const job = db.jobs[id];
  if (!job) return { added: false, reason: "job not found" };

  const key = leadKey(lead);

  for (const existing of job.leads || []) {
    const matchedOn = leadMatches(existing, key);

    if (matchedOn) {
      return { added: false, reason: "duplicate", matchedOn };
    }
  }

  job.leads.push(lead);
  job.updatedAt = new Date().toISOString();
  db.meta.leadsGenerated = Number(db.meta.leadsGenerated || 0) + 1;

  writeDb(db);
  return { added: true, reason: "" };
}

export const LEAD_TTL_MS = 24 * 60 * 60 * 1000;

function leadCreatedAtMs(lead, job, now) {
  const value = new Date(lead.createdAt || job.createdAt || now).getTime();
  return Number.isFinite(value) ? value : now;
}

export function getUserPastLeads(userId) {
  const db = readDb();
  const now = Date.now();

  const out = [];

  for (const jobId of Object.keys(db.jobs || {})) {
    const job = db.jobs[jobId];
    if (!job || job.userId !== userId) continue;

    for (const lead of job.leads || []) {
      const createdMs = leadCreatedAtMs(lead, job, now);
      if (now - createdMs > LEAD_TTL_MS) continue;

      out.push({
        ...lead,
        jobId,
        jobNiche: job.niche || "",
        jobLocation: job.location || "",
        jobStatus: job.status || ""
      });
    }
  }

  return sortLeadsByPriority(out);
}

export function flushExpiredLeads() {
  const db = readDb();
  const now = Date.now();

  let flushed = 0;

  for (const jobId of Object.keys(db.jobs || {})) {
    const job = db.jobs[jobId];
    if (!job) continue;

    const kept = (job.leads || []).filter(lead => {
      const createdMs = leadCreatedAtMs(lead, job, now);
      const keep = now - createdMs <= LEAD_TTL_MS;
      if (!keep) flushed += 1;
      return keep;
    });

    job.leads = kept;

    const jobUpdatedMs = new Date(job.updatedAt || job.createdAt || now).getTime();
    const jobOld = Number.isFinite(jobUpdatedMs) && now - jobUpdatedMs > LEAD_TTL_MS;

    if (kept.length === 0 && jobOld) {
      delete db.jobs[jobId];
    }
  }

  writeDb(db);
  return flushed;
}
