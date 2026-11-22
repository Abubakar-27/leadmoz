import * as cheerio from "cheerio";

export function nativeWebsiteAudit(html, url = "") {
  const $ = cheerio.load(html || "<html></html>");
  const result = {
    ssl_vulnerable: false,
    tracking_pixels_missing: {
      facebook_pixel: { detected: false, evidence: [] },
      google_analytics: { detected: false, evidence: [] },
    },
    mobile_responsiveness_failure: false,
    flags: [],
  };

  try {
    const u = new URL(url || "http://example.com");
    if (u.protocol === "http:") {
      result.ssl_vulnerable = true;
      result.flags.push("Unencrypted HTTP protocol detected");
    }
  } catch (e) {
    result.ssl_vulnerable = true;
    result.flags.push("Unencrypted or invalid protocol");
  }

  const htmlStr = html || "";

  if (htmlStr.includes("fbevents.js") || htmlStr.includes("connect.facebook.net")) {
    result.tracking_pixels_missing.facebook_pixel.detected = true;
    result.tracking_pixels_missing.facebook_pixel.evidence.push("Facebook Pixel script detected");
  } else {
    result.tracking_pixels_missing.facebook_pixel.detected = false;
    result.flags.push("Facebook Pixel not detected");
  }

  if (
    htmlStr.includes("googletagmanager.com") ||
    htmlStr.includes("analytics.js") ||
    htmlStr.includes("gtag.js")
  ) {
    result.tracking_pixels_missing.google_analytics.detected = true;
    result.tracking_pixels_missing.google_analytics.evidence.push("Google Analytics/Tag Manager detected");
  } else {
    result.tracking_pixels_missing.google_analytics.detected = false;
    result.flags.push("Google Analytics not detected");
  }

  const viewport = $('meta[name="viewport"]').attr("content") || "";
  if (!viewport) {
    result.mobile_responsiveness_failure = true;
    result.flags.push("Missing viewport meta tag");
  } else if (viewport.includes("user-scalable=no")) {
    result.mobile_responsiveness_failure = true;
    result.flags.push("Viewport blocks scalability (user-scalable=no)");
  }

  return result;
}

export function buildAuditTemplate(audit, url = "") {
  return JSON.stringify({
    url,
    audit,
    generatedAt: new Date().toISOString(),
  });
}
