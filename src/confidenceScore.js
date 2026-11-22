function clean(value = "") {
    return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function getDomain(url = "") {
    try {
        return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
        return "";
    }
}

function getEmailDomain(email = "") {
    return String(email).split("@")[1]?.toLowerCase() || "";
}

function isGenericName(name = "") {
    const n = clean(name);

    const badNames = [
        "",
        "home",
        "contact",
        "contact us",
        "about",
        "about us",
        "services",
        "official site",
        "book now",
        "get quote",
        "request estimate",
        "index"
    ];

    return badNames.includes(n) || n.length < 3;
}

function nicheMatches(scraped, niche) {
    const text = clean([
        scraped.businessName,
        scraped.title,
        scraped.description,
        scraped.text,
        scraped.website
    ].join(" "));

    const nicheText = clean(niche);

    if (nicheText.includes("plumber") || nicheText.includes("plumbing")) {
        return [
            "plumber",
            "plumbing",
            "drain",
            "sewer",
            "pipe",
            "water heater",
            "leak",
            "rooter"
        ].some(word => text.includes(word));
    }

    const words = nicheText.split(/\s+/).filter(w => w.length > 3);
    return words.some(word => text.includes(word));
}

function locationMatches(scraped, location) {
    const text = clean([
        scraped.text,
        scraped.description,
        scraped.addresses?.join(" "),
        scraped.website
    ].join(" "));

    const words = clean(location).split(/\s+/).filter(w => w.length > 2);

    if (!words.length) return true;

    return words.some(word => text.includes(word));
}

function emailLooksValid(email, website) {
    if (!email) return false;

    const emailDomain = getEmailDomain(email);
    const websiteDomain = getDomain(website);

    if (!emailDomain) return false;

    const genericEmailDomains = [
        "gmail.com",
        "yahoo.com",
        "hotmail.com",
        "outlook.com",
        "icloud.com",
        "aol.com"
    ];

    if (emailDomain === websiteDomain) return true;
    if (genericEmailDomains.includes(emailDomain)) return true;

    return false;
}

export function scoreLead(scraped, job) {
    let score = 0;
    const proof = [];
    const rejectionReasons = [];

    const hasName = !isGenericName(scraped.businessName);
    const hasPhone = Array.isArray(scraped.phones) && scraped.phones.length > 0;
    const hasEmail = Array.isArray(scraped.emails) && scraped.emails.length > 0;
    const hasAddress = Array.isArray(scraped.addresses) && scraped.addresses.length > 0;
    const hasPages = Array.isArray(scraped.pagesScraped) && scraped.pagesScraped.length > 0;

    if (scraped.scrapeOk) {
        score += 10;
        proof.push("Website scraped successfully");
    } else {
        rejectionReasons.push("Website could not be scraped properly");
    }

    if (hasName) {
        score += 20;
        proof.push("Business name found");
    } else {
        rejectionReasons.push("Business name is weak or generic");
    }

    if (hasPhone) {
        score += 30;
        proof.push("Valid phone found");
    } else {
        rejectionReasons.push("No valid phone found");
    }

    if (hasEmail) {
        const validEmails = scraped.emails.filter(email =>
            emailLooksValid(email, scraped.website)
        );

        if (validEmails.length > 0) {
            score += 25;
            proof.push("Valid email found");
        } else {
            score += 5;
            proof.push("Email found but not domain/generic verified");
        }
    } else {
        rejectionReasons.push("No public email found");
    }

    if (hasAddress) {
        score += 10;
        proof.push("Address found");
    }

    if (hasPages && scraped.pagesScraped.length > 1) {
        score += 10;
        proof.push("Contact/about/location pages scraped");
    }

    if (nicheMatches(scraped, job.niche)) {
        score += 20;
        proof.push("Niche matched");
    } else {
        rejectionReasons.push("Niche not confirmed on website");
    }

    const locationConfirmed = locationMatches(scraped, job.location);

if (locationConfirmed) {
    score += 25;
    proof.push(`Location confirmed for "${job.location}"`);
} else {
    rejectionReasons.push(`Location not confirmed for "${job.location}"`);

    return {
        status: "rejected",
        confidenceScore: Math.min(score, 40),
        primaryPhone: "",
        primaryEmail: "",
        phoneSource: null,
        emailSource: null,
        proof,
        rejectionReasons
    };
}

    let status = "rejected";

    if (score >= 80 && hasPhone && hasName) {
        status = "verified";
    } else if (score >= 55 && (hasPhone || hasEmail)) {
        status = "needsReview";
    }

    return {
        confidenceScore: Math.min(score, 100),
        status,
        proof,
        rejectionReasons
    };
}