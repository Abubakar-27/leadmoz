import { deriveWeaknesses } from "./weaknesses.js";
import { leadMatchesServiceFilter, normalizeServiceFilter } from "./serviceFilter.js";

/*
  Quality bar.

  A lead is a business we can contact, in the area the user asked for, that has
  something real and provable wrong with its website. All three matter, and the
  third is what separates this from a list of phone numbers.

  The weak spot is the third one. A lead can pass every contact and location
  check and still have nothing to say: no measured defect, no missing asset
  worth naming. Sending a pitch with no real weakness to that business wastes
  the user's quota and burns the domain, so it is not saved.

  "No weakness" is allowed through for a business with no website at all. There
  the absence of a site is itself the finding, and that is a genuine, sellable
  fact rather than a failure to find one.

  It is now also allowed through when the user asked for existing-site work.
  "No measurable weakness" used to be a hard reject for redesign and SEO orders,
  which is backwards: a well-built tattoo studio website is a perfectly good
  redesign prospect, and refusing it is precisely why a "10 redesign leads in
  Lisbon" order could only ever find six. The strict rule stays for "all" and for
  building from scratch, where a provable flaw is what the pitch is built on.
  An audit that came back clean is reported as such instead of being hidden, so
  the user can see why a lead has no attack angle rather than finding out later.
*/

const VERIFIED = "verified";
const DEFECT = "defect";
const OPPORTUNITY = "opportunity";
const CLEAR = "clear";

/*
  Filters where "their site is not broken" is a normal, sellable answer rather
  than a reason to throw the lead away.
*/
const EXISTING_SITE_WORK = new Set(["redesign", "seo"]);

function findingsFor(lead) {
  if (Array.isArray(lead.weaknesses) && lead.weaknesses.length) return lead.weaknesses;

  const niche = lead.niche || "";
  try {
    return deriveWeaknesses({ ...lead, niche }) || [];
  } catch (err) {
    console.warn("deriveWeaknesses failed during quality gate:", err.message);
    return [];
  }
}

function hasSubstantiveFinding(lead, findings) {
  if (!Array.isArray(findings) || !findings.length) return false;

  /*
    A CLEAR finding is the honest "nothing measurable is wrong" answer. It is
    not a weakness and must not be counted as one, otherwise every lead passes
    this gate by default.
  */
  const real = findings.filter(
    finding => finding && finding.class !== CLEAR && finding.status !== CLEAR
  );

  if (!real.length) return false;

  // A verified defect is a measurement: strongest possible opener.
  if (real.some(f => f.evidence === VERIFIED)) return true;

  /*
    Otherwise we need an opportunity that is specific to this business. A
    generic "no testimonials" is weak on its own but acceptable when it comes
    with a named page or a concrete signal, because the pitch can point at it.
  */
  return real.some(f => f.class === DEFECT || Boolean(f.detail || f.evidence));
}

export function isNoWebsiteLead(lead) {
  const signals = lead.rawSignals || {};
  return Boolean(signals.noWebsite) || !String(lead.website || "").trim();
}

/*
  Returns { ok, reason, findings, hasVerifiedFault }.

  Callers should skip the lead when ok is false, and should record the reason so
  the rejection trace explains the drop.
*/
export function evaluateLeadQuality(lead, options = {}) {
  if (!lead) {
    return { ok: false, reason: "Lead was empty", findings: [], hasVerifiedFault: false };
  }

  if (!String(lead.phone || "").trim() && !String(lead.email || "").trim()) {
    return {
      ok: false,
      reason: "No reachable phone or email",
      findings: [],
      hasVerifiedFault: false
    };
  }

  const findings = findingsFor(lead);

  /*
    Checked after contact and before the finding rules, because the user's chosen
    service decides whether this business is a prospect at all. A redesign job
    has no use for a business with no website, and a build job has no use for a
    site that already exists.
  */
  const serviceMatch = leadMatchesServiceFilter(lead, options.serviceFilter, {
    allowExistingWebsite: options.allowExistingWebsite
  });
  if (!serviceMatch.ok) {
    return {
      ok: false,
      reason: serviceMatch.reason,
      findings,
      hasVerifiedFault: false,
      filteredByService: true
    };
  }

  if (isNoWebsiteLead(lead)) {
    return {
      ok: true,
      reason: "No website: the absence is the finding",
      findings,
      hasVerifiedFault: false
    };
  }

  if (!hasSubstantiveFinding(lead, findings)) {
    /*
      The audit came back clean. For redesign and SEO the business is still a
      valid prospect, so the lead is kept and the reason says plainly that there
      is no measured flaw to lead with, instead of the pitch pretending
      otherwise.

      A build order relaxed because the no-website source was unreachable counts
      as existing-site work too: the lead has a website (that is why it needed
      relaxing), so "nothing is broken" is still a sellable starting point rather
      than a reason to discard it.
    */
    const existingSiteWork =
      EXISTING_SITE_WORK.has(normalizeServiceFilter(options.serviceFilter)) ||
      Boolean(options.allowExistingWebsite);

    if (existingSiteWork) {
      return {
        ok: true,
        reason: existingSiteWork && options.allowExistingWebsite && !EXISTING_SITE_WORK.has(normalizeServiceFilter(options.serviceFilter))
          ? "Existing site with no measured defect: kept as an improvement prospect"
          : "Existing site with no measured defect: kept because this order is for redesign/SEO work",
        findings,
        hasVerifiedFault: false,
        cleanAudit: true
      };
    }

    return {
      ok: false,
      reason:
        "No measurable weakness: every check came back clear, so there is nothing to pitch",
      findings,
      hasVerifiedFault: false,
      /*
        This is a quality miss, not a bad lead. The business is real, in area and
        contactable - the only thing missing is a defect to lead with. The worker
        holds these back and admits them as clearly-labelled fill leads when the
        requested count cannot be met any other way, instead of reporting a
        "market shortfall" that the market never had. Marked so the caller can
        tell this drop from a genuine dud.
      */
      cleanAudit: true
    };
  }

  return {
    ok: true,
    reason: "",
    findings,
    hasVerifiedFault: findings.some(f => f && f.evidence === VERIFIED)
  };
}

export const qualityClasses = { VERIFIED, DEFECT, OPPORTUNITY, CLEAR };
