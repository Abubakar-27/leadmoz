function escapeCsv(value) {
    let s = value;

    if (Array.isArray(s)) s = s.join(" | ");

    s = String(s ?? "");

    if (/[",\n\r]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }

    return s;
}

function fmtFunnel(audit) {
    if (!audit || typeof audit !== "object") return "Not audited";

    const parts = [];

    if (audit.broken_internal_links?.length) {
        parts.push(
            `Broken links (${audit.broken_internal_links.length}): ` +
            audit.broken_internal_links.map(b => `${b.broken_url} (${b.status_code})`).join(", ")
        );
    }

    if (audit.dead_social_icons?.length) {
        parts.push(
            `Dead social icons (${audit.dead_social_icons.length}): ` +
            audit.dead_social_icons.map(d => d.platform).join(", ")
        );
    }

    const form = audit.form_vulnerabilities;
    if (form) {
        if (form.has_contact_form) {
            parts.push(`Contact form found${form.issues?.length ? ` — issues: ${form.issues.join("; ")}` : ""}`);
        } else {
            parts.push("No contact form found");
        }
    }

    return parts.length ? parts.join(" | ") : "No leak signals found";
}

function fmtSocial(social) {
    if (!social || typeof social !== "object") return "";
    return [social.linkedin, social.facebook, social.instagram].filter(Boolean);
}

function fmtFlag(value) {
    if (value === true) return "Yes";
    if (value === false) return "No";
    return "";
}

function fmtSeo(audit) {
    if (!audit || typeof audit !== "object") return "Not audited";

    const parts = [];

    const og = audit.open_graph;
    if (og) {
        if (og.is_valid) {
            parts.push("OG tags complete");
        } else {
            parts.push(
                `Missing OG tags: ${(og.missing_tags || []).join(", ") || "shared"}` +
                (og.preview_warning ? ` — ${og.preview_warning}` : "")
            );
        }
    }

    const schema = audit.schema_markup;
    if (schema) {
        parts.push(
            schema.schema_present
                ? `Schema present: ${(schema.detected_types || []).join(", ")}`
                : "No schema markup found"
        );
    }

    return parts.join(" | ");

}

export function leadsToCsv(leads) {
    const anyAudits = (leads || []).some(lead => lead.leakingFunnelAudit || lead.seoSchemaAudit);

    const headers = [
        "businessName",
        "website",
        "linkedinUrl",
        "socialLinks",
        "primaryPhone",
        "primaryEmail",
        "confidenceScore",
        "status",
        "proof",
        "rejectionReasons",
        "allPhones",
        "allEmails",
        "addresses",
        "score",
        "priorityScore",
        "scoreBand",
        "scrapeOk",
        "pagesScraped",
        "weaknessSummary",
        "topWeakness",
        "detectedWeaknesses",
        "personalizationAngle",
        "coldEmail",
        "linkedInDM",
        "callOpener",
        "ownerName",
        "missingPixel",
        "noClickToCall",
        "noSocialsFound",
        "missingMobileOptimization",
        "icpScore",
        "icpTier",
        "icpHeat",
        "icpReasons",
        "aeoGrade",
        "aiCrawlersBlocked",
        "officialEmail",
        "connectionNote",
        "followUps"
    ];

    if (anyAudits) headers.push("leakingFunnelIssues", "seoGaps");

    const rows = [headers.join(",")];

    for (const lead of leads) {
        const signals = lead.rawSignals || {};

        const row = {
            businessName: lead.businessName,
            website: lead.website,
            linkedinUrl: lead.linkedinUrl,
            socialLinks: fmtSocial(lead.socialLinks),
            primaryPhone: lead.phone,
            primaryEmail: lead.email,
            allPhones: lead.allPhones || [],
            allEmails: lead.allEmails || [],
            addresses: lead.addresses || [],
            score: lead.score,
            priorityScore: lead.priorityScore,
            scoreBand: lead.scoreBand,
            scrapeOk: lead.scrapeOk,
            pagesScraped: lead.pagesScraped || [],
            weaknessSummary: lead.weaknessSummary,
            topWeakness: (lead.weaknesses && lead.weaknesses[0] && lead.weaknesses[0].label) || "",
            detectedWeaknesses: (lead.weaknesses || []).map(w => w.label).join(" | "),
            personalizationAngle: lead.personalizationAngle,
            coldEmail: lead.coldEmail,
            linkedInDM: lead.linkedInDM,
            callOpener: lead.callOpener,
            ownerName: lead.ownerName || signals.ownerName || "",
            missingPixel: fmtFlag(signals.missingPixel),
            noClickToCall: fmtFlag(signals.noClickToCall),
            noSocialsFound: fmtFlag(signals.noSocialsFound),
            missingMobileOptimization: fmtFlag(signals.missingMobileOptimization),
            icpScore: lead.icpScore ?? "",
            icpTier: lead.icpTier || "",
            icpHeat: lead.icpHeat || "",
            icpReasons: lead.icpReasons || [],
            aeoGrade: signals.aeoGrade || "",
            aiCrawlersBlocked: signals.aiCrawlersBlocked || [],
            officialEmail: signals.officialEmail || lead.primaryEmail || "",
            connectionNote: lead.connectionNote || "",
            followUps: lead.followUps || [],
            leakingFunnelIssues: fmtFunnel(lead.leakingFunnelAudit),
            seoGaps: fmtSeo(lead.seoSchemaAudit)
        };

        rows.push(headers.map(h => escapeCsv(row[h])).join(","));
    }

    return rows.join("\n");
}