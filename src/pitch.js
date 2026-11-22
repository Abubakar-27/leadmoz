/*
  Deterministic outreach pitch.

  Built from the same measured findings the dashboard and the AI prompt use
  (deriveWeaknesses), so a pitch can never claim a fault the audit did not take.
  No model is involved: every lead gets a usable email at zero cost, and the
  same lead yields the same pitch on every run - which is what a rep copying it
  into a mail client wants.

  This is the floor under outbound. It is the fallback the AI path drops to when
  every provider is dry or none is configured, so it has to be good enough to
  send on its own rather than an apology template.
*/

const DEFAULT_SIGNOFF = "Best,";

function tidy(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/*
  A greeting that uses the owner's first name only when we actually extracted
  one. "Hi John," beats "Hi," when it is right, and a wrong or empty name is
  worse than no name, so anything that is not a clean single token is dropped.
*/
export function firstName(fullName) {
  const cleaned = tidy(fullName).replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, "");
  const token = cleaned.split(" ")[0] || "";
  return /^[A-Za-z][A-Za-z'.-]*$/.test(token) ? token : "";
}

/* Lowercases the first letter unless it opens an acronym (SEO, H1, ...). */
function lowerFirst(sentence) {
  const s = tidy(sentence);
  if (!s) return s;
  if (/^[A-Z]{2,}/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/*
  The single line the pitch leads with. A verified defect always wins because a
  prospect can reproduce it; failing that the strongest opportunity is offered
  as an addition, never as something broken; failing that the pitch says the
  site is fine and sells growth instead of inventing a fault.
*/
function openingLine(findings) {
  const defects = findings.filter(f => f.class === "defect" && f.hook);
  const opportunities = findings.filter(f => f.class === "opportunity" && f.hook);

  if (defects.length) return { line: defects[0].hook, angleId: defects[0].id, kind: "defect" };
  if (opportunities.length) return { line: opportunities[0].hook, angleId: opportunities[0].id, kind: "opportunity" };
  return { line: "", angleId: "no_defects_found", kind: "clear" };
}

/*
  A LinkedIn connection request is capped at 300 characters and gets truncated
  silently past that, so it is built to a 280 budget rather than trusting the
  limit. The owner's first name is used only when we actually extracted one.
*/
export function buildConnectionNote({ firstName: first = "", businessName = "", line = "" } = {}) {
  const name = tidy(businessName) || "your business";
  const hi = first ? `${first}, ` : "";
  const core = line
    ? `saw one thing on ${name}'s site that is worth a quick fix`
    : `had an idea to get ${name} more enquiries`;

  const note = tidy(`${hi}${core} - worth a quick connect?`);
  return note.length > 280 ? note.slice(0, 277).trimEnd() + "..." : note;
}

/*
  The three-message follow-up after the cold email. Each one stands alone (a rep
  may send any of them) and the last explicitly releases the prospect, so a
  no-reply thread ends politely instead of being chased forever.
*/
export function buildFollowUps({ businessName = "", ownerName = "", line = "", offer = "" } = {}) {
  const name = tidy(businessName) || "your business";
  const first = firstName(ownerName);
  const hi = first ? `Hi ${first},` : "Hi,";
  const promise = tidy(offer) || "I help local businesses turn more website visitors into calls and enquiries";
  const angle = line ? lowerFirst(line) : `turning more of ${name}'s visitors into enquiries`;

  return [
    tidy(`${hi} just following up on my note about ${name}. The one thing I spotted: ${angle}.`),
    tidy(`${hi} not looking to clutter your inbox. If it helps, I can send two specific ideas for ${name} you can hand straight to whoever runs the site.`),
    tidy(`${hi} last note from me on this one about ${name}. ${promise}. If the timing is wrong, just say so and I will leave it here.`)
  ];
}

export function buildPitch({
  businessName = "",
  ownerName = "",
  niche = "",
  location = "",
  weaknesses = [],
  offer = "",
  signoff = DEFAULT_SIGNOFF
} = {}) {
  const name = tidy(businessName) || "your business";
  const findings = Array.isArray(weaknesses) ? weaknesses : [];
  const { line, angleId, kind } = openingLine(findings);

  const where = [tidy(niche) || "local businesses", tidy(location) ? `in ${tidy(location)}` : ""]
    .filter(Boolean)
    .join(" ");

  const greeting = firstName(ownerName) ? `Hi ${firstName(ownerName)},` : "Hi,";
  const promise = tidy(offer) || "I help local businesses turn more website visitors into calls and enquiries";

  const subject =
    kind === "defect" ? `Quick fix for ${name}`
      : kind === "opportunity" ? `Idea for ${name}`
        : `A growth idea for ${name}`;

  const bodyLines = [
    greeting,
    "",
    `I came across ${name} while looking at ${where}.`,
    ""
  ];

  if (line) {
    bodyLines.push(lowerFirst(line));
  } else {
    bodyLines.push("Nothing on your site looks broken - which usually means the growth is sitting unused.");
  }

  bodyLines.push("", `${promise}.`, "", `Want me to send 2 quick ideas for ${name}?`, "", signoff);

  return {
    subject,
    body: bodyLines.join("\n"),
    line,
    angleId,
    kind,
    connectionNote: buildConnectionNote({ firstName: firstName(ownerName), businessName: name, line }),
    followUps: buildFollowUps({ businessName: name, ownerName, line, offer }),
    angle: line
      ? `Lead with the ${kind === "defect" ? "measured fault" : "upsell"}: ${line}`
      : "No measurable fault found - position growth work instead."
  };
}

export function formatColdEmail(pitch = {}) {
  const subject = tidy(pitch.subject) || "Quick idea";
  return `Subject: ${subject}\n\n${String(pitch.body || "").trim()}`;
}
