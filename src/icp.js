/*
  Ideal-customer-profiling for a lead.

  Scores a lead against the customer this service is actually built to sell to,
  so a rep can rank a page of raw results instead of reading them one by one.
  Every input is something the pipeline already measured - the website, the
  contact details, the Google review count, the derived weaknesses - so the
  score is explainable and never rests on data we did not collect.

  The default profile is a local service business with a reachable owner and a
  website that has real, fixable work on it, which is exactly the lead the
  weaknesses engine is written to pitch. Every threshold is overridable by env
  so the same build can be pointed at another segment without a code change.
*/

function tidy(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

export function icpConfig() {
  return {
    targetNiches: splitList(process.env.ICP_TARGET_NICHES),
    excludeNiches: splitList(process.env.ICP_EXCLUDE_NICHES),
    minRating: num(process.env.ICP_MIN_RATING, 0),
    minReviews: num(process.env.ICP_MIN_REVIEWS, 0),
    requireWebsite: process.env.ICP_REQUIRE_WEBSITE === "1"
  };
}

function matchesAny(niche, list) {
  const key = tidy(niche).toLowerCase();
  if (!key || !list.length) return false;
  return list.some(word => key.includes(word));
}

export function profileLead(lead = {}, config = icpConfig()) {
  const signals = lead.rawSignals || {};
  const niche = tidy(lead.niche || signals.niche || "");
  const reasons = [];

  const hasWebsite = Boolean(tidy(lead.website || lead.url || ""));
  const hasEmail = Boolean(lead.email || lead.primaryEmail || (Array.isArray(lead.allEmails) && lead.allEmails.length) || signals.hasEmail);
  const hasPhone = Boolean(lead.phone || lead.primaryPhone || (Array.isArray(lead.allPhones) && lead.allPhones.length) || signals.hasPhone);
  const reachable = hasEmail || hasPhone;

  const rating = lead.mapsRating ?? signals.mapsRating ?? null;
  const reviewCount = num(lead.mapsReviewCount ?? signals.mapsReviewCount, 0);

  const weaknesses = Array.isArray(lead.weaknesses) ? lead.weaknesses : [];
  const defects = weaknesses.filter(w => w.class === "defect").length;

  let score = 50;

  if (hasWebsite) {
    score += 12;
    reasons.push("has a website we can improve");
  } else {
    score -= 10;
    reasons.push("no website of its own");
  }

  if (defects > 0) {
    score += Math.min(20, 8 + defects * 4);
    reasons.push(`${defects} verified site defect${defects === 1 ? "" : "s"} to sell against`);
  }

  if (reachable) {
    score += 12;
    reasons.push(hasEmail ? "has an email to reach" : "has a phone to reach");
  } else {
    score -= 15;
    reasons.push("no email or phone found");
  }

  if (reviewCount >= 25) {
    score += 8;
    reasons.push(`${reviewCount} reviews (established)`)
  } else if (reviewCount >= 10) {
    score += 4;
    reasons.push(`${reviewCount} reviews`);
  }

  const ratingFloor = config.minRating > 0 ? config.minRating : 4.0;
  if (rating !== null && num(rating, 0) >= ratingFloor) {
    score += 4;
  }

  if (config.targetNiches.length) {
    if (matchesAny(niche, config.targetNiches)) {
      score += 12;
      reasons.push(`matches target niche "${niche}"`);
    } else {
      score -= 10;
      reasons.push("outside the target niches");
    }
  }

  if (matchesAny(niche, config.excludeNiches)) {
    score -= 25;
    reasons.push(`excluded niche "${niche}"`);
  }

  if (config.requireWebsite && !hasWebsite) {
    score -= 20;
    reasons.push("website required by config");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const icpTier =
    score >= 75 ? "A"
      : score >= 55 ? "B"
        : score >= 35 ? "C" : "D";

  /*
    A three-word summary of the tier for a rep scanning a list, so they do not
    have to remember that "B" means "worth a call". Kept separate from the tier
    letter because the letter is what the sorting and gates key off.
  */
  const icpHeat = icpTier === "A" ? "hot" : icpTier === "B" ? "warm" : icpTier === "C" ? "cool" : "cold";

  return { icpScore: score, icpTier, icpHeat, icpReasons: reasons };
}

export function isIcpLead(lead = {}, minScore = 55) {
  return num(lead.icpScore, profileLead(lead).icpScore) >= minScore;
}

export function sortLeadsByIcp(leads = []) {
  return [...leads].sort((a, b) => {
    const ia = num(a.icpScore, 0);
    const ib = num(b.icpScore, 0);
    if (ib !== ia) return ib - ia;
    return num(b.priorityScore, 0) - num(a.priorityScore, 0);
  });
}
