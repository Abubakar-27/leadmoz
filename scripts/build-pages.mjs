/*
  Static template-page generator.

  Emits:
    /compare/<slug>/     from  content/compare.json
    /leads/<niche>/<city>/  from  content/leads.json

  These land in public/ and are served by the existing express.static(PUBLIC_DIR)
  mount, so no server code or route changes are involved.

  Indexing rule: a page is indexable only when status === "published" AND every
  required field is present. Otherwise it is written with
  <meta name="robots" content="noindex, nofollow"> so a half-filled draft can
  never be indexed. No statistics are ever invented here: the operator supplies
  the content, this script only formats it.

  Run: node scripts/build-pages.mjs
*/

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "public");
const BASE = "https://leadmoz.com";

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const slugify = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function loadJson(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return { pages: [] };
  return JSON.parse(readFileSync(p, "utf8"));
}

function hasText(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function breadcrumb(title, canonical) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", "position": 1, "name": "Leadmoz", "item": BASE + "/" },
      { "@type": "ListItem", "position": 2, "name": title, "item": canonical }
    ]
  };
}

function webPage(title, description, canonical) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description: description,
    url: canonical,
    isPartOf: { "@type": "WebSite", name: "Leadmoz", url: BASE + "/" }
  };
}

const STYLE = `
:root{
  --fog:#f7f7f7; --snow:#fff; --ink:#16181d; --graphite:#3f4249; --stone:#6b6e76;
  --pebble:#9a9da4; --orange:#ff7a00; --line:rgba(20,22,28,.10); --line-soft:rgba(20,22,28,.06);
  --display:"DM Sans",Inter,ui-sans-serif,system-ui,sans-serif; --font:Inter,ui-sans-serif,system-ui,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--fog);color:var(--ink);font-family:var(--font);-webkit-font-smoothing:antialiased;letter-spacing:-.01em}
a{color:inherit}
.tpl-page{max-width:880px;margin:0 auto;padding:104px 24px 72px}
.tpl-crumb{font-size:13px;color:var(--pebble);margin:0 0 18px}
.tpl-crumb a{color:var(--stone);text-decoration:none}
.tpl-crumb a:hover{color:var(--orange)}
.tpl-page h1{font-family:var(--display);font-size:clamp(30px,4.4vw,46px);line-height:1.08;letter-spacing:-.028em;margin:0 0 16px}
.tpl-lede{color:var(--graphite);font-size:18px;line-height:1.65;margin:0 0 30px}
.tpl-page h2{font-family:var(--display);font-size:23px;line-height:1.25;letter-spacing:-.015em;margin:34px 0 12px}
.tpl-page p{color:var(--graphite);font-size:16.5px;line-height:1.7;margin:0 0 18px}
.tpl-table-wrap{overflow-x:auto;border:1px solid var(--line-soft);border-radius:16px;background:var(--snow);margin:24px 0}
.tpl-table{width:100%;min-width:600px;border-collapse:collapse;font-size:15px}
.tpl-table th,.tpl-table td{padding:14px 16px;text-align:left;border-bottom:1px solid var(--line-soft);vertical-align:top;color:var(--graphite)}
.tpl-table thead th{background:var(--fog);font-family:var(--display);font-weight:600;color:var(--ink)}
.tpl-table thead th:nth-child(2){color:var(--orange)}
.tpl-table tbody tr:last-child td{border-bottom:0}
.tpl-meta{font-size:13px;color:var(--pebble)}
.tpl-meta a{color:var(--stone)}
.tpl-cta{margin-top:40px;padding:26px;background:var(--ink);color:#fff;border-radius:16px;text-align:center}
.tpl-cta h2{margin:0 0 8px;color:#fff;font-size:20px}
.tpl-cta p{margin:0 0 16px;color:rgba(255,255,255,.75);font-size:14.5px}
.tpl-cta a{display:inline-block;background:var(--orange);color:#1b1916;font-family:var(--display);font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;text-decoration:none}
.tpl-draft-note{max-width:880px;margin:0 auto 0;padding:0 24px}
.tpl-draft-note p{background:#fff6ec;border:1px solid #f2d9bd;color:#7a4a12;border-radius:12px;padding:12px 16px;font-size:13.5px;margin:24px 0 0}
`;

function shell({ title, description, canonical, indexable, ogType, jsonld, body }) {
  const ld = jsonld.map((o) => '  <script type="application/ld+json">' + JSON.stringify(o) + "</script>").join("\n");
  const draft = indexable ? "" : '\n    <div class="tpl-draft-note"><p><strong>Draft.</strong> This page is not published and is marked noindex. Fill the required fields in the content file and set status to "published", then rebuild to index it.</p></div>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${canonical}" />
<meta name="robots" content="${indexable ? "index, follow" : "noindex, nofollow"}" />
<meta property="og:type" content="${ogType}" />
<meta property="og:site_name" content="Leadmoz" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${canonical}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<link rel="icon" href="/favicon.png" />
<link rel="apple-touch-icon" href="/favicon.png" />
<meta name="theme-color" content="#f7f7f7" />
<link rel="stylesheet" href="/nav.css" />
<style>${STYLE}</style>
${ld}
</head>
<body data-page="template">
<a class="skip-link" href="#main">Skip to content</a>
<!-- Generated by scripts/build-pages.mjs from content/*.json. Edit the data, not this file. -->
<main class="tpl-page" id="main">
${body}
</main>${draft}
<script src="/nav.js"></script>
</body>
</html>
`;
}

function renderCompare(page, indexable) {
  const canonical = BASE + "/compare/" + page.slug + "/";
  const rows = page.rows
    .map(
      (r) =>
        "        <tr><th scope=\"row\">" + esc(r.dimension) + "</th><td>" + esc(r.ours) + "</td><td>" + esc(r.them) + "</td></tr>"
    )
    .join("\n");
  const body =
    '  <p class="tpl-crumb"><a href="/">Leadmoz</a> / Comparison</p>\n' +
    "  <h1>" + esc(page.title) + "</h1>\n" +
    '  <p class="tpl-lede">' + esc(page.positioning) + "</p>\n" +
    '  <div class="tpl-table-wrap"><table class="tpl-table">\n' +
    "    <thead><tr><th>Dimension</th><th>Leadmoz</th><th>" + esc(page.competitor) + "</th></tr></thead>\n" +
    "    <tbody>\n" + rows + "\n    </tbody>\n" +
    "  </table></div>\n" +
    "  <h2>Who each is for</h2>\n" +
    "  <p>" + esc(page.whoFor) + "</p>\n" +
    '  <p class="tpl-meta">Last updated ' + esc(page.updated) + '. Competitor details from <a href="' + esc(page.competitorUrl) + '" target="_blank" rel="noopener nofollow">' + esc(page.competitor) + "</a>; check the provider before deciding.</p>\n" +
    '  <div class="tpl-cta"><h2>Try Leadmoz free</h2><p>Search a niche and city, verify contacts, and draft outreach in minutes.</p><a href="/auth?plan=free">Start free</a></div>';
  return shell({
    title: page.title,
    description: page.description,
    canonical,
    indexable,
    ogType: "article",
    jsonld: [breadcrumb(page.title, canonical), webPage(page.title, page.description, canonical)],
    body
  });
}

function renderLeads(page, indexable) {
  const nicheSlug = slugify(page.niche);
  const citySlug = slugify(page.city);
  const canonical = BASE + "/leads/" + nicheSlug + "/" + citySlug + "/";
  const body =
    '  <p class="tpl-crumb"><a href="/">Leadmoz</a> / Leads</p>\n' +
    "  <h1>" + esc(page.title) + "</h1>\n" +
    '  <p class="tpl-lede">' + esc(page.description) + "</p>\n" +
    "  <h2>What actually works here</h2>\n" +
    "  <p>" + esc(page.uniqueInsight) + "</p>\n" +
    "  <h2>Service angle to lead with</h2>\n" +
    "  <p>" + esc(page.serviceAngle) + "</p>\n" +
    "  <p class=\"tpl-meta\">Last updated " + esc(page.updated) + ".</p>\n" +
    "  <div class=\"tpl-cta\"><h2>Find " + esc(page.niche) + " prospects in " + esc(page.city) + "</h2><p>Set your niche, location, and offer, then review the leads before you reach out.</p><a href=\"/auth?plan=free\">Start free</a></div>";
  return shell({
    title: page.title,
    description: page.description,
    canonical,
    indexable,
    ogType: "article",
    jsonld: [breadcrumb(page.title, canonical), webPage(page.title, page.description, canonical)],
    body
  });
}

function missingCompare(p) {
  const miss = [];
  for (const f of ["slug", "competitor", "competitorUrl", "positioning", "whoFor", "title", "description", "updated"]) {
    if (!hasText(p[f])) miss.push(f);
  }
  if (!Array.isArray(p.rows) || p.rows.length < 4) miss.push("rows(>=4)");
  else if (p.rows.some((r) => !hasText(r.dimension) || !hasText(r.ours) || !hasText(r.them))) miss.push("row fields");
  return miss;
}

function missingLeads(p) {
  const miss = [];
  for (const f of ["slug", "niche", "city", "title", "description", "uniqueInsight", "serviceAngle", "updated"]) {
    if (!hasText(p[f])) miss.push(f);
  }
  if (hasText(p.uniqueInsight) && p.uniqueInsight.trim().length < 80) miss.push("uniqueInsight(>=80 chars)");
  return miss;
}

function writePage(relDir, html) {
  const dir = join(OUT, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html, "utf8");
  return "/" + relDir.replace(/\\/g, "/") + "/";
}

const report = [];

const compare = loadJson("content/compare.json");
for (const p of compare.pages) {
  const miss = missingCompare(p);
  const indexable = p.status === "published" && miss.length === 0;
  if (!indexable && p.status === "published") report.push(`compare/${p.slug}: status=published but missing ${miss.join(", ")} -> noindex`);
  const urlPath = writePage(join("compare", p.slug), renderCompare(p, indexable));
  report.push(`compare ${urlPath} ${indexable ? "INDEX" : "noindex"}`);
}

const leads = loadJson("content/leads.json");
for (const p of leads.pages) {
  const miss = missingLeads(p);
  const indexable = p.status === "published" && miss.length === 0;
  if (!indexable && p.status === "published") report.push(`leads/${p.slug}: status=published but missing ${miss.join(", ")} -> noindex`);
  const urlPath = writePage(join("leads", slugify(p.niche), slugify(p.city)), renderLeads(p, indexable));
  report.push(`leads    ${urlPath} ${indexable ? "INDEX" : "noindex"}`);
}

console.log("build-pages: wrote " + report.filter((r) => r.includes("/")).length + " page(s)");
for (const line of report) console.log("  " + line);
