import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
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
  throwaway directory. The real data/store.json is never touched.
*/
function withStore(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leadmoz-store-"));
  const dbFile = path.join(dir, "data", "store.json");
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(dbFile, JSON.stringify(initial, null, 2));

  const script = `
    const store = await import(${JSON.stringify(storeModule)});
    const out = await (async () => { ${fn} })();
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

  return { value, meta: onDisk.meta || {} };
}

const bigStore = {
  jobs: {
    a: { id: "a", leads: [{ id: 1 }, { id: 2 }] },
    b: { id: "b", leads: [{ id: 3 }] }
  },
  meta: { jobsCreated: 185, leadsGenerated: 1836 }
};

check("lifetime counters survive a rewrite from the stored jobs", () => {
  const { meta } = withStore(bigStore, `
    const db = store.readDb();
    db.meta.jobsCreated = Object.keys(db.jobs).length;
    db.meta.leadsGenerated = Object.values(db.jobs).reduce((s, j) => s + j.leads.length, 0);
    store.writeDb(db);
    return null;
  `);

  assert.equal(meta.jobsCreated, 185, "jobsCreated was overwritten");
  assert.equal(meta.leadsGenerated, 1836, "leadsGenerated was overwritten");
});

check("lifetime counters still increase normally", () => {
  const { meta } = withStore(bigStore, `
    store.addLead("a", { id: 4 });
    store.addLead("b", { id: 5 });
    return null;
  `);

  assert.equal(meta.leadsGenerated, 1838);
});

check("an intentionally higher value is written", () => {
  const { meta } = withStore(bigStore, `
    const db = store.readDb();
    db.meta.leadsGenerated = 2000;
    store.writeDb(db);
    return null;
  `);

  assert.equal(meta.leadsGenerated, 2000);
});

check("pruning leads does not lower the lifetime total", () => {
  const store = withStore(bigStore, `
    const db = store.readDb();
    delete db.jobs.a;
    delete db.jobs.b;
    store.writeDb(db);
    return store.dbSummary();
  `);

  assert.equal(store.meta.leadsGenerated, 1836);
  assert.equal(store.meta.jobsCreated, 185);
  assert.equal(store.value.storedLeads, 0);
  assert.equal(store.value.storedJobs, 0);
  assert.equal(store.value.leadsGenerated, 1836);
});

check("dbSummary reports stored and lifetime separately", () => {
  const store = withStore(bigStore, `return store.dbSummary();`);

  assert.equal(store.value.leadsGenerated, 1836);
  assert.equal(store.value.jobsCreated, 185);
  assert.equal(store.value.storedLeads, 3);
  assert.equal(store.value.storedJobs, 2);
});

check("a store with no meta is seeded once", () => {
  const { meta, value } = withStore(
    { jobs: { a: { id: "a", leads: [{ id: 1 }] } } },
    `return store.dbSummary();`
  );

  assert.equal(value.leadsGenerated, 1);
  assert.equal(meta.leadsGenerated, 1);
});

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nlifetime counters are protected");
