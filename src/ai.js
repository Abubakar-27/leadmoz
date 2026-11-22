import { GoogleGenerativeAI } from "@google/generative-ai";
import { deriveWeaknesses } from "./weaknesses.js";
import { buildPitch, formatColdEmail } from "./pitch.js";
import { cachedAnalyze, setCachedAnalyze, cachedClassify, setCachedClassify } from "./aiCache.js";

let disabledProviders = {
  openrouter: false,
  gemini: false,
  groq: false,
  cloudflare: false
};

function hasValue(value) {
  return Boolean(value && String(value).trim() && !String(value).includes("your_"));
}

export function initGemini() {
  const keys = splitKeys(process.env.GEMINI_API_KEYS).length
    ? splitKeys(process.env.GEMINI_API_KEYS)
    : splitKeys(process.env.GEMINI_API_KEY);

  if (!keys.length) {
    console.warn("Missing GEMINI_API_KEY. Gemini will be skipped.");
    return null;
  }

  const model = getGeminiModel(keys[0]);

  if (!model) {
    console.warn("Gemini init failed.");
    return null;
  }

  console.log(`Gemini ready with ${keys.length} pooled key(s).`);
  return model;
}

function safeJsonParse(text = "") {
  const cleaned = String(text)
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const match = cleaned.match(/\{[\s\S]*\}/);

  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  return null;
}

function normalizeAiOutput(parsed, fallback) {
  if (!parsed || typeof parsed !== "object") return fallback;
  function cleanOutreachText(text = "") {
  return String(text)
    .replace(/\[Your Name\]/gi, "")
    .replace(/\[Your Company\]/gi, "")
    .replace(/\[Company\]/gi, "")
    .replace(/\[Name\]/gi, "")
    .replace(/\[Your Website\]/gi, "")
    .replace(/Best,\s*$/i, "Best,")
    .trim();
}

  return {
  score: Math.max(1, Math.min(10, Number(parsed.score) || fallback.score || 5)),
  weaknessSummary: cleanOutreachText(parsed.weaknessSummary || fallback.weaknessSummary || ""),
  personalizationAngle: cleanOutreachText(parsed.personalizationAngle || fallback.personalizationAngle || ""),
  coldEmail: cleanOutreachText(parsed.coldEmail || fallback.coldEmail || ""),
  linkedInDM: cleanOutreachText(parsed.linkedInDM || fallback.linkedInDM || ""),
  callOpener: cleanOutreachText(parsed.callOpener || fallback.callOpener || "")
};
}

function isQuotaOrAuthError(err) {
  const msg = String(err?.message || err || "").toLowerCase();

  return (
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("invalid api key")
  );
}

/*
  A provider is only skipped while every key in its pool is genuinely unusable.
  The previous version latched this on permanently, so one bad response could
  take a provider out for the rest of the server session and only a PM2 restart
  brought it back. Now the latch is re-checked against the pool on each call.
*/
function poolFor(provider) {
  if (provider === "gemini") return geminiPool;
  if (provider === "groq") return groqPool;
  return null;
}

function providerUnavailable(provider, geminiApiKey = "") {
  if (!disabledProviders[provider]) return false;

  // A user-supplied Gemini key is always worth trying.
  if (provider === "gemini" && userGeminiKeys(geminiApiKey).length) {
    disabledProviders.gemini = false;
    return false;
  }

  const pool = poolFor(provider);
  if (pool && pool.hasAvailable()) {
    disabledProviders[provider] = false;
    console.warn(`${provider} re-enabled: a pooled key is available again.`);
    return false;
  }

  return true;
}

function maybeDisableProvider(provider, geminiApiKey = "") {
  if (provider === "gemini") {
    const userKeys = userGeminiKeys(geminiApiKey);
    if (userKeys.length) return false;
    if (geminiPool.hasAvailable()) return false;
    disabledProviders.gemini = true;
    console.warn("gemini paused: all pooled keys are on cooldown or invalid.");
    return true;
  }

  if (provider === "groq") {
    if (groqPool.hasAvailable()) return false;
    disabledProviders.groq = true;
    console.warn("groq paused: all pooled keys are on cooldown or invalid.");
    return true;
  }

  return false;
}

function getWebsiteSignals(scraped) {
  const signals = scraped.signals || {};

  return {
    hasBooking: Boolean(signals.hasBooking),
    hasPricing: Boolean(signals.hasPricing),
    hasTestimonials: Boolean(signals.hasTestimonials),
    hasCTA: Boolean(signals.hasCTA),
    hasEmail: Boolean(signals.hasEmail || scraped.primaryEmail || scraped.emails?.length),
    hasPhone: Boolean(signals.hasPhone || scraped.primaryPhone || scraped.phones?.length),
    likelyOldSite: Boolean(signals.likelyOldSite),
    textLength: Number(signals.textLength || scraped.text?.length || 0),
    /*
      The outbound-pitch booleans. Each is a measured markup fact, and each is
      null when no page was read, so the model only hears "missing" when we
      actually opened the site (see scrape.js detectHtmlSignals).
    */
    missingPixel: signals.missingPixel === true,
    noClickToCall: signals.noClickToCall === true,
    noSocialsFound: signals.noSocialsFound === true,
    missingMobileOptimization: signals.missingMobileOptimization === true,
    ownerName: String(signals.ownerName || scraped.ownerName || ""),
    /*
      The measured counts and markup facts, kept in the same shape the
      dashboard's findings are derived from. Without these the prompt saw a
      narrower boolean set than the dashboard did, so the model was told about
      a different site than the user was looking at — and the countable
      evidence (page count, images missing alt, the copyright year) that makes
      a summary read as this site's audit never reached it.
    */
    hasViewport: signals.hasViewport === true,
    hasMetaDescription: signals.hasMetaDescription === true,
    hasSchemaMarkup: signals.hasSchemaMarkup === true,
    linkCount: Number(signals.linkCount || 0),
    imageCount: signals.imageCount == null ? null : Number(signals.imageCount),
    imagesMissingAlt: signals.imagesMissingAlt == null ? null : Number(signals.imagesMissingAlt),
    imagesMissingAltCount: signals.imagesMissingAltCount == null ? null : Number(signals.imagesMissingAltCount),
    /*
      The rest of the markup counts, measured on the same download. They are
      passed as plain numbers so the model can quote the one that actually
      fired for this site instead of reaching for the alt-text count out of
      habit - which is what made every card lead with the same sentence.
    */
    imagesMissingDimensions: signals.imagesMissingDimensions == null ? null : Number(signals.imagesMissingDimensions),
    pagesMissingTitle: signals.pagesMissingTitle == null ? null : Number(signals.pagesMissingTitle),
    htmlLangMissing: signals.htmlLangMissing === true,
    hasCanonical: signals.hasCanonical === true,
    hasFaqSchema: signals.hasFaqSchema === true,
    schemaSameAsCount: signals.schemaSameAsCount == null ? null : Number(signals.schemaSameAsCount),
    h1Count: signals.h1Count == null ? null : Number(signals.h1Count),
    missingH1: signals.missingH1 === true,
    /*
      Tracking tags, read from the downloaded markup. Kept as explicit booleans
      so the model can pitch "you have no analytics installed" only when we
      actually looked and found none.
    */
    hasGoogleAnalytics: signals.hasGoogleAnalytics === true,
    hasFacebookPixel: signals.hasFacebookPixel === true,
    /*
      AEO facts, read from the markup and the site's own robots.txt. Passed to
      the model so it can pitch AI-search visibility only from what we measured,
      and kept as plain values rather than prose.
    */
    aeoGrade: String(signals.aeoGrade || ""),
    aiCrawlersBlocked: Array.isArray(signals.aiCrawlersBlocked) ? signals.aiCrawlersBlocked : [],
    hasOrganizationSchema: signals.hasOrganizationSchema === true,
    noindex: signals.noindex === true,
    copyrightYear: String(signals.copyrightYear || "")
  };
}

function buildPrompt({ scraped, niche, location, serviceOffer }) {
  const signals = getWebsiteSignals(scraped);

  /*
    The verified findings, handed to the model as the authoritative shortlist.

    Without this the model is asked to infer a weakness from a bag of booleans,
    which is exactly how a Calendly site's scheduler turned into "no booking
    option" in a cold email. Deriving them here means the copy is written about
    the same findings the dashboard shows, and the model is told plainly which
    ones are measured and which are only guesses.
  */
  const findings = deriveWeaknesses({
    website: scraped.website,
    scrapeOk: scraped.scrapeOk,
    niche,
    rawSignals: signals
  });

  const verified = findings.filter(f => f.class === "defect");
  const inferred = findings.filter(f => f.class === "opportunity");

  const findingBlock = verified.length
    ? verified.map(f => `- [VERIFIED FAULT] ${f.label}: ${f.detail}`).join("\n")
    : "- [VERIFIED FAULT] none. Nothing measurable is wrong with this site.";

  const upsideBlock = inferred.length
    ? inferred.map(f => `- [NOT A FAULT, just missing] ${f.label}`).join("\n")
    : "- none";

  return `
You are a B2B lead research assistant.

Analyze this business website for outreach.

Niche: ${niche}
Location: ${location}
Service being sold: ${serviceOffer}

Website data:
Business name: ${scraped.businessName || ""}
Website: ${scraped.website || ""}
Title: ${scraped.title || ""}
Meta description: ${scraped.description || ""}
Emails: ${(scraped.emails || []).join(", ")}
Phones: ${(scraped.phones || []).join(", ")}
Addresses: ${(scraped.addresses || []).join(", ")}

Findings already verified by our own crawler:
${findingBlock}

Things the site does not have, which are upsells and NOT defects:
${upsideBlock}

Signals:
${JSON.stringify(signals, null, 2)}

Website text sample:
${String(scraped.text || "").slice(0, 3500)}

Rules:
- Return ONLY valid JSON.
- Do not use markdown.
- Do not write generic outreach.
- Mention the business name.
- In weaknessSummary, name 2-3 distinct points from the two lists above. Lead with the highest-severity [VERIFIED FAULT] and quote a number measured on THAT fault - the count of pages missing a title, the images with no alt text, the images with no size, the characters of text read, the pages crawled, the copyright year, or the Google review count. Pick the number that belongs to the fault you are leading with; never default to the alt-text count when a different fault ranks higher. Then name one or two [NOT A FAULT, just missing] items as additions the site could make, phrased as an offer rather than a fault. Keep it to at most 3 sentences and never reuse the same sentence shape for two different sites.
- Lead with a [VERIFIED FAULT] if there is one. Those were measured and the prospect can confirm them.
- Only describe an item from the "NOT A FAULT" list as an opportunity or an offer, never as something broken, missing, or failing.
- If the verified list says none, do NOT invent a fault. Describe growth upside instead, in wording that does not accuse them of anything.
- If the site has booking, pricing, testimonials, CTA, email, or phone, do not claim it is missing.
- Never invent a specific technical fault. Do not mention speed, security, HTTPS, mobile layout, broken links, forms, or structured data unless it appears in the verified list above.
- The cold email must sound human, short, and direct.
- Do not use spammy words like "boost", "skyrocket", "guaranteed", "limited time".
- Cold email must be under 120 words.
- LinkedIn DM must be under 350 characters.
- Call opener must sound natural.

Return this exact JSON shape:
{
  "score": 1-10,
  "weaknessSummary": "specific weakness in 1-2 sentences",
  "personalizationAngle": "specific angle to personalize outreach",
  "coldEmail": "plain text only. Include subject line and email body in one string. Do not return an object.",
  "linkedInDM": "short DM under 350 characters",
  "callOpener": "short call opener"
}
`;
}

export function fallbackLead(scraped, niche = "", location = "", serviceOffer = "") {
  const signals = scraped.signals || {};
  const businessName = scraped.businessName || "your business";

  /*
    Taken from the same derivation the dashboard and the prompt use, rather than
    rebuilt from the raw booleans.

    This used to list "there is no clear booking or scheduling option" the
    moment hasBooking was false, which is how a Calendly site got told it had no
    booking in its own email. deriveWeaknesses already accounts for embedded
    widgets, unreadably thin pages and the price-opaque niches, so the fallback
    cannot quietly reintroduce every claim the rest of the system refuses to
    make.
  */
  const findings = deriveWeaknesses({
    website: scraped.website,
    scrapeOk: scraped.scrapeOk,
    niche,
    rawSignals: signals
  });

  const defects = findings.filter(f => f.class === "defect");
  const opportunities = findings.filter(f => f.class === "opportunity");

  /*
    Only a measured fault is allowed to lead. With no fault to lead with, the
    summary names the addition instead of dressing a missing testimonial up as a
    problem, which is the claim a prospect can disprove.

    The clause must stand alone. It used to read "nothing is broken, but there is
    room to add ..." and then get wrapped in "has a website, but ...", which
    produced "has a website, but nothing is broken, but there is room to add ...".

    An opportunity must use its gain phrase, never its label. The label is written
    as a negative finding ("No reviews or testimonials"), so dropping it straight
    after "room to add" produced "room to add no reviews or testimonials".
  */
  const lead_ = defects[0] || null;

  const mainWeakness = lead_
    ? `there is a real problem: ${lead_.label.toLowerCase()}`
    : opportunities.length
      ? `there is room to add ${opportunities[0].gain || opportunities[0].label.toLowerCase()}`
      : "nothing measurable is wrong with it";

  /*
    A second, different point so every lead carries more than one pitchable
    weakness. Prefer another measured fault; fall back to the first named
    addition, always phrased as an offer. Skipped silently when the site only
    produced the one finding.
  */
  const secondPoint = lead_ ? defects[1] || opportunities[0] : opportunities[1];
  const secondLine = secondPoint
    ? secondPoint.class === "defect"
      ? ` It also has ${secondPoint.label.toLowerCase()}.`
      : ` It could also add ${secondPoint.gain || secondPoint.label.toLowerCase()}.`
    : "";

  const offer =
    serviceOffer ||
    "I help local businesses improve their websites so more visitors turn into calls and quote requests";

  const ownerName = signals.ownerName || scraped.ownerName || "";

  /*
    The deterministic pitch, derived from the same measured findings as the rest
    of the system. Used whenever the model is unavailable or returns nothing, so
    a lead still leaves with a real, fact-based email instead of a template that
    guesses.
  */
  const pitch = buildPitch({
    businessName,
    ownerName,
    niche,
    location,
    weaknesses: findings,
    offer
  });

  const pitchLine = pitch.line || "Nothing on your site looks broken, which usually means the growth is sitting unused.";

  return {
    score: Math.max(4, Math.min(10, 10 - defects.length)),
    weaknessSummary: `${businessName} has a website, but ${mainWeakness}.${secondLine}`,
    personalizationAngle: `Mention ${businessName}, their ${niche || "local service"} website, and focus on turning more ${location || "local"} visitors into inquiries.`,
    coldEmail: formatColdEmail(pitch),
    linkedInDM:
`Hi, I came across ${businessName}. ${pitchLine} I help local businesses turn more website visitors into enquiries - want me to send 2 ideas?`,
    connectionNote: pitch.connectionNote || "",
    followUps: Array.isArray(pitch.followUps) ? pitch.followUps : [],
    callOpener:
`Hi, I found ${businessName} while checking ${niche || "local businesses"} in ${location || "your area"}. ${pitchLine} Who looks after your website?`
  };
}

function splitKeys(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(s => s && !s.includes("your_"));
}

const QUOTA_COOLDOWN_MS = Number(process.env.AI_KEY_COOLDOWN_MS || 10 * 60 * 1000);
// Auth-class errors (401/403, including a project-level "denied access") get a
// long pause rather than a permanent one, so a provider can still come back.
const AUTH_COOLDOWN_MS = Number(process.env.AI_KEY_AUTH_COOLDOWN_MS || 6 * 60 * 60 * 1000);

/*
  A pool of API keys per provider.
  - Round-robins so quota is spread across all keys.
  - A key that returns 429/5xx is put on a cooldown (not the whole provider).
  - A key that returns 401/403 is paused for a long cooldown.
  - A 404 (retired/misspelled model) is a config problem and never penalises a key.
  This is what stops one exhausted key from disabling an entire provider.
*/
/*
  How a failed call should affect the key that made it.
  - "model": the model name is wrong (404). Nothing is wrong with the key, so
    the key must not be penalised -- this is what silently killed Groq before.
  - "auth":  401/403, including a project-level "denied access". Pause the key.
  - "quota": 429 and friends. Short cooldown, then rotate back in.
*/
export function classifyKeyError(err) {
  const msg = String(err?.message || err || "").toLowerCase();

  if (msg.includes("404") || msg.includes("not found") || msg.includes("no longer available")) {
    return "model";
  }

  if (
    msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") ||
    msg.includes("forbidden") || msg.includes("invalid api key") || msg.includes("api key not valid")
  ) {
    return "auth";
  }

  return "quota";
}

function createKeyPool(getKeys) {
  const state = new Map();
  let cursor = 0;

  const keyState = key => {
    if (!state.has(key)) state.set(key, { disabledUntil: 0 });
    return state.get(key);
  };

  const available = key => {
    const s = keyState(key);
    return Date.now() >= s.disabledUntil;
  };

  const ordered = () => {
    const keys = getKeys();
    if (keys.length <= 1) return keys;

    const start = cursor % keys.length;
    return [...keys.slice(start), ...keys.slice(0, start)];
  };

  return {
    keys: () => getKeys(),
    ordered,
    available,
    hasAvailable: () => getKeys().some(available),
    size: () => getKeys().length,

    onSuccess(key) {
      if (!key) return;
      keyState(key).disabledUntil = 0;
      const keys = getKeys();
      const idx = keys.indexOf(key);
      if (idx >= 0) cursor = idx + 1;
    },

    onQuotaError(key) {
      if (!key) return;
      keyState(key).disabledUntil = Date.now() + QUOTA_COOLDOWN_MS;
      console.warn(`AI key on cooldown for ${QUOTA_COOLDOWN_MS}ms (quota/rate limit).`);
    },

    onAuthError(key) {
      if (!key) return;
      // Not "forever": a project-level 403 or a revoked key can recover, and a
      // session-latched block meant one bad response disabled a provider until
      // someone restarted PM2.
      keyState(key).disabledUntil = Date.now() + AUTH_COOLDOWN_MS;
      console.warn(`AI key paused for ${AUTH_COOLDOWN_MS}ms (auth/quota-per-key error).`);
    },

    recordError(key, err) {
      const kind = classifyKeyError(err);
      if (kind === "model") {
        console.warn("AI model error (not a key problem):", String(err?.message || err).slice(0, 120));
        return;
      }
      if (kind === "auth") this.onAuthError(key);
      else this.onQuotaError(key);
    }
  };
}

function userGeminiKeys(geminiApiKey = "") {
  return hasValue(geminiApiKey) ? splitKeys(geminiApiKey) : [];
}

const geminiPool = createKeyPool(() => {
  const server = splitKeys(process.env.GEMINI_API_KEYS);
  if (server.length) return server;
  return splitKeys(process.env.GEMINI_API_KEY);
});

const groqPool = createKeyPool(() => {
  const server = splitKeys(process.env.GROQ_API_KEYS);
  if (server.length) return server;
  return splitKeys(process.env.GROQ_API_KEY);
});

const modelCache = new Map();

function getGeminiModel(key) {
  if (!hasValue(key)) return null;

  if (modelCache.has(key)) return modelCache.get(key);

  try {
    const genAI = new GoogleGenerativeAI(key.trim());
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-flash-latest"
    });

    modelCache.set(key, model);
    return model;
  } catch (err) {
    console.warn("Gemini model build failed:", err.message);
    modelCache.set(key, null);
    return null;
  }
}

async function callGeminiWithKeys(prompt, keys, pool) {
  let lastErr = null;

  for (const key of keys) {
    if (pool && !pool.available(key)) continue;

    const model = getGeminiModel(key);
    if (!model) {
      if (pool) pool.onAuthError(key);
      lastErr = new Error("Gemini model not initialized");
      continue;
    }

    try {
      const res = await model.generateContent(prompt);
      if (pool) pool.onSuccess(key);
      return res.response.text();
    } catch (err) {
      if (pool) pool.recordError(key, err);
      lastErr = err;
      console.warn(`gemini key ...${String(key).slice(-4)} failed: ${err.message?.slice(0, 120)}`);
    }
  }

  throw lastErr || new Error("No usable Gemini API key");
}

export function providerStatus(geminiApiKey = "") {
  const userKeys = userGeminiKeys(geminiApiKey);
  const allGemini = [...userKeys, ...geminiPool.keys()].filter((k, i, arr) => arr.indexOf(k) === i);

  return {
    gemini: {
      total: allGemini.length,
      available: allGemini.filter(k => !userKeys.includes(k) ? geminiPool.available(k) : true).length,
      userKeys: userKeys.length
    },
    groq: {
      total: groqPool.size(),
      available: groqPool.keys().filter(k => groqPool.available(k)).length
    }
  };
}

async function callOpenRouter(prompt) {
  if (disabledProviders.openrouter) {
    throw new Error("OpenRouter disabled for this session");
  }

  if (!hasValue(process.env.OPENROUTER_API_KEY)) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:5050",
      "X-Title": "Leadmoz"
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || "openrouter/free",
      messages: [
        {
          role: "system",
          content: "You return only valid JSON. No markdown."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.4
    })
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`OpenRouter failed ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }

  return json?.choices?.[0]?.message?.content || "";
}

async function callGemini(prompt, geminiApiKey = "") {
  if (providerUnavailable("gemini", geminiApiKey)) {
    throw new Error("Gemini paused: all pooled keys are on cooldown or invalid");
  }

  // User-supplied keys first, then the server pool.
  const userKeys = userGeminiKeys(geminiApiKey);
  const serverKeys = geminiPool.ordered();
  const allKeys = [...userKeys, ...serverKeys.filter(k => !userKeys.includes(k))];

  if (!allKeys.length) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  return await callGeminiWithKeys(prompt, allKeys, geminiPool);
}

async function callGroq(prompt) {
  if (providerUnavailable("groq")) {
    throw new Error("Groq paused: all pooled keys are on cooldown or invalid");
  }

  const keys = groqPool.ordered();

  if (!keys.length) {
    throw new Error("Missing GROQ_API_KEY");
  }

  let lastErr = null;

  for (const key of keys) {
    if (!groqPool.available(key)) continue;

    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
          messages: [
            {
              role: "system",
              content: "You are a B2B lead research assistant. Return only valid JSON. No markdown."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.4
        })
      });

      if (!res.ok) {
        const body = await res.text();
        groqPool.recordError(key, new Error(`Groq failed ${res.status}: ${body.slice(0, 200)}`));
        lastErr = new Error(`Groq failed ${res.status}`);
        continue;
      }

      const json = await res.json().catch(() => ({}));
      groqPool.onSuccess(key);

      return json?.choices?.[0]?.message?.content || "";
    } catch (err) {
      groqPool.recordError(key, err);
      lastErr = err;
    }
  }

  throw lastErr || new Error("No usable Groq API key");
}

const CLOUDFLARE_AI_MODELS = [
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/zai-org/glm-4.7-flash"
];

async function callCloudflare(prompt) {
  if (providerUnavailable("cloudflare")) {
    throw new Error("Cloudflare AI paused: daily neuron allocation exhausted or token invalid");
  }

  const token = process.env.CLOUDFLARE_AI_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!hasValue(token) || !hasValue(account)) {
    throw new Error("Missing CLOUDFLARE_AI_TOKEN or CLOUDFLARE_ACCOUNT_ID");
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`;
  const models = String(process.env.CLOUDFLARE_AI_MODEL || "").trim()
    ? [String(process.env.CLOUDFLARE_AI_MODEL).trim(), ...CLOUDFLARE_AI_MODELS]
    : CLOUDFLARE_AI_MODELS;

  let lastErr = null;

  for (const model of models) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: "You are a B2B lead research assistant. Return only valid JSON. No markdown."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          // Workers AI reasoning models emit a `reasoning` field and can return
          // content:null when the budget is too small. 1500 leaves headroom.
          max_tokens: Number(process.env.CLOUDFLARE_AI_MAX_TOKENS || 1500),
          temperature: 0.2
        })
      });

      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Cloudflare AI failed ${res.status}: ${body.slice(0, 200)}`);
        lastErr = err;
        // 403/5035 means the model needs the Workers Paid plan; try the next one.
        if (res.status === 403) continue;
        if (res.status === 401) {
          disabledProviders.cloudflare = true;
          throw err;
        }
        if (res.status === 429) {
          disabledProviders.cloudflare = true;
          console.warn("cloudflare paused: daily 10k neuron allocation exhausted.");
          throw err;
        }
        continue;
      }

      const json = await res.json().catch(() => ({}));
      const content = json?.choices?.[0]?.message?.content;

      if (!content) {
        lastErr = new Error(`Cloudflare AI ${model} returned empty content`);
        continue;
      }

      return content;
    } catch (err) {
      if (disabledProviders.cloudflare) throw err;
      lastErr = err;
    }
  }

  throw lastErr || new Error("No usable Cloudflare AI model");
}

/*
  Provider health, so one dead provider cannot tax every single lead.

  Why this exists
  ---------------
  The order below only ever considered configuration, never observed health. A
  run against the live host logged 668 `openrouter timed out after 25000ms`
  entries: openrouter sits first in the queue, so EVERY lead paid its full 25s
  timeout before the chain moved on to a provider that actually answers. On a
  job that scrapes 200+ sites that is hours of dead time, and it is the reason a
  Glasgow dental search for 20 leads finished with 6 - the worker simply ran out
  of wall clock while waiting on a provider that was never going to reply.

  A provider that hangs is demoted for a while, not removed: this is the same
  shape as the Overpass mirror health in apis/osm.js, and for the same reason.
  A provider that answers is promoted back by having no penalty at all.
*/
const PROVIDER_HANG_COOLDOWN_MS = 5 * 60 * 1000;
const PROVIDER_FAIL_COOLDOWN_MS = 60 * 1000;
// A daily quota does not recover in a minute. Retrying it every 60s spent the
// whole job re-asking a provider that is out of allowance until tomorrow.
const PROVIDER_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
const providerHealth = new Map();

function noteProviderSuccess(provider) {
  providerHealth.delete(provider);
}

function providerFailureKind(message) {
  const text = String(message || "");

  if (/429|rate limit|quota|exceeded|too many requests/i.test(text)) return "quota";
  if (/timed out|abort/i.test(text)) return "hang";

  return "fail";
}

function noteProviderFailure(provider, { kind = "fail" } = {}) {
  const prev = providerHealth.get(provider) || { fails: 0 };

  const cooldown =
    kind === "quota" ? PROVIDER_QUOTA_COOLDOWN_MS
      : kind === "hang" ? PROVIDER_HANG_COOLDOWN_MS
        : PROVIDER_FAIL_COOLDOWN_MS;

  providerHealth.set(provider, { fails: prev.fails + 1, until: Date.now() + cooldown });
}

function getProviderOrder(geminiApiKey = "") {
  const hasUserGemini = hasValue(geminiApiKey);
  const preferred = hasUserGemini ? "gemini" : String(process.env.AI_PROVIDER || "openrouter").toLowerCase();

  const all = ["cloudflare", "openrouter", "gemini", "groq"];
  const now = Date.now();

  const penalty = provider => {
    const health = providerHealth.get(provider);
    if (!health) return 0;
    // Cooling providers sort last; the 1000 keeps them behind every healthy one
    // regardless of how many times they have failed.
    return health.until > now ? 1000 + health.fails : health.fails;
  };

  const ordered = [
    preferred,
    ...all.filter(provider => provider !== preferred)
  ];

  /*
    Stable sort on penalty only. Array.prototype.sort is stable, so providers
    with equal health keep the configured preference order - a healthy
    openrouter still outranks a healthy groq.
  */
  return [...ordered].sort((a, b) => penalty(a) - penalty(b));
}

async function callProvider(provider, prompt, opts = {}) {
  const timeoutMs = Number(process.env.AI_CALL_TIMEOUT_MS || 25000);
  const enhanced = async () => {
    if (provider === "openrouter") return await callOpenRouter(prompt);
    if (provider === "gemini") return await callGemini(prompt, opts.geminiApiKey || "");
    if (provider === "groq") return await callGroq(prompt);
    if (provider === "cloudflare") return await callCloudflare(prompt);
    throw new Error(`Unknown AI provider: ${provider}`);
  };

  // Workers AI reasoning models are far slower than Groq on the long analyzeLead
  // prompt, so they get their own, larger budget instead of failing at 25s.
  const isCloudflare = provider === "cloudflare";
  const budget = isCloudflare
    ? Number(process.env.CLOUDFLARE_AI_TIMEOUT_MS || 60000)
    : timeoutMs;

  try {
    const content = await withTimeout(enhanced(), budget, `${provider} timed out after ${budget}ms`);
    noteProviderSuccess(provider);
    return content;
  } catch (err) {
    /*
      Cool a provider by the reason it failed: a daily quota is out until much
      later, a hang needs minutes, and anything else gets a short pause.
    */
    noteProviderFailure(provider, { kind: providerFailureKind(err && err.message) });
    throw err;
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function buildBusinessTypePrompt({ scraped, niche, location }) {
  return `
You are a strict B2B lead qualification filter. Return ONLY valid JSON.

TARGET NICHE: ${niche || "(any local service)"}
TARGET LOCATION: ${location || "(anywhere)"}

WEBSITE:
URL: ${scraped.website || ""}
Business name: ${scraped.businessName || ""}
Title: ${scraped.title || ""}
Meta description: ${scraped.description || ""}
Addresses: ${(scraped.addresses || []).join(" | ")}
Phones: ${(scraped.phones || []).join(", ")}

PAGE TEXT (first 3000 chars):
${String(scraped.text || "").slice(0, 3000)}

Decide two things.

1) businessType — what kind of page is this? Pick exactly one:
   "single_local_business" = ONE real business that sells its own services
   "directory" = lists or profiles MULTIPLE businesses
   "marketplace" = connects buyers and sellers / classifieds
   "aggregator" = compiles stats, rankings, reviews of many businesses
   "government" = .gov or any government/regulatory agency page
   "educational" = school, college, academy, university, course provider
   "informational_content" = blog/guide/SEO article, no business being sold
   "online_only_service" = sells nationally/online with no local presence
   "other" = anything else

2) Fit:
   servesNiche = this single business actually offers "${niche}" services
   servesLocation = this business physically operates in/serves "${location}"

Rules:
- A site that mostly LISTS other businesses is a directory, even if it has one "featured" company.
- A site selling web design/SEO/lead-gen/courses TO businesses is not a "${niche}" business.
- A site about licenses, permits, state boards, or regulations is government/informational_content, not a business to sell websites to.
- Educational institutions (barber school, trade school, college) are "educational", not the target local business.
- If you cannot confirm the business is a single real local business, set isSingleBusiness to false.
- Reason must be one short sentence.

Return this exact JSON shape:
{
  "businessType": "",
  "isSingleBusiness": true,
  "servesNiche": true,
  "servesLocation": true,
  "reason": ""
}`;
}

export async function classifyBusinessType({ scraped, niche = "", location = "", geminiApiKey = "" }) {
  if (!scraped || !scraped.scrapeOk) return null;

  const prompt = buildBusinessTypePrompt({ scraped, niche, location });
  const providers = getProviderOrder(geminiApiKey);

  const ckeyUrl = scraped.website || scraped.url || "";
  const cached = cachedClassify(ckeyUrl, niche, location);
  if (cached) return cached;

  for (const provider of providers) {
    try {
      const text = await callProvider(provider, prompt, { geminiApiKey });
      const parsed = safeJsonParse(text);

      if (!parsed) {
        throw new Error(`${provider} returned invalid JSON`);
      }

      const isSingleBusiness =
        parsed.isSingleBusiness === true ||
        String(parsed.businessType || "").toLowerCase() === "single_local_business";

      const out = {
        businessType: String(parsed.businessType || (isSingleBusiness ? "single_local_business" : "other"))
          .trim()
          .toLowerCase(),
        isSingleBusiness,
        servesNiche: parsed.servesNiche !== false,
        servesLocation: parsed.servesLocation !== false,
        reason: String(parsed.reason || "").slice(0, 200),
        provider
      };
      setCachedClassify(ckeyUrl, niche, location, out);
      return out;
    } catch (err) {
      console.warn(`classifyBusinessType: ${provider} failed:`, err.message?.slice(0, 200));

      if (isQuotaOrAuthError(err)) {
        maybeDisableProvider(provider, geminiApiKey);
      }
    }
  }

  return null;
}

export async function analyzeLead({ scraped, niche, location, serviceOffer, geminiApiKey = "" }) {
  const fallback = fallbackLead(scraped, niche, location, serviceOffer);

  if (!scraped.scrapeOk) {
    return fallback;
  }

  const cacheKeyUrl = scraped.website || scraped.url || "";

  const prompt = buildPrompt({
    scraped,
    niche,
    location,
    serviceOffer
  });

  const providers = getProviderOrder(geminiApiKey);

  for (const provider of providers) {
    try {
      const text = await callProvider(provider, prompt, { geminiApiKey });
      const parsed = safeJsonParse(text);

      if (!parsed) {
        throw new Error(`${provider} returned invalid JSON`);
      }

      console.log(`AI provider used: ${provider}`);

      const out = normalizeAiOutput(parsed, fallback);
      setCachedAnalyze(cacheKeyUrl, niche, location, out);
      return out;
    } catch (err) {
      console.warn(`${provider} failed:`, err.message?.slice(0, 200));

      if (isQuotaOrAuthError(err)) {
        maybeDisableProvider(provider, geminiApiKey);
      }
    }
  }

  console.warn("All AI providers failed. Using local fallback.");
  return fallback;
}