const HOT_THRESHOLD = 80;
const WARM_THRESHOLD = 60;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value) {
  return Boolean(value);
}

function recencyPoints(createdAt) {
  const ms = new Date(createdAt || Date.now()).getTime();
  if (!Number.isFinite(ms)) return 4;
  const ageHours = (Date.now() - ms) / (60 * 60 * 1000);
  if (ageHours <= 6) return 4;
  if (ageHours <= 24) return 3;
  if (ageHours <= 72) return 2;
  return 1;
}

export function computePriorityScore(lead = {}) {
  const signals = lead.rawSignals || {};
  const score = num(lead.score, 5);
  const confidence = num(lead.confidenceScore, 0);

  const hasEmail = bool(lead.email || lead.primaryEmail || (lead.allEmails && lead.allEmails.length));
  const hasPhone = bool(lead.phone || lead.primaryPhone || (lead.allPhones && lead.allPhones.length));

  const mapsReviewCount = num(signals.mapsReviewCount, 0);

  /*
    A business with no website at all was being scored as if it had been
    audited and found wanting.

    The opportunity component rewarded signs of a neglected site: no
    testimonials, no call to action, an old-looking build. A lead with no
    website has none of those signals, so it scored zero on the one axis that
    describes the work we are trying to sell, and landed in the "cool" band
    below businesses that merely have a bad site.

    For this service a missing website is not a weak signal, it is the whole
    opportunity. It now scores full marks, and the site-quality signals keep
    applying only to leads that actually have a site to improve.
  */
  const hasWebsite = bool(lead.website || lead.url);
  const noWebsiteOpportunity = hasWebsite ? 0 : 14;

  const funnel = lead.leakingFunnelAudit || null;
  const seo = lead.seoSchemaAudit || null;
  const brokenLinks = funnel && Array.isArray(funnel.broken_internal_links) ? funnel.broken_internal_links.length : 0;
  const deadIcons = funnel && Array.isArray(funnel.dead_social_icons) ? funnel.dead_social_icons.length : 0;
  const ogValid = seo && seo.open_graph ? Boolean(seo.open_graph.is_valid) : null;
  const hasSchema = seo && seo.schema_markup ? Boolean(seo.schema_markup.schema_present) : null;

  const breakdown = {
    aiFit: Math.round((clamp(score, 0, 10) / 10) * 28),
    confidence: Math.round((clamp(confidence, 0, 100) / 100) * 18),
    reachability: (hasEmail ? 10 : 0) + (hasPhone ? 8 : 0),
    budget: (signals.hasPricing ? 6 : 0) + (signals.hasBooking ? 5 : 0) + Math.round(clamp(mapsReviewCount / 100, 0, 1) * 7),
    opportunity:
      noWebsiteOpportunity +
      (signals.likelyOldSite ? 6 : 0) +
      (!signals.hasTestimonials ? 4 : 0) +
      (!signals.hasCTA ? 4 : 0),
    auditGap: clamp(
      (brokenLinks > 0 ? 4 : 0) +
      (deadIcons > 0 ? 2 : 0) +
      (ogValid === false ? 2 : 0) +
      (hasSchema === false ? 2 : 0),
      0,
      10
    ),
    recency: recencyPoints(lead.createdAt)
  };

  const priorityScore = clamp(
    Object.values(breakdown).reduce((sum, v) => sum + v, 0),
    0,
    100
  );

  const scoreBand =
    priorityScore >= HOT_THRESHOLD ? "hot"
      : priorityScore >= WARM_THRESHOLD ? "warm"
        : priorityScore >= 40 ? "cool" : "low";

  return { priorityScore, scoreBand, scoreBreakdown: breakdown, scoredAt: new Date().toISOString() };
}

export function isPriorityLead(lead = {}, threshold = HOT_THRESHOLD) {
  return num(lead.priorityScore, computePriorityScore(lead).priorityScore) >= threshold;
}

export function sortLeadsByPriority(leads = []) {
  return [...leads].sort((a, b) => {
    const pa = num(a.priorityScore, 0);
    const pb = num(b.priorityScore, 0);
    if (pb !== pa) return pb - pa;
    const sa = num(a.score, 0);
    const sb = num(b.score, 0);
    if (sb !== sa) return sb - sa;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
}

export function buildPriorityAlert(lead = {}) {
  return {
    businessName: lead.businessName || "Unknown business",
    website: lead.website || "",
    priorityScore: num(lead.priorityScore, 0),
    scoreBand: lead.scoreBand || "hot",
    weaknessSummary: lead.weaknessSummary || "",
    email: lead.email || "",
    phone: lead.phone || "",
    at: new Date().toISOString()
  };
}

export function priorityThreshold() {
  const configured = Number(process.env.PRIORITY_LEAD_THRESHOLD);
  return Number.isFinite(configured) && configured > 0 ? configured : HOT_THRESHOLD;
}