import * as cheerio from "cheerio";
import axios from "axios";
import { chromium } from "playwright";

async function getBrowser() {
  try {
    return await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-images",
        "--disable-plugins",
        "--disable-javascript",
      ],
    });
  } catch (err) {
    return null;
  }
}

function extractPhones(text) {
  const matches = text.match(/(\+\d{1,3}[\s-]?)?(\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/g);
  return matches || [];
}

function extractEmails(text) {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  return matches || [];
}

export async function ingestDirectory(url, { useBrowser = false } = {}) {
  const results = [];

  try {
    if (useBrowser) {
      const browser = await getBrowser();
      if (browser) {
        const context = await browser.newContext({
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        });
        const page = await context.newPage();
        await page.route("**/*", (route) => {
          const req = route.request();
          const type = req.resourceType();
          if (["image", "font", "stylesheet", "media", "script"].includes(type)) {
            return route.abort();
          }
          return route.continue();
        });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        const html = await page.content();
        await context.close();
        await browser.close();

        const $ = cheerio.load(html);
        $("body *").each((_, el) => {
          const text = $(el).text();
          const phones = extractPhones(text);
          const emails = extractEmails(text);
          const name = $(el).find("h1,h2,h3,a").first().text().trim();
          if ((phones.length || emails.length) && name) {
            results.push({
              business_name: name,
              category: "",
              phone: phones[0] || "",
              email: emails[0] || "",
              geographic_coordinates: "",
              source: "directory",
            });
          }
        });
        return results;
      }
    }

    const res = await axios.get(url, {
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      maxContentLength: 5 * 1024 * 1024,
    });

    const $ = cheerio.load(res.data);
    const text = $("body").text();
    const phones = extractPhones(text);
    const emails = extractEmails(text);
    $("a,h3,h2,h1").each((_, el) => {
      const name = $(el).text().trim();
      if (name && name.length > 3) {
        results.push({
          business_name: name,
          category: "",
          phone: phones[0] || "",
          email: emails[0] || "",
          geographic_coordinates: "",
          source: "directory",
        });
      }
    });
    return results.slice(0, 50);
  } catch (err) {
    console.error("Directory ingest error:", err.message);
    return [];
  }
}
