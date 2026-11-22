import { createRejectionTrace, topRejectionReason } from "../src/rejectionTrace.js";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error("assertion returned false");
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

function assert(value, message) {
  if (!value) throw new Error(message || "expected truthy");
}

console.log("rejection trace");

check("records a domain and groups the reason", () => {
  const t = createRejectionTrace();
  t.record("gate", "Does not offer roofers", { website: "https://AcmeRoof.com/x" }, {}, "");
  const snap = t.snapshot();
  assert(snap.total === 1, "total should be 1");
  const keys = Object.keys(snap.reasons);
  assert(keys.length === 1, "one reason key");
  assert(snap.reasons[keys[0]][0].domain === "acmeroof.com", "domain normalised and www stripped");
});

check("counts totals even when the sample is capped", () => {
  const t = createRejectionTrace();
  for (let i = 0; i < 40; i += 1) {
    t.record("gate", "Does not offer roofers", { website: `https://site${i}.com` }, {}, "");
  }
  const snap = t.snapshot();
  assert(snap.total === 40, "total keeps counting past the sample cap");
  assert(snap.byReason.gate === 40, "bucket count is exact");
});

check("caps stored samples so the job record cannot grow without bound", () => {
  const t = createRejectionTrace();
  for (let i = 0; i < 200; i += 1) {
    t.record("noContact", "No email or phone after scrape", { website: `https://s${i}.com` }, {}, "");
  }
  const snap = t.snapshot();
  const stored = Object.values(snap.reasons).reduce((n, list) => n + list.length, 0);
  assert(stored <= 80, `stored samples should be capped, got ${stored}`);
});

check("collapses numbers so the same rule groups together", () => {
  const t = createRejectionTrace();
  t.record("gate", "Site is missing 17 pages", {}, {}, "");
  t.record("gate", "Site is missing 4 pages", {}, {}, "");
  const keys = Object.keys(t.snapshot().reasons);
  assert(keys.length === 1, `numbers should collapse, got ${keys.length} keys`);
});

check("does not store the same domain twice under one reason", () => {
  const t = createRejectionTrace();
  t.record("gate", "Does not offer roofers", { website: "https://dup.com/a" }, {}, "");
  t.record("gate", "Does not offer roofers", { website: "https://dup.com/b" }, {}, "");
  const keys = Object.keys(t.snapshot().reasons);
  assert(t.snapshot().reasons[keys[0]].length === 1, "duplicate domain not stored twice");
});

check("prefers the site hostname over an empty listing url", () => {
  const t = createRejectionTrace();
  t.record("gate", "reason", { website: "https://real-site.com" }, { website: "" }, "");
  const keys = Object.keys(t.snapshot().reasons);
  assert(t.snapshot().reasons[keys[0]][0].domain === "real-site.com");
});

check("records unknown when there is no url at all", () => {
  const t = createRejectionTrace();
  t.record("noContact", "reason", {}, {}, "");
  const keys = Object.keys(t.snapshot().reasons);
  assert(t.snapshot().reasons[keys[0]][0].domain === "unknown");
});

check("topRejectionReason names a real reason with samples", () => {
  const t = createRejectionTrace();
  t.record("gate", "Does not offer roofers", { website: "https://a.com" }, {}, "");
  t.record("gate", "Does not offer roofers", { website: "https://b.com" }, {}, "");
  const top = topRejectionReason(t.snapshot());
  assert(top, "should return a top reason");
  assert(top.count === 2, "count should be 2");
  assert(top.samples.length === 2, "both domains returned");
});

check("topRejectionReason returns null when nothing was rejected", () => {
  assert(topRejectionReason(createRejectionTrace().snapshot()) === null, "no rejections means no top reason");
  assert(topRejectionReason(null) === null, "null snapshot is safe");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
