import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(path.join(here, "..", "src", "landingStats.js")).href;
const indexPath = path.join(here, "..", "public", "index.html");

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

function withModule(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leadmoz-landing-"));
  const dbFile = path.join(dir, "data", "store.json");
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    dbFile,
    JSON.stringify({ jobs: { a: { id: "a", leads: [{ id: 1 }] } }, meta: { jobsCreated: 185, leadsGenerated: 1836 } }, null, 2)
  );

  const script = `
    const m = await import(${JSON.stringify(moduleUrl)});
    console.log("__RESULT__" + JSON.stringify(await (async () => { ${fn} })()));
  `;

  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    encoding: "utf8"
  });

  const line = stdout.split("\n").find(l => l.startsWith("__RESULT__"));
  const value = line ? JSON.parse(line.slice("__RESULT__".length)) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return value;
}

check("stats expose the lifetime counters, not the 24h window", () => {
  const out = withModule(`return m.publicStats();`);

  assert.equal(out.leadsGenerated, 1836);
  assert.equal(out.jobsCreated, 185);
  assert.equal(typeof out.usersRegistered, "number");
  assert.ok(out.updatedAt);
});

check("stats never decrease when the store is rewritten lower", () => {
  const out = withModule(`
    const first = m.publicStats();
    const store = await import("file:///STORE");
    const db = store.readDb();
    db.meta.leadsGenerated = 5;
    db.meta.jobsCreated = 1;
    store.writeDb(db);
    const second = m.publicStats();
    return { first, second };
  `.replace("file:///STORE", pathToFileURL(path.join(here, "..", "src", "store.js")).href));

  assert.ok(out.second.leadsGenerated >= 1836, "leads went backwards");
  assert.ok(out.second.jobsCreated >= 185, "jobs went backwards");
});

check("placeholders are replaced with formatted numbers", () => {
  const out = withModule(`
    return m.renderPlaceholders("a {{LEADS_GENERATED}} b {{JOBS_CREATED}} c {{USERS_REGISTERED}} d {{UNKNOWN}}");
  `);

  assert.equal(out, "a 1,836 b 185 c 0 d {{UNKNOWN}}");
});

check("only the leads placeholder remains on the landing page", () => {
  const html = fs.readFileSync(indexPath, "utf8");
  const remaining = html.match(/\{\{(LEADS_GENERATED|JOBS_CREATED|USERS_REGISTERED)\}\}/g) || [];

  assert.equal(remaining.length, 1, `expected 1 placeholder, found ${remaining.length}`);
  assert.equal(remaining[0], "{{LEADS_GENERATED}}");
});

check("landing page shows only the leads number", () => {
  const html = fs.readFileSync(indexPath, "utf8");

  assert.ok(html.includes('id="livePanel"'));
  assert.ok(html.includes('id="liveStatsTitle"'));
  assert.ok(html.includes('data-live="leadsGenerated"'));
  assert.ok(html.includes("/api/public/stats"));
});

check("jobs and accounts metrics are not on the landing page", () => {
  const html = fs.readFileSync(indexPath, "utf8");

  assert.ok(!html.includes('data-live="jobsCreated"'), "jobsCreated metric is still rendered");
  assert.ok(!html.includes('data-live="usersRegistered"'), "usersRegistered metric is still rendered");
  assert.ok(!html.includes("Lead searches run"), "jobs label is still rendered");
  assert.ok(!html.includes("Accounts created"), "accounts label is still rendered");
  assert.ok(!html.includes("live-metrics"), "dead metric css/markup is still present");
});

check("rate limiter allows a burst then blocks", () => {
  const out = withModule(`
    const allowed = [];
    for (let i = 0; i < 70; i++) allowed.push(m.allowPublicStatsRequest("1.2.3.4"));
    const other = m.allowPublicStatsRequest("5.6.7.8");
    return { allowed: allowed.filter(Boolean).length, other };
  `);

  assert.equal(out.allowed, 60, "rate limit did not engage at 60");
  assert.equal(out.other, true, "a different IP was blocked");
});

check("rate limiter window resets", () => {
  const out = withModule(`
    const before = [];
    for (let i = 0; i < 65; i++) before.push(m.allowPublicStatsRequest("9.9.9.9"));
    return { allowed: before.filter(Boolean).length };
  `);

  assert.equal(out.allowed, 60);
});

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nlanding counter checks passed");
