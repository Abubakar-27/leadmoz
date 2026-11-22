/*
  Seed the appsumo_codes store from a CSV of AppSumo purchase codes.

  Expected shape: one code per line, code in the first column, no header row,
  e.g. "LEAD-XXXXX-XXXXX". Idempotent: codes already in the store are skipped,
  so re-running after a partial seed only adds what is missing.

  Usage:
    node scripts/seed-appsumo-codes.mjs [path-to-csv]

  The path defaults to the leadio_appsumo_codes.csv export in Downloads.
*/
import fs from "fs";
import * as S from "../src/appsumoCodes.js";

const CSV = process.argv[2] || "C:\\Users\\Arsh\\Downloads\\leadio_appsumo_codes.csv";

if (!fs.existsSync(CSV)) {
  console.error(`CSV not found: ${CSV}`);
  process.exit(1);
}

const lines = fs.readFileSync(CSV, "utf8").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
const codes = lines.map(line => String(line).split(",")[0].trim()).filter(Boolean);

const res = S.insertSumoCodes(codes);

console.log(`input:     ${codes.length} code(s) read from ${CSV}`);
console.log(`added:     ${res.added}`);
console.log(`skipped (already present or duplicate in CSV): ${res.skipped}`);
console.log(`invalid:   ${res.invalid}`);
console.log(`total in store: ${res.total}`);

const redeemed = S.readSumoCodes().codes.filter(c => c.is_used === true).length;
console.log(`redeemed so far: ${redeemed}`);

if (res.added === 0 && res.skipped === 0 && res.total === 0) process.exit(1);
process.exit(res.invalid > codes.length / 2 ? 1 : 0);