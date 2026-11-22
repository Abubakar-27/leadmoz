export function clean(value = "") {
  return String(value || "").trim();
}

export function getDomain(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function normalizeName(value = "") {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizePhone(value = "") {
  let digits = String(value || "").replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits;
}

export function candidateKey(candidate) {
  const website = candidate.website || candidate.url || "";
  const domain = getDomain(website);
  if (domain) return `domain:${domain}`;

  const phone = normalizePhone(candidate.phone || "");
  if (phone && phone.length >= 7) return `phone:${phone}`;

  return `name:${normalizeName(candidate.businessName || candidate.title || "")}`;
}

export function leadKey(lead) {
  return candidateKey(lead);
}

export function leadMatches(lead, key) {
  if (String(lead.website || lead.url || "")) {
    const domain = getDomain(lead.website || lead.url);
    if (domain && key === `domain:${domain}`) return `domain:${domain}`;
  }

  const phones = [lead.phone, ...(lead.allPhones || [])].filter(Boolean);
  for (const p of phones) {
    const np = normalizePhone(p);
    if (np && np.length >= 7 && key === `phone:${np}`) return `phone:${np}`;
  }

  const name = normalizeName(lead.businessName || lead.title || "");
  if (name && key === `name:${name}`) return `name:${name}`;

  return "";
}
