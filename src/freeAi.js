import axios from "axios";

const FREE_AI_ENDPOINTS = [
  {
    name: "groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    keyEnv: "GROQ_API_KEY",
    model: "llama3-8b-8192",
  },
  {
    name: "google",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyEnv: "GOOGLE_AI_API_KEY",
    model: "gemini-2.5-flash-preview-05-20",
  },
];

export async function generateOutreachText({ audit, businessName, url } = {}) {
  const systemPrompt = `You are an outreach assistant. Generate a clean B2B outreach pitch based on website audit flags. Output only the pitch text.`;

  const userPrompt = `Business: ${businessName || "Unknown"}
URL: ${url || ""}
Audit: ${JSON.stringify(audit)}

Write a concise, professional outreach pitch mentioning relevant improvement opportunities.`;

  for (const ep of FREE_AI_ENDPOINTS) {
    const key = process.env[ep.keyEnv];
    if (!key) continue;
    try {
      const res = await axios.post(
        ep.url,
        {
          model: ep.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 400,
        },
        {
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          timeout: 60000,
        }
      );
      const content = res.data?.choices?.[0]?.message?.content || "";
      return content.trim();
    } catch (err) {
      console.error(`${ep.name} free AI error:`, err.message);
    }
  }
  return "I'd love to help improve your online presence and capture more qualified leads.";
}
