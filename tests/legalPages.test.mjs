import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PUBLIC = path.join(process.cwd(), "public");
const SRC = path.join(process.cwd(), "src");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok -", name);
  } catch (err) {
    failed++;
    console.error("  FAIL -", name);
    console.error("   ", err.message);
    process.exitCode = 1;
  }
}

const PAGES = [
  { slug: "terms", file: "terms.html" },
  { slug: "privacy", file: "privacy.html" },
  { slug: "refund", file: "refund.html" }
];

const read = (f) => fs.readFileSync(path.join(PUBLIC, f), "utf8");
const serverSrc = fs.readFileSync(path.join(SRC, "server.js"), "utf8");

PAGES.forEach(({ slug, file }) => {
  check(`${file} exists`, () => {
    assert.ok(fs.existsSync(path.join(PUBLIC, file)), "file missing");
  });

  check(`${file} is a complete html document`, () => {
    const html = read(file);
    assert.ok(html.includes("<!doctype html>"), "missing doctype");
    assert.ok(html.includes("</html>"), "unclosed html");
    assert.ok(html.includes("<title>"), "missing title");
    assert.ok(html.includes('name="viewport"'), "missing viewport");
  });

  check(`${file} every table-of-contents anchor resolves`, () => {
    const html = read(file);
    const ids = new Set([...html.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]));
    const links = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    assert.ok(links.length > 0, "no table of contents found");
    for (const l of links) {
      assert.ok(ids.has(l), `anchor #${l} has no matching <h2 id>`);
    }
  });

  check(`${file} no unrendered template placeholders`, () => {
    const html = read(file);
    const bad = html.match(/\{\{|\$\{|PLACEHOLDER|\[undefined\]/);
    assert.ok(
      !bad,
      bad
        ? `found placeholder near: ${html.slice(Math.max(0, bad.index - 40), bad.index + 40)}`
        : ""
    );
  });

  check(`${file} identifies the operator and a contact route`, () => {
    const html = read(file);
    assert.ok(html.includes("Abubakar Naeem"), "operator name missing");
    assert.ok(html.includes("mailto:abubakar.reachout@gmail.com"), "contact email missing");
  });

  check(`/${slug} route is registered`, () => {
    const block = serverSrc.match(/const LEGAL_PAGES = \[[\s\S]*?\];/);
    assert.ok(block, "LEGAL_PAGES block missing from server.js");
    assert.ok(block[0].includes(`"${slug}"`), `slug ${slug} not in LEGAL_PAGES`);
    assert.ok(block[0].includes(file), `${file} not mapped in LEGAL_PAGES`);
  });
});

check("legal routes are public, not behind auth", () => {
  const block = serverSrc.match(/for \(const \{ slug, file \} of LEGAL_PAGES\) \{[\s\S]*?\n\}/);
  assert.ok(block, "route loop missing");
  assert.ok(!block[0].includes("requireAuth"), "legal page must not require auth");
  assert.ok(!block[0].includes("requireAdmin"), "legal page must not require admin");
});

check("each legal path redirects its .html form", () => {
  PAGES.forEach(({ slug }) => {
    assert.ok(
      serverSrc.includes("app.get(`/${slug}.html`"),
      `/${slug}.html redirect missing`
    );
  });
});

/*
  The refund policy commits to specific promises. If someone later softens the
  no-refund stance in the UI, the page promising it should be caught here.
*/
check("refund policy states the no-refund position and the service-failure exception", () => {
  const html = read("refund.html");
  assert.ok(/no refunds? on paid plans/i.test(html), "no-refund statement missing");
  assert.ok(/never activated|never activated/i.test(html), "failed-activation case missing");
  assert.ok(/substantial part of your paid period/i.test(html), "technical-failure case missing");
});

check("privacy notice discloses the sensitive data actually stored", () => {
  const html = read("privacy.html");
  for (const item of ["email address", "password", "SMTP", "retention", "deletion"]) {
    assert.ok(
      new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(html),
      `privacy notice does not mention: ${item}`
    );
  }
});

check("terms disclaim guaranteed accuracy and unlimited availability", () => {
  const html = read("terms.html");
  assert.ok(/not guaranteed|do not guarantee/i.test(html), "accuracy guarantee missing");
  assert.ok(/as is|as available/i.test(html), "warranty disclaimer missing");
});

console.log(`\nlegalPages: ${passed} passed, ${failed} failed`);
