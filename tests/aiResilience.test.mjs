// Guards the bug where one bad AI response disabled a provider for the rest of
// the server session, leaving the app stuck on the local fallback with no way
// back except a PM2 restart.
import assert from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";

const AUTH = "1200"; // short enough to observe recovery in a test
process.env.AI_KEY_AUTH_COOLDOWN_MS = AUTH;
process.env.AI_KEY_COOLDOWN_MS = "60000";

// Deliberately invalid keys so the 401 path is exercised deterministically.
process.env.GROQ_API_KEYS = "sk-not-a-real-key";
process.env.GEMINI_API_KEYS = "gk-not-a-real-key";
delete process.env.OPENROUTER_API_KEY;

const { classifyKeyError, providerStatus, analyzeLead } = await import("../src/ai.js");

// --- A retired/misspelled model must never be blamed on the key --------------
// This is the exact case that silently killed Groq before the fix.
for (const msg of [
  "Groq failed 404: The model `llama-3.1-8b-instant` does not exist",
  "404 Not Found",
  "This model models/gemini-2.0-flash is no longer available",
  "model not found"
]) {
  assert.strictEqual(classifyKeyError({ message: msg }), "model", `should be a model error: ${msg}`);
}

for (const msg of [
  "Groq failed 401",
  "Gemini failed 403: Your project has been denied access",
  "API key not valid",
  "unauthorized"
]) {
  assert.strictEqual(classifyKeyError({ message: msg }), "auth", `should be an auth error: ${msg}`);
}

for (const msg of ["Groq failed 429", "rate limit exceeded", "quota exceeded", "some 5xx blip"]) {
  assert.strictEqual(classifyKeyError({ message: msg }), "quota", `should be a quota error: ${msg}`);
}

// A model error is checked first, so a 404 mentioning auth still blames the model.
assert.strictEqual(
  classifyKeyError({ message: "404 not found or you do not have access" }),
  "model",
  "404 must win over access wording"
);

// --- The app must still return usable output with every provider failing ----
const scraped = {
  scrapeOk: true,
  businessName: "Riverside Family Dentistry",
  title: "Riverside Family Dentistry",
  primaryEmail: "hello@riverside.example",
  primaryPhone: "+17135551234",
  emails: ["hello@riverside.example"],
  phones: ["+17135551234"],
  signals: { hasBooking: false, hasPricing: false, hasTestimonials: false, hasCTA: true, hasEmail: true, hasPhone: true }
};

const out = await analyzeLead({ scraped, niche: "dentist", location: "texas" });
assert.ok(out, "analyzeLead must always return a result");
assert.ok(Number(out.score) >= 1 && Number(out.score) <= 10, `score in range, got ${out.score}`);
assert.ok(out.weaknessSummary && out.weaknessSummary.length > 0, "needs a weakness summary");
assert.ok(!/\bbut\b.*\bbut\b/i.test(out.weaknessSummary), `no doubled "but": ${out.weaknessSummary}`);
assert.ok(!/\[Your Name\]|\[Company\]|\[Name\]/i.test(out.coldEmail || ""), "no placeholder leakage");

// --- Keys paused by a 401 must come back on their own, with no restart -------
await sleep(Number(AUTH) + 500);
const st = providerStatus();
assert.strictEqual(st.gemini.available, 1, `gemini must self-recover, got ${st.gemini.available}/${st.gemini.total}`);
assert.strictEqual(st.groq.available, 1, `groq must self-recover, got ${st.groq.available}/${st.groq.total}`);

console.log("ALL AI RESILIENCE CHECKS PASSED");
