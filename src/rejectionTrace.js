/*
  Rejection tracing.

  A count tells you how many candidates were dropped but never which ones, so a
  36x "non-business" figure could be 36 directories doing their job or 36 real
  roofers thrown away by a bad rule. Every rejection records a short, bounded
  sample of domain + reason so the funnel can be audited after the fact.

  The sample is capped per reason and the whole payload is capped overall, so a
  noisy job cannot grow the job record without bound.
*/

const MAX_PER_REASON = 12;
const MAX_TOTAL = 80;
const MAX_REASON_LENGTH = 120;

function reasonKey(reason = "") {
  const normalized = String(reason)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "unspecified";

  // Collapse the variable parts of a message so the same rule groups together
  // instead of producing dozens of one-off keys.
  const collapsed = normalized
    .split(" ")
    .filter(w => w && !STOP_WORDS.has(w))
    .join(" ")
    // Applied after stopword removal, so a single digit is not left behind and
    // "17 pages" and "4 pages" land in the same bucket.
    .replace(/\b\d+\b/g, "#")
    .replace(/\b[a-f0-9]{8,}\b/g, "#");

  return (collapsed || normalized).slice(0, 60);
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "was", "are", "were", "be", "been", "not", "no", "no email", "or phone",
  "found", "this", "that", "it", "its", "at", "by", "from", "as", "has",
  "have", "had", "does", "do", "did", "but", "if", "so", "than", "then",
  "already", "earlier", "search", "looking", "leads", "business", "businesses",
  "skipped", "previous", "previously", "same", "another", "one"
]);

/*
  Picks the single most common reason so the completion message can name a real
  cause. Sampled domains are only attached when we actually captured some, so
  the message never implies evidence we do not have.
*/
export function topRejectionReason(snapshot) {
  const reasons = snapshot && snapshot.reasons;
  if (!reasons || typeof reasons !== "object") return null;

  const entries = Object.entries(reasons).filter(([, list]) => Array.isArray(list) && list.length);
  if (!entries.length) return null;

  // Prefer the reason with the widest sample, so the examples are trustworthy.
  entries.sort((a, b) => b[1].length - a[1].length);

  const [key, list] = entries[0];

  /*
    `key` is the collapsed bucket id ("directory aggregator page lists many
    single"), which the completion message used to print as if it were a
    sentence. Quote the original wording recorded with it so the message names a
    real cause instead of a truncated fragment.
  */
  const original = snapshot.samples && snapshot.samples[key];

  return {
    reason: String(original || key).replace(/#/g, "number"),
    count: list.length,
    samples: list.slice(0, 3).map(entry => entry.domain)
  };
}

function domainOf(scraped = {}, result = {}, fallbackUrl = "") {
  const candidates = [
    result.website,
    result.url,
    scraped.website,
    scraped.url,
    fallbackUrl,
    result.hostname
  ];

  for (const value of candidates) {
    const raw = String(value || "").trim();
    if (!raw) continue;

    try {
      if (/^https?:\/\//i.test(raw)) {
        return new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
      }
      return raw.replace(/^www\./, "").split("/")[0].toLowerCase();
    } catch {
      /* fall through to the next candidate */
    }
  }

  return "unknown";
}

export function createRejectionTrace() {
  const trace = { reasons: {}, byReason: {}, total: 0, samples: {} };

  const budgetLeft = () => {
    let used = 0;
    for (const list of Object.values(trace.reasons)) used += list.length;
    return Math.max(0, MAX_TOTAL - used);
  };

  return {
    /*
      bucket is one of: nonBusiness, noContact, duplicate, gate, lowConfidence,
      noWebsiteNoContact, saved.
    */
    record(bucket, reason, scraped = {}, result = {}, fallbackUrl = "") {
      const key = reasonKey(reason);

      // Remember the human wording once per bucket so the completion message can
      // quote a real sentence instead of the collapsed, stopword-stripped key.
      if (!trace.samples[key]) trace.samples[key] = String(reason || "");

      trace.total += 1;
      trace.byReason[bucket] = (trace.byReason[bucket] || 0) + 1;

      if (!trace.reasons[key]) trace.reasons[key] = [];

      const list = trace.reasons[key];
      if (list.length >= MAX_PER_REASON) return;
      if (budgetLeft() <= 0) return;

      const domain = domainOf(scraped, result, fallbackUrl);
      if (list.some(entry => entry.domain === domain)) return;

      list.push({ domain, bucket });
    },

    snapshot() {
      return {
        total: trace.total,
        byReason: { ...trace.byReason },
        reasons: JSON.parse(JSON.stringify(trace.reasons)),
        samples: { ...trace.samples }
      };
    }
  };
}

export const rejectionTraceLimits = { MAX_PER_REASON, MAX_TOTAL };
