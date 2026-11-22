import * as cheerio from "cheerio";

const CORE_PAGE_KEYWORDS = [
  ["contact", 100],
  ["contact us", 100],
  ["about", 70],
  ["pricing", 70],
  ["price", 60],
  ["features", 60],
  ["book", 40],
  ["appointment", 40]
];

const SOCIAL_HOSTS = {
  facebook: "facebook.com",
  instagram: "instagram.com",
  linkedin: "linkedin.com",
  twitter: "twitter.com",
  x: "x.com",
  youtube: "youtube.com",
  tiktok: "tiktok.com"
};

const PLACEHOLDER_PATTERNS = [
  "yourusername",
  "your_username",
  "your-username",
  "username",
  "companyname",
  "brandname",
  "yourcompany",
  "your-handle",
  "yourhandle",
  "url-here",
  "link-here",
  "example.com",
  "todo",
  "lorem"
];

const IO_TRAP_SEGMENTS = ["company", "home", "follow", "profile", "share"];

function clean(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function uniqString(arr) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length).fill(undefined);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return out;
}

function sameHost(base, link) {
  try {
    const a = new URL(base).hostname.replace(/^www\./, "");
    const b = new URL(link).hostname.replace(/^www\./, "");
    return a === b;
  } catch {
    return false;
  }
}

function resolveHref(base, href = "") {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function cssPathOf($, element) {
  let node = element;
  const parts = [];

  while (node && node.type === "tag" && parts.length < 5) {
    const tag = node.tagName || "";
    const id = $(node).attr("id");
    const classes = ($(node).attr("class") || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);

    if (id) {
      parts.unshift(`#${id}`);
      break;
    }

    if (classes.length) {
      parts.unshift(`${tag}.${classes.join(".")}`);
    } else {
      parts.unshift(tag);
    }

    node = node.parent;
  }

  return parts.join(" > ") || "body";
}

async function probeUrl(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
      }
    });

    if (res.status === 405) {
      res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
        }
      });
    }

    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

function rankCorePages(baseUrl, $) {
  const links = [];

  $("a").each((_, el) => {
    const href = clean($(el).attr("href") || "");
    const text = clean($(el).text());
    const url = resolveHref(baseUrl, href);

    if (!url || !sameHost(baseUrl, url)) return;

    const pathname = url.split("#")[0];
    const hay = `${text} ${new URL(pathname).pathname.toLowerCase()}`;

    let score = 0;
    for (const [keyword, points] of CORE_PAGE_KEYWORDS) {
      if (hay.includes(keyword)) score += points;
    }

    if (score > 0) {
      links.push({
        url: pathname.split("#")[0],
        text,
        score,
        selector: cssPathOf($, el)
      });
    }
  });

  const map = new Map();
  for (const item of links.sort((a, b) => b.score - a.score)) {
    if (!map.has(item.url)) map.set(item.url, item);
  }

  return [...map.values()].slice(0, 10);
}

function isPlaceholderHref(href) {
  const lower = href.toLowerCase();

  let pathname = "";
  try {
    pathname = new URL(href).pathname;
  } catch {
    return true;
  }

  const segments = pathname
    .split("/")
    .map(s => s.replace(/[_\-]+/g, "-").toLowerCase())
    .filter(Boolean);

  if (segments.length === 0) return true;
  if (segments.some(seg => PLACEHOLDER_PATTERNS.includes(seg))) return true;

  const last = segments[segments.length - 1];
  if (IO_TRAP_SEGMENTS.includes(last)) return true;

  for (const seg of segments) {
    if (/\d{4}/.test(seg) && /\b(year|company|username|handle)\b/.test(lower)) return true;
  }

  return false;
}

function detectedPlatform(href, baseUrl) {
  let host = "";
  try {
    host = new URL(href, baseUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "unknown";
  }

  for (const [name, domain] of Object.entries(SOCIAL_HOSTS)) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return name;
    }
  }

  return "";
}

function detectDeadSocialIcons($, baseUrl, pageUrl, seen) {
  const result = [];

  $("a[href]").each((_, el) => {
    const href = clean($(el).attr("href") || "");
    if (!href) return;

    const platform = detectedPlatform(href, baseUrl);
    if (!platform) return;

    const inSocialZone =
      $(el).closest(
        "footer, header, aside, [class*=social], [class*=Social], [id*=social], [id*=Social], [class*=footer], [class*=header]"
      ).length > 0;

    const looksDead =
      href === "#" ||
      href === "" ||
      href.toLowerCase().startsWith("javascript:") ||
      isPlaceholderHref(href);

    if (!looksDead || !inSocialZone) return;

    const key = `${platform}|${href}`;
    if (seen.has(key)) return;
    seen.add(key);

    result.push({
      platform,
      selector: cssPathOf($, el),
      invalid_href: href.slice(0, 120),
      zone: inSocialZone ? "header_or_footer" : "body",
      source_page: pageUrl
    });
  });

  return result;
}

export async function auditLeakingFunnel({ pages, baseUrl }) {
  const brokenInternalLinks = [];
  const deadSocialIcons = [];
  const formIssues = [];
  let hasContactForm = false;

  for (const page of pages) {
    const $ = cheerio.load(page.html);
    const pageUrl = page.url || baseUrl;

    const forms = $("form");
    const isContactPage = /contact|reach|get-in-touch|enquiry|inquiry/i.test(pageUrl);

    if (forms.length > 0 && (isContactPage || /contact/i.test(forms.first().attr("action") || ""))) {
      hasContactForm = true;

      forms.each((_, el) => {
        const action = clean($(el).attr("action") || "");
        const method = clean($(el).attr("method") || "get");

        const hasSubmit =
          $(el).find('input[type="submit"], button[type="submit"], button:not([type])').length > 0 ||
          /submit|send|message|enquir|query|contact/i.test(clean($(el).text()));

        if (!hasSubmit) {
          formIssues.push(`Form on ${pageUrl} has no visible submit button`);
        }

        if (!action) {
          formIssues.push(`Form on ${pageUrl} has no action attribute (submits to same page)`);
        } else if (/^javascript:|^#|^mailto:/i.test(action)) {
          formIssues.push(`Form on ${pageUrl} points to invalid action: ${action.slice(0, 80)}`);
        }
      });
    }
  }

  const homepage = pages.find(p => sameHost(baseUrl, p.url)) || pages[0];

  if (homepage) {
    const $ = cheerio.load(homepage.html);
    const ranked = rankCorePages(baseUrl, $);
    const alreadyFetched = new Set(pages.map(p => p.url.replace(/\/$/, "")));

    const candidates = ranked
      .filter(link => !alreadyFetched.has(link.url.replace(/\/$/, "")))
      .slice(0, 10);

    const probes = await mapWithConcurrency(
      candidates,
      4,
      async (link) => ({ link, status: await probeUrl(link.url) })
    );

    for (const { link, status } of probes) {
      if (status >= 400 && status <= 599) {
        brokenInternalLinks.push({
          source_page: homepage.url,
          broken_url: link.url,
          status_code: status,
          anchor: link.text
        });
      }
    }

    const deadSocialSeen = new Set();

    for (const page of pages) {
      const $$ = cheerio.load(page.html);
      deadSocialIcons.push(...detectDeadSocialIcons($$, baseUrl, page.url, deadSocialSeen));
    }
  }

  return {
    broken_internal_links: brokenInternalLinks,
    dead_social_icons: deadSocialIcons,
    form_vulnerabilities: {
      has_contact_form: hasContactForm,
      issues: uniqString(formIssues)
    }
  };
}

const OG_REQUIRED = ["og:title", "og:description", "og:image", "og:url"];

function isDefaultValue(content = "") {
  const value = clean(content).toLowerCase();
  if (!value) return true;
  if (/^(your \w+|\w+ title|title|description|default|placeholder|sample|example|test|todo|put |add )/.test(value)) return true;
  if (PLACEHOLDER_PATTERNS.some(p => value.includes(p))) return true;
  return false;
}

function extractSchemaTypes($) {
  const types = new Set();

  $('script[type="application/ld+json"]').each((_, el) => {
    let parsed;
    try {
      parsed = JSON.parse($(el).text());
    } catch {
      return;
    }

    const items = Array.isArray(parsed) ? parsed : [parsed];

    const walk = (item) => {
      if (!item || typeof item !== "object") return;

      if (Array.isArray(item["@graph"])) {
        for (const g of item["@graph"]) walk(g);
      }

      const type = item["@type"];
      const list = Array.isArray(type) ? type : [type];

      for (const t of list) {
        if (typeof t === "string" && t.trim()) {
          if (t.includes("/")) {
            types.add(t.split("/").pop() || t);
          } else {
            types.add(t);
          }
        }
      }
    };

    for (const item of items) walk(item);
  });

  $('[itemscope][itemtype]').each((_, el) => {
    const type = clean($(el).attr("itemtype") || "");
    if (type.includes("/")) {
      types.add(type.split("/").pop() || type);
    }
  });

  return [...types];
}

export function auditSeoSchema({ pages }) {
  const homepage = pages[0];

  const $ = cheerio.load(homepage && homepage.html ? homepage.html : "<html></html>");
  const homepageUrl = clean($('meta[property="og:url"]').attr("content") || (homepage && homepage.url) || "");

  const ogTags = {};
  for (const property of OG_REQUIRED) {
    ogTags[property] = clean($(`meta[property="${property}"], meta[name="${property}"]`).attr("content") || "");
  }

  const missingTags = OG_REQUIRED.filter(property => isDefaultValue(ogTags[property]));

  const totalTags = OG_REQUIRED.length;
  const presentTags = totalTags - missingTags.length;
  const isOgValid = presentTags === totalTags;

  const typesFound = [];
  for (const page of pages) {
    const $$ = cheerio.load(page.html);
    typesFound.push(...extractSchemaTypes($$));
  }
  const detectedTypes = uniqString(typesFound);

  return {
    open_graph: {
      is_valid: isOgValid,
      found_tags: Object.fromEntries(
        OG_REQUIRED.map(property => [property, ogTags[property] || ""])
      ),
      missing_tags: missingTags,
      preview_warning: missingTags.length
        ? "Links will look broken or generic when shared on LinkedIn, X, or Slack."
        : "Open Graph tags are complete. Sharing previews should render correctly."
    },
    schema_markup: {
      schema_present: detectedTypes.length > 0,
      detected_types: detectedTypes,
      host: homepage && homepage.url ? new URL(homepage.url).hostname : ""
    }
  };
}

export async function runSiteAudit({ pages, baseUrl }) {
  const leakingFunnel = await auditLeakingFunnel({ pages, baseUrl });
  const seoSchema = auditSeoSchema({ pages });

  return {
    leaking_funnel_audit: leakingFunnel,
    seo_schema_audit: seoSchema,
    auditedAt: new Date().toISOString()
  };
}