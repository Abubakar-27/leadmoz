/*
  One-off rebrand: leadio.site -> leadmoz.com.

  Deliberately NOT touched:
    - leadio_user_id  (Paddle custom_data key that existing subscriptions carry;
                       renaming it would orphan those subscribers)
    - .env            (holds secrets; SITE_URL/PUBLIC_BASE_URL are changed by hand)
    - scratch files (_*.mjs), .deploy-compare/, .dbg-sandbox/, leadio.zip

  Run: node scripts/rebrand-leadmoz.mjs [--write]
*/

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const WRITE = process.argv.includes("--write");

const ROOTS = ["src", "public", "content", "data", "docs", "scripts", "tests"];
const FILES = ["index.html", ".env.example", "README.txt"];

const SKIP_DIRS = new Set([".git", "node_modules", ".deploy-compare", ".dbg-sandbox", ".tmp", "uploads"]);
const SKIP_FILE = (name) => name.startsWith("_") || name === "leadio.zip" || name === "rebrand-leadmoz.mjs";
const TEXT = /\.(js|mjs|cjs|html|json|txt|md|xml|css|yml|yaml|example)$/i;

/*
  Order matters. The uid key is masked first so the lowercase sweep can never
  rewrite it, then it is restored untouched at the end.
*/
const RULES = [
    ["leadio_user_id", "\u0000UID\u0000"],
    ["https://leadio.site", "https://leadmoz.com"],
    ["http://leadio.site", "http://leadmoz.com"],
    ["leadio.site", "leadmoz.com"],
    ["leadio-logo.png", "leadmoz-logo.png"],
    ["LeadioLeadBot", "LeadmozLeadBot"],
    ["leadio-leadfinder", "leadmoz-leadfinder"],
    ["leadio-location-suggest", "leadmoz-location-suggest"],
    ["leadio-vs-", "leadmoz-vs-"],
    ["Leadio", "Leadmoz"],
    ["Lead io", "Leadmoz"],
    ["leadio-", "leadmoz-"],
    ["\u0000UID\u0000", "leadio_user_id"]
];

const changed = [];

function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full);
            continue;
        }
        if (SKIP_FILE(entry.name)) continue;
        if (!TEXT.test(entry.name)) continue;
        let body;
        try {
            body = readFileSync(full, "utf8");
        } catch {
            continue;
        }
        let next = body;
        for (const [from, to] of RULES) next = next.split(from).join(to);
        if (next === body) continue;
        const hits = RULES.reduce((n, [from]) => n + body.split(from).length - 1, 0);
        changed.push({ file: relative(ROOT, full), hits });
        if (WRITE) writeFileSync(full, next);
    }
}

for (const dir of ROOTS) {
    try {
        if (statSync(join(ROOT, dir)).isDirectory()) walk(join(ROOT, dir));
    } catch {
        /* missing directory is fine */
    }
}
for (const file of FILES) {
    const full = join(ROOT, file);
    let body;
    try {
        body = readFileSync(full, "utf8");
    } catch {
        continue;
    }
    let next = body;
    for (const [from, to] of RULES) next = next.split(from).join(to);
    if (next === body) continue;
    changed.push({ file, hits: RULES.reduce((n, [from]) => n + body.split(from).length - 1, 0) });
    if (WRITE) writeFileSync(full, next);
}

changed.sort((a, b) => b.hits - a.hits);
for (const c of changed) console.log(`${String(c.hits).padStart(4)}  ${c.file}`);
console.log(`\n${changed.length} files ${WRITE ? "rewritten" : "would change"} (${changed.reduce((n, c) => n + c.hits, 0)} replacements)`);
if (!WRITE) console.log("Re-run with --write to apply.");
