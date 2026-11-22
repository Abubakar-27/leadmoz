#!/usr/bin/env node
/*
  Optional Google Maps enrichment — standalone, additive, opt-in.

  It reads existing jobs/leads from data/store.json, asks a private scraper
  sidecar for Google Maps data, and writes the result into a NEW `lead.gmaps`
  field. It never deletes, rewrites or re-scores an existing lead.

  Usage (from anywhere):
    node scripts/gmaps-enrich.mjs --job <jobId> [--dry-run] [--from-file results.jsonl]
    node scripts/gmaps-enrich.mjs --all --limit 20 [--dry-run]
    node scripts/gmaps-enrich.mjs --job <id> --force          # ignore GMAPS_ENABLED

  First run without Docker (test the merge logic on a JSONL you already have):
    node scripts/gmaps-enrich.mjs --job <id> --from-file ./sample.jsonl --dry-run
*/

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// src/store.js and src/config.js resolve paths from process.cwd(), so do this
// BEFORE the dynamic imports below (static imports would be evaluated first).
process.chdir(projectRoot);

function parseArgs(argv) {
  const args = { limit: 0, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--job") args.jobId = argv[++i];
    else if (token === "--all") args.all = true;
    else if (token === "--limit") args.limit = Number(argv[++i]) || 0;
    else if (token === "--from-file") args.fromFile = argv[++i];
    else if (token === "--output") args.output = argv[++i];
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--force") args.force = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else console.warn(`Unknown argument ignored: ${token}`);
  }
  return args;
}

function printHelp() {
  console.log(`
Google Maps enrichment (additive, opt-in)

  node scripts/gmaps-enrich.mjs --job <jobId> [options]
  node scripts/gmaps-enrich.mjs --all [options]

Options:
  --all              process the newest jobs (use with --limit)
  --job <id>         process one job
  --limit <n>        max jobs when --all (default 10)
  --from-file <p>    use an existing scraper JSONL instead of running Docker
  --output <p>       CSV report path (default data/gmaps/enrichment-<stamp>.csv)
  --dry-run          do everything except write data/store.json
  --force            run even when GMAPS_ENABLED is not true
  -h, --help         this message

Environment (add to .env; see docs/gmaps-integration.md):
  GMAPS_ENABLED=true       master switch (default false)
  GMAPS_MODE=docker        docker | binary
  GMAPS_IMAGE=gosom/google-maps-scraper
  GMAPS_CACHE_VOLUME=gmaps-playwright-cache
  GMAPS_WORK_DIR=<root>/data/gmaps
  GMAPS_DEPTH=1  GMAPS_CONCURRENCY=2  GMAPS_MAX_QUERIES=50
  GMAPS_TIMEOUT_MS=900000  GMAPS_EXTRA_ARGS="-lang en"

No existing lead field is changed; enrichment lives in lead.gmaps.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  // Dynamic imports run after chdir(), so store paths resolve correctly.
  const { readDb, writeDb } = await import("../src/store.js");
  const source = await import("../src/gmapsSource.js");
  const config = source.gmapsConfig(projectRoot);

  if (!config.enabled && !args.force) {
    console.error("Google Maps enrichment is OFF. Set GMAPS_ENABLED=true in .env, or pass --force.");
    process.exitCode = 2;
    return;
  }

  const db = readDb();
  const allJobs = Object.values(db.jobs || {}).filter(job => job && job.id);
  if (!allJobs.length) {
    console.error("No jobs found in data/store.json. Run a normal search first.");
    process.exitCode = 2;
    return;
  }

  let jobs;
  if (args.jobId) {
    const job = allJobs.find(j => j.id === args.jobId);
    if (!job) {
      console.error(`Job not found: ${args.jobId}`);
      process.exitCode = 2;
      return;
    }
    jobs = [job];
  } else {
    const limit = args.limit || 10;
    jobs = allJobs
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, limit);
  }

  const reportRows = [];
  let totalMatched = 0;
  let totalScraped = 0;

  for (const job of jobs) {
    const leads = Array.isArray(job.leads) ? job.leads : [];
    if (!leads.length) {
      console.log(`[skip] job ${job.id} has no leads`);
      continue;
    }

    const queries = source.buildQueries(leads, job.location, config.maxQueries);
    if (!queries.length) {
      console.log(`[skip] job ${job.id} has no usable business names`);
      continue;
    }

    let entries;
    if (args.fromFile) {
      entries = source.readGmapsJsonl(path.resolve(args.fromFile));
      console.log(`[file] ${path.resolve(args.fromFile)} -> ${entries.length} Google Maps result(s)`);
    } else {
      const resultFile = await source.runGmapsScrape(queries, config);
      entries = source.readGmapsJsonl(resultFile);
      console.log(`[scrape] ${queries.length} queries -> ${entries.length} result(s) in ${resultFile}`);
    }
    totalScraped += entries.length;

    if (!entries.length) {
      console.warn(`[warn] no Google Maps results for job ${job.id}; leaving it untouched`);
      continue;
    }

    const matches = source.matchEntriesToLeads(leads, entries, {
      location: job.location,
      allowNameLocationMatch: config.allowNameLocationMatch
    });
    const changed = source.applyGmapsMatches(leads, entries, matches);
    totalMatched += changed;

    for (const match of matches) {
      reportRows.push({ jobId: job.id, lead: leads[match.leadIndex] });
    }

    console.log(`[job ${job.id}] ${leads.length} lead(s), ${changed} enriched (${matches.map(m => m.matchBy).join(", ") || "none"})`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = args.output
    ? path.resolve(args.output)
    : path.join(config.workDir, `enrichment-${stamp}.csv`);
  source.writeEnrichmentCsv(reportPath, reportRows);

  if (args.dryRun) {
    console.log(`\nDRY RUN — data/store.json was NOT changed. Report: ${reportPath}`);
  } else if (totalMatched > 0) {
    writeDb(db);
    console.log(`\nSaved ${totalMatched} enrichment record(s) to data/store.json. Report: ${reportPath}`);
  } else {
    console.log(`\nNothing matched; data/store.json left untouched. Report: ${reportPath}`);
  }

  console.log(`Summary: ${jobs.length} job(s), ${totalScraped} scraped result(s), ${totalMatched} lead(s) enriched.`);
}

main().catch(err => {
  console.error("gmaps-enrich failed:", err.message);
  process.exitCode = 1;
});
