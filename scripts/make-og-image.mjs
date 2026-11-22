/*
  Renders the social share card (og:image) used by every page.

  Why this exists: the page markup has no og:image, so chat apps and social
  networks fall back to scraping a photo from the page - which picked up a
  testimonial avatar. A real 1200x630 card replaces that fallback.

  The card is drawn as HTML and screenshotted with the same Chromium the
  scraping pipeline already ships, so there is no extra image dependency and
  the layout is easy to tweak.

  Run:  node scripts/make-og-image.mjs
  Out:  public/og-leadmoz.png  (1200x630)
*/

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logo = readFileSync(join(root, "public", "leadmoz-logo.png")).toString("base64");

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    background: #16181d; color: #fff;
    font-family: "Segoe UI", Inter, system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
 .card {
    position: relative; width: 1200px; height: 630px;
    padding: 60px 72px 52px; display: flex; flex-direction: column;
  }
 .glow {
    position: absolute; inset: 0; pointer-events: none;
    background:
      radial-gradient(760px 420px at 92% 4%, rgba(255,122,0,.22), transparent 68%),
      radial-gradient(680px 460px at 4% 102%, rgba(255,122,0,.11), transparent 70%);
  }
 .rule {
    position: absolute; left: 0; top: 0; width: 100%; height: 6px;
    background: linear-gradient(90deg, #ff7a00 0%, #ff7a00 26%, rgba(255,122,0,0) 62%);
  }
  header { display: flex; align-items: center; gap: 20px; position: relative; }
 .mark { width: 82px; height: 82px; filter: invert(1); }
 .word { font-size: 40px; font-weight: 700; letter-spacing: -.025em; }
  main { position: relative; margin-top: 54px; }
  h1 {
    font-size: 74px; line-height: 1.06; letter-spacing: -.035em; font-weight: 700;
    max-width: 1010px;
  }
  h1 .accent { color: #ff8a24; }
  p {
    margin-top: 28px; font-size: 26px; line-height: 1.42; font-weight: 400;
    color: rgba(255,255,255,.66); max-width: 920px; letter-spacing: -.005em;
  }
  footer {
    position: relative; margin-top: auto; display: flex; align-items: center;
    justify-content: space-between; padding-top: 34px;
    border-top: 1px solid rgba(255,255,255,.12);
  }
 .domain { font-size: 25px; font-weight: 600; color: #ff8a24; letter-spacing: -.01em; }
 .note { font-size: 20px; color: rgba(255,255,255,.45); letter-spacing: .01em; }
</style>
</head>
<body>
  <div class="card">
    <div class="glow"></div>
    <div class="rule"></div>

    <header>
      <img class="mark" src="data:image/png;base64,${logo}" alt="" />
      <span class="word">Leadmoz</span>
    </header>

    <main>
      <h1>Find verified local leads<br /><span class="accent">and outreach that gets replies.</span></h1>
      <p>Search by niche and city. Verified contacts, quality scores, and ready-to-send outreach in one dashboard.</p>
    </main>

    <footer>
      <span class="domain">leadmoz.com</span>
      <span class="note">AI lead research for freelancers and agencies</span>
    </footer>
  </div>
</body>
</html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  const out = join(root, "public", "og-leadmoz.png");
  await page.screenshot({ path: out, type: "png" });
  console.log("wrote", out);
} finally {
  await browser.close();
}
