const HUNTER_BASE = "https://api.hunter.io/v2";

function hasHunterKey() {
    return Boolean(process.env.HUNTER_API_KEY && process.env.HUNTER_API_KEY !== "your_hunter_key_here");
}

function getDomain(url = "") {
    try {
        return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
        return "";
    }
}

function normalizeEmail(email = "") {
    return String(email)
        .trim()
        .toLowerCase()
        .replace(/^mailto:/i, "")
        .split("?")[0]
        .replace(/[;,]+$/, "");
}

async function hunterGet(path, params = {}) {
    if (!hasHunterKey()) {
        return { ok: false, skipped: true, reason: "Missing HUNTER_API_KEY" };
    }

    const url = new URL(`${HUNTER_BASE}${path}`);

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && String(value).trim() !== "") {
            url.searchParams.set(key, String(value));
        }
    }

    url.searchParams.set("api_key", process.env.HUNTER_API_KEY);

    try {
        const res = await fetch(url, {
            headers: {
                accept: "application/json",
                "user-agent": "ClientFinderAI/1.0"
            },
            signal: AbortSignal.timeout(20000)
        });

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
            return {
                ok: false,
                status: res.status,
                reason: json?.errors?.[0]?.details || json?.errors?.[0]?.code || "Hunter API failed",
                raw: json
            };
        }

        return { ok: true, data: json.data || json };
    } catch (err) {
        return {
            ok: false,
            reason: err.message
        };
    }
}

export async function verifyEmailWithHunter(email) {
    const cleanEmail = normalizeEmail(email);

    if (!cleanEmail || !cleanEmail.includes("@")) {
        return {
            ok: false,
            email: cleanEmail,
            result: "invalid",
            score: 0,
            reason: "Invalid email format"
        };
    }

    const response = await hunterGet("/email-verifier", {
        email: cleanEmail
    });

    if (!response.ok) {
        return {
            ok: false,
            email: cleanEmail,
            result: "unknown",
            score: 0,
            reason: response.reason || "Hunter skipped"
        };
    }

    const data = response.data || {};

    const result = String(data.result || "").toLowerCase();

    return {
        ok: true,
        email: cleanEmail,
        result: result || "unknown",
        score: Number(data.score) || 0,
        disposable: Boolean(data.disposable),
        gibberish: Boolean(data.gibberish),
        block: Boolean(data.block),
        reason: ""
    };
}

export async function findEmailsWithHunterDomain(website) {
    const domain = getDomain(website);

    if (!domain) {
        return {
            ok: false,
            emails: [],
            reason: "No domain"
        };
    }

    const response = await hunterGet("/domain-search", {
        domain,
        limit: 10
    });

    if (!response.ok) {
        return {
            ok: false,
            domain,
            emails: [],
            reason: response.reason || "Hunter domain search skipped"
        };
    }

    const emails = Array.isArray(response.data?.emails)
        ? response.data.emails
            .map(item => ({
                value: normalizeEmail(item.value),
                type: item.type || "",
                confidence: Number(item.confidence || 0),
                firstName: item.first_name || "",
                lastName: item.last_name || "",
                position: item.position || "",
                department: item.department || "",
                sources: item.sources || []
            }))
            .filter(item => item.value && item.value.includes("@"))
        : [];

    return {
        ok: true,
        domain,
        emails
    };
}

/*
    Individual email finder. Only meaningful once a decision-maker's first and
    last name are known; Hunter returns the most likely professional address for
    that person at that domain. Uses the same key/limit/error handling as the
    other calls so the caller can classify the failure uniformly.
*/
export async function findEmailWithHunter(website, firstName, lastName) {
    const domain = getDomain(website);
    const first = String(firstName || "").trim();
    const last = String(lastName || "").trim();

    if (!domain) {
        return { ok: false, domain, email: "", reason: "No domain" };
    }
    if (!first || !last) {
        return { ok: false, domain, email: "", reason: "Missing first or last name" };
    }

    const response = await hunterGet("/email-finder", {
        domain,
        first_name: first,
        last_name: last
    });

    if (!response.ok) {
        return { ok: false, domain, email: "", reason: response.reason || "Hunter email finder skipped" };
    }

    const data = response.data || {};
    return {
        ok: true,
        domain,
        email: normalizeEmail(data.email || ""),
        confidence: Number(data.score || 0),
        firstName: data.first_name || first,
        lastName: data.last_name || last,
        position: data.position || "",
        sources: Array.isArray(data.sources) ? data.sources : []
    };
}