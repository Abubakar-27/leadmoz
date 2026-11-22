import fs from "fs";
import path from "path";
import { detectNonBusinessSite, locationEvidence } from "./advancedVerifier.js";
import { classifyBusinessType } from "./ai.js";
import { serviceProviderEvidence } from "./nicheCheck.js";

const dataDir = path.join(process.cwd(), "data");
const cachePath = path.join(dataDir, "lead-gate.json");

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let cache = null;

function getDomain(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function loadCache() {
  if (cache) return cache;

  try {
    if (fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        cache = parsed;
        return cache;
      }
    }
  } catch (err) {
    console.warn("lead-gate cache read failed:", err.message);
  }

  cache = {};
  return cache;
}

function saveCache() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache || {}, null, 2));
  } catch (err) {
    console.warn("lead-gate cache write failed:", err.message);
  }
}

function readVerdict(domain) {
  if (!domain) return null;

  const entry = loadCache()[domain];
  if (!entry || typeof entry !== "object") return null;

  const at = Number(entry.at || 0);
  if (!at || Date.now() - at > CACHE_TTL_MS) {
    delete loadCache()[domain];
    return null;
  }

  return entry;
}

function writeVerdict(domain, verdict) {
  if (!domain) return;

  loadCache()[domain] = {
    isSingleBusiness: Boolean(verdict.isSingleBusiness),
    businessType: String(verdict.businessType || "other"),
    reason: String(verdict.reason || "").slice(0, 200),
    at: Date.now()
  };

  saveCache();
}

const NICHE_REJECT_TYPES = new Set([
  "directory",
  "marketplace",
  "aggregator",
  "government",
  "informational_content",
  "online_only_service",
  "educational"
]);

/*
  Order of checks (cheapest first):
  1. Rule-based non-business detector  -> no AI cost
  2. Cached AI verdict for this domain   -> no AI cost on repeat searches
  3. Strong rule evidence (niche + area in name/title/address) -> no AI cost
  4. AI classification                  -> only for ambiguous candidates

  Returns { decided, isLead, reason, source }.
  "decided: false" means we do not block the lead.
*/
export async function screenLead({ scraped, niche = "", location = "", geminiApiKey = "" }) {
  const domain = getDomain(scraped.website || scraped.url || "");

  const rules = detectNonBusinessSite(scraped, { niche });
  if (rules.hardReject) {
    writeVerdict(domain, { isSingleBusiness: false, businessType: "directory", reason: rules.reason });
    return { decided: true, isLead: false, reason: rules.reason, source: "rules" };
  }

  const cached = readVerdict(domain);

  if (cached && cached.isSingleBusiness === false) {
    return {
      decided: true,
      isLead: false,
      reason: cached.reason || "Previously classified as a directory/aggregator, not a single business",
      source: "cache"
    };
  }

  const locStrength = locationEvidence(scraped, location);

  if (cached && cached.isSingleBusiness === true && locStrength === "strong") {
    return { decided: false, isLead: true, reason: "", source: "cache+rules" };
  }

  // A niche keyword on its own is not proof. "Barber Law Office", "Barber Life
  // Academy" and "The Pet Barber" all contain the word, so the keyword match
  // only counts once the site also shows real signs of running the trade.
  if (
    locStrength === "strong" &&
    nicheInStrongFields(scraped, niche) &&
    serviceProviderEvidence(scraped).score >= 8
  ) {
    return { decided: false, isLead: true, reason: "", source: "rules" };
  }

  const ai = await classifyBusinessType({ scraped, niche, location, geminiApiKey });

  if (!ai) {
    return { decided: false, isLead: true, reason: "", source: "unavailable" };
  }

  writeVerdict(domain, ai);

  if (!ai.isSingleBusiness || NICHE_REJECT_TYPES.has(ai.businessType)) {
    return {
      decided: true,
      isLead: false,
      reason: ai.reason || `Site type "${ai.businessType}" is not a single local ${niche || "business"}`,
      source: "ai"
    };
  }

  if (!ai.servesNiche) {
    return {
      decided: true,
      isLead: false,
      reason: ai.reason || `Does not offer ${niche || "this service"}`,
      source: "ai"
    };
  }

  if (!ai.servesLocation) {
    /*
      A location alias appearing in the business name is not proof of location.
      "White Buffalo Coffee Bar" matched the "buffalo" alias for a New York job,
      which made locStrength "strong" and let an out-of-area business through
      even though the classifier had already said it was elsewhere.

      The address is the only reliable local evidence, so it is allowed to
      override the classifier and nothing else is.
    */
    const addressOnly = { addresses: Array.isArray(scraped.addresses) ? scraped.addresses : [] };
    const addressStrength = locationEvidence(addressOnly, location);

    if (addressStrength !== "strong") {
      return {
        decided: true,
        isLead: false,
        reason: ai.reason || `Not located in ${location || "the target area"}`,
        source: "ai"
      };
    }
  }

  return { decided: false, isLead: true, reason: "", source: "ai" };
}

function nicheInStrongFields(scraped, niche = "") {
  const words = String(niche || "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(w => w.length >= 3);

  if (!words.length) return false;

  const strong = [
    scraped.businessName,
    scraped.title,
    scraped.description,
    ...(Array.isArray(scraped.addresses) ? scraped.addresses : [])
  ]
    .join(" ")
    .toLowerCase();

  const head = String(scraped.text || "").slice(0, 2500).toLowerCase();
  const haystack = `${strong} ${head}`;

  return words.some(word => {
    const singular = word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word;
    return haystack.includes(singular);
  });
}
