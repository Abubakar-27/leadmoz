import { addLeadIfUnique, findGlobalDuplicateLead, updateJob, getJob } from "./store.js";
import { searchPublicWeb, delay, isMarketplaceHost, hasNonLocalTitle } from "./search.js";
import { screenLead } from "./leadGate.js";
import { scrapeWebsite } from "./scrape.js";
import { analyzeLead } from "./ai.js";
import { verifyLead, locationEvidence } from "./advancedVerifier.js";
import { metroAreaVerdict, searchLocalityFor } from "./areaGate.js";
import { STATE_ABBR, cityNameVariants } from "./geo.js";
import { searchOsmPlaces } from "./apis/osm.js";
import { getUserGeminiKey } from "./userGmailSettings.js";
import { getUserById } from "./authStore.js";
import { hasAuditAccess } from "./plans.js";
import { settleJobBilling, isPaidActive, isLifetimeUser } from "./creditPolicy.js";
import { trackEvent } from "./analytics.js";
import {
  computePriorityScore,
  isPriorityLead,
  buildPriorityAlert,
  priorityThreshold
} from "./leadScore.js";
import { deriveWeaknesses } from "./weaknesses.js";
import { profileLead } from "./icp.js";
import { applyScrapeFailureStatus } from "./leadStatus.js";
import { createRejectionTrace, topRejectionReason } from "./rejectionTrace.js";
import { evaluateLeadQuality } from "./leadQualityGate.js";
import { leadMatchesServiceFilter, normalizeServiceFilter, serviceFilterLabel, SERVICE_FILTER_BUILD } from "./serviceFilter.js";
import { ACTIVE_STATES } from "./jobRecovery.js";

/*
  Google Places is gone and is not coming back: it is a paid API and the account
  cannot buy it. The key returned 403 PERMISSION_DENIED on every call, so it
  only ever added a failed request and a misleading "Google Maps leads: 0" line
  to the diagnostics. Nothing reads the flag any more and the module is no longer
  imported, so there is no way for it to be switched back on by accident or by a
  stray environment variable.

  Search supply is Tavily, Firecrawl and the free HTML engines, so the per-run
  call budgets below are what protect the monthly quota.
*/

/*
  OpenStreetMap is opt-in and now genuinely useful when on. Three Overpass
  mirrors carry data outside Switzerland (api.de, lz4 and z, each answering the
  same query in 25-34s from this host), so an enabled pass waits ~25-30s per
  city and returns real single-business websites - which is exactly what a
  scraped Bing fails to supply for a non-Western market. Leaving it off returns
  that time to the web engines but loses the only source of businesses the
  directory-heavy web results cannot replace.
*/
function osmEnabled() {
  return String(process.env.OSM_ENABLED || "false") === "true";
}

/*
  The zero-lead guarantee, enforced structurally instead of by better copy.

  A run that reaches zero - or crashes - re-queues itself and runs again
  instead of closing, because every re-run re-rolls the things that make a
  search come back empty: engine health and strike cooldowns, paid key
  rotation, fresh query phrasings through the escalation ladder, fresh
  Overpass mirrors. The cap keeps a genuinely empty market (or a real code
  bug) from looping forever; the honest zero message only appears once the
  budget is spent.

  Lazy env reads so a test or boot script that sets env vars after importing
  this module still controls the knobs.
*/
function autoRetryMax() {
  const configured = Number(process.env.JOB_AUTO_RETRY_MAX);
  return Number.isFinite(configured) && configured >= 0 ? configured : 2;
}
function autoRetryDelayMs() {
  const configured = Number(process.env.JOB_RETRY_DELAY_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 30000;
}

function clean(value = "") {
  return String(value || "").trim();
}

function getDomain(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function normalizeName(value = "") {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizePhone(value = "") {
  return String(value || "").replace(/[^\d]/g, "");
}

function candidateKey(candidate) {
  const website = candidate.website || candidate.url || "";
  const domain = getDomain(website);
  if (domain) return `domain:${domain}`;

  const phone = normalizePhone(candidate.phone || "");
  if (phone && phone.length >= 7) return `phone:${phone}`;

  return `name:${normalizeName(candidate.businessName || candidate.title || "")}`;
}

/*
  How many of a job's leads are actually in the place the user asked for.

  This is the count the target is measured against. It used to be the raw
  leads array length, which meant a search for Austin could be "completed" by
  businesses in Houston and San Antonio: the user picked an area and got the
  right count of the wrong city. Out-of-area leads are still kept and shown,
  but they no longer count as progress, so the search keeps going for real
  local businesses.
*/
function inAreaCount(job) {
  const leads = (job && job.leads) || [];
  return leads.filter(l => l.inTargetArea !== false).length;
}

/*
  The last gate before a lead is written to the store.

  Candidates are processed by a concurrent worker pool, so a targetMet() check at
  the top of each candidate is not a cap: several candidates can all read "9 of
  10" before any of them inserts, and a target of 10 finished with 15 saved. The
  count has to be re-read immediately before the insert, and the insert has to be
  the thing that refuses.

  Out-of-area leads are refused here too. They used to be persisted and shown as
  "nearby, not counted", which read as broken results and still consumed the free
  plan's daily quota.
*/
function admitLead(jobId, lead, targetCount) {
  if (lead.inTargetArea === false) {
    return { ok: false, reason: "outOfArea" };
  }

  const current = getJob(jobId);
  const have = inAreaCount(current);
  const cap = Number(targetCount) || 0;

  if (cap > 0 && have >= cap) {
    return { ok: false, reason: "targetReached", have };
  }

  return { ok: true, have };
}

const REQUEST_LOCATION_STOP_WORDS = new Set([
  "near", "in", "at", "the", "city", "area", "region", "state", "province",
  "district", "county", "and", "of", "for"
]);

/*
  Both directions are needed, because STATE_ABBR is keyed by the full state name
  and holds the postal abbreviation as its value: keys are "texas", values are
  "TX". A user typing either one means the same state, so both count as a state
  word and neither is treated as the name of a city.
*/
const STATE_WORD_SET = new Set([
  ...Object.keys(STATE_ABBR).map(v => String(v).toLowerCase()),
  ...Object.values(STATE_ABBR).map(v => String(v).toLowerCase())
]);

function isStateWord(word) {
  const w = String(word || "").toLowerCase();
  if (!w) return false;
  return STATE_WORD_SET.has(w);
}

/*
  The words of a user-typed location that name a city, used by the lead builder
  that never runs verifyLead. A city request has to agree on the city itself:
  matching "tx" would let "San Antonio, TX" satisfy "Austin TX", which is the
  mistake this whole change exists to remove. A request that names no city at
  all falls back to the state words, which is what a state-level request means.
*/
function normalizeRequestedLocationWords(location) {
  const words = String(location || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(word => word.trim())
    .filter(word => word.length > 1 && !REQUEST_LOCATION_STOP_WORDS.has(word));

  const cityWords = words.filter(word => !isStateWord(word));
  return cityWords.length ? cityWords : words;
}

export function targetMet(job, targetCount) {
    return inAreaCount(job) >= targetCount;
}

/*
  Records why the candidate budget shrank before any scraping happened, so a
  "saved 1 of 10" result is explainable instead of looking like a search failure.
*/
function debugServiceFilterEarly(diagnostics, filter, before, after) {
    if (before === after) return;

    diagnostics.searchDebug = [
      ...(diagnostics.searchDebug || []),
      `Service filter "${filter}" removed ${before - after} of ${before} candidates before processing; ` +
        `these would never have been saved, so the remaining ${after} were the ones worth scraping.`
    ];
}

/*
  A shortfall that survives every widening pass is reported plainly. Silently
  finishing on 4 leads with a green "completed" is what made this look like a
  search bug instead of a market with four matching businesses in it.
*/
function debugStalledPasses(diagnostics, have, target) {
    diagnostics.searchDebug = [
      ...(diagnostics.searchDebug || []),
      `Stopped after widening the area twice with no new businesses found: ` +
        `${have} of ${target} leads. The remaining shortfall is the market, not the search.`
    ];
}

// Exported for tests: the merge silently used to discard locality, which is a
// data-quality bug that is invisible until leads fail verification.
export function mergeCandidates(...lists) {
  const map = new Map();
  // Secondary index by business name. candidateKey() prefers domain, then
  // phone, then name, and the two main sources almost never agree on which
  // they have: an OpenStreetMap result typically carries a phone and no
  // website, while a web result carries a website and no phone. The same
  // garage therefore landed under two different keys and was counted as two
  // separate businesses.
  const byName = new Map();

  const conflicts = (a, b) => {
    const pa = normalizePhone(a?.phone || "");
    const pb = normalizePhone(b?.phone || "");
    if (pa && pb && pa !== pb) return true;

    const da = getDomain(a?.website || a?.url || "");
    const db = getDomain(b?.website || b?.url || "");
    if (da && db && da !== db) return true;

    return false;
  };

  for (const list of lists) {
    for (const item of list || []) {
      const key = candidateKey(item);
      if (!key || key === "name:") continue;

      let existing = map.get(key);
      let existingKey = key;

      if (!existing) {
        // Fall back to matching on the normalised business name, but only when
        // the two records do not disagree about phone or domain. Merging on
        // name alone would collapse genuinely different businesses that happen
        // to share a name in different cities.
        const nameKey = normalizeName(item.businessName || item.title || "");
        if (nameKey.length >= 4) {
          const prior = byName.get(nameKey);
          if (prior && !conflicts(prior.item, item)) {
            existing = prior.item;
            existingKey = prior.key;
          }
        }
      }

      if (!existing) {
        map.set(key, item);
        const nk = normalizeName(item.businessName || item.title || "");
        if (nk.length >= 4 && !byName.has(nk)) byName.set(nk, { key, item });
        continue;
      }

    const merged = {
      ...existing,
      ...item,
      source:
        existing.source === item.source
        ? existing.source
        : "mixed",
      /*
        Locality has to be merged the same way as the other contact fields.

        The spread above lets the incoming record overwrite every field,
        including ones that are empty. Web search results usually carry no
        city/state, and they are merged after the OpenStreetMap results, so
        "city: ''" was wiping out a locality that OSM had just resolved by
        reverse lookup. A lead with no city fails the location check during
        verification and can never reach verified, so every OSM lead that also
        appeared in web search was silently downgraded to needs review.
      */
      city: existing.city || item.city || "",
      state: existing.state || item.state || "",
      phone: existing.phone || item.phone || "",
      address: existing.address || item.address || "",
      addresses: existing.addresses?.length ? existing.addresses : item.addresses || [],
      rating: existing.rating || item.rating || null,
      reviewCount: existing.reviewCount || item.reviewCount || 0,
      placeId: existing.placeId || item.placeId || "",
      website: existing.website || item.website || existing.url || item.url || "",
      url: existing.url || item.url || existing.website || item.website || ""
    };

    /*
      Replace the stored record under the key it was originally filed under.
      When the match came from the name fallback the two records have different
      candidateKey values, so writing the merged object under the incoming key
      would leave the stale object reachable under the old key and emit the
      same business twice.
    */
    if (existingKey !== key) map.delete(key);
    map.set(existingKey, merged);
  }
  }

  return [...map.values()];
}

function directoryName(result) {
  if (result.source === "osm") return "OpenStreetMap";
  if (result.source === "google_places") return "Google Maps";
  return "";
}

function directoryFoundProof(result, suffix = "") {
  const dir = directoryName(result);

  if (dir) {
    return `Business found from ${dir}${suffix}`;
  }

  return `Business found from public web search${suffix}`;
}

// Exported for tests: this builder is the one that skipped verifyLead entirely,
// so its locality verdict is the only thing standing between a map listing and a
// city it has nothing to do with.
export async function mapsNoWebsiteLead(place, job) {
  const directory = directoryName(place) || "Google Maps";
  const ratingText = place.rating
    ? `${place.rating} rating with ${place.reviewCount || 0} reviews`
    : `${directory} listing found`;

  /*
    This is the second of the two lead builders in the file, and it was the one
    hiding from the in-area count. It never went through verifyLead, so it never
    had a location verdict, so inTargetArea was simply absent. Absent counted as
    in-area, which let a map listing from anywhere in the region satisfy an
    order for a specific city. A map result still has to be in the requested
    place to count.
  */
  /*
    A map listing has to name the same city that was asked for, and it has to do
    it in the listing's own address fields. Checking it with the verifier's
    locationEvidence() means a listing is judged by exactly the same rule as a
    scraped website: the address establishes it, a service-area sentence does
    not. Every requested word has to match, not one of them, so "San Antonio,
    TX" cannot satisfy "Austin TX" on the strength of the state code.
  */
  const listingForLocation = {
    businessName: place.businessName || place.title || "",
    title: place.title || "",
    city: place.city || "",
    state: place.state || "",
    country: place.country || "",
    addresses: Array.isArray(place.addresses) && place.addresses.length
      ? place.addresses
      : [place.address].filter(Boolean)
  };

  const requestedWords = normalizeRequestedLocationWords(job.location);
  const foldText = value => String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const listingHaystack = [
    listingForLocation.businessName,
    listingForLocation.title,
    listingForLocation.city,
    listingForLocation.state,
    listingForLocation.country,
    ...listingForLocation.addresses
  ].filter(Boolean).join(" ").toLowerCase();

  const foldedHaystack = foldText(listingHaystack);

  /*
    A state word matches either spelling, because a request for "Texas" and a
    listing that says "TX" are describing the same place. Requiring the literal
    string would reject every Texan listing for a "Texas" request.
  */
  const listingNamesWord = word => {
    if (listingHaystack.includes(word)) return true;
    /*
      A listing rarely spells the city the way the order did. Lisbon is
      "Lisboa" on a Portuguese address, Munich is "Munchen", Bangalore is
      "Bengaluru". Requiring the literal request string threw those leads away
      even though the listing was in the right place.
    */
    if (cityNameVariants(word).some(v => listingHaystack.includes(v) || foldedHaystack.includes(foldText(v)))) {
      return true;
    }
    if (!isStateWord(word)) return false;
    return Object.entries(STATE_ABBR).some(([name, abbr]) =>
      name.toLowerCase() === word
        ? listingHaystack.includes(String(abbr).toLowerCase())
        : String(abbr).toLowerCase() === word
          && listingHaystack.includes(name.toLowerCase())
    );
  };

  const namesRequestedPlace =
    !requestedWords.length ||
    requestedWords.every(listingNamesWord);

  const requestedKey = requestedWords.join('');
  const metroAliases = {
    newyork: ['nyc', 'new york city', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten island']
  };
  const listingHaystackLower = listingHaystack;
  let relaxedByAlias = false;
  if (metroAliases[requestedKey]) {
    relaxedByAlias = metroAliases[requestedKey].some(a => listingHaystackLower.includes(a));
  }
  if (requestedKey === 'austintx' && listingHaystackLower.includes('san antonio')) {
    relaxedByAlias = false;
  }
  if (requestedKey === 'austintx' && listingHaystackLower.includes('houston')) {
    relaxedByAlias = false;
  }

  const byName =
    (namesRequestedPlace || relaxedByAlias) &&
    locationEvidence(listingForLocation, job.location) !== "none";

  /*
    Apply the same distance rule the scraped path uses. OSM resolves a lat/lon for
    every listing, and address strings alone were rejecting listings that are
    unambiguously nearby: "Palmela, 2950-000" is a different city name but sits
    ~20km from Lisbon, well inside the 25km metro radius. A scraped website 20km
    out counted as metro while the identical business from a map listing was
    thrown away, which is how a Lisbon search for 3 returned 0 in Lisbon.

    Name match stays stronger: it reports "address", distance reports "metro".
  */
  const metro = await metroAreaVerdict(
    { ...listingForLocation, location: place.location || null },
    job.location
  );

  const inArea = Boolean(byName || metro.inArea);
  const areaSource = byName ? "address" : metro.inArea ? "metro" : "none";

  return decorateWithScore({
    businessName: place.businessName || place.title || "Unknown business",
    website: "",
    linkedinUrl: "",
    socialLinks: null,
    source: place.source || "google_places",
    placeId: place.placeId || "",

    phone: place.phone || "",
    email: "",

    allPhones: place.phone ? [place.phone] : [],
    allEmails: [],
    city: place.city || "",
    state: place.state || "",
    addresses: place.addresses || [],
    /*
      Keep the coordinates on the lead. They are what let the distance rule be
      re-checked later without re-querying the map, and they are the only proof
      that a "metro" lead is genuinely near the requested place.
    */
    location: place.location || null,
    pagesScraped: [],

    confidenceScore: place.phone ? 82 : 58,
    /*
      A reachable business with no website is not an unverified lead, it is the
      best kind of lead for this service: we know it exists, we can call it, and
      the thing we sell is the exact thing it is missing.

      It used to be filed as "needsReview" alongside leads we simply could not
      confirm, which buried the easiest prospects in the same bucket as the
      doubtful ones. It gets its own status so it can be worked first.
    */
    status: place.phone ? "noWebsite" : "needsReview",
    noWebsite: !place.website && Boolean(place.phone),
    inTargetArea: inArea,
    locationConfirmed: inArea,
    areaSource,
    distanceKm: metro.distanceKm ?? null,
    metroReason: metro.reason || "",
    proof: [
      `Business found on ${directory}`,
      place.address ? `Address found: ${place.address}` : "",
      place.phone ? `Phone found on ${directory}` : `No phone found on ${directory}`,
      ratingText,
      "No website found on the business listing"
    ].filter(Boolean),
    rejectionReasons: place.phone ? [] : ["No phone found"],

    score: place.phone ? 8 : 6,
    weaknessSummary:
      `This business is listed on ${directory} with a working phone number but no website of its own. That makes it a ready-made prospect: there is no site to lose and no incumbent to displace.`,
personalizationAngle:
      `Mention that you found their ${job.niche} business in ${job.location}, but could not find a website connected to the listing.`,
    coldEmail:
      `Subject: Quick question about your online presence\n\nHi,\n\nI found your business while searching for ${job.niche} in ${job.location}. I noticed your listing is visible, but I couldn't find a website connected to it.\n\nI help local businesses create simple, modern websites that make it easier for customers to call, request quotes, and trust the business before contacting them.\n\nWould you like me to send over a quick example of what that could look like for your business?\n\nBest,\n`,
    linkedInDM:
      `Hi, I found your ${job.niche} business in ${job.location}. I noticed there may not be a website connected to your listing. I help local businesses set up clean websites that bring more calls and quote requests. Open to seeing a quick example?`,
    callOpener:
      `Hi, I found your business on ${directory} while searching for ${job.niche} in ${job.location}. I noticed I couldn't find a website connected to the listing, so I wanted to ask if you're currently using a website to get calls or quote requests.`,

scrapeOk: false,
    rawSignals: {
      source: place.source || "google_places",
      noWebsite: true,
      rating: place.rating || null,
      reviewCount: place.reviewCount || 0,
      businessStatus: place.businessStatus || "",
      types: place.types || []
    },
    scrapeError: "No website found on business listing",

    leakingFunnelAudit: null,
    seoSchemaAudit: null,

verified: false,
    needsReview: true,

    createdAt: new Date().toISOString()
  });
}

function buildScrapedFromPlaceFallback(place) {
  return {
    website: place.website || place.url || "",
    businessName: place.businessName || place.title || "",
    title: place.title || place.businessName || "",
    description: "",
    emails: [],
    phones: place.phone ? [place.phone] : [],
    primaryEmail: "",
    primaryPhone: place.phone || "",
    addresses: place.addresses || [],
    city: place.city || "",
    state: place.state || "",
    pagesScraped: [],
    text: [
      place.businessName,
      place.address,
      [place.city, place.state].filter(Boolean).join(" "),
      place.phone,
      place.rating ? `Rating ${place.rating}` : "",
      place.reviewCount ? `${place.reviewCount} reviews` : "",
      place.types?.join(" ")
    ].filter(Boolean).join(" "),
    scrapeOk: false,
    signals: {
      source: place.source || "google_places",
      rating: place.rating || null,
      reviewCount: place.reviewCount || 0
    },
    scrapeError: ""
  };
}

function decorateWithScore(lead) {
  // The job's niche travels with the lead so niche-aware findings (published
  // pricing only matters where shoppers compare numbers) stay consistent
  // between the dashboard, exports and the public preview.
  const job = lead?.jobId ? getJob(lead.jobId) : null;
  const niche = lead?.niche || job?.niche || "";

  /*
    The weaknesses are derived once and handed to the ICP scorer as well, so the
    fit score reflects the same measured findings the rep will read rather than
    a second, divergent derivation.
  */
  const weaknesses = deriveWeaknesses({ ...lead, niche });
  const icp = profileLead({ ...lead, niche, weaknesses });

  return {
    ...lead,
    ...computePriorityScore(lead),
    weaknesses,
    /*
      The decision-maker, when the scrape could extract one, lifted to the top
      level so the CSV and the outreach copy can greet a person by name. It
      already rides inside rawSignals, which is the fallback for records built
      before this field existed.
    */
    ownerName: lead.ownerName || (lead.rawSignals && lead.rawSignals.ownerName) || "",
    ...icp
  };
}

function maybePushPriorityAlert(jobId, lead) {
  if (!isPriorityLead(lead, priorityThreshold())) return;

  const job = getJob(jobId);
  if (!job) return;

  const existing = (job.priorityAlerts || []).find(
    a => a.businessName === lead.businessName && a.website === lead.website
  );
  if (existing) return;

  const alerts = [...(job.priorityAlerts || []), buildPriorityAlert(lead)].slice(-50);

  updateJob(jobId, {
    priorityAlerts: alerts,
    progressMessage: job.progressMessage || ""
  });
}

function saveBackfillLead({
  jobId,
  competitor,
  scraped,
  result,
  websiteUrl,
  hostname,
  verification,
  diagnostics,
  reason
}) {
  const rejectionTrace = createRejectionTrace();
  const targetCount = Number((competitor && competitor.targetCount) || 5);

  return (async () => {
  const leadPhone =
    (verification && verification.primaryPhone) ||
    scraped.primaryPhone ||
    scraped.phones?.[0] ||
    result.phone ||
    "";
  const leadEmail =
    (verification && verification.primaryEmail) ||
    scraped.primaryEmail ||
    scraped.emails?.[0] ||
    "";

  const listingName = result.businessName || result.title || "";
  const businessName =
    listingName && listingName.length >= 3
      ? listingName
      : scraped.businessName ||
        result.title ||
        result.businessName ||
        result.hostname ||
        hostname ||
        "Business";

  /*
    Backfill leads are a fallback for weak evidence, not a place to park leads
    that cannot be contacted. Without this guard a low-confidence candidate with
    no email and no phone still reached the results list.
  */
  if (!leadPhone && !leadEmail) {
    diagnostics.leadsSkippedNoContact += 1;
    try {
      rejectionTrace.record(
        "backfillNoContact",
        "Backfill candidate had no email or phone",
        scraped,
        result,
        scraped.website
      );
    } catch (e) {}
    updateJob(jobId, {
      progressMessage:
        `Skipped backfill (no contact): ${scraped.businessName || hostname}`
    });
    return false;
  }

  const scoredLead = decorateWithScore({
    businessName,
    website: scraped.website || websiteUrl || result.website || result.url || "",
    linkedinUrl: scraped.linkedinUrl || result.linkedinUrl || "",
    socialLinks: scraped.socialLinks || null,
    source: result.source || "public_web",
    placeId: result.placeId || "",
    mapsRating: result.rating || null,
    mapsReviewCount: result.reviewCount || 0,

    phone: leadPhone,
    email: leadEmail,

    allPhones: scraped.phones?.length ? scraped.phones : leadPhone ? [leadPhone] : [],
    allEmails: (scraped.emails?.length ? scraped.emails : leadEmail ? [leadEmail] : [])
      .map(e => {
        try {
          const cleaned = decodeURIComponent(String(e).replace(/\+/g, " ")).trim().toLowerCase();
          return cleaned.replace(/^mailto:/i, "");
        } catch {
          return String(e).trim().toLowerCase();
        }
      })
      .filter((e, i, arr) => e && arr.indexOf(e) === i),
    addresses: scraped.addresses || result.addresses || [],
    pagesScraped: scraped.pagesScraped || [],

    confidenceScore: (verification && verification.confidenceScore) || 5,
    status: "needsReview",
    proof: [
      ...(result.title || result.businessName
        ? [`Business found: ${result.title || result.businessName}`]
        : []),
      result.phone ? `Phone from listing: ${result.phone}` : "",
      result.website ? `Website: ${result.website}` : "",
      ...((verification && verification.proof) || []),
      ...(leadPhone || leadEmail ? [] : ["No phone or email extracted. Manual follow-up needed."])
    ].filter(Boolean),
    rejectionReasons: (verification && verification.rejectionReasons) || [reason || "Needs manual review"],

    score: 1,
    weaknessSummary: leadEmail
      ? "Email found, but the site weakness is unproven. Verify before outreach."
      : leadPhone
        ? "Phone only: no email was found on this site. Verify before outreach."
        : "Contact details are incomplete. Verify before outreach.",
    personalizationAngle: `Found ${scraped.businessName || result.title || "this business"} while searching for ${competitor.niche} in ${competitor.location}.`,
    coldEmail: "",
    linkedInDM: "",
    callOpener: "",
    scrapeOk: !!scraped.scrapeOk,
    rawSignals: {
      ...(scraped.signals || {}),
      source: result.source || "public_web",
      mapsRating: result.rating || null,
      mapsReviewCount: result.reviewCount || 0,
      backfillSaved: true,
      backfillReason: reason || ""
    },
    scrapeError: scraped.scrapeError || "",
    leakingFunnelAudit: scraped.leakingFunnelAudit || null,
    seoSchemaAudit: scraped.seoSchemaAudit || null,
    /*
      Backfill leads were being stored with no area verdict at all. Because
      inAreaCount() treats a missing flag as in-area, a backfilled lead from
      another city both counted toward the target and reached the results list.
      This mirrors the field the main web path sets.
    */
    locationConfirmed: verification.locationConfirmed !== false,
    inTargetArea: verification.locationConfirmed !== false,

    verified: false,
    needsReview: true,
    createdAt: new Date().toISOString()
  });

  const globalDup = findGlobalDuplicateLead(scoredLead, jobId);

  if (globalDup) {
    diagnostics.duplicatesSkipped += 1;
    try {
      rejectionTrace.record(
        "duplicate",
        `Backfill duplicate across searches, matched on ${globalDup.matchedOn || "unknown key"}`,
        scraped,
        result,
        scraped.website
      );
    } catch (e) {}
    updateJob(jobId, {
      progressMessage: `Skipped ${scraped.businessName || hostname} — already found in an earlier search.`,
      diagnostics
    });
    await delay(300);
    return false;
  }

  const admitBackfill = admitLead(jobId, scoredLead, targetCount);

  if (!admitBackfill.ok) {
    if (admitBackfill.reason === "outOfArea") {
      diagnostics.outOfAreaSkipped = (diagnostics.outOfAreaSkipped || 0) + 1;
    }
    try {
      rejectionTrace.record(
        admitBackfill.reason,
        admitBackfill.reason === "outOfArea"
          ? "Backfill candidate was outside the requested area"
          : "Backfill stopped because the requested number of leads was already saved",
        scraped,
        result,
        scraped.website
      );
    } catch (e) {}
    return false;
  }

  const addResult = addLeadIfUnique(jobId, scoredLead);

  if (!addResult.added) {
    diagnostics.duplicatesSkipped += 1;
    try {
      rejectionTrace.record(
        "duplicate",
        `Backfill candidate was already in this job, matched on ${addResult.matchedOn || "unknown key"}`,
        scraped,
        result,
        scraped.website
      );
    } catch (e) {}
    updateJob(jobId, {
      progressMessage: `Skipped duplicate: ${scraped.businessName || hostname} already saved in this job.`,
      diagnostics
    });
    await delay(500);
    return false;
  }

  maybePushPriorityAlert(jobId, scoredLead);

  diagnostics.leadsSaved += 1;
  diagnostics.needsReviewLeads += 1;
  if (leadPhone) diagnostics.withPhone += 1;
  if (leadEmail) diagnostics.withEmail += 1;
  if (!scraped.scrapeOk) diagnostics.weakOrBlockedScrapes += 1;

  updateJob(jobId, {
    progressMessage:
      `Saved ${diagnostics.leadsSaved}/${targetCount}. ` +
      `(${scraped.businessName || hostname} — kept for review: ${reason || "no contact extracted"})`,
    diagnostics
  });
  await delay(700);
  return true;
  })();
}

/*
  Re-queue a job that produced nothing so it runs again.

  The only safe moment to call this is BEFORE settleJobBilling: the
  reservation must stay open so a lead the re-run actually delivers can still
  be billed against it, and trackEvent("lead_generation_completed") must wait
  for the real close so the funnel counts outcomes, not attempts.

  Status goes back to "queued" - which jobRecovery.js treats as active - so
  app.html keeps polling, a restart during the wait is resumed by boot
  recovery, and this function is a no-op (returns false) if anything about
  the re-read state makes it unsafe: job gone, job no longer ours to run,
  job already terminal (someone closed it), or the retry budget spent. Every
  early return leaves the job untouched for the caller to close honestly.

  Both timers are unref()'d so a pending retry never holds the process open,
  and an unref'd interval re-stamps updatedAt for as long as the job sits in
  "queued" so the 90-minute stale sweep cannot reap a job that is simply
  waiting out its retry delay.
*/
export function scheduleAutoRetry(jobId, reason, diagnostics) {
  try {
    const fresh = getJob(jobId);
    if (!fresh) return false;
    if (!ACTIVE_STATES.includes(fresh.status)) return false;
    // Once money has moved the outcome is decided: re-running would deliver
    // leads against an already-settled reservation that cannot be re-billed.
    if (fresh.billing?.settledAt) return false;

    const attempts = Number(fresh.autoRetries || 0);
    const max = autoRetryMax();
    if (attempts >= max) return false;

    const next = attempts + 1;
    // First retry rides out a transient outage; later ones wait out the engine
    // strike cooldown so re-running cannot just re-hit the same blocked set.
    const cooldown = Number(process.env.ENGINE_COOLDOWN_MS);
    const cooldownMs = Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 300000;
    const delayMs = next === 1
      ? autoRetryDelayMs()
      : Math.max(autoRetryDelayMs(), cooldownMs + autoRetryDelayMs());

    const keepAlive = setInterval(() => {
      const current = getJob(jobId);
      if (!current || current.status !== "queued") {
        clearInterval(keepAlive);
        return;
      }
      updateJob(jobId, { progressMessage: current.progressMessage });
    }, 60000);
    keepAlive.unref?.();

    setTimeout(() => {
      clearInterval(keepAlive);
      const current = getJob(jobId);
      if (!current || current.status !== "queued") return;
      runLeadJob(jobId).catch(err => console.error(`Auto-retry crashed for job ${jobId}:`, err));
    }, delayMs).unref?.();

    updateJob(jobId, {
      status: "queued",
      autoRetries: next,
      progressMessage:
        `No leads on attempt ${next} of ${max + 1} - ${reason}. ` +
        `Automatically widening the search and trying again in ` +
        `${Math.round(delayMs / 1000)}s...`,
      diagnostics: { ...diagnostics, autoRetries: next }
    });

    console.warn(
      `[auto-retry] job ${jobId}: ${reason} (attempt ${next} of ${max + 1}), re-running in ${delayMs}ms`
    );
    return true;
  } catch (err) {
    console.error(`scheduleAutoRetry failed for job ${jobId}:`, err);
    return false;
  }
}

export async function runLeadJob(jobId) {
  const job = getJob(jobId);
  if (!job) return;

  let userGeminiKey = "";
  // Free users get audited leads too, capped per job so raising the free lead
  // limit can never turn this into an unbounded cost.
  //
  // Previously this was hasAuditAccess(user), which is paid-only, so scrape.js
  // handed every free search all-null siteAudit. A free user got 5 bare contact
  // records with no analysis at all - and 37% of free searches returned nothing.
  // The audit is the reason to care about a lead, so withholding it from the
  // trial made the trial impossible to judge.
  let paidAuditAccess = false;
  let paidSearchAccess = false;
  let freeAuditLimit = 5;
  try {
    const user = getUserById(job.userId);
    userGeminiKey = getUserGeminiKey(user?.id) || "";
    paidAuditAccess = hasAuditAccess(user);
    // Paid search keys (_API_KEYS_PAID) are gated on this: paid, lifetime and
    // admin accounts get the paid pool, everyone else is limited to the free
    // pool no matter how many paid keys are configured.
    paidSearchAccess = isPaidActive(user) || isLifetimeUser(user) || user?.role === "admin";
    const configured = Number(process.env.FREE_AUDIT_LEAD_LIMIT);
    if (Number.isFinite(configured) && configured >= 0) freeAuditLimit = configured;
  } catch (err) {
    console.warn("Failed to load user Gemini key:", err.message);
  }

  const rejectionTrace = createRejectionTrace();

  const diagnostics = {
    searchResultsFound: 0,
    placesResultsFound: 0,
    mixedCandidatesFound: 0,
    websitesProcessed: 0,
    placesProcessed: 0,
    noWebsitePlacesSaved: 0,
    leadsSaved: 0,
    outOfAreaSkipped: 0,
    overTargetTrimmed: 0,
    weakOrBlockedScrapes: 0,
    withEmail: 0,
    withPhone: 0,
verifiedLeads: 0,
      needsReviewLeads: 0,
      noWebsiteLeads: 0,
      serviceFilterSkipped: 0,
      serviceFilterDegraded: 0,
    rejectedLowConfidence: 0,
    duplicatesSkipped: 0,
    nonBusinessSkipped: 0,
    gateRejected: 0,
    leadsSkippedNoContact: 0,
    lowQualitySkipped: 0,
    qualityPassed: 0,
    verifiedFaultLeads: 0,
    searchDebug: [],
    searchEngineHealth: [],
    placesDebug: [],
    osmDebug: []
  };

  try {
    updateJob(jobId, {
      status: "searching",
      progressMessage: "Searching public web results...",
      diagnostics
    });

    const targetCount = Number(job.targetCount || 5);

    /*
      "Always delivers the requested number" needs two things this loop did not
      have: more attempts, and attempts that actually widen instead of repeating
      the same query. A strict service filter (build / redesign) throws away
      roughly half of every candidate batch, so the same modest budget that
      satisfied an "all" job leaves a redesign job permanently short. The
      multiplier below over-samples for the strict filters and lets later passes
      escalate the OSM search tier so they cover the wider metro rather than
      re-asking the same box.
    */
    const activeFilter = normalizeServiceFilter(job.serviceFilter);
    const strictness =
      activeFilter === "build" || activeFilter === "redesign" ? 2.6 :
      activeFilter === "seo" ? 2.0 :
      1;
    const maxPasses = strictness > 1 ? 7 : 4;

    /*
      Stop when widening has stopped helping. A pass that adds nothing new means
      the extra Overpass cells are only re-finding businesses already considered,
      and each tier costs real time (the Lisbon redesign run reached 18 minutes
      before finishing). Two consecutive empty passes end the job, because by
      then the remaining shortfall is the market, not the search.
    */
    let stalledPasses = 0;
    let previousTotal = -1;

    /*
      Counts passes that produced no leads at all. This is not the same as
      stalledPasses: a job can stall at 12 leads because the market is thin,
      which is a legitimate reason to stop. Stalling at zero is not, because it
      means every candidate was discarded for a reason that broader searches can
      change - directories, duplicates, listings with no contact. Once this is
      non-zero the next pass asks searchPublicWeb to force the escalation ladder
      even though candidates already exist.
    */
    let zeroLeadPasses = 0;

    /*
      One escalation run per job. The ladder has its own 75s deadline, and with
      maxPasses at 4-7 a job that granted it every pass could sit for minutes
      re-running identical phrasings. Spending it once gives the guarantee its
      one real attempt without turning an empty search into the slowest thing
      in the queue.
    */
    let escalationSpent = false;

    /*
      Real, in-area, contactable businesses whose only defect is "the audit came
      back clean". The quality gate refuses them because a build/all order is
      meant to pitch a flaw, but when the target count cannot be met from
      defect-bearing leads they are the honest supply sitting next to an
      otherwise-false "market shortfall" message. Held here during a run and
      admitted as clearly-labelled fill leads at the end of each pass.
    */
    const heldCleanAudit = [];

    for (let pass = 0; pass < maxPasses; pass++) {
      const passCheck = getJob(jobId);
      if (!passCheck) break;
      const haveNow = inAreaCount(passCheck);
      if (haveNow >= targetCount) break;

      if (previousTotal >= 0 && passCheck.leads.length === previousTotal) {
        stalledPasses += 1;

        // Stopping here is what let a search that had candidates close at zero.
        // A shortfall is the market; a shortfall of zero is a search that gave
        // up. Keep going up to maxPasses so escalation gets its chance.
        if (passCheck.leads.length === 0) {
          stalledPasses = 0;
        } else if (stalledPasses >= 2) {
          debugStalledPasses(diagnostics, haveNow, targetCount);
          break;
        }
      } else {
        stalledPasses = 0;
      }

      if (passCheck.leads.length === 0) zeroLeadPasses += 1;

      previousTotal = passCheck.leads.length;

      const passNeed = Math.max(targetCount - haveNow, 1);

      updateJob(jobId, {
        status: "searching",
        progressMessage: `Searching for more leads (pass ${pass + 1}/${maxPasses}, have ${haveNow}/${targetCount})...`,
        diagnostics
      });

      const oversample = Math.min(
        Math.max(Math.ceil(passNeed * 3 * strictness), passNeed + 6),
        Math.max(150, Math.ceil(passNeed * 5 * strictness))
      );
      /*
        Web engines are the only paid supply left now that Places is gone, so the
        whole oversample budget goes to them. OSM stays additive rather than
        taking a share: it costs nothing per query, and OSM entries with no
        website cannot yield an email anyway.
      */
      const webTarget = Math.max(1, Math.ceil(oversample));
      const osmTarget = osmEnabled() ? Math.max(1, Math.ceil(oversample)) : 0;

      /*
        Each source is settled on its own. Promise.all rejected the moment any
        one of them threw, so a single DNS failure inside a scraped engine
        ("fetch failed") discarded the OSM and web candidates that had
        already been collected and failed the whole job.
      */
      const sourceFail = (name, err) => {
        console.warn(`Search source "${name}" failed:`, err?.message || err);
        return { results: [], debug: [`${name} failed: ${err?.message || err}`] };
      };

      /*
        Search with a place name, not with whatever the user typed when what
        they typed turns out to be a shop inside a city. The coordinates used
        by the area gate stay tied to job.location, so leads are still measured
        against the point the customer asked about.
      */
      const searchLocality = await searchLocalityFor(job.location);

      if (searchLocality.changed) {
        diagnostics.searchLocationUsed = searchLocality.location;
        diagnostics.searchLocationReason = searchLocality.reason;
      }

      const [webSearch, osmSearch] = await Promise.all([
        searchPublicWeb({
            niche: job.niche,
            location: searchLocality.location,
            targetCount: webTarget,
            passOffset: pass,
            // A pass that already returned candidates but no leads must try
            // harder, not longer: the ladder is what widens the query.
            forceEscalation: zeroLeadPasses > 0,
            allowEscalation: !escalationSpent,
            paid: paidSearchAccess
          }).catch(err => sourceFail("public web", err)),
        osmEnabled() && osmTarget > 0
          ? searchOsmPlaces({
              niche: job.niche,
              location: searchLocality.location,
              targetCount: osmTarget,
              // Later passes escalate to the metro tier so they keep finding new
              // in-area businesses instead of re-querying the same tight box.
              tier: pass
            }).catch(err => sourceFail("osm", err))
          : Promise.resolve({
              results: [],
              debug: ["OSM disabled (set OSM_ENABLED=true to enable)"]
            })
      ]);

      // Spend the guarantee exactly once, and only if search actually used it.
      if (webSearch?.escalated === true) escalationSpent = true;

      const webResults = (webSearch.results || []).map(item => ({
      ...item,
      source: item.source || "public_web",
      website: item.website || item.url || "",
      url: item.url || item.website || ""
    }));

    const osmResults = osmSearch.results || [];

    /*
      These were assignments, so every pass overwrote the previous one and the
      panel reported only the final (usually weakest) round. A Lisbon redesign run
      looked like it had found 6 web results when an earlier pass had 54, which is
      exactly the evidence needed to see that the search, not the market, was the
      problem. Totals now accumulate across passes.

      placesResultsFound is retained as the name the panel and CSV already read,
      but with Places gone it only ever counts OpenStreetMap rows now.
    */
    diagnostics.searchResultsFound += webResults.length;
    diagnostics.placesResultsFound += osmResults.length;
    diagnostics.searchDebug = webSearch.debug || [];
    diagnostics.searchEngineHealth = webSearch.engineHealth || [];
    diagnostics.placesDebug = [...(osmSearch.debug || [])];
    diagnostics.osmDebug = osmSearch.debug || [];

    /*
      The location named no place OpenStreetMap could resolve and no US state or
      country we hold a city list for. The OSM source returns nothing, and the
      web source is left querying a string that matches no real market, so this
      is a spelling problem to surface, not a "no businesses here" result. Kept
      sticky across passes so a later narrow pass cannot clear it.
    */
    if (osmSearch?.locationUnrecognised) diagnostics.locationUnrecognised = true;

    let results = mergeCandidates(osmResults, webResults);

    diagnostics.mixedCandidatesFound += results.length;

    /*
      The service filter has to be applied BEFORE the processing budget, not
      after it. Sorting by contact priority puts phone-bearing OpenStreetMap
      businesses first, and for a "redesign" order almost all of them have no
      website at all. Slicing to processCap before filtering therefore spent the
      whole budget on leads that were about to be discarded: a Lisbon redesign
      run dropped 136 candidates by the service filter and still saved 1 lead,
      because every slot meant for a website-bearing candidate had already been
      taken. Filtering first makes the cap count only leads that can be kept.
    */
    /*
      Set when this pass had to relax "build" because no no-website businesses
      could be sourced. Flows into the quality gate so the very same website-
      bearing leads it would otherwise reject are accepted as improvement
      prospects for this pass.
    */
    let allowExistingWebsiteThisPass = false;

    if (activeFilter !== "all") {
      const beforeFilter = results.length;

      const strictKept = results.filter(candidate => {
        const verdict = leadMatchesServiceFilter(
          {
            website: candidate.website || candidate.url || "",
            rawSignals: candidate.rawSignals || {}
          },
          activeFilter
        );

        return verdict.ok;
      });

      /*
        Graceful degradation for "build from scratch".

        A build order wants businesses with no website, and the only source of
        those is OpenStreetMap. OSM usually answers now, but it is a free public
        service and can still return nothing - throttled, mid-outage, or for a
        market its mirrors do not cover. When it does, every web result has a
        website and the strict rule above would drop the entire batch, so the
        order closes at zero even though 150+ real local businesses had been
        found, which reads to the user as an empty market rather than a
        temporarily thin source.

        Rather than return nothing, the website-bearing web results are kept and
        flagged, so the pitch becomes "your site could be improved" instead of
        "let me build you one". This only fires when the strict filter kept
        nothing and there were no map leads at all - a genuine no-website supply
        still wins and the strict filter is left untouched.
      */
      if (
        strictKept.length === 0 &&
        beforeFilter > 0 &&
        activeFilter === SERVICE_FILTER_BUILD &&
        osmResults.length === 0
      ) {
        allowExistingWebsiteThisPass = true;
        results = results.map(candidate => ({ ...candidate, serviceFilterDegraded: true }));
        diagnostics.serviceFilterDegraded =
          (diagnostics.serviceFilterDegraded || 0) + results.length;
      } else {
        results = strictKept;
        diagnostics.serviceFilterSkipped += beforeFilter - strictKept.length;
      }

      debugServiceFilterEarly(
        diagnostics,
        activeFilter,
        beforeFilter,
        results.length
      );
    }

    const contactPriority = (c) =>
      (c.phone ? 2 : 0) + (c.email ? 2 : 0) + (c.website ? 1 : 0);

    results.sort((a, b) => contactPriority(b) - contactPriority(a));

    // A strict service filter discards part of every batch, so the scraping cap
    // has to be scaled too or the job runs out of candidates before the target.
    const processCap = Math.min(
      results.length,
      Math.max(Math.ceil(targetCount * 6 * strictness), targetCount + 24)
    );
    results = results.slice(0, processCap);

    updateJob(jobId, {
      status: "scraping",
      progressMessage:
        `Found ${webResults.length} web results and ${osmResults.length} OpenStreetMap leads. ` +
        `Processing ${results.length} candidates.`,
      diagnostics
    });

    if (results.length === 0) {
      updateJob(jobId, {
        status: "searching",
        progressMessage:
          "No usable leads found this pass. Trying more search variations...",
        diagnostics
      });
      await delay(2500);
      continue;
    }

    let processed = 0;

    const processCandidate = async (result) => {
      const current = getJob(jobId);
      if (!current || targetMet(current, targetCount)) return false;

      processed += 1;

      if (result.source === "google_places" || result.placeId) {
        diagnostics.placesProcessed += 1;
      }

      const websiteUrl = result.website || result.url || "";
      const hostname = result.hostname || getDomain(websiteUrl) || result.businessName || "lead";

      if (websiteUrl && isMarketplaceHost(getDomain(websiteUrl))) {
        diagnostics.marketplaceSkipped = (diagnostics.marketplaceSkipped || 0) + 1;
        updateJob(jobId, {
          progressMessage: `Skipped ${hostname} — marketplace/listing site, not a standalone business.`,
          diagnostics
        });
        await delay(120);
        return true;
      }

      if (hasNonLocalTitle(result.title)) {
        diagnostics.marketplaceSkipped = (diagnostics.marketplaceSkipped || 0) + 1;
        updateJob(jobId, {
          progressMessage: `Skipped ${hostname} — directory/informational page, not a standalone business.`,
          diagnostics
        });
        await delay(120);
        return true;
      }

      updateJob(jobId, {
        progressMessage: `Processing ${processed}/${results.length}: ${hostname}`,
        diagnostics
      });

      if (!websiteUrl && (result.source === "google_places" || result.placeId)) {
        if (!result.phone) {
          diagnostics.leadsSkippedNoContact += 1;
          rejectionTrace.record(
            "noWebsiteNoContact",
            "Map listing with no website had no phone number",
            // No scrape has happened yet in this branch; pass an empty object
            // instead of reading `scraped` before its declaration.
            {},
            result,
            ""
          );
          updateJob(jobId, {
            progressMessage:
              `Skipped ${result.businessName || "business"} — no phone or email on the listing. ` +
              `Looking for ${targetCount} leads...`,
            diagnostics
          });
          await delay(150);
          return true;
        }

        const noWebsiteLead = await mapsNoWebsiteLead(result, job);

        /*
          Map leads skip the shared quality gate because they have no site to
          audit, so the service filter has to be applied here as well. Without
          this a redesign job still filled up with no-website businesses, which
          is the exact list that cannot buy a redesign.
        */
        const serviceMatch = leadMatchesServiceFilter(noWebsiteLead, job.serviceFilter);
        if (!serviceMatch.ok) {
          diagnostics.serviceFilterSkipped =
            (diagnostics.serviceFilterSkipped || 0) + 1;

          updateJob(jobId, {
            progressMessage:
              `Skipped ${result.businessName || "business"} - ${serviceMatch.reason}. ` +
              `Looking for ${targetCount} leads...`,
            diagnostics
          });
          await delay(150);
          return true;
        }

        const admit = admitLead(jobId, noWebsiteLead, targetCount);

        if (!admit.ok) {
          if (admit.reason === "outOfArea") {
            diagnostics.outOfAreaSkipped = (diagnostics.outOfAreaSkipped || 0) + 1;
          }
          return true;
        }

        const addResult = addLeadIfUnique(jobId, noWebsiteLead);

        if (!addResult.added) {
          diagnostics.duplicatesSkipped += 1;
          updateJob(jobId, {
            progressMessage:
              `Skipped duplicate: ${result.businessName || "business"} already saved in this job.`,
            diagnostics
          });
          await delay(300);
          return true;
        }

        maybePushPriorityAlert(jobId, noWebsiteLead);
        diagnostics.noWebsitePlacesSaved += 1;
        diagnostics.leadsSaved += 1;
        /*
          Counted apart from "needs review" on purpose. These are confirmed
          businesses with a phone number and nothing to review: the missing
          website is the pitch, not an open question about the lead.
        */
        diagnostics.noWebsiteLeads += 1;
        diagnostics.withPhone += 1;

        updateJob(jobId, {
          progressMessage:
            `Saved ${diagnostics.leadsSaved}/${targetCount}. ` +
            `No-website lead: ${result.businessName || "business"}.`,
          diagnostics
        });

        await delay(300);
        return true;
      }

      diagnostics.websitesProcessed += 1;

      let scraped;

      try {
        // websitesProcessed already counts this candidate, so a free user gets
        // audits on their first freeAuditLimit candidates and bare records after.
        // Free searches are capped at 5 leads, so this normally audits all of them.
        const auditThis = paidAuditAccess || diagnostics.websitesProcessed <= freeAuditLimit;
        /*
          A site that accepts the connection and never answers must not stall the
          whole job. scrapeWebsite's internal fetch and goto timeouts do not cover
          everything - a slow body read, a wedged renderer, or a DNS lookup that
          never settles - and one such hang left a paid user's search frozen on a
          single candidate for hours. This hard cap turns the hang into a normal
          scrape failure so the loop moves on to the next candidate.
        */
        const SCRAPE_WALL_CLOCK_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 60000);
        let scrapeTimer;
        const scrapeWallClock = new Promise((_, reject) => {
          scrapeTimer = setTimeout(
            () => reject(new Error(`scrape timed out after ${SCRAPE_WALL_CLOCK_MS}ms`)),
            SCRAPE_WALL_CLOCK_MS
          );
        });
        try {
          scraped = await Promise.race([scrapeWebsite(websiteUrl, { runAudits: auditThis }), scrapeWallClock]);
        } finally {
          clearTimeout(scrapeTimer);
        }
      } catch (err) {
        scraped = {
          website: websiteUrl,
          businessName: result.businessName || result.title || result.hostname,
          title: result.title || result.businessName || "",
          description: "",
          emails: [],
          phones: result.phone ? [result.phone] : [],
          primaryEmail: "",
          primaryPhone: result.phone || "",
          addresses: result.addresses || [],
          pagesScraped: [],
          text: "",
          scrapeOk: false,
          signals: { textLength: 0, source: result.source || "unknown" },
          scrapeError: err.message
        };
      }

      if (!scraped.scrapeOk && (result.source === "google_places" || result.placeId)) {
        const fallback = buildScrapedFromPlaceFallback(result);

        scraped = {
          ...fallback,
          ...scraped,
          businessName: scraped.businessName || fallback.businessName,
          phones: scraped.phones?.length ? scraped.phones : fallback.phones,
          primaryPhone: scraped.primaryPhone || fallback.primaryPhone,
          addresses: scraped.addresses?.length ? scraped.addresses : fallback.addresses,
          text: scraped.text || fallback.text,
          signals: {
            ...(fallback.signals || {}),
            ...(scraped.signals || {})
          }
        };
      }

      if (targetMet(getJob(jobId), targetCount)) {
        diagnostics.websitesProcessed -= 1;
        return false;
      }

      if (!scraped.scrapeOk) {
        diagnostics.weakOrBlockedScrapes += 1;
      }

      if (scraped.emails?.length) {
        diagnostics.withEmail += 1;
      }

      if (scraped.phones?.length) {
        diagnostics.withPhone += 1;
      }

      let verification;

      if (targetMet(getJob(jobId), targetCount)) return false;

      try {
        verification = await verifyLead(scraped, job);
      } catch (err) {
        console.error(`verifyLead failed for ${scraped.businessName || websiteUrl}:`, err.message);
        verification = {
          status: "rejected",
          confidenceScore: 0,
          primaryPhone: "",
          primaryEmail: "",
          phoneSource: null,
          emailSource: null,
          proof: [],
          rejectionReasons: [`Verification error: ${err.message}`]
        };
      }

      /*
        "Verified" means the business was confirmed on its own website. If the
        fetch failed we only have map/OSM metadata, so the claim is not true and
        a stale directory record can carry a dead domain (a coffee shop whose
        domain no longer resolves was being marked verified at 100/100). Cap it
        at needs review so the status keeps meaning something.
      */
      verification = applyScrapeFailureStatus(verification, scraped.scrapeOk);

      if (verification.status === "rejected") {        if (verification.hardReject) {
          diagnostics.nonBusinessSkipped = (diagnostics.nonBusinessSkipped || 0) + 1;

          rejectionTrace.record(
            "nonBusiness",
            verification.rejectionReasons?.[0] || "Not a single local business",
            scraped,
            result,
            websiteUrl
          );

          updateJob(jobId, {
            progressMessage:
              `Skipped ${scraped.businessName || hostname} — ` +
              `${verification.rejectionReasons?.[0] || "not a single local business"}. ` +
              `Looking for ${targetCount} leads...`,
            diagnostics
          });
          await delay(150);
          return true;
        }

        const softName = String(scraped.businessName || "").trim();
        const nameLooksReal =
          softName.length >= 3 &&
          !/^(home|contact|about|services|index|welcome|official site|book now|get quote|access denied|denied)$/i.test(
            softName
          ) &&
          !/^w\d+$/i.test(softName);

        const hasIdentity =
          nameLooksReal ||
          Boolean(result.businessName || result.title || result.hostname) ||
          Boolean(websiteUrl);

        diagnostics.rejectedLowConfidence += 1;

        if (!hasIdentity) {
          rejectionTrace.record(
            "noIdentity",
            verification.rejectionReasons?.[0] || "No usable business identity",
            scraped,
            result,
            websiteUrl
          );

          updateJob(jobId, {
            progressMessage:
              `Skipped ${scraped.businessName || hostname} — no usable identity. ` +
              `Looking for ${targetCount} leads...`,
            diagnostics
          });
          await delay(150);
          return true;
        }

        const backfillLead = {
          jobId,
          competitor: job,
          scraped: {
            ...scraped,
            businessName:
              (result.businessName || result.title) && (result.businessName || result.title).length >= 3
                ? result.businessName || result.title
                : scraped.businessName || result.businessName || result.title || result.hostname || hostname,
            phones: scraped.phones?.length ? scraped.phones : result.phone ? [result.phone] : [],
            primaryPhone: scraped.primaryPhone || result.phone || "",
            primaryEmail: scraped.primaryEmail || "",
            addresses: scraped.addresses?.length ? scraped.addresses : result.addresses || []
          },
          result,
          websiteUrl,
          hostname,
          verification,
          diagnostics,
          reason:
            (verification.rejectionReasons && verification.rejectionReasons[0]) ||
            `Low confidence (score ${verification.confidenceScore})`
        };

        const saved = await saveBackfillLead(backfillLead);
        diagnostics.rejectedLowConfidence -= 1;

        if (saved && targetMet(getJob(jobId), targetCount)) return false;

        return true;
      }

      let gate = { decided: false, isLead: true, reason: "", source: "unavailable" };

      try {
        gate = await screenLead({
          scraped,
          niche: job.niche,
          location: job.location,
          geminiApiKey: userGeminiKey
        });
      } catch (err) {
        console.warn(`screenLead failed for ${scraped.businessName || websiteUrl}:`, err.message);
      }

      if (gate.decided && !gate.isLead) {
        diagnostics.gateRejected = (diagnostics.gateRejected || 0) + 1;

        rejectionTrace.record(
          "gate",
          `${gate.reason || "Not a real local business"} (via ${gate.source})`,
          scraped,
          result,
          websiteUrl
        );

        if (scraped.emails?.length) diagnostics.withEmail -= 1;
        if (scraped.phones?.length) diagnostics.withPhone -= 1;
        diagnostics.websitesProcessed -= 1;

        updateJob(jobId, {
          progressMessage:
            `Skipped ${scraped.businessName || hostname} — ` +
            `${gate.reason || "not a real local business for this search"}. ` +
            `Looking for ${targetCount} leads...`,
          diagnostics
        });

        await delay(150);
        return true;
      }

      let ai;

      if (targetMet(getJob(jobId), targetCount)) return false;

      try {
        ai = await analyzeLead({
          scraped,
          niche: job.niche,
          location: job.location,
          serviceOffer: job.serviceOffer,
          geminiApiKey: userGeminiKey
        });
      } catch (err) {
        console.error(`analyzeLead failed for ${scraped.businessName || websiteUrl}:`, err.message);

        ai = {
          score: verification.confidenceScore || 5,
          weaknessSummary: "",
          personalizationAngle: "",
          coldEmail: "",
          linkedInDM: "",
          callOpener: ""
        };
      }

      /*
        The search listing can carry a phone even when the scrape found nothing,
        and the scrape can find a phone the listing did not have. This used to
        read the scrape only, so a business with a usable number on its search
        listing but a blocked or thin website was counted as "no contact" and
        thrown away. Every available source is now considered, most trusted first.
      */
      const leadPhone =
        verification.primaryPhone ||
        scraped.primaryPhone ||
        scraped.phones?.[0] ||
        result.phone ||
        "";
      const leadEmail =
        verification.primaryEmail ||
        scraped.primaryEmail ||
        scraped.emails?.[0] ||
        "";

      if (!leadPhone && !leadEmail) {
        /*
          A lead with no email and no phone cannot be contacted, so it is not a
          lead. These used to be saved as "manual review" entries, which filled
          results with businesses you have no way to reach. Skipped instead, so
          the list only ever shows contactable businesses.
        */
        diagnostics.leadsSkippedNoContact += 1;
        rejectionTrace.record(
          "noContact",
          `No email or phone after scrape${scraped.scrapeOk ? "" : " (scrape failed)"}`,
          scraped,
          result,
          websiteUrl
        );
        updateJob(jobId, {
          progressMessage:
            `Skipped ${result.businessName || hostname || "business"} — no email or phone found. ` +
            `Looking for ${targetCount} leads...`,
          diagnostics
        });
        await delay(150);
        return true;
      }

      const listingName = result.businessName || result.title || "";
      const businessName =
        listingName && listingName.length >= 3
          ? listingName
          : scraped.businessName || result.title || result.hostname;

      if (targetMet(getJob(jobId), targetCount)) return false;

      const candidateLead = decorateWithScore({
        businessName,
        website: scraped.website || websiteUrl,
        linkedinUrl: scraped.linkedinUrl || "",
        socialLinks: scraped.socialLinks || null,

        source: result.source || "public_web",
        /*
          Set when this lead was kept only because no no-website businesses could
          be sourced for this area. Carried onto the saved lead so the UI can mark
          it "has website" and frame the pitch as improving an existing site
          rather than pretending it needs one built.
        */
        serviceFilterDegraded: Boolean(result.serviceFilterDegraded || allowExistingWebsiteThisPass),
        placeId: result.placeId || "",
        mapsRating: result.rating || null,
        mapsReviewCount: result.reviewCount || 0,

        phone: leadPhone,
        email: leadEmail,

        allPhones: scraped.phones || [],
        allEmails: scraped.emails || [],
        addresses: scraped.addresses || [],
        city: scraped.city || result.city || "",
        state: scraped.state || result.state || "",
        /*
          OSM resolves a lat/lon for every business it returns. Persisting it is
          what lets the area gate place a lead by distance instead of by matching
          the city name, which is the only way a strict filter can still reach the
          requested number in a small city.
        */
        location: scraped.location || result.location || null,
        pagesScraped: scraped.pagesScraped || [],

        confidenceScore: verification.confidenceScore,
        status: verification.status,
        /*
          The user picked a city or area, so "is this lead actually there" is a
          first-class answer, not something to re-derive from the address later.
          The target count is measured against this flag, so a search for Austin
          cannot be satisfied by San Antonio businesses.
        */
        locationConfirmed: verification.locationConfirmed !== false,
        inTargetArea: verification.locationConfirmed !== false,
        /*
          How the area was proven, so the UI can tell the user which leads came
          from the requested city and which are genuinely nearby. A "metro" lead
          counts toward the order but is never dressed up as address-level proof.
        */
        areaSource: verification.areaSource || "address",
        distanceKm: verification.distanceKm ?? null,
        proof: [
          directoryFoundProof(result),
          ...(verification.proof || [])
        ],
        rejectionReasons: verification.rejectionReasons || [],

        score: ai.score,
        weaknessSummary: ai.weaknessSummary,
        personalizationAngle: ai.personalizationAngle,
        coldEmail: ai.coldEmail,
        linkedInDM: ai.linkedInDM,
        callOpener: ai.callOpener,

        scrapeOk: !!scraped.scrapeOk,
        rawSignals: {
          ...(scraped.signals || {}),
          source: result.source || "public_web",
          mapsRating: result.rating || null,
          mapsReviewCount: result.reviewCount || 0
        },
        scrapeError: scraped.scrapeError || "",
        leakingFunnelAudit: scraped.leakingFunnelAudit || null,
        seoSchemaAudit: scraped.seoSchemaAudit || null,

        verified: verification.status === "verified",
        needsReview: verification.status === "needsReview",

        createdAt: new Date().toISOString()
      });

      /*
        The quality gate runs after the lead is fully built, so it judges the
        real findings rather than raw scrape signals. A lead with no contact, no
        in-area proof or nothing to pitch is dropped here instead of being saved
        and shown to the user as if it were worth paying for.
      */
      const quality = evaluateLeadQuality(candidateLead, {
        serviceFilter: job.serviceFilter,
        allowExistingWebsite: allowExistingWebsiteThisPass
      });

      if (!quality.ok) {
        /*
          A clean audit is the one quality miss worth keeping around. The lead is
          real, in the requested area and reachable; it only lacks a defect to
          pitch. If stronger leads cannot reach the target count, these get
          admitted as honestly-labelled fill leads rather than making the job
          report "the market ran out" while a row of real local businesses sits
          in the reject pile.
        */
        if (quality.cleanAudit) {
          diagnostics.cleanAuditHeld = (diagnostics.cleanAuditHeld || 0) + 1;
          heldCleanAudit.push({ ...candidateLead, cleanAudit: true });

          updateJob(jobId, {
            progressMessage:
              `Held back ${scraped.businessName || hostname} (strong site, no defect to pitch) ` +
              `as a fill lead. Looking for ${targetCount} leads...`,
            diagnostics
          });

          await delay(150);
          return true;
        }

        diagnostics.lowQualitySkipped = (diagnostics.lowQualitySkipped || 0) + 1;

        /*
          Kept apart from the other drops. A lead removed because the user sells
          redesigns and this business has no site is not a defect in the lead, so
          lumping it in with "no measurable weakness" would report a clean run as
          a run full of duds.
        */
        if (quality.filteredByService) {
          diagnostics.serviceFilterSkipped =
            (diagnostics.serviceFilterSkipped || 0) + 1;
        }

        rejectionTrace.record(
          "lowQuality",
          quality.reason,
          scraped,
          result,
          websiteUrl
        );

        if (scraped.emails?.length) diagnostics.withEmail -= 1;
        if (scraped.phones?.length) diagnostics.withPhone -= 1;
        diagnostics.websitesProcessed -= 1;

        updateJob(jobId, {
          progressMessage:
            `Skipped ${scraped.businessName || hostname} — ${quality.reason}. ` +
            `Looking for ${targetCount} leads...`,
          diagnostics
        });

        await delay(150);
        return true;
      }

      diagnostics.qualityPassed = (diagnostics.qualityPassed || 0) + 1;
      if (quality.hasVerifiedFault) {
        diagnostics.verifiedFaultLeads = (diagnostics.verifiedFaultLeads || 0) + 1;
      }

      const scoredLead = candidateLead;

      const globalDup = findGlobalDuplicateLead(scoredLead, jobId);

      if (globalDup) {
        if (scraped.emails?.length) diagnostics.withEmail -= 1;
        if (scraped.phones?.length) diagnostics.withPhone -= 1;
        diagnostics.duplicatesSkipped += 1;

        rejectionTrace.record(
          "duplicate",
          `Duplicate across searches, matched on ${globalDup.matchedOn || "unknown key"}`,
          scraped,
          result,
          websiteUrl
        );

        updateJob(jobId, {
          progressMessage:
            `Skipped ${scraped.businessName || hostname} — already found in an earlier search (24h dedupe).`,
          diagnostics
        });

        await delay(300);
        return true;
      }

const admitWeb = admitLead(jobId, scoredLead, targetCount);

      if (!admitWeb.ok) {
        if (scraped.emails?.length) diagnostics.withEmail -= 1;
        if (scraped.phones?.length) diagnostics.withPhone -= 1;
        if (admitWeb.reason === "outOfArea") {
          diagnostics.outOfAreaSkipped = (diagnostics.outOfAreaSkipped || 0) + 1;
        }
        return true;
      }

      const addResult = addLeadIfUnique(jobId, scoredLead);

      if (!addResult.added) {
        if (scraped.emails?.length) diagnostics.withEmail -= 1;
        if (scraped.phones?.length) diagnostics.withPhone -= 1;
        diagnostics.duplicatesSkipped += 1;
        diagnostics.leadsSaved += 0;

        rejectionTrace.record(
          "duplicate",
          `Duplicate within this job, matched on ${addResult.matchedOn || "unknown key"}`,
          scraped,
          result,
          websiteUrl
        );

        updateJob(jobId, {
          progressMessage:
            `Skipped duplicate: ${scraped.businessName || hostname} already saved in this job.`,
          diagnostics
        });

        await delay(300);
        return true;
      }

      maybePushPriorityAlert(jobId, scoredLead);

      diagnostics.leadsSaved += 1;

      if (verification.status === "verified") {
        diagnostics.verifiedLeads += 1;
      }

      if (verification.status === "needsReview") {
        diagnostics.needsReviewLeads += 1;
      }

      updateJob(jobId, {
        progressMessage:
          `Saved ${diagnostics.leadsSaved}/${targetCount}. ` +
          `Verified: ${diagnostics.verifiedLeads}. ` +
          `No website (ready to pitch): ${diagnostics.noWebsiteLeads}. ` +
          `Needs review: ${diagnostics.needsReviewLeads}. ` +
          `Rejected: ${diagnostics.rejectedLowConfidence}.`,
        diagnostics
      });

      await delay(300);
      return targetMet(getJob(jobId), targetCount) ? false : true;
    };

    const queue = [...results];
    const CONCURRENCY = 4;

    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        if (targetMet(getJob(jobId), targetCount)) break;
        const result = queue.shift();
        if (!result) break;

        /*
          One malformed candidate must not end the whole job. A throw here
          rejects Promise.all below, the job flips to "failed", and every lead
          the other three workers had already saved is reported as zero while
          the user is still charged for it. Candidates are external, untrusted
          input, so each one is isolated and recorded.
        */
        try {
          await processCandidate(result);
        } catch (err) {
          diagnostics.candidateErrors = (diagnostics.candidateErrors || 0) + 1;
          rejectionTrace.record(
            "candidateError",
            `Candidate could not be processed: ${err.message || err}`,
            {},
            result,
            ""
          );
          console.warn("Candidate failed, continuing:", err.message || err);
        }
      }
    });

    await Promise.all(workers);
    }

    /*
      Final guarantee of an exact result.

      admitLead() already refuses the insert, but a worker pool means two
      candidates can still both pass it in the same tick, so the stored list is
      reconciled once here rather than trusted. Without this the job finished with
      more leads than were asked for, which reads as a bug even though every lead
      is real. Out-of-area leads are dropped at the same time, so what is left is
      exactly the requested number of matching businesses.
    */
    const beforeTrim = getJob(jobId);
    if (beforeTrim) {
      const kept = [];
      const dropped = [];

      for (const lead of beforeTrim.leads || []) {
        const inArea = lead.inTargetArea !== false;
        if (inArea && kept.length < targetCount) kept.push(lead);
        else dropped.push(lead);
      }

      if (dropped.length) {
        updateJob(jobId, { leads: kept });

        for (const lead of dropped) {
          if (lead.inTargetArea === false) {
            diagnostics.outOfAreaSkipped = (diagnostics.outOfAreaSkipped || 0) + 1;
          } else {
            diagnostics.overTargetTrimmed =
              (diagnostics.overTargetTrimmed || 0) + 1;
          }
        }

        diagnostics.leadsSaved = kept.length;
        diagnostics.leadsFound = Math.max(diagnostics.leadsFound || 0, kept.length);
      }
    }

    /*
      Shortfall fill. A real local business whose audit came back clean is held
      rather than dropped. If the defect-bearing supply could not reach the
      requested count, these are admitted now - labelled "cleanAudit" so the
      user sees the site had nothing wrong with it, instead of a green
      "completed" that reports a market shortfall while qualified businesses sat
      in the reject pile.
    */
    if (heldCleanAudit.length > 0) {
      const afterTrim = getJob(jobId);
      if (afterTrim && !targetMet(afterTrim, targetCount)) {
        for (const held of heldCleanAudit) {
          const current = getJob(jobId);
          if (!current || targetMet(current, targetCount)) break;

          const admit = admitLead(jobId, held, targetCount);
          if (!admit.ok) continue;

          const addResult = addLeadIfUnique(jobId, held);
          if (!addResult.added) continue;

          diagnostics.cleanAuditAdmitted =
            (diagnostics.cleanAuditAdmitted || 0) + 1;
          diagnostics.leadsSaved += 1;
          if (held.status === "verified") {
            diagnostics.verifiedLeads = (diagnostics.verifiedLeads || 0) + 1;
          } else if (held.status === "needsReview") {
            diagnostics.needsReviewLeads = (diagnostics.needsReviewLeads || 0) + 1;
          }

          updateJob(jobId, {
            progressMessage:
              `Saved ${diagnostics.leadsSaved}/${targetCount}. ` +
              `Strong-site lead ${held.businessName || "business"} kept to meet the target ` +
              `(audit was clean, no defect to pitch).`,
            diagnostics
          });

          await delay(200);
        }
      }
    }

    const finalJob = getJob(jobId);
    const allLeads = finalJob?.leads || [];
    const totalLeads = allLeads.length;
    const localLeads = inAreaCount(finalJob);
    const outOfAreaLeads = totalLeads - localLeads;

    /*
      The trace is stored on the job rather than only logged, so a user asking
      "why did you not find 10" gets the actual domains and rule names rather
      than a bare count.
    */
    diagnostics.rejections = rejectionTrace.snapshot();

    // Say plainly why the count fell short instead of leaving the user to guess
    // whether the request failed or simply ran out of real businesses.
    const shortfall = [];

    /*
      The target is measured against businesses in the requested area, because
      that is what the user asked for. Anything found outside it is reported
      separately rather than being allowed to quietly complete the order.
    */
    if (localLeads < targetCount) {
      shortfall.push(
        `Requested ${targetCount} in "${job.location}", found ${localLeads} in that area.`
      );
      if (outOfAreaLeads > 0) {
        shortfall.push(
          `${outOfAreaLeads} business${outOfAreaLeads === 1 ? "" : "es"} nearby were found and are listed separately; they were not counted toward the ${targetCount}.`
        );
      } else if (diagnostics.outOfAreaSkipped > 0) {
        /*
          Out-of-area leads are no longer stored, so the honest report is how many
          were turned away. Saying "found 0 in Lisbon" while quietly discarding two
          Palmela businesses a 16km away is the same result with none of the
          explanation.
        */
        const skipped = diagnostics.outOfAreaSkipped;
        shortfall.push(
          `${skipped} business${skipped === 1 ? "" : "es"} found outside "${job.location}" ` +
            `${skipped === 1 ? "was" : "were"} not saved, because ${skipped === 1 ? "it is" : "they are"} not in the requested area.`
        );
      }
      const dropped =
        (diagnostics.marketplaceSkipped || 0) +
        (diagnostics.duplicatesSkipped || 0) +
        (diagnostics.leadsSkippedNoContact || 0) +
        (diagnostics.gateRejected || 0) +
        (diagnostics.lowQualitySkipped || 0) +
        (diagnostics.nonBusinessSkipped || 0);
      if (dropped > 0) {
        shortfall.push(
          `${dropped} candidates were dropped as directories, duplicates or without contact details.`
        );
      }

      /*
        A service filter drop is a different story from a quality drop: the
        candidate was real, the job's own filter just did not want it. Reported
        separately so a job that filtered its whole market out never reads as
        "the search found only junk".
      */
      if (diagnostics.serviceFilterSkipped > 0) {
        const n = diagnostics.serviceFilterSkipped;
        shortfall.push(
          `${n} business${n === 1 ? "" : "es"} w${n === 1 ? "as" : "ere"} excluded by this job's ` +
            `service filter ("${serviceFilterLabel(job.serviceFilter)}").`
        );
      }

      /*
        The build order fell back to website-bearing businesses because no
        no-website supply could be found. Reported here too, since it is a
        shortfall explanation: the user asked for businesses without a site and
        the honest answer is that the source for them was unavailable.
      */
      if (diagnostics.serviceFilterDegraded > 0) {
        const n = diagnostics.serviceFilterDegraded;
        shortfall.push(
          `No businesses without a website could be sourced for this area, so ${n} ` +
          `website-bearing business${n === 1 ? "" : "es"} ${n === 1 ? "was" : "were"} kept instead, ` +
          `flagged "has website" as improvement prospects.`
        );
      }

      const topReason = topRejectionReason(diagnostics.rejections);
      if (topReason) {
        shortfall.push(
          `Most common reason: ${topReason.reason} (${topReason.count}, e.g. ${topReason.samples.join(", ")}).`
        );
      }
      if (!osmEnabled()) {
        shortfall.push("OpenStreetMap is not enabled, so only web search was used.");
      }
    }

    /*
      The last line of defence behind the zero-result guarantee.

      search.js escalates through looser and broader phrasings on the free
      engines whenever a search comes back empty, so reaching this point with
      nothing at all means every engine was blocked or offline, not that the
      market was empty. It has to say so plainly rather than closing the order as
      a normal completion, because a silent "Saved leads: 0" reads as "this
      business type does not exist here" and the user has no way to tell the
      difference between that and a broken search.

      The status stays "completed" on purpose: app.html only stops polling on
      "completed" or "failed", so inventing a new status would leave the UI
      polling forever.
    */
    const zeroResult = totalLeads === 0;

    if (zeroResult) {
      diagnostics.zeroResult = true;

      /*
        The guarantee: nothing that reaches zero closes at zero on its first
        shot. scheduleAutoRetry re-queues the job (status back to "queued",
        counter incremented) and returns true only when the re-run is actually
        armed - so return immediately and let that attempt deliver. Settlement,
        analytics and the customer message all wait until the budget is spent
        or a re-run finds something: settling here would stamp billing.settledAt
        and the idempotency guard would then refuse to bill any lead the retry
        delivers. Applies to every user, free or paid: a free retry spends only
        free engines, and a zero is equally broken for both.
      */
      if (scheduleAutoRetry(jobId, "no qualifying leads were found", diagnostics)) return;

      /*
        Three different situations all produce zero leads, and the old copy
        blamed the search engines for every one of them - a job whose service
        filter excluded all 133 candidates was told "search engines were
        unreachable", which sends the user to complain about engines that had
        worked fine. The message now names what actually happened.
      */
      const noResults =
        diagnostics.searchResultsFound === 0 && diagnostics.placesResultsFound === 0;
      const filterAteEverything =
        diagnostics.serviceFilterSkipped > 0 &&
        diagnostics.serviceFilterSkipped >= (diagnostics.searchResultsFound || 0);

      let zeroMessage;
      if (diagnostics.locationUnrecognised === true) {
        /*
          The location did not resolve to a real place. Telling the user the
          candidates "did not qualify" would send them to tweak filters when the
          fix is the spelling of the town, so name the actual problem instead.
        */
        zeroMessage =
          `No leads were returned. We could not recognise the location "${job.location}" on the map, so the ` +
          `local-business search could not run in that area. Check the spelling of the place (for example ` +
          `"Houston, Texas") and run the search again. This search did not use up any of your daily lead quota.`;
      } else if (noResults) {
        /*
          The technical cause - which provider failed and its HTTP/billing status
          - is recorded ONLY in diagnostics for the operator. It must never reach
          the customer-facing message: provider names and "out of credits" codes
          mean nothing to the person running a search and leak internal infra.
          The customer gets a plain, honest notice instead.
        */
        const health = Array.isArray(diagnostics.searchEngineHealth)
          ? diagnostics.searchEngineHealth
          : [];
        const reasons = health.map(h => h.note).filter(Boolean);
        const osmFailed = (diagnostics.osmDebug || []).some(l =>
          /unreachable|returned no elements|unavailable|failed:|giving up|no matching places|recognised/.test(l)
        );
        if (osmFailed) reasons.push("OpenStreetMap was unreachable");
        diagnostics.searchFailureCause = reasons.join("; ");

        zeroMessage =
          "No leads were returned. Our search network was temporarily unavailable, so this " +
          "is a search failure rather than an empty market - not a problem with your search. " +
          "This search did not use up any of your daily lead quota. Please try again shortly.";
      } else if (filterAteEverything) {
        const found = diagnostics.mixedCandidatesFound || 0;
        const filtered = diagnostics.serviceFilterSkipped;
        const leftover = found - filtered;
        zeroMessage =
          `No leads were returned. The search found ${found} businesses, but ${filtered} were ` +
          `excluded by this job's service filter ("${serviceFilterLabel(job.serviceFilter)}")` +
          (leftover > 0
            ? ` and the remaining ${leftover} did not pass the area or quality checks.`
            : ", leaving nothing that qualified.") +
          ` The search worked; the filter had nothing left to keep. ` +
          `This search did not use up any of your daily lead quota.`;
      } else {
        zeroMessage =
          `No leads were returned. ${diagnostics.mixedCandidatesFound} businesses were found, ` +
          `but none passed the quality checks (directories, duplicates, outside the area, or no ` +
          `contact details). The search worked; the candidates did not qualify. ` +
          `This search did not use up any of your daily lead quota.`;
      }

      /*
        This is the message shown only AFTER the retry budget is spent, so say
        how many attempts it took - otherwise "please try again shortly" reads
        as if the system gave up on the first empty pass.
      */
      const attemptsUsed = Number(job.autoRetries || 0);
      if (attemptsUsed > 0) {
        zeroMessage +=
          ` The search was automatically retried ${attemptsUsed} time(s), so this message is ` +
          `after ${attemptsUsed + 1} attempts.`;
      }

      shortfall.unshift(zeroMessage);
    }

    const areaNote =
      outOfAreaLeads > 0
        ? ` In "${job.location}": ${localLeads}. Nearby (not counted): ${outOfAreaLeads}.`
        : ` In "${job.location}": ${localLeads}.`;

    /*
      A location we could not place can still yield leads from the web source,
      but those were never limited to a requested area, so say so rather than
      presenting them as if they were confirmed local to it.
    */
    const locationNote = diagnostics.locationUnrecognised === true
      ? ` Note: "${job.location}" was not recognised as a place, so results could not be limited to that area.`
      : "";

    /*
      Settle the reservation against the leads actually delivered. A search that
      returned fewer than requested - or none, because the network was down or
      the filter ate everything - gives the unused credits straight back. This
      is the half that makes the "did not use up your quota" wording literally
      true instead of just reassuring.
    */
    settleJobBilling(jobId, { billable: totalLeads, failed: false });
    /*
      lead_generation_completed fires for every finished search (the funnel's
      "did they get through a run" step). first_lead_generated is one-shot per
      user, so it marks the real first-lead moment without recounting.
    */
    trackEvent("lead_generation_completed", { userId: job.userId, meta: { leads: totalLeads } });
    if (totalLeads > 0) {
      trackEvent("first_lead_generated", { userId: job.userId, meta: { leads: totalLeads } });
    }

    /*
      Say plainly when a build order had to fall back to website-bearing
      businesses, so a green "10 leads" completion is not mistaken for ten
      businesses that actually need a site built.
    */
    const degradedNote =
      diagnostics.serviceFilterDegraded > 0
        ? `Heads up: no businesses without a website could be sourced here, so ` +
          `${diagnostics.serviceFilterDegraded} website-bearing ` +
          `business${diagnostics.serviceFilterDegraded === 1 ? "" : "es"} ` +
          `${diagnostics.serviceFilterDegraded === 1 ? "was" : "were"} kept and flagged ` +
          `"has website" - pitch them as site improvements. `
        : "";

    updateJob(jobId, {
      status: "completed",
      progressMessage:
        (shortfall.length ? `${shortfall.join(" ")} ` : "") +
        degradedNote +
        `Completed. Saved leads: ${totalLeads}.${areaNote}${locationNote} ` +
        `Web results: ${diagnostics.searchResultsFound}. ` +
        `OpenStreetMap leads: ${diagnostics.placesResultsFound}. ` +
        `Skipped (no contact): ${diagnostics.leadsSkippedNoContact}. ` +
        `Verified: ${diagnostics.verifiedLeads}. ` +
        `No website (ready to pitch): ${diagnostics.noWebsiteLeads}. ` +
        `Needs review: ${diagnostics.needsReviewLeads}. ` +
        `Rejected: ${diagnostics.rejectedLowConfidence}.`,
      diagnostics
    });
  } catch (err) {
    console.error(err);

    /*
      A crash gets the same budget as a zero close: a DNS blip or a browser
      that refused to launch killed the whole job on its first strike before,
      and "failed" for a paid user is exactly as broken as 0 leads. The retry
      runs BEFORE settlement on purpose - a crashed job is not billed, so the
      reservation stays open across attempts and settles once, at the real
      close. Only when the budget is spent does the old behaviour apply:
      settle with billable 0 (idempotent, so a recovered job cannot be
      refunded twice) and fail for real.
    */
    if (scheduleAutoRetry(jobId, "the search hit an unexpected error", diagnostics)) return;

    settleJobBilling(jobId, { billable: 0, failed: true });

    updateJob(jobId, {
      status: "failed",
      progressMessage:
        (Number(job.autoRetries || 0) > 0
          ? `Search failed after ${Number(job.autoRetries || 0) + 1} attempts: `
          : "") + err.message,
      diagnostics
    });
  }
}