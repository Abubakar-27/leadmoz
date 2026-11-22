/*
  Tests for the batched marketing drizzle.

  Each test rewrites a throwaway data/marketing.json in a temp directory and
  calls drizzleMarketingQueue(). SMTP is unconfigured in the test process, so
  sendPlatformMail takes its DEV branch: the queue advances exactly as it would
  in production without a single real email leaving.
*/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leadmoz-marketing-"));
const originalCwd = process.cwd();
process.chdir(dir);
fs.mkdirSync(path.join(dir, "data"), { recursive: true });

const { drizzleMarketingQueue, MARKETING_SETTINGS_DEFAULTS } = await import("../src/marketingCampaigns.js");

const HOUR = 60 * 60 * 1000;

function seed(campaigns, settings = { drizzleMinutes: 15, batchSize: 2 }, sendLog = [], users = []) {
  fs.writeFileSync(
    path.join(dir, "data", "marketing.json"),
    JSON.stringify({ version: 1, templates: [{ id: "tpl", name: "T", subject: "S", body: "B" }], campaigns, sendLog, settings }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, "data", "auth.json"),
    JSON.stringify({ users, sessions: [], emailCodes: [], usage: [] }, null, 2)
  );
}

function read() {
  return JSON.parse(fs.readFileSync(path.join(dir, "data", "marketing.json"), "utf8"));
}

function campaign(id, emails, extra = {}) {
  return {
    id,
    segment: "all",
    subject: "Hello {First_Name}",
    body: "Hi {First_Name},\n\nA short note.",
    status: "sending",
    createdAt: new Date().toISOString(),
    total: emails.length,
    sent: 0,
    failed: 0,
    nextSendAt: new Date(Date.now() - 1000).toISOString(),
    queue: emails.map((email, i) => ({ userId: `${id}-u${i}`, email, status: "pending", sentAt: "", error: "" })),
    ...extra
  };
}

// The DEV branch prints the whole email to stdout; keep the test output clean.
async function quietly(fn) {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

test("releases exactly the configured batch size, then waits the gap", async () => {
  seed([campaign("camp_a", ["a@x.com", "b@x.com", "c@x.com"])]);

  const first = await quietly(() => drizzleMarketingQueue());
  assert.equal(first.sent, 2);
  assert.equal(first.batch, 2);

  let data = read();
  const queue = data.campaigns[0].queue;
  assert.deepEqual(queue.map(e => e.status), ["sent", "sent", "pending"]);
  assert.equal(data.campaigns[0].sent, 2);

  const gapMinutes = Math.round((Date.parse(data.campaigns[0].nextSendAt) - Date.now()) / 60000);
  assert.equal(gapMinutes, 15);

  // An immediate second tick must not send: the gap has not elapsed.
  const second = await quietly(() => drizzleMarketingQueue());
  assert.equal(second.sent, 0);
  assert.equal(second.reason, "waiting_for_next_slot");

  data = read();
  assert.equal(data.campaigns[0].queue.filter(e => e.status === "pending").length, 1);
});

test("splits one tick across concurrent campaigns instead of starving one", async () => {
  seed([
    campaign("camp_a", ["a1@x.com", "a2@x.com", "a3@x.com"]),
    campaign("camp_b", ["b1@x.com", "b2@x.com", "b3@x.com"])
  ], { drizzleMinutes: 15, batchSize: 2 });

  const result = await quietly(() => drizzleMarketingQueue());
  assert.equal(result.sent, 2);

  const data = read();
  const a = data.campaigns.find(c => c.id === "camp_a");
  const b = data.campaigns.find(c => c.id === "camp_b");
  assert.equal(a.sent, 1, "first campaign should get one slot");
  assert.equal(b.sent, 1, "second campaign should get one slot");
});

test("a bigger batch drains concurrent campaigns faster without duplicates", async () => {
  seed([
    campaign("camp_a", ["a1@x.com", "a2@x.com"]),
    campaign("camp_b", ["b1@x.com", "b2@x.com"])
  ], { drizzleMinutes: 15, batchSize: 4 });

  const result = await quietly(() => drizzleMarketingQueue());
  assert.equal(result.sent, 4);

  const data = read();
  for (const c of data.campaigns) {
    assert.equal(c.status, "completed", `${c.id} should be finished`);
    assert.equal(c.queue.filter(e => e.status === "sent").length, 2);
  }
});

test("the same address in two campaigns is mailed once", async () => {
  seed([
    campaign("camp_a", ["shared@x.com", "a2@x.com"]),
    campaign("camp_b", ["shared@x.com", "b2@x.com"])
  ], { drizzleMinutes: 15, batchSize: 4 });

  await quietly(() => drizzleMarketingQueue());

  const data = read();
  const emails = data.sendLog.map(e => e.email).filter(e => e === "shared@x.com");
  assert.equal(emails.length, 1, "shared address must only be delivered once per tick");

  const skipped = data.campaigns.flatMap(c => c.queue).filter(e => e.status === "skipped");
  assert.equal(skipped.length, 1);
});

test("a campaign that is not due yet is left alone", async () => {
  seed([
    campaign("camp_a", ["a@x.com"], { nextSendAt: new Date(Date.now() + HOUR).toISOString() })
  ]);

  const result = await quietly(() => drizzleMarketingQueue());
  assert.equal(result.sent, 0);

  const data = read();
  assert.equal(data.campaigns[0].queue[0].status, "pending");
  assert.equal(data.campaigns[0].sent, 0);
});

test("a paused campaign never sends", async () => {
  seed([campaign("camp_a", ["a@x.com"], { status: "paused" })]);

  const result = await quietly(() => drizzleMarketingQueue());
  assert.equal(result.sent, 0);
  assert.equal(result.reason, "no_active_campaign");

  assert.equal(read().campaigns[0].queue[0].status, "pending");
});

test("an exhausted campaign is marked completed, not left sending forever", async () => {
  const c = campaign("camp_a", []);
  c.status = "sending";
  seed([c]);

  await quietly(() => drizzleMarketingQueue());

  assert.equal(read().campaigns[0].status, "completed");
});

test("saved dashboard settings win over the env seed", async () => {
  seed([campaign("camp_a", ["a@x.com"])], { drizzleMinutes: 30, batchSize: 1 });

  process.env.MARKETING_DRIZZLE_MINUTES = "5";
  try {
    await quietly(() => drizzleMarketingQueue());
    const data = read();
    const gap = Math.round((Date.parse(data.campaigns[0].nextSendAt) - Date.now()) / 60000);
    assert.equal(gap, 30, "30 minutes from the dashboard must beat the 5-minute env default");
  } finally {
    delete process.env.MARKETING_DRIZZLE_MINUTES;
  }
});

test("sane defaults survive a missing settings block", async () => {
  assert.equal(MARKETING_SETTINGS_DEFAULTS.drizzleMinutes, 15);
  assert.equal(MARKETING_SETTINGS_DEFAULTS.batchSize, 2);

  const c = campaign("camp_a", ["a@x.com"]);
  fs.writeFileSync(
    path.join(dir, "data", "marketing.json"),
    JSON.stringify({ version: 1, templates: [{ id: "tpl" }], campaigns: [c], sendLog: [] }, null, 2)
  );

  await quietly(() => drizzleMarketingQueue());
  const gap = Math.round((Date.parse(read().campaigns[0].nextSendAt) - Date.now()) / 60000);
  assert.equal(gap, 15);
});

let failed = 0;
for (const { name, fn } of results) {
  try {
    await fn();
    console.log("ok - " + name);
  } catch (err) {
    failed++;
    console.error("not ok - " + name);
    console.error("   " + err.message);
  }
}

process.chdir(originalCwd);
fs.rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`${failed} of ${results.length} failed`);
  process.exit(1);
}
console.log(`${results.length} passed`);
