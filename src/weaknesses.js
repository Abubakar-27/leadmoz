/*
  Derives pitchable "website weakness" findings from signals the pipeline has
  actually measured. Nothing here may claim a flaw we did not detect: no page
  speed, HTTPS, review responses or Google Business Profile data is collected,
  so none of those are ever asserted. The markup facts it does rely on
  (viewport, meta description, images missing alt, H1 count, and whether a
  Google Analytics or Meta advertising tag is present) are read straight from
  the downloaded HTML, so each one is either in the page or it is not.

  Every finding carries the raw value it was derived from in `evidence`, so a
  rep can be shown the number behind the claim instead of taking it on trust.
*/

const AUDIT = "audit";
const SIGNAL = "signal";

/*
  How a finding earns the right to be called a problem.

  VERIFIED means we measured a specific, countable fault in markup or in a live
  HTTP response: a form with no submit button, a link returning 404, a page
  with no viewport tag, a site our crawler could not load. The prospect can
  reproduce every one of these by looking.

  INFERRED means the finding comes from the *absence* of a word in the scraped
  prose. That is a guess about intent, and it is wrong often enough to be
  dangerous: a Calendly embed gives a site a booking flow without ever writing
  "book now", and a Google reviews widget gives it social proof without writing
  "testimonial".

  The distinction is kept as data rather than left implicit in the wording,
  because the ranker needs it and the dashboard tags it. INFERRED findings are
  real upsides worth raising, but they are never counted as faults, never
  ranked above a verified defect, and never phrased as "your site is broken".
*/
const VERIFIED = "verified";
const INFERRED = "inferred";

/*
  What kind of thing the finding is.

  DEFECT is something wrong. OPPORTUNITY is something merely missing, which is
  only a problem in a market where the prospect's customers go looking for it.
  CLEAR is the honest answer when nothing measurable is wrong.

  Keeping these apart is what stops a lead being sold on noise. A site can be
  entirely functional and still have upsides, and telling that owner their site
  is broken is how a rep gets hung up on.
*/
const DEFECT = "defect";
const OPPORTUNITY = "opportunity";
const CLEAR = "clear";

/*
  Below this much readable text we cannot say anything is missing from the page,
  because we did not read enough of the page to know. The body is capped at
  18000 characters, so a long site is read in full, but a site that returns a
  nav and a footer yields a few hundred characters and every absence test on it
  would be noise dressed up as an audit.

  Without this floor the thin-page sites produced the loudest findings, because
  a page missing every keyword is exactly what a page too small to read looks
  like. The thin-page fault itself is still reported, separately and honestly.
*/
const MIN_TEXT_FOR_ABSENCE = 500;

function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/*
  The per-site numbers every absence finding quotes. Before these existed each
  site produced the same sentence — "No review or testimonial content was
  found" — because the only input was a boolean. Page count, character count,
  the owner's own copyright year and the image/heading counts are measured on
  that site's markup alone, so two sites never read the same.

  `linkCount` is the field name the scraper has always stored the crawled page
  count under, so it is the primary source; `pagesScraped` covers leads built
  from a record that never went through detectSignals.

  Returns nulls for htmlStats when the scrape predates those measurements: an
  unknown count must never be rendered as 0, or "0 of 0 images" would ship as
  a finding we never took.
*/
function siteScope(record) {
    const signals = record.rawSignals || {};
    const pagesRead = num(signals.linkCount, 0) || (Array.isArray(record.pagesScraped) ? record.pagesScraped.length : 0);
    const textLength = num(signals.textLength, 0);

    const htmlStatsKnown = signals.imageCount != null || signals.h1Count != null;

    return {
        pagesRead,
        textLength,
        copyrightYear: String(signals.copyrightYear || ""),
        imageCount: num(signals.imageCount, 0),
        imagesMissingAlt: num(signals.imagesMissingAlt, 0),
        /*
          Counted on the same pass as the alt count above. A record that
          predates the measurement has the key absent, and num() turns that
          into 0 - which fails every floor below, so an old lead is never
          accused of a fault we never took.
        */
        imagesMissingDimensions: num(signals.imagesMissingDimensions, 0),
        /*
          Images that opt into deferred loading. An old record has the key
          absent, so the floor below fails and no lead is accused of an
          eager-loading fault we never measured.
        */
        imagesLazy: num(signals.imagesLazy, 0),
        pagesMissingTitle: num(signals.pagesMissingTitle, 0),
        h1Count: num(signals.h1Count, 0),
        htmlStatsKnown
    };
}

/* "all 4 pages we read" / "the single page we read" — blank when the page
   count is unknown, so callers fall back to wording that claims no count. */
function pagesPhrase(pagesRead) {
    if (pagesRead <= 0) return "";
    return pagesRead === 1 ? "the single page we read" : `all ${pagesRead} pages we read`;
}

/*
  Audit findings are the one place where raw evidence gets quoted verbatim into
  copy a stranger reads. The site audit writes sentences like "Form on
  https://their-site.example/contact has no action attribute", because the URL
  is exactly what an engineer needs to find the fault.

  But that same sentence reaches an anonymous visitor on a card whose business
  is supposed to be masked, and it hands over the domain the masking exists to
  hide. Reducing the URL to its path keeps the sentence useful and the identity
  private, and this is applied where the copy is built rather than where the
  evidence is stored, so the dashboard keeps the full URL for its own use.
*/
export function safeAuditText(value) {
    return String(value ?? "")
        .replace(/https?:\/\/[^\s,;)]+/gi, match => {
            try {
                const u = new URL(match);
                const path = `${u.pathname || ""}${u.search || ""}`.replace(/\/$/, "");
                return path ? `your site's ${path} page` : "this page";
            } catch {
                return "this page";
            }
        })
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}

/*
  "You have no prices on your website" is a fair, sellable observation for a
  shop or a restaurant and a useless one for a barber or a dentist, where
  nobody publishes a price list. We only make the claim where shoppers are
  actually comparing numbers, so we do not hand a rep a line the prospect will
  laugh at. An unknown niche keeps the old behaviour rather than silently
  dropping a finding.
*/
const PRICE_OPAQUE_NICHES = [
    "barber", "hair", "salon", "spa", "massage", "nails", "tattoo", "piercing",
    "dental", "dentist", "orthodontic", "doctor", "clinic", "medical", "chiro",
    "physio", "therapy", "counselling", "lawyer", "attorney", "legal",
    "accountant", "bookkeeper", "tax", "consultant", "consulting", "coach",
    "trainer", "plumber", "electrician", "hvac", "plumbing", "roofing",
    "landscaping", "cleaning", "cleaner", "pest", "moving", "locksmith",
    "photographer", "photography", "wedding", "event", "caterer", "personal trainer"
];

export function pricingIsExpected(niche) {
    const key = String(niche || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    if (!key) return true;
    return !PRICE_OPAQUE_NICHES.some(word => key.includes(word));
}

/*
  `tier` decides who may see the finding.

  AUDIT findings come from leakingFunnelAudit / seoSchemaAudit, which
  server.js strips for anyone without audit access, so they must never be
  rendered on a free preview or in a logged-out context.

  SIGNAL findings come from rawSignals, which every plan receives.
*/
function buildFindings(lead) {
    const record = lead || {};
    const signals = record.rawSignals || {};
    const funnel = record.leakingFunnelAudit || null;
    const seo = record.seoSchemaAudit || null;

    const findings = [];

    const website = String(record.website || "").trim();
    const noWebsite = Boolean(signals.noWebsite) || !website;

    const textLength = num(signals.textLength, 0);
    const scope = siteScope(record);
    const scopePages = pagesPhrase(scope.pagesRead);

    /*
      Not enough of the site was readable for any "you are missing X" claim to
      mean anything. Kept separate from `noWebsite` because a site with no copy
      is still a genuine, countable fault, and the honest finding for it is the
      thin-page one rather than a list of every keyword it did not contain.
    */
    const readEnoughToJudge = textLength >= MIN_TEXT_FOR_ABSENCE;

    /*
      Cross-checks that suppress an inferred finding when we have direct
      structural evidence against it. Without these the keyword tests simply
      outvoted the audit, which is backwards: a form we found in the markup is
      proof a form exists, and beats the absence of the word "contact" in the
      page prose.
    */
    const auditFoundForm = Boolean(funnel && funnel.form_vulnerabilities && funnel.form_vulnerabilities.has_contact_form === true);

    /* Applies to every absence-based claim, not just booking. */
    const mayClaimAbsence = !noWebsite && readEnoughToJudge;

    if (noWebsite) {
        findings.push({
            id: "no_website",
            label: "No website at all",
            detail: "This business has no website of its own, so it cannot accept online enquiries.",
            hook: "You have no site of your own, so every search for you ends at a phone call - I can get you a page that books itself.",
            severity: 100,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT
        });
    }

    if (record.scrapeOk === false && !noWebsite) {
        findings.push({
            id: "unreadable_site",
            label: "Website could not be read",
            detail: "The site failed to load for our crawler, which usually means visitors see a slow or broken page too.",
            hook: "Your site did not load for our crawler - if it stalls for customers, that is daily business walking out the door.",
            severity: 95,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT
        });
    }

    if (signals.likelyOldSite) {
        findings.push({
            id: "stale_copyright",
            label: "Dated copyright",
            /* Quoting the year found in this owner's own footer is a claim
               only this site can satisfy — no other prospect gets this line. */
            detail: scope.copyrightYear
                ? `The footer still shows a copyright © ${scope.copyrightYear}, which reads as an abandoned site.`
                : "The footer still shows a copyright year from 2000-2018, which reads as an abandoned site.",
            hook: scope.copyrightYear
                ? `Your footer still shows © ${scope.copyrightYear} - that is the first thing a competitor's customer notices.`
                : "Your footer still shows a copyright year from the 2010s - that is the first thing a competitor's customer notices.",
            severity: 80,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT,
            evidenceValues: scope.copyrightYear ? { copyrightYear: scope.copyrightYear } : undefined
        });
    }

    /*
      Measured straight from the downloaded markup, so these can be stated as
      facts. They are also the three that matter most to a local business
      whose customers are standing in a car park holding a phone.
    */
    if (signals.hasViewport === false && !noWebsite) {
        findings.push({
            id: "no_mobile_viewport",
            label: "No mobile viewport tag",
            detail: scope.pagesRead > 1
                ? `None of the ${scope.pagesRead} pages we downloaded declare a mobile viewport, so phones normally have to pinch and zoom to read anything.`
                : "The pages declare no mobile viewport, so phones normally have to pinch and zoom to read anything.",
            hook: "There is no mobile viewport on your site, so anyone opening it on a phone has to pinch and zoom to read a single line.",
            severity: 88,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT
        });
    }

    /*
      No way to make contact appeared anywhere in the readable text. Gated on
      the same form check as the other inferred items, because a contact form
      is a contact path: a site with a working enquiry form and no printed email
      address is not unreachable, and telling its owner there is nothing to tap
      is disproved the moment they open their own contact page.
    */
    if (signals.hasEmail === false && signals.hasPhone === false && mayClaimAbsence && !auditFoundForm) {
        findings.push({
            id: "no_contact_details",
            label: "No email or phone in the text",
            detail: `No email address or phone number appeared in any of the ${textLength} characters of readable text${scope.pagesRead ? ` we read across ${scope.pagesRead} page${scope.pagesRead === 1 ? "" : "s"}` : ""}, so anyone who wants to enquire has nothing to press.`,
            hook: "We could not find an email address or a phone number anywhere on your site - anyone who wants to reach you has nothing to tap.",
            severity: 84,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT,
            evidenceValues: { textLength }
        });
    }

    /*
      Real and measurable, but a search-result polish item rather than anything
      a customer standing in the shop would notice. Verified, yet ranked as an
      opportunity so it never displaces a fault the customer can actually feel.
    */
    if (signals.hasMetaDescription === false && !noWebsite) {
        findings.push({
            id: "no_meta_description",
            label: "No meta description",
            gain: "a meta description you control",
            detail: scope.pagesRead > 1
                ? `None of the ${scope.pagesRead} pages we read carry a meta description, so Google invents the snippet instead of you and most people skip the result.`
                : "The pages have no meta description, so Google invents the snippet instead of you and most people skip the result.",
            hook: "You are letting Google write your search result - with no description of your own, that snippet is a guess, and guesses do not get clicked.",
            severity: 58,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY
        });
    }

    /*
      A description that exists but does not fit the search result is a
      different fault from having none at all, and the one most owners never
      see. Google prints roughly 155-160 characters; anything past that is cut
      and anything far shorter leaves the result looking thin. Measured on the
      exact string we downloaded, so the count is reproducible.
    */
    const metaLen = num(signals.metaDescriptionLength, 0);
    if (!noWebsite && signals.hasMetaDescription === true && metaLen > 0 && (metaLen > 160 || metaLen < 50)) {
        findings.push({
            id: "meta_description_length",
            label: metaLen > 160
                ? `Meta description is ${metaLen} characters`
                : `Meta description is only ${metaLen} characters`,
            gain: "a search snippet written to fit",
            detail: metaLen > 160
                ? `The meta description runs to ${metaLen} characters. Google shows roughly 160 of them, so the closing ${metaLen - 160} characters - usually the part with the offer - are cut from every search result.`
                : `The meta description is just ${metaLen} characters, so the search result leaves most of the space Google gives it blank and looks thinner than the competitors listed beside it.`,
            hook: metaLen > 160
                ? `Your Google snippet is ${metaLen} characters long - Google cuts it at about 160, so the half of the sentence that would win the click never appears.`
                : `Your Google snippet is only ${metaLen} characters, so the search result looks half-empty next to the businesses listed beside you.`,
            severity: 49,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY,
            evidenceValues: { metaDescriptionLength: metaLen }
        });
    }

    /*
      Presence in the markup we downloaded, so it is a measured fact rather than
      a guess. Fires only when the scrape looked and found neither tag: a record
      from before these flags existed has them undefined, so a legacy lead is
      never accused. Classed an opportunity — it is a gap the owner cannot see
      from the outside, not a fault their customers feel.
    */
    if (!noWebsite && signals.hasGoogleAnalytics === false && signals.hasFacebookPixel === false) {
        findings.push({
            id: "no_tracking_tags",
            label: "No analytics or ad tracking installed",
            gain: "analytics that show where enquiries come from",
            detail: "Neither a Google Analytics tag nor a Meta advertising tag is present in the page markup, so the business sees no source of its visitors and cannot tell which marketing pays off.",
            hook: "You have no analytics or ad tracking on the site, so you are spending on marketing blind - nothing tells you what brought the enquiry in.",
            severity: 52,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY
        });
    }

    /*
      AEO (answer-engine) findings. All three are read from the pages we
      downloaded and from the site's own robots.txt, so each is a fact the
      prospect can reproduce. The robots fact only fires when we actually
      fetched the file (robotsFetched === true), and the schema check only when
      we read markup (hasOrganizationSchema === false, never the null of an
      unread site). Blocking AI crawlers is an opportunity - a gap the owner
      cannot see - while a noindex is a real fault, since it removes the site
      from search altogether.
    */
    const blockedAiCrawlers = Array.isArray(signals.aiCrawlersBlocked) ? signals.aiCrawlersBlocked : [];

    if (signals.noindex === true) {
        findings.push({
            id: "noindexed",
            label: "Page tells search engines to ignore it",
            detail: "The homepage carries a robots meta tag set to noindex, which asks Google and every AI engine to drop the page from their index.",
            hook: "Your homepage has a noindex tag on it - that tells Google and the AI assistants to remove you from search, which is why you cannot be found.",
            severity: 90,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT
        });
    }

    if (signals.robotsFetched === true && blockedAiCrawlers.length > 0) {
        findings.push({
            id: "ai_crawlers_blocked",
            label: `AI crawlers blocked in robots.txt (${blockedAiCrawlers.length})`,
            gain: "visibility in ChatGPT, Perplexity and Google's AI answers",
            detail: `The site's robots.txt tells these AI agents not to read it: ${blockedAiCrawlers.join(", ")}. When a customer asks an AI assistant for a business like this, those engines have nothing of the site to quote.`,
            hook: `Your robots.txt blocks ${blockedAiCrawlers.join(" and ")} from reading the site, so when someone asks ChatGPT or Perplexity for a business like yours, you are not in the answer.`,
            severity: 74,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY,
            evidenceValues: { blockedAiCrawlers }
        });
    }

    if (!noWebsite && signals.hasOrganizationSchema === false) {
        findings.push({
            id: "no_organization_schema",
            label: "No Organization schema",
            gain: "structured data that names the business to AI engines",
            detail: "No Organization or LocalBusiness structured data was found, so search engines and AI assistants cannot reliably tell who the business is or what it does.",
            hook: "There is no Organization data in your page code, so AI assistants and Google cannot tell who you are - they quote the businesses that spell it out for them.",
            severity: 50,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY
        });
    }

    /*
      Counted from the <img> tags in the markup we downloaded, so the count is
      reproducible by the prospect. Held to a floor (enough images for the
      number to mean anything) because a site with four images and one missing
      alt is not a finding worth pitching — a third of a forty-image site is.
      An image with alt="" is decorative by design and is never counted.
    */
    if (!noWebsite && scope.htmlStatsKnown && scope.imageCount >= 4 && scope.imagesMissingAlt >= 2) {
        findings.push({
            id: "images_missing_alt",
            label: `${scope.imagesMissingAlt} of ${scope.imageCount} images have no alt text`,
            detail: `${scope.imagesMissingAlt} of the ${scope.imageCount} images on the site carry no alt attribute at all, so search engines and screen readers get nothing from them.`,
            hook: `${scope.imagesMissingAlt} of your images have no alt text - Google and anyone using a screen reader get nothing from them.`,
            severity: 62,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT,
            evidenceValues: { imageCount: scope.imageCount, imagesMissingAlt: scope.imagesMissingAlt }
        });
    }

    /*
      Markup faults counted on the same download as the alt count above.

      They exist because missing alt text was winning the top slot on almost
      every modern site: viewport, contact details and copyright were all fine,
      so the same sentence led every card and the pitch read as a template.
      These checks cost nothing extra - the HTML is already on disk - and each
      is reproducible by the prospect with View Source, but they fire on
      different sites, so a rep opens with a different measured fault each time.

      Every one is gated on its signal being present. A record from before the
      measurement has the key undefined, and an unknown count must never be
      rendered as a fault we actually took.
    */

    /*
      A page with no <title> at all ships a guessed heading in every search
      result for it. Counted across the pages we read rather than tested on
      the homepage alone, because a site can get its front page right and
      still lose every deep page.
    */
    if (!noWebsite && scope.pagesMissingTitle > 0 && scope.pagesRead > 0) {
        findings.push({
            id: "pages_missing_title",
            label: `${scope.pagesMissingTitle} of ${scope.pagesRead} page${scope.pagesRead === 1 ? "" : "s"} have no title`,
            detail: `${scope.pagesMissingTitle} of the ${scope.pagesRead} page${scope.pagesRead === 1 ? "" : "s"} we read carr${scope.pagesMissingTitle === 1 ? "ies" : "y"} no <title> element, so a search engine prints its own guess as the heading for ${scope.pagesMissingTitle === 1 ? "that page" : "those pages"}.`,
            hook: `${scope.pagesMissingTitle} of your pages have no title tag at all, so the search engine writes the heading for you - and it does not know what you sell.`,
            severity: 74,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT,
            evidenceValues: { pagesMissingTitle: scope.pagesMissingTitle, pagesRead: scope.pagesRead }
        });
    }

    /*
      An image with neither width nor height gives the markup nothing to
      reserve, so nothing in the page tells the browser how much room to keep
      for it. Same floor as the alt finding: a four-image site with one tag
      missing is not worth pitching, a third of a forty-image site is.
    */
    if (!noWebsite && scope.htmlStatsKnown && scope.imageCount >= 4 && scope.imagesMissingDimensions >= 2) {
        findings.push({
            id: "images_missing_dimensions",
            label: `${scope.imagesMissingDimensions} of ${scope.imageCount} images declare no size`,
            detail: `${scope.imagesMissingDimensions} of the ${scope.imageCount} images on the site carry neither a width nor a height attribute, so nothing in the markup tells the browser how much room to keep for them.`,
            hook: `${scope.imagesMissingDimensions} of your images declare no size at all, so the browser only finds out how much room they need once they have arrived.`,
            severity: 57,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT,
            evidenceValues: { imageCount: scope.imageCount, imagesMissingDimensions: scope.imagesMissingDimensions }
        });
    }

    /*
      What a shared link looks like. WhatsApp, Facebook and LinkedIn read the
      og:image tag to build the preview card, so a site without one hands every
      recommendation on to the next person as a bare line of text. Presence in
      the markup, so it is a fact rather than a guess, and null on a record from
      before the measurement so nothing is claimed we did not look for.
    */
    if (!noWebsite && signals.hasOgImage === false) {
        findings.push({
            id: "no_social_preview_image",
            label: "No image in shared link previews",
            gain: "a preview image on every shared link",
            detail: "The pages we read carry no og:image tag, so a link shared on WhatsApp, Facebook or LinkedIn appears as a plain line of text instead of a picture with a headline.",
            hook: "Share your own link on WhatsApp and it shows as a bare line of text - no photo, no headline. That is what every customer sees when someone recommends you.",
            severity: 52,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY
        });
    }

    /*
      Every picture fetched before it is needed. Measured from the loading
      attributes in the markup, so the count is exact; held to a floor because a
      handful of images is not worth a performance pitch. Classed as an
      opportunity - it is a speed gap, not a broken page.
    */
    if (!noWebsite && scope.htmlStatsKnown && scope.imageCount >= 8 && signals.imagesLazy === 0) {
        findings.push({
            id: "images_not_lazy_loaded",
            label: `All ${scope.imageCount} images load up front`,
            gain: "images that load only when needed",
            detail: `None of the ${scope.imageCount} images on the site use the browser's built-in lazy loading, so the markup asks for every picture in one go instead of deferring the ones below the fold. On a phone that is extra work before the page is usable.`,
            hook: `Nothing in your markup defers the ${scope.imageCount} images, so a phone downloads all of them before the visitor scrolls past the first screen.`,
            severity: 44,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY,
            evidenceValues: { imageCount: scope.imageCount, imagesLazy: 0 }
        });
    }

    /*
      The <html> tag either names its language or it does not, and a screen
      reader that is not told which language a page is in has to guess before
      it can read a word aloud. Absence in the markup, so it is a fact rather
      than an opinion about the site.
    */
    if (!noWebsite && signals.htmlLangMissing === true) {
        findings.push({
            id: "no_html_lang",
            label: "Page declares no language",
            detail: "The <html> tag on the pages we read carries no lang attribute, so a screen reader has to guess the language before it can read a single word aloud.",
            hook: "Your pages never say what language they are written in, so a screen reader has to guess before it can read your site out loud.",
            severity: 54,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT
        });
    }

    /*
      A phone number in plain text is not a number a phone can dial. The
      signal has always been measured and exported, but it never became a
      finding, so the one fault a local business feels on a mobile was
      invisible to the card. Gated on a number actually being present: a site
      with no phone at all belongs to no_contact_details, not here.
    */
    if (!noWebsite && signals.hasPhone === true && signals.noClickToCall === true) {
        findings.push({
            id: "phone_not_tappable",
            label: "Phone number cannot be tapped to call",
            detail: `A phone number appears in the ${scope.textLength} characters of text we read, but no tel: link was found in the markup, so a visitor on a phone has to copy the digits out by hand.`,
            hook: "Your phone number is plain text on the page - on a phone it cannot be tapped, so the call you are waiting for turns into a copy and paste.",
            severity: 76,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT,
            evidenceValues: { textLength: scope.textLength }
        });
    }

    /*
      No Facebook, Instagram or LinkedIn link anywhere in the markup we read.
      An opportunity rather than a fault: a business may deliberately have no
      profiles, so the copy offers the link instead of claiming a break.
    */
    if (!noWebsite && signals.noSocialsFound === true) {
        findings.push({
            id: "no_social_links",
            label: "No social profiles linked from the site",
            gain: "links to your social profiles",
            detail: `No link to Facebook, Instagram or LinkedIn appeared in any of the ${scope.pagesRead || "pages"} we read, so a visitor who wants to see what the business has been doing has nowhere to go.`,
            hook: "Nothing on your site points to your social profiles, so a visitor who wants to see what you have been up to has nowhere to click.",
            severity: 46,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY,
            evidenceValues: { pagesRead: scope.pagesRead }
        });
    }

    /*
      AEO facts, read from the markup we downloaded. Absence only - a record
      that predates the AEO pass has these undefined, so it is never accused.
    */
    if (!noWebsite && signals.hasCanonical === false) {
        findings.push({
            id: "no_canonical_url",
            label: "No canonical URL declared",
            gain: "a canonical URL on each page",
            detail: "None of the pages we read declares a canonical link, so if the same page is reachable at more than one address the search engine has to pick one itself.",
            hook: "Your pages do not say which address is the real one, so the search engine guesses between the duplicates instead of choosing yours.",
            severity: 48,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY
        });
    }

    if (!noWebsite && signals.hasFaqSchema === false) {
        findings.push({
            id: "no_faq_schema",
            label: "No FAQ structured data",
            gain: "FAQ structured data",
            detail: "The pages we read contain no FAQ structured data, so an answer engine has no question-and-answer block to quote when someone asks about this trade.",
            hook: "There is no FAQ markup on your site, so when someone asks an assistant a question you could answer, it has nothing of yours to quote.",
            severity: 42,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY
        });
    }

    /*
      The business is named in structured data but points at none of its own
      profiles, so an engine cannot confirm which accounts are really its.
      Only fires when the Organization data exists in the first place - the
      missing-entirely case is no_organization_schema above.
    */
    if (!noWebsite && signals.hasOrganizationSchema === true && num(signals.schemaSameAsCount, 0) === 0) {
        findings.push({
            id: "schema_no_profile_links",
            label: "Organization data links no profiles",
            gain: "profile links inside your structured data",
            detail: "The Organization data on the page lists no sameAs links, so search engines cannot confirm which social profiles genuinely belong to the business.",
            hook: "Your structured data names the business but points at none of its profiles, so engines cannot tell which accounts are really yours.",
            severity: 44,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY
        });
    }

    /*
      Totalled across every crawled page, so it only fires when literally no
      page on the site opened with an H1 — not "the homepage lacks one".
      Classed an opportunity rather than a defect: it is a measurable gap, but
      a visitor never sees it, so it must not outrank a fault they can feel.
      Severity sits just under the meta-description finding so a verified
      opportunity still leads the opportunity list (see the ranking test).
    */
    if (!noWebsite && scope.htmlStatsKnown && scope.h1Count === 0 && scope.pagesRead > 0) {
        findings.push({
            id: "no_h1_heading",
            label: "No top-level heading (H1)",
            gain: "a clear H1 heading on each page",
            detail: `None of the ${scope.pagesRead} page${scope.pagesRead === 1 ? "" : "s"} we read ${scope.pagesRead === 1 ? "has" : "have"} an <h1> heading, so search engines and visitors get no clear title for the page.`,
            hook: `Your pages have no H1 heading at all - search engines get no clear title signal from the page that matters most.`,
            severity: 57,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY
        });
    }

    /*
      No booking flow found. Held to a higher bar than the other absence tests,
      because a booking element is exactly the thing that gets embedded rather
      than written: a Calendly iframe or a third-party scheduler is invisible
      to the prose scrape. So this only fires when there is also no widget
      signature in the markup, and only once we have read enough of the site to
      have found one if it was there in words.
    */
    if (!signals.hasBooking && mayClaimAbsence && !auditFoundForm) {
        findings.push({
id: "no_online_booking",
            label: "No online booking",
            gain: "online booking",
            detail: `No scheduler widget (Calendly, Booksy, Fresha and the rest) appeared in the markup, and no booking phrase in the ${textLength} characters of copy, so customers have to phone during business hours.`,
            hook: "Customers who want you tonight cannot book you - one tap and they are booked, instead of ringing you during opening hours.",
            severity: 50,
            tier: SIGNAL,
            evidence: INFERRED,
            class: OPPORTUNITY,
            evidenceValues: { textLength }
        });
    }

    /*
      Reviews already handled by the widget-aware detector in scrape.js, so this
      only fires when neither the prose nor the markup showed a review feed.
    */
    if (!signals.hasTestimonials && mayClaimAbsence) {
        findings.push({
            id: "no_testimonials",
            label: "No reviews or testimonials",
            gain: "reviews or testimonials",
            detail: scopePages
                ? `${scopePages.charAt(0).toUpperCase()}${scopePages.slice(1)} (${textLength} characters) contained no review text, rating widget or testimonial section, so new visitors get no social proof.`
                : "No review or testimonial content was found on the site, so new visitors get no social proof.",
            hook: scope.pagesRead > 1
                ? `Your site shows no reviews on any of its ${scope.pagesRead} pages - one wall of five-star proof is usually the cheapest conversion lift there is.`
                : "Your site shows no reviews at all - one wall of five-star proof is usually the cheapest conversion lift there is.",
            severity: 70,
            tier: SIGNAL,
            evidence: INFERRED,
            class: OPPORTUNITY,
            evidenceValues: { textLength }
        });
    }

    /*
      Only one thin-site finding, and it is deliberately the strict one. A
      single-page brochure site is completely normal for a local trade, so
      counting links would insult half the customers we would pitch it to.
      Almost no readable text is a different matter: nobody's one-pager is
      meant to contain under a thousand characters, so this one is a fair,
      countable fault.
    */
    if (!noWebsite && textLength > 0 && textLength < MIN_TEXT_FOR_ABSENCE) {
        findings.push({
            id: "barely_any_copy",
            label: "Almost no text on the site",
            detail: scope.pagesRead > 0
                ? `The whole site is ${scope.pagesRead} page${scope.pagesRead === 1 ? "" : "s"} holding roughly ${textLength} characters of readable text, which is too little to sell anything.`
                : `The page contains roughly ${textLength} characters of readable text, which is too little to sell anything.`,
            hook: "There is almost no wording on your site - there is nothing there to convince someone to pick you.",
            severity: 66,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: DEFECT,
            evidenceValues: { textLength }
        });
    }

    /*
      Suppressed outright when we found a form in the markup. A contact form is
      a call to action by definition, and telling a site it has no obvious next
      step while pointing at the form it already built is the kind of claim a
      prospect disproves in one click.
    */
    if (!signals.hasCTA && mayClaimAbsence && !auditFoundForm) {
        findings.push({
            id: "no_call_to_action",
            label: "No clear call to action",
            gain: "a clear call to action",
            detail: scope.pagesRead > 1
                ? `Not one of the ${scope.pagesRead} pages we read contains a book, quote or contact prompt, so visitors have no obvious next step.`
                : "No prominent book/quote/contact prompt was detected, so visitors have no obvious next step.",
            hook: "There is no clear button telling visitors what to do next - they read the page and leave.",
            severity: 65,
            tier: SIGNAL,
            evidence: INFERRED,
            class: OPPORTUNITY,
            evidenceValues: { textLength }
        });
    }

    /*
      An unknown niche is not evidence that prices should be published. The
      previous behaviour treated a blank niche as "prices expected", so any lead
      whose category we failed to identify was told it lacked a price list. Not
      knowing the trade is not a finding.
    */
    const nicheKnown = pricingIsExpected(record.niche) && String(record.niche || "").trim().length > 0;

    if (!signals.hasPricing && nicheKnown && mayClaimAbsence) {
        findings.push({
            id: "no_pricing",
            label: "No pricing on site",
            gain: "pricing on the page",
            detail: `No price, rate or package appeared in the ${textLength} characters of text we read, so prospects must enquire before they can compare.`,
            hook: "You publish no prices, so half your prospects leave to ask a competitor instead of asking you.",
            severity: 55,
            tier: SIGNAL,
            evidence: INFERRED,
            class: OPPORTUNITY,
            evidenceValues: { textLength }
        });
    }

    const reviewCount = num(record.mapsReviewCount ?? signals.mapsReviewCount, 0);
    const rating = record.mapsRating ?? signals.mapsRating ?? null;

    /* Only fair if the site is genuinely not showing the proof. Without this
       check a site with 4.8 stars and reviews on the page was told "none of
       that reputation is shown on your website" - and it could see otherwise
       the moment it visited. */
    if (!signals.hasTestimonials && mayClaimAbsence && reviewCount >= 25 && rating !== null && num(rating, 0) >= 4.5) {
        findings.push({
            id: "strong_reputation_no_site_proof",
            label: `${reviewCount} reviews but no proof on the site`,
            gain: `on-site proof of those ${reviewCount} reviews`,
            detail: `Google shows ${reviewCount} reviews at ${rating} stars, but none of that reputation is shown on the website.`,
            hook: `You have ${reviewCount} reviews at ${rating} stars and none of them on your site - that is free social proof going to waste.`,
            severity: 60,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: OPPORTUNITY
        });
    }

    if (funnel) {
        const broken = Array.isArray(funnel.broken_internal_links) ? funnel.broken_internal_links.length : 0;

        /*
          Every one of these came back from an actual HTTP request we made
          against the prospect's own site, so they are the strongest claims the
          system makes anywhere. Note they only exist for plans that ran the
          audit pass at all, which is why the free tier's best finding is a
          markup fact rather than a request result.
        */
        if (broken > 0) {
            findings.push({
                id: "broken_links",
                label: `${broken} broken internal link${broken === 1 ? "" : "s"}`,
                detail: `${broken} internal link${broken === 1 ? "" : "s"} return an error, so visitors hit dead ends mid-journey.`,
                hook: `${broken} links on your site are dead ends - that is traffic you already paid for, leaving quietly.`,
                severity: 90,
                tier: AUDIT,
                evidence: VERIFIED,
                class: DEFECT
            });
        }

        const deadIcons = Array.isArray(funnel.dead_social_icons) ? funnel.dead_social_icons.length : 0;

        if (deadIcons > 0) {
            findings.push({
                id: "dead_social_icons",
                label: `${deadIcons} dead social icon${deadIcons === 1 ? "" : "s"}`,
                detail: `${deadIcons} social icon${deadIcons === 1 ? "" : "s"} link nowhere, so the profiles you paid for get no traffic.`,
                hook: `${deadIcons} of your social buttons go nowhere - the profiles behind them get zero clicks.`,
                severity: 85,
                tier: AUDIT,
                evidence: VERIFIED,
                class: DEFECT
            });
        }

        const form = funnel.form_vulnerabilities || null;

        if (form && form.has_contact_form && Array.isArray(form.issues) && form.issues.length > 0) {
            findings.push({
                id: "broken_contact_form",
                label: "Contact form is broken",
                detail: `The contact form has a fault: ${safeAuditText(form.issues[0])}. Enquiries sent through it are lost.`,
                hook: `Your contact form is broken (${safeAuditText(form.issues[0])}) - you are losing the leads you worked hardest for.`,
                severity: 98,
                tier: AUDIT,
                evidence: VERIFIED,
                class: DEFECT
            });
        }
    }

    if (seo && seo.open_graph && seo.open_graph.is_valid === false) {
        const missing = Array.isArray(seo.open_graph.missing_tags) ? seo.open_graph.missing_tags : [];

        findings.push({
            id: "link_preview_broken",
            label: "Broken link previews",
            gain: "link previews that actually show",
            detail: `Social and messaging link previews are incomplete${missing.length ? ` (missing ${missing.join(", ")})` : ""}, so your links share as blank cards.`,
            hook: "When anyone shares your link it shows as a blank card - that is the share that never happens.",
            severity: 55,
            tier: AUDIT,
            evidence: VERIFIED,
            class: OPPORTUNITY
        });
    }

    if (seo && seo.schema_markup && seo.schema_markup.schema_present === false) {
        findings.push({
            id: "no_schema_markup",
            label: "No structured data",
            gain: "structured data that helps Google understand the business",
            detail: "No structured data markup was found, so the business is skipped for rich 'near me' results.",
            hook: "You are invisible to the map and rich results your competitors are winning - structured data is the fix.",
            severity: 65,
            tier: AUDIT,
            evidence: VERIFIED,
            class: OPPORTUNITY
        });
    }

    /*
      Nothing measurable is wrong with this site. Say so plainly and sell the
      upside instead of inventing a defect, which would be the one thing a
      prospect could disprove on the spot.

      This used to fire only when there were no findings at all, and with eight
      keyword tests on the pass that almost never happened, so the honest
      answer was effectively unreachable and the guesswork was always the
      headline instead. It now fires whenever there is no *verified defect*,
      which is the only condition that justifies telling a rep this site has a
      real problem. Any opportunities collected below are kept and ranked
      underneath it, so nothing is lost, they simply stop being sold as faults.
    */
    if (!findings.some(f => f.class === DEFECT)) {
        findings.push({
            id: "no_defects_found",
            label: "Nothing broken, nothing tuned",
            detail: findings.length > 0
                ? `Nothing measurable is wrong with this site. The ${findings.length} item${findings.length === 1 ? "" : "s"} below ${findings.length === 1 ? "is" : "are"} things it could add, not things it is doing badly.`
                : "No missing booking, pricing, reviews or call to action were found, so any gain here comes from growth work rather than repairs.",
            hook: "Your site has nothing obviously broken - which usually means the growth is sitting in plain sight, unused.",
            severity: 10,
            tier: SIGNAL,
            evidence: VERIFIED,
            class: CLEAR
        });
    }

    /*
      Rank by what kind of thing the finding is before by how alarming it
      sounds, then by evidence, then by severity.

      Severity alone was the bug. "No testimonials" scores 70 and "no online
      booking" 50, both of them guesses from missing words, so they would
      outrank a genuinely broken contact form scoring 98 only when the audit
      had not run, and a rep would open with the softest possible claim. Putting
      class first means the pitch always leads with something the prospect can
      verify, and a guess is never promoted above a measured fault.

      CLEAR ranks above everything because it only exists when there is no
      defect: in that case "nothing here is broken" is the honest headline and
      the upside items belong underneath it, where they read as offers rather
      than accusations.
    */
    const classRank = { [CLEAR]: 0, [DEFECT]: 1, [OPPORTUNITY]: 2 };
    const evidenceRank = { [VERIFIED]: 0, [INFERRED]: 1 };

    findings.sort((a, b) => {
        const byClass = (classRank[a.class] ?? 3) - (classRank[b.class] ?? 3);
        if (byClass !== 0) return byClass;

        const byEvidence = (evidenceRank[a.evidence] ?? 2) - (evidenceRank[b.evidence] ?? 2);
        if (byEvidence !== 0) return byEvidence;

        return b.severity - a.severity;
    });

    return findings;
}

/*
  True only for a finding we measured rather than inferred from missing words.
  Callers that need to decide whether a site has a genuine problem, rather than
  merely some upside, should test this instead of counting findings.
*/
export function realIssues(lead = {}) {
    return buildFindings(lead || {}).filter(f => f.class === DEFECT);
}

export function hasRealIssue(lead = {}) {
    return realIssues(lead).length > 0;
}

/*
  Splits the list so a caller can label the two kinds differently in the UI
  rather than flattening them back into one undifferentiated list. Every
  finding also carries `class` on itself, so this is only needed where the split
  is wanted explicitly.
*/
export function weaknessesByClass(lead = {}) {
    const all = buildFindings(lead || {});
    return {
        defects: all.filter(f => f.class === DEFECT),
        opportunities: all.filter(f => f.class === OPPORTUNITY),
        clear: all.filter(f => f.class === CLEAR),
        all
    };
}

export function deriveWeaknesses(lead = {}) {
    return buildFindings(lead || {});
}

/*
  Findings that are safe to show without audit access. server.js nulls the
  audit objects for free plans, so gating on the collected tier is what keeps
  a paid-only finding from leaking into a free preview.
*/
export function weaknessesForFreeTier(lead = {}) {
    return buildFindings(lead || {}).filter(f => f.tier === SIGNAL);
}

/*
  The anonymous preview runs the same audit pass a paying user does, so it must
  not be filtered down to signal tier afterwards.

  That filter is the free *plan* rule, and it is a different thing from the
  signed-out *preview*: preview visitors are meant to see the same depth as a
  signed-in user, with identity masked on all but one card. Using the free-tier
  filter here silently discarded every audit finding, which made running the
  audit pass pure cost with no visible result.
*/
export function weaknessesForPreview(lead = {}) {
    return buildFindings(lead || {});
}

export function primaryWeakness(lead = {}) {
    return buildFindings(lead || {})[0] || null;
}

const NICHE_LABELS = {
    barber: "Barber Shop",
    barbers: "Barber Shop",
    barber_shop: "Barber Shop",
    plumber: "Plumbing Company",
    plumbers: "Plumbing Company",
    plumbing: "Plumbing Company",
    dentist: "Dental Clinic",
    dentists: "Dental Clinic",
    dental: "Dental Clinic",
    electrician: "Electrician",
    electricians: "Electrician",
    roofer: "Roofing Company",
    roofers: "Roofing Company",
    roofing: "Roofing Company",
    landscaper: "Landscaping Company",
    landscaping: "Landscaping Company",
    lawn_care: "Landscaping Company",
    hvac: "HVAC Company",
    restaurant: "Restaurant",
    cafe: "Cafe",
    gym: "Gym",
    salon: "Hair Salon",
    spa: "Spa",
    auto_repair: "Auto Repair Shop",
    mechanic: "Auto Repair Shop"
};

/*
  Keeps the prospect anonymous in previews. Deliberately coarse: naming the
  category plus the town is enough for a visitor to recognise the relevance
  without handing over the business it refers to.
*/
export function categoryLabel(niche = "") {
    const key = String(niche || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

    return NICHE_LABELS[key] || "Local Business";
}

/*
  Keeps the prospect anonymous in previews. Deliberately coarse: naming the
  category plus the town is enough for a visitor to recognise the relevance
  without handing over the business it refers to.
*/
export function anonymizeLead(lead = {}, niche = "") {
    const record = lead || {};
    const label = categoryLabel(niche);

    const place =
        String(record.addresses && record.addresses[0] || "")
            .split(",")
            .map(part => part.trim())
            .filter(Boolean)
            .pop() || "";

    return {
        label: place ? `A ${label} in ${place}` : `A ${label}`,
        weakness: primaryWeakness(record)
    };
}
