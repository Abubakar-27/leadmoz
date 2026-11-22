import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const recoveryModule = pathToFileURL(path.join(here, "..", "src", "jobRecovery.js")).href;
const storeModule = pathToFileURL(path.join(here, "..", "src", "store.js")).href;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`not ok - ${name}`);
    console.log(`  ${err.message}`);
  }
}

/*
  store.js resolves its path from process.cwd(), so each scenario runs in a
  throwaway directory and the real data/store.json is never touched.
*/
function scenario(initial, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leadmoz-recovery-"));
  const dbFile = path.join(dir, "data", "store.json");
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(dbFile, JSON.stringify(initial, null, 2));

  const script = `
    const store = await import(${JSON.stringify(storeModule)});
    const recovery = await import(${JSON.stringify(recoveryModule)});
    const out = await (async () => { ${body} })();
    console.log("__RESULT__" + JSON.stringify(out));
  `;

  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    encoding: "utf8"
  });

  const line = stdout.split("\n").find(l => l.startsWith("__RESULT__"));
  const value = line ? JSON.parse(line.slice("__RESULT__".length)) : null;
  const onDisk = JSON.parse(fs.readFileSync(dbFile, "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });

  return { value, db: onDisk };
}

const MIN = 60000;
const now = Date.now();

function activeJob(id, overrides = {}) {
  return {
    id,
    niche: "plumbers",
    location: "texas",
    status: "searching",
    leads: [{ id: "lead-1", website: "example.com" }],
    progressMessage: "Saved leads: 1",
    createdAt: new Date(now - 15 * MIN).toISOString(),
    updatedAt: new Date(now - 1 * MIN).toISOString(),
    ...overrides
  };
}

check("boot resumes an interrupted job instead of failing it", () => {
  const { value, db } = scenario(
    { jobs: { [activeJob("j1").id]: activeJob("j1") } },
    `
      const recovered = recovery.recoverInterruptedJobsOnBoot();
      return {
        resumed: recovered.resumed,
        failed: recovered.failed.length,
        job: store.readDb().jobs.j1
      };
    `
  );

  assert.deepEqual(value.resumed, ["j1"], "job was not returned for resume");
  assert.equal(value.failed, 0, "job was failed instead of resumed");
  assert.equal(value.job.status, "queued", "resumed job should be re-queued");
  assert.equal(value.job.resumeAttempts, 1, "resumeAttempts was not incremented");
  assert.match(value.job.progressMessage, /resuming/i, "progress message does not say resuming");
  assert.equal(value.job.leads.length, 1, "collected leads were dropped");
  assert.equal(db.jobs.j1.leads[0].id, "lead-1", "leads lost on disk");
});

check("a resumed job is resumed again on the next boot", () => {
  const { value } = scenario(
    { jobs: { j1: activeJob("j1", { resumeAttempts: 1, status: "queued" }) } },
    `
      const recovered = recovery.recoverInterruptedJobsOnBoot();
      const job = store.readDb().jobs.j1;
      return { resumed: recovered.resumed, attempts: job.resumeAttempts, status: job.status };
    `
  );

  assert.deepEqual(value.resumed, ["j1"], "second resume did not happen");
  assert.equal(value.attempts, 2, "resumeAttempts should be 2 after two boots");
  assert.equal(value.status, "queued", "job should be queued again");
});

check("a job over the resume cap fails with its leads kept", () => {
  const { value } = scenario(
    { jobs: { j1: activeJob("j1", { resumeAttempts: 2 }) } },
    `
      const recovered = recovery.recoverInterruptedJobsOnBoot();
      const job = store.readDb().jobs.j1;
      return {
        resumed: recovered.resumed,
        failed: recovered.failed.map(f => f.id),
        status: job.status,
        error: job.error,
        message: job.progressMessage,
        leads: job.leads.length
      };
    `
  );

  assert.deepEqual(value.resumed, [], "capped job must not resume");
  assert.deepEqual(value.failed, ["j1"], "capped job was not reported failed");
  assert.equal(value.status, "failed", "capped job status should be failed");
  assert.match(value.error, /interrupted/i, "failure should say the job was interrupted");
  assert.match(value.message, /1 lead already collected is kept/, "kept-lead count missing from message");
  assert.doesNotMatch(value.message, /0h without finishing/, "fresh job should not report 0h");
  assert.equal(value.leads, 1, "leads dropped on failure");
});

check("the three-boot cycle resumes twice then fails", () => {
  const { value } = scenario(
    { jobs: { j1: activeJob("j1") } },
    `
      const first = recovery.recoverInterruptedJobsOnBoot();
      const second = recovery.recoverInterruptedJobsOnBoot();
      const third = recovery.recoverInterruptedJobsOnBoot();
      const job = store.readDb().jobs.j1;
      return {
        first: first.resumed.length,
        second: second.resumed.length,
        thirdFailed: third.failed.length,
        attempts: job.resumeAttempts,
        status: job.status
      };
    `
  );

  assert.equal(value.first, 1, "first boot should resume");
  assert.equal(value.second, 1, "second boot should resume");
  assert.equal(value.thirdFailed, 1, "third boot should fail");
  assert.equal(value.attempts, 2, "attempts must stay at the cap");
  assert.equal(value.status, "failed", "job should end failed");
});

check("finished jobs are left alone", () => {
  const { value } = scenario(
    {
      jobs: {
        done: activeJob("done", { status: "completed" }),
        dead: activeJob("dead", { status: "failed" })
      }
    },
    `
      const recovered = recovery.recoverInterruptedJobsOnBoot();
      const swept = recovery.reapStaleJobs();
      return { resumed: recovered.resumed, failed: recovered.failed.length, swept: swept.length };
    `
  );

  assert.deepEqual(value, { resumed: [], failed: 0, swept: 0 }, "non-active job was touched");
});

check("the periodic sweep fails a stale job but spares a live one", () => {
  const { value } = scenario(
    {
      jobs: {
        stale: activeJob("stale", { updatedAt: new Date(now - 100 * MIN).toISOString() }),
        live: activeJob("live")
      }
    },
    `
      const swept = recovery.reapStaleJobs();
      const db = store.readDb();
      return {
        swept: swept.map(s => s.id),
        stale: db.jobs.stale.status,
        live: db.jobs.live.status
      };
    `
  );

  assert.deepEqual(value.swept, ["stale"], "sweep should only reach the stale job");
  assert.equal(value.stale, "failed", "stale job should be failed by the sweep");
  assert.equal(value.live, "searching", "live job must not be swept");
});

console.log(failures ? `\n${failures} test(s) failed` : "\nall job recovery tests passed");
process.exit(failures ? 1 : 0);
