const SCRAPE_FAILURE_REASON =
  "Website could not be loaded, so the business was not confirmed on its own site";

const SCRAPE_FAILURE_MAX_CONFIDENCE = 60;

/*
  A verification that scored a perfect 100/100 can still be based on a domain
  that no longer resolves, so a lead whose own site failed to load must never
  stay "verified". Cap it at needs review so the status keeps meaning
  something. Kept in its own module so it can be unit tested without importing
  the worker (which pulls in the whole job pipeline).
*/
export function applyScrapeFailureStatus(verification, scrapeOk) {
  if (scrapeOk || !verification || verification.status !== "verified") {
    return verification;
  }

  return {
    ...verification,
    status: "needsReview",
    confidenceScore: Math.min(
      Number(verification.confidenceScore) || 0,
      SCRAPE_FAILURE_MAX_CONFIDENCE
    ),
    rejectionReasons: [
      ...(verification.rejectionReasons || []),
      SCRAPE_FAILURE_REASON
    ]
  };
}

export { SCRAPE_FAILURE_REASON, SCRAPE_FAILURE_MAX_CONFIDENCE };
