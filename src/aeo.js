/*
  Answer Engine Optimization (AEO) facts.

  A newer question than SEO: when someone asks ChatGPT, Perplexity or Claude
  about a trade in a town, can those engines even reach this site, and can they
  tell who the business is? Every answer here is read from the pages we already
  downloaded plus (optionally) the site's own robots.txt, so no extra rendering
  and no new dependency is involved.

  Two rules carried over from the rest of the pipeline:

    - A markup fact is only reported when we actually observed it. With no HTML,
      `hasOrganizationSchema` is null rather than false, so a site we never
      opened is never accused of missing schema.

    - Blocking AI crawlers is reported as the measured robots.txt fact it is,
      quoting the exact agents - never as "your SEO is broken".
*/

/*
  The agents that decide whether an AI assistant can cite a site. Kept to the
  ones a prospect can actually verify by opening their own robots.txt, so the
  copy can name them without hand-waving. Anthropic's agent has been published
  under more than one token, so all of them are matched.
*/
const AI_CRAWLERS = [
  { key: "gptbot", label: "GPTBot (ChatGPT)", match: /^(gptbot)$/i },
  { key: "oai-searchbot", label: "OAI-SearchBot (ChatGPT Search)", match: /^(oai-searchbot)$/i },
  { key: "claudebot", label: "ClaudeBot (Anthropic)", match: /^(claudebot|claude-web|anthropic-ai)$/i },
  { key: "perplexitybot", label: "PerplexityBot", match: /^(perplexitybot)$/i },
  { key: "ccbot", label: "CCBot (Common Crawl)", match: /^(ccbot)$/i },
  { key: "google-extended", label: "Google-Extended (Gemini)", match: /^(google-extended)$/i }
];

/* Pulls every JSON-LD object out of the markup, flattening @graph. Plain regex
   rather than a DOM parse so the module stays dependency-free and unit-testable. */
function schemaItems(html) {
  const items = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match;
  while ((match = re.exec(html))) {
    try {
      const parsed = JSON.parse(match[1]);
      const arr = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        items.push(item);

        if (Array.isArray(item["@graph"])) {
          for (const graphItem of item["@graph"]) {
            if (graphItem && typeof graphItem === "object") items.push(graphItem);
          }
        }
      }
    } catch {}
  }

  return items;
}

function typeString(item) {
  return Array.isArray(item["@type"]) ? item["@type"].join(" ") : String(item["@type"] || "");
}

/*
  Markup-only facts. Each returns null when there was no HTML at all, so a lead
  built before this existed is never scored as if it failed the checks.
*/
export function analyzeAeoHtml(html = "") {
  const source = String(html || "");

  if (!source.trim()) {
    return {
      hasCanonical: null,
      hasHreflang: null,
      noindex: null,
      hasOrganizationSchema: null,
      hasFaqSchema: null,
      schemaSameAsCount: 0
    };
  }

  const hasCanonical = /<link[^>]+rel=["']?canonical["']?/i.test(source);
  const hasHreflang = /<link[^>]+hreflang=/i.test(source);
  const noindex =
    /<meta[^>]+name=["']?robots["']?[^>]*content=["'][^"']*noindex/i.test(source) ||
    /<meta[^>]+content=["'][^"']*noindex[^"']*["'][^>]*name=["']?robots["']?/i.test(source);

  const items = schemaItems(source);

  let hasOrganizationSchema = false;
  let hasFaqSchema = false;
  let schemaSameAsCount = 0;

  for (const item of items) {
    const type = typeString(item);

    if (/Organization|LocalBusiness|ProfessionalService|Store|Restaurant|Dentist|Plumber|Electrician|AutoRepair|LegalService/i.test(type)) {
      hasOrganizationSchema = true;
    }

    if (/FAQPage/i.test(type)) hasFaqSchema = true;

    if (Array.isArray(item.sameAs)) schemaSameAsCount += item.sameAs.length;
    else if (typeof item.sameAs === "string" && item.sameAs) schemaSameAsCount += 1;

    if (item.publisher && Array.isArray(item.publisher.sameAs)) {
      schemaSameAsCount += item.publisher.sameAs.length;
    }
  }

  return { hasCanonical, hasHreflang, noindex, hasOrganizationSchema, hasFaqSchema, schemaSameAsCount };
}

/*
  robots.txt is plain text, so it is parsed by hand rather than with the HTML
  fetcher (which deliberately rejects anything that is not text/html). A group
  blocks an AI crawler when its User-agent matches that crawler (or is `*`) and
  the group disallows the root without a matching Allow: /.
*/
export function parseRobotsAiAccess(robotsTxt = "") {
  const text = String(robotsTxt || "");

  if (!text.trim()) return { robotsFetched: false, blocked: [], blockedAllAi: false };

  const groups = new Map();
  let agents = [];
  let inAgentBlock = false;

  const group = agent => {
    if (!groups.has(agent)) groups.set(agent, { disallowRoot: false, allowRoot: false });
    return groups.get(agent);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const ua = line.match(/^user-agent\s*:\s*(.+)$/i);
    if (ua) {
      const agent = ua[1].trim().toLowerCase();
      if (!inAgentBlock) {
        agents = [];
        inAgentBlock = true;
      }
      agents.push(agent);
      group(agent);
      continue;
    }

    const rule = line.match(/^(disallow|allow)\s*:\s*(.*)$/i);
    if (rule) {
      inAgentBlock = false;
      const isDisallow = rule[1].toLowerCase() === "disallow";
      const path = rule[2].trim();
      const isRoot = path === "/" || path === "/*";

      for (const agent of agents) {
        const g = group(agent);
        if (isDisallow && isRoot) g.disallowRoot = true;
        if (!isDisallow && isRoot) g.allowRoot = true;
      }
    }
  }

  const blocked = [];

  for (const crawler of AI_CRAWLERS) {
    const direct = [...groups.entries()].filter(([agent]) => crawler.match.test(agent));
    const wildcard = groups.get("*");

    const isBlocked =
      direct.some(([, g]) => g.disallowRoot && !g.allowRoot) ||
      (direct.length === 0 && wildcard && wildcard.disallowRoot && !wildcard.allowRoot);

    if (isBlocked) blocked.push(crawler.label);
  }

  const blockedAllAi = blocked.length === AI_CRAWLERS.length;

  return { robotsFetched: true, blocked, blockedAllAi };
}

/*
  A blunt 0-100 score that exists to give a rep a single sortable number and a
  letter to put on a card. Every deduction is gated on an observed fact, so a
  site we could not read scores 100 rather than being punished for our failure
  to fetch it.
*/
export function aeoGrade({
  aiCrawlersBlocked = [],
  noindex = null,
  hasCanonical = null,
  hasHreflang = null,
  hasOrganizationSchema = null,
  hasFaqSchema = null,
  schemaSameAsCount = 0
} = {}) {
  const issues = [];
  let score = 100;

  if (noindex === true) {
    score -= 30;
    issues.push("Page is set to noindex, so search and AI engines are told to ignore it.");
  }

  if (Array.isArray(aiCrawlersBlocked) && aiCrawlersBlocked.length) {
    score -= Math.min(40, aiCrawlersBlocked.length * 12);
    issues.push(`robots.txt blocks ${aiCrawlersBlocked.length} AI crawler(s): ${aiCrawlersBlocked.join(", ")}.`);
  }

  if (hasOrganizationSchema === false) {
    score -= 15;
    issues.push("No Organization/LocalBusiness schema, so engines cannot identify the business with confidence.");
  }

  if (hasCanonical === false) {
    score -= 8;
    issues.push("No canonical URL declared.");
  }

  if (hasHreflang === false) {
    score -= 4;
    issues.push("No hreflang tags (only matters for multi-language sites).");
  }

  if (hasFaqSchema === false) {
    score -= 6;
    issues.push("No FAQ schema.");
  }

  if (hasOrganizationSchema === true && schemaSameAsCount === 0) {
    score -= 5;
    issues.push("Organization schema carries no sameAs links to the business's profiles.");
  }

  score = Math.max(0, Math.min(100, score));

  const grade =
    score >= 90 ? "A+" : score >= 80 ? "A" : score >= 65 ? "B" : score >= 45 ? "C" : score >= 25 ? "D" : "F";

  return { aeoScore: score, aeoGrade: grade, aeoIssues: issues };
}

export function analyzeAeo({ html = "", robotsTxt = "" } = {}) {
  const markup = analyzeAeoHtml(html);
  const robots = parseRobotsAiAccess(robotsTxt);
  const { aeoScore, aeoGrade: grade, aeoIssues } = aeoGrade({
    aiCrawlersBlocked: robots.blocked,
    noindex: markup.noindex,
    hasCanonical: markup.hasCanonical,
    hasHreflang: markup.hasHreflang,
    hasOrganizationSchema: markup.hasOrganizationSchema,
    hasFaqSchema: markup.hasFaqSchema,
    schemaSameAsCount: markup.schemaSameAsCount
  });

  return { ...markup, ...robots, aeoScore, aeoGrade: grade, aeoIssues };
}

export const AI_CRAWLER_LABELS = AI_CRAWLERS.map(c => c.label);
