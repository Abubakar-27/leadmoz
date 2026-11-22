/*
  Which businesses a job is actually selling to.

  The same search turns up two very different prospects, and pitching them the
  same way wastes the contact:

    build    - the business has no website. The pitch is "let me make you one".
    redesign - the business already has a website. The pitch is "let me improve
               the one you have".
    seo      - both groups want this. A business with no website wants to be
               found; a business with a site wants to rank better in it.
    all      - keep everything, for users who have not chosen.

  Without this, a user who sells redesigns was handed a list of businesses with
  no website at all, which is the one group that cannot buy a redesign.
*/

export const SERVICE_FILTER_BUILD = "build";
export const SERVICE_FILTER_REDESIGN = "redesign";
export const SERVICE_FILTER_SEO = "seo";
export const SERVICE_FILTER_ALL = "all";

export const SERVICE_FILTERS = [
  {
    value: SERVICE_FILTER_ALL,
    label: "All businesses",
    hint: "Keep every business found, whether or not it has a website."
  },
  {
    value: SERVICE_FILTER_BUILD,
    label: "No website (build from scratch)",
    hint: "Only businesses with no website of their own. These need one built."
  },
  {
    value: SERVICE_FILTER_REDESIGN,
    label: "Has a website (redesign)",
    hint: "Only businesses that already have a website. These need it improved."
  },
  {
    value: SERVICE_FILTER_SEO,
    label: "SEO (both kinds)",
    hint: "Businesses with a website and businesses without. Both want to be found."
  }
];

const KNOWN = new Set(SERVICE_FILTERS.map((f) => f.value));

/*
  Anything unrecognised falls back to "all" so an old job, a hand-made API call
  or a typo never silently filters every lead away.
*/
export function normalizeServiceFilter(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return SERVICE_FILTER_ALL;

  // Accept a few obvious spellings so the UI and the API cannot disagree.
  const aliases = {
    none: SERVICE_FILTER_BUILD,
    nowebsite: SERVICE_FILTER_BUILD,
    "no-website": SERVICE_FILTER_BUILD,
    new: SERVICE_FILTER_BUILD,
    development: SERVICE_FILTER_BUILD,
    design: SERVICE_FILTER_BUILD,
    dev: SERVICE_FILTER_BUILD,
    existing: SERVICE_FILTER_REDESIGN,
    "has-website": SERVICE_FILTER_REDESIGN,
    rebuild: SERVICE_FILTER_REDESIGN,
    "both": SERVICE_FILTER_SEO
  };

  const candidate = aliases[raw] || raw;
  return KNOWN.has(candidate) ? candidate : SERVICE_FILTER_ALL;
}

/*
  Reads website presence the same way the quality gate does, so a lead cannot be
  saved by one rule and filtered out by the other.
*/
export function leadHasWebsite(lead = {}) {
  const signals = lead.rawSignals || {};
  if (signals.noWebsite === true) return false;
  return Boolean(String(lead.website || "").trim());
}

/*
  Returns { ok, reason }.

  "all" and "seo" keep both kinds, which is why seo is not the same filter as
  all in practice: all is the untouched default, seo is a deliberate choice the
  user made and the run summary reports back.
*/
export function leadMatchesServiceFilter(lead, filter, options = {}) {
  const normalized = normalizeServiceFilter(filter);

  if (normalized === SERVICE_FILTER_ALL || normalized === SERVICE_FILTER_SEO) {
    return { ok: true, reason: "" };
  }

  const hasSite = leadHasWebsite(lead);

  if (normalized === SERVICE_FILTER_BUILD && hasSite) {
    /*
      "Build" wants businesses with no website, and the only source of those is
      the map (OpenStreetMap). When that source is unreachable there is no
      no-website supply to draw from at all, and the strict rule would throw away
      every web result - all of which have websites - leaving the order empty.
      In that degraded mode the caller passes allowExistingWebsite so the
      website-bearing businesses are kept as improvement prospects ("your site
      could be better") rather than returning nothing.
    */
    if (options.allowExistingWebsite) {
      return { ok: true, reason: "", degraded: true };
    }

    return {
      ok: false,
      reason: "Skipped: business already has a website, and this job is for businesses that need one built"
    };
  }

  if (normalized === SERVICE_FILTER_REDESIGN && !hasSite) {
    return {
      ok: false,
      reason: "Skipped: business has no website, and this job is for redesigning existing websites"
    };
  }

  return { ok: true, reason: "" };
}

export function serviceFilterLabel(filter) {
  const normalized = normalizeServiceFilter(filter);
  return SERVICE_FILTERS.find((f) => f.value === normalized)?.label || SERVICE_FILTER_ALL;
}