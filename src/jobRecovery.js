import { readDb, updateJob } from "./store.js";
import { settleJobBilling } from "./creditPolicy.js";

/*
  Stale-job recovery.

  A job is written to the store as "searching" or "scraping" before the work
  starts, and only marked complete at the very end. If the process dies in
  between - a deploy, a crash, a reboot - the job keeps that status forever.
  Nothing ever moves it on, so it is permanently stuck: the user sees a search
  that never finishes, and every future deploy refuses to restart while a job
  looks active.

  That is not hypothetical. One "plumbers / newyork" search sat in "searching"
  for 16 hours after a restart and blocked a release on its own.

  Boot therefore handles interrupted jobs immediately, and it RESUMES them
  rather than failing them: jobs live only in process memory, so a deploy used
  to kill whatever the user had running and hand them "Stopped after 0h without
  finishing". The re-run keeps every lead already saved (addLeadIfUnique
  deduplicates against the job's own leads) and is capped at
  MAX_RESUME_ATTEMPTS re-runs, so a job that crashes the process fails itself
  out instead of crash-looping the server.

  The periodic sweep below still fails jobs outright: it runs while the process
  is alive, so a job it reaches has genuinely stopped making progress for
  STALE_AFTER_MIN, not been interrupted.
*/

// Exported so worker.js's auto-retry check agrees with recovery on which
// statuses are still "the job's own run in flight" - a drift between the two
// would let a sweep-resumed job refuse its retry or vice versa.
export const ACTIVE_STATES = ["queued", "searching", "scraping", "running"];

// The slowest measured search (a Lisbon redesign that exhausted every widening
// pass) took about 29 minutes, so 90 minutes is comfortably past any real run.
const STALE_AFTER_MIN = Number(process.env.STALE_JOB_MINUTES || 90);

const MAX_RESUME_ATTEMPTS = Number(process.env.JOB_RESUME_ATTEMPTS || 2);

function activeJobs() {
  const db = readDb() || {};
  const jobs = Array.isArray(db.jobs) ? db.jobs : Object.values(db.jobs || {});
  return jobs.filter(job => job && ACTIVE_STATES.includes(job.status));
}

/*
  `cause` picks the user-facing explanation. The boot path genuinely means the
  server restarted mid-search; the periodic sweep runs while the process is
  alive, so a job it reaches has stalled on its own - telling that user "the
  server restarted" is simply false and reads as a hand-wave.
*/
function failInterruptedJob(job, now, cause = "restart") {
  const touched = job.updatedAt || job.createdAt;
  const ageMin = touched ? (now - new Date(touched).getTime()) / 60000 : 0;
  const kept = (job.leads || []).length;
  const age = ageMin >= 90 ? `${Math.round(ageMin / 60)}h` : `${Math.max(1, Math.round(ageMin))}min`;
  const why =
    cause === "restart"
      ? "the server restarted mid-search"
      : "it stopped making progress";

  /*
    A job that is being failed here will never run again, so its reservation is
    settled now. Leads already kept are still delivered, so they are billed; the
    rest of the reservation goes back. Settling is idempotent on the job id.
  */
  settleJobBilling(job.id, { billable: kept, failed: true });

  updateJob(job.id, {
    status: "failed",
    error: "This search was interrupted and never finished. Start it again.",
    progressMessage:
      `Stopped after ${age} without finishing (${why}).` +
      (kept ? ` ${kept} lead${kept === 1 ? "" : "s"} already collected ${kept === 1 ? "is" : "are"} kept.` : ""),
    updatedAt: new Date(now).toISOString()
  });

  return { id: job.id, niche: job.niche, location: job.location, ageMin: Math.round(ageMin), kept };
}

export function reapStaleJobs({ now = Date.now(), staleAfterMin = STALE_AFTER_MIN } = {}) {
  const reaped = [];

  for (const job of activeJobs()) {
    const touched = job.updatedAt || job.createdAt;
    if (!touched) continue;

    const ageMin = (now - new Date(touched).getTime()) / 60000;
    if (!Number.isFinite(ageMin) || ageMin < staleAfterMin) continue;

    reaped.push(failInterruptedJob(job, now, "stall"));
  }

  return reaped;
}

/**
 * Startup recovery: every job still marked active at boot is dead (the process
 * that ran it is gone). Jobs under the resume cap are re-queued and returned so
 * the caller can run them again; the rest are failed as before.
 *
 * @returns {{ resumed: string[], failed: object[] }}
 */
export function recoverInterruptedJobsOnBoot({ now = Date.now() } = {}) {
  const resumed = [];
  const failed = [];

  for (const job of activeJobs()) {
    const attempts = Number(job.resumeAttempts || 0);

    if (attempts < MAX_RESUME_ATTEMPTS) {
      updateJob(job.id, {
        status: "queued",
        resumeAttempts: attempts + 1,
        progressMessage:
          `Server restarted mid-search - resuming (attempt ${attempts + 1} of ${MAX_RESUME_ATTEMPTS})...`,
        updatedAt: new Date(now).toISOString()
      });
      resumed.push(job.id);

      console.warn(
        `[job-recovery] resuming "${job.niche}"/${job.location} after restart ` +
        `(attempt ${attempts + 1} of ${MAX_RESUME_ATTEMPTS})`
      );
      continue;
    }

    const record = failInterruptedJob(job, now);
    failed.push(record);

    console.warn(
      `[job-recovery] marked "${record.niche}"/${record.location} failed after ${record.ageMin}min ` +
      `stuck in an unfinished state (kept ${record.kept} leads)`
    );
  }

  if (resumed.length || failed.length) {
    console.warn(
      `[job-recovery] recovered ${resumed.length + failed.length} interrupted job(s) at startup ` +
      `(${resumed.length} resumed, ${failed.length} failed)`
    );
  }

  return { resumed, failed };
}
