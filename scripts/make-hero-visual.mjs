/*
  Renders the hero product visual: the lead results panel from /app.

  It is built from the dashboard's own markup and CSS values (.lead-card,
  .lead-top, .cell-label, .tag, .score-pill, .priority-pill, .mini-bar), so it
  matches the real table instead of being a generic illustration. The rows are
  illustrative sample data, not a live capture.

  Run:  node scripts/make-hero-visual.mjs
  Out:  public/hero-leads.png  (1140x720 CSS, rendered at 2x)
*/

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logo = readFileSync(join(root, "public", "leadmoz-logo.png")).toString("base64");

const leads = [
  {
    initial: "B",
    name: "Brightline Dental Studio",
    site: "brightlinedental.com",
    email: "hello@brightlinedental.com",
    phone: "(512) 555-0147",
    status: "Verified",
    statusClass: "ok",
    confidence: 94,
    ai: 8,
    priority: 88,
    band: "hot",
    weakness:
      "Booking page carries no LocalBusiness schema and the blog stopped in 2022, so local search visibility is slipping.",
    proof: "No LocalBusiness schema on /contact &bull; Last post 2022-08-14",
  },
  {
    initial: "C",
    name: "Cedar & Co Interiors",
    site: "cedarandco.studio",
    email: "studio@cedarandco.studio",
    phone: "(512) 555-0192",
    status: "Needs review",
    statusClass: "warn",
    confidence: 71,
    ai: 7,
    priority: 64,
    band: "warm",
    weakness:
      "No pricing page and no case studies, so visitors cannot judge fit before they book a call.",
    proof: "4 portfolio pages &bull; 0 case studies &bull; no /pricing",
  },
  {
    initial: "M",
    name: "Mesa Ridge Roofing",
    site: "mesaridgeroofing.com",
    email: "",
    phone: "(512) 555-0233",
    status: "Review",
    statusClass: "warn",
    confidence: 58,
    ai: 6,
    priority: 52,
    band: "warm",
    weakness: "Site is not mobile responsive and the quote form has no thank-you state.",
    proof: "Fixed 980px layout &bull; no viewport meta tag",
  },
];

const row = (l) => `
  <article class="lead-card">
    <div class="lead-top">
      <div class="lead-name-row">
        <div class="lead-avatar">${l.initial}</div>
        <div>
          <span class="cell-label">Business</span>
          <div class="lead-title">${l.name}${l.status === "Verified" ? '<span class="verified-dot">✓</span>' : ""}</div>
          <div class="site-link">${l.site}</div>
          <span class="tag ok">Scraped</span>
        </div>
      </div>

      <div>
        <span class="cell-label">Contact</span>
        <div class="contact-strong">${l.email || "No verified email"}</div>
        <div class="contact-muted">${l.phone}</div>
        <span class="tag ${l.email ? "ok" : "gray"}">${l.email ? "Email found" : "No verified email"}</span>
      </div>

      <div>
        <span class="cell-label">Status</span>
        <span class="tag ${l.statusClass}">${l.status}</span>
      </div>

      <div>
        <span class="cell-label">Confidence</span>
        <span class="score-pill">${l.confidence}/100</span>
        <div class="mini-bar bar-warm"><i style="width:${l.confidence}%"></i></div>
      </div>

      <div>
        <span class="cell-label">AI score</span>
        <span class="score-pill">${l.ai}/10</span>
      </div>

      <div>
        <span class="cell-label">Priority</span>
        <span class="priority-pill ${l.band}">${l.priority}/100</span>
        <div class="mini-bar bar-warm"><i style="width:${l.priority}%"></i></div>
      </div>
    </div>

    <div class="lead-summary">
      <div>
        <span class="cell-label">Weakness</span>
        <div class="clamp">${l.weakness}</div>
      </div>
      <div>
        <span class="cell-label">Proof</span>
        <div class="clamp">${l.proof}</div>
      </div>
    </div>
  </article>`;

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --fog: #f7f7f7;
    --stone: #636363;
    --muted: #8b8b8b;
    --line: rgba(20, 20, 20, .09);
    --border: rgba(178, 178, 178, .34);
    --green: #0F766E;
    --green-bg: #E9F5F2;
    --amber: #9A5B12;
    --amber-bg: #FBF1DF;
    --orange: #f69251;
    --display: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  body {
    width: 1140px; height: 720px; overflow: hidden;
    background: transparent;
    font-family: var(--display);
    color: #101418;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    position: absolute; left: 24px; top: 20px;
    width: 1092px; height: 680px;
    background: #fff;
    border: 1px solid rgba(27, 25, 22, .10);
    border-radius: 26px;
    box-shadow: 0 34px 64px -34px rgba(27, 25, 22, .38), 0 2px 6px rgba(27, 25, 22, .05);
    overflow: hidden;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 22px 26px 20px;
    border-bottom: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; gap: 14px; }
  .tile { width: 42px; height: 42px; flex: none; border-radius: 13px; background: #101418; display: grid; place-items: center; }
  .tile img { width: 28px; height: 28px; filter: invert(1); }
  .k { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 600; margin-bottom: 4px; }
  h2 { font-size: 21px; font-weight: 600; letter-spacing: -.02em; }
  h2 span { color: var(--stone); font-weight: 500; }
  .stats { display: flex; gap: 10px; }
  .pill {
    display: inline-flex; align-items: center; gap: 7px;
    border: 1px solid var(--border); border-radius: 100px;
    padding: 9px 14px; font-size: 12.5px; font-weight: 500; color: #484758; background: #fff;
  }
  .pill b { font-size: 13.5px; font-weight: 700; color: #101418; }
  .pill.gold { background: rgba(246, 146, 81, .12); border-color: rgba(246, 146, 81, .28); color: #101418; }

  .rows { padding: 16px; display: flex; flex-direction: column; gap: 14px; }

  .lead-card {
    border: 1px solid var(--line); border-radius: 22px; background: #fff; overflow: hidden;
    box-shadow: 0 1px 2px rgba(24, 24, 37, .05);
  }
  .lead-top {
    display: grid;
    grid-template-columns: minmax(230px, 1.45fr) minmax(200px, 1.25fr) 96px 92px 76px 96px;
    gap: 16px; padding: 16px 18px; align-items: start;
  }
  .lead-name-row { display: flex; align-items: flex-start; gap: 12px; }
  .lead-avatar {
    width: 40px; height: 40px; flex: none; border-radius: 13px;
    display: grid; place-items: center; font-size: 16px; font-weight: 600;
    background: linear-gradient(135deg, rgba(246, 146, 81, .26), rgba(240, 81, 95, .16));
    border: 1px solid rgba(246, 146, 81, .28);
  }
  .lead-title { font-size: 16px; font-weight: 600; letter-spacing: -.02em; margin-bottom: 4px; }
  .verified-dot {
    display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; margin-left: 6px; border-radius: 50%;
    background: var(--green); color: #fff; font-size: 10px; font-weight: 700; vertical-align: 2px;
  }
  .site-link { font-size: 12.5px; color: var(--stone); text-decoration: underline; text-underline-offset: 3px; margin-bottom: 9px; }
  .cell-label {
    display: block; color: var(--muted); font-size: 10px; letter-spacing: .06em;
    text-transform: uppercase; font-weight: 600; margin-bottom: 7px;
  }
  .contact-strong { font-size: 13px; font-weight: 600; letter-spacing: -.01em; margin-bottom: 3px; }
  .contact-muted { font-size: 12px; color: var(--muted); margin-bottom: 9px; }
  .tag {
    display: inline-flex; align-items: center; border-radius: 100px; padding: 5px 10px;
    font-size: 11.5px; font-weight: 600; border: 1px solid var(--border); background: #fff; color: #484758;
  }
  .tag.ok { background: var(--green-bg); color: var(--green); border-color: #CBE9E1; }
  .tag.warn { background: var(--amber-bg); color: var(--amber); border-color: #F2DEB1; }
  .tag.gray { color: var(--muted); }
  .score-pill {
    display: inline-flex; border-radius: 100px; padding: 5px 9px; font-size: 11.5px; font-weight: 600;
    background: rgba(246, 146, 81, .12); border: 1px solid rgba(246, 146, 81, .28);
  }
  .priority-pill {
    display: inline-flex; border-radius: 100px; padding: 5px 9px; font-size: 11.5px; font-weight: 600;
  }
  .priority-pill.hot { background: rgba(240, 81, 95, .12); color: #B4232F; border: 1px solid rgba(240, 81, 95, .3); }
  .priority-pill.warm { background: var(--amber-bg); color: var(--amber); border: 1px solid #F2DEB1; }
  .mini-bar { height: 5px; border-radius: 999px; background: rgba(20, 20, 20, .08); overflow: hidden; margin-top: 9px; }
  .mini-bar i { display: block; height: 100%; border-radius: 999px; }
  .bar-warm i { background: linear-gradient(90deg, #fbbf24, #f0515f); }

  .lead-summary {
    border-top: 1px solid var(--line); background: #fafaf8;
    padding: 14px 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
  }
  .clamp { font-size: 12.5px; line-height: 1.5; color: #26262b; }
</style>
</head>
<body>
  <div class="card">
    <header>
      <div class="brand">
        <div class="tile"><img src="data:image/png;base64,${logo}" alt="" /></div>
        <div>
          <div class="k">Research results</div>
          <h2>web design <span>&middot; Austin, TX &middot; Research + AI outreach</span></h2>
        </div>
      </div>
      <div class="stats">
        <span class="pill"><b>40</b> Found</span>
        <span class="pill"><b>31</b> Verified</span>
        <span class="pill gold"><b>12</b> Ready to send</span>
      </div>
    </header>

    <div class="rows">
      ${leads.map(row).join("\n")}
    </div>
  </div>
</body>
</html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1140, height: 720 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });
  const out = join(root, "public", "hero-leads.png");
  await page.screenshot({ path: out, type: "png", omitBackground: true });
  console.log("wrote", out);
} finally {
  await browser.close();
}
