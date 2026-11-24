require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const port = Number(process.env.PORT) || 3000;
const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use(express.static(path.join(__dirname)));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/voice", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 3000) : "";
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!text) return res.status(400).json({ error: "Text is required for speech." });
  if (!apiKey || !voiceId) return res.status(503).json({ error: "ElevenLabs voice is not configured." });

  try {
    const modelName = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
    const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
      body: JSON.stringify({
        text,
        model_id: modelName,
        voice_settings: { stability: 0.6, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true }
      }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!upstream.ok) {
      const result = await upstream.json().catch(() => ({}));
      console.error("ElevenLabs TTS request failed:", upstream.status, result?.detail?.message || result?.detail || "upstream error");
      return res.status(502).json({ error: "The selected ElevenLabs voice could not speak just now." });
    }
    const audio = Buffer.from(await upstream.arrayBuffer());
    res.set("Content-Type", "audio/mpeg");
    res.set("Cache-Control", "no-store");
    res.send(audio);
  } catch (error) {
    console.error("ElevenLabs TTS backend error:", error.message);
    res.status(502).json({ error: "Could not reach the voice service." });
  }
});

app.post("/api/chat", async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question || question.length > 4000) {
    return res.status(400).json({ error: "Enter a question under 4,000 characters." });
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "The AI service is not configured. Add GROQ_API_KEY to .env and restart the server." });

  const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
  const messages = [
    { role: "system", content: "You are HealMeal, a supportive general health information assistant for people in India. Do not diagnose, prescribe, or recommend changing medication. For urgent or severe symptoms, advise seeking emergency medical care. Be clear about uncertainty, keep answers concise and remind users that your information is not a substitute for a licensed clinician. Format answers as clean GitHub-flavored Markdown: begin with a brief direct answer, use short ## headings and bullets for scannability, and use a table only when it makes a comparison clearer. Do not use raw HTML. For meal ideas, give 3–4 practical options with portions where useful, not an exhaustive food catalogue. Prefer affordable, locally available and seasonal Indian foods and familiar home-cooked dishes; do not assume imported, specialty, or costly products are available. Offer vegetarian options where practical, while respecting the user's stated needs." },
    ...history
      .filter(item => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
      .map(item => ({ role: item.role, content: item.content.slice(0, 4000) })),
    { role: "user", content: question }
  ];

  try {
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 600 }),
      signal: AbortSignal.timeout(30_000)
    });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Groq request failed:", upstream.status, result?.error?.message || "upstream error");
      return res.status(502).json({ error: "The AI service could not answer just now. Please try again." });
    }
    const answer = result.choices?.[0]?.message?.content?.trim();
    if (!answer) return res.status(502).json({ error: "The AI service returned no answer. Please try again." });
    res.json({ answer });
  } catch (error) {
    console.error("Chat backend error:", error.message);
    res.status(502).json({ error: "Could not reach the AI service. Check your connection and try again." });
  }
});


const indianDietaryGuidelines = {
  label: "ICMR–National Institute of Nutrition: Dietary Guidelines for Indians (2024)",
  url: "https://nin.res.in/dietaryguidelines/pdfjs/locale/DGI_2024.pdf"
};
const eatRightIndia = {
  label: "FSSAI: Eat Right India",
  url: "https://fssai.gov.in/eat-right-india"
};

const trustedSources = {
  diabetes: [
    { label: "National Centre for Disease Control (India): Diabetes FAQs", url: "https://ncdc.mohfw.gov.in/wp-content/uploads/2024/11/Diabetes-Mellitus-English.pdf" },
    indianDietaryGuidelines
  ],
  hypertension: [
    { label: "National Centre for Disease Control (India): Hypertension FAQs", url: "https://ncdc.mohfw.gov.in/wp-content/uploads/2024/11/Hypertension-English-FAQs.pdf" },
    indianDietaryGuidelines
  ],
  "high blood pressure": [
    { label: "National Centre for Disease Control (India): Hypertension FAQs", url: "https://ncdc.mohfw.gov.in/wp-content/uploads/2024/11/Hypertension-English-FAQs.pdf" },
    indianDietaryGuidelines
  ],
  "heart disease": [indianDietaryGuidelines, eatRightIndia],
  heartburn: [
    indianDietaryGuidelines,
    { label: "NIDDK: GER & GERD information", url: "https://www.niddk.nih.gov/health-information/digestive-diseases/acid-reflux-ger-gerd-adults" }
  ],
  obesity: [
    { label: "National Centre for Disease Control (India): Obesity FAQs", url: "https://ncdc.mohfw.gov.in/wp-content/uploads/2024/11/Obesity-English-FAQs.pdf" },
    indianDietaryGuidelines
  ],
  anemia: [indianDietaryGuidelines, eatRightIndia],
  anaemia: [indianDietaryGuidelines, eatRightIndia],
  pcos: [indianDietaryGuidelines, eatRightIndia],
  pcod: [indianDietaryGuidelines, eatRightIndia],
  kidney: [
    indianDietaryGuidelines,
    { label: "NIDDK: Eating Right for Chronic Kidney Disease", url: "https://www.niddk.nih.gov/health-information/kidney-disease/chronic-kidney-disease-ckd/healthy-eating" }
  ],
  "acid reflux": [
    indianDietaryGuidelines,
    { label: "NIDDK: GER & GERD information", url: "https://www.niddk.nih.gov/health-information/digestive-diseases/acid-reflux-ger-gerd-adults" }
  ],
  gerd: [
    indianDietaryGuidelines,
    { label: "NIDDK: GER & GERD information", url: "https://www.niddk.nih.gov/health-information/digestive-diseases/acid-reflux-ger-gerd-adults" }
  ],
  celiac: [
    indianDietaryGuidelines,
    { label: "NIDDK: Celiac Disease", url: "https://www.niddk.nih.gov/health-information/digestive-diseases/celiac-disease" }
  ],
  pregnancy: [
    indianDietaryGuidelines,
    { label: "Ministry of Health & Family Welfare (India): Nutrition of pregnant women", url: "https://www.mohfw.gov.in/sites/default/files/308320517NATIONAL%20GUIDELINES%20ON%20INFANT%20AND%20YOUNG%20CHILD%20FEEDING.pdf" }
  ],
  general: [indianDietaryGuidelines, eatRightIndia]
};

function getTrustedSources(concern) {
  const normalized = concern.toLowerCase();
  const key = Object.keys(trustedSources).find(item => item !== "general" && normalized.includes(item));
  if (key) return trustedSources[key];
  return [
    ...trustedSources.general,
    {
      label: `MedlinePlus: Evidence-based information about ${concern}`,
      url: `https://medlineplus.gov/search/?query=${encodeURIComponent(concern)}`
    }
  ];
}

app.post("/api/meal-plan", async (req, res) => {
  const concern = typeof req.body?.healthConcern === "string" ? req.body.healthConcern.trim() : "";
  if (!concern || concern.length > 500) {
    return res.status(400).json({ error: "Enter a health concern or nutrition goal under 500 characters." });
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "The AI service is not configured. Add GROQ_API_KEY to .env and restart the server." });

  const schema = {
    type: "object",
    properties: {
      overview: { type: "string" },
      meals: { type: "array", items: { type: "object", properties: {
        meal: { type: "string" }, name: { type: "string" }, description: { type: "string" },
        calories: { type: "number", minimum: 0, maximum: 1500 }, protein_g: { type: "number", minimum: 0, maximum: 200 }, carbs_g: { type: "number", minimum: 0, maximum: 200 }, fiber_g: { type: "number", minimum: 0, maximum: 80 }
      }, required: ["meal", "name", "description", "calories", "protein_g", "carbs_g", "fiber_g"], additionalProperties: false } },
      nutrition_focus: { type: "array", items: { type: "string" } },
      helpful_foods: { type: "array", items: { type: "string" } },
      disclaimer: { type: "string" }
    },
    required: ["overview", "meals", "nutrition_focus", "helpful_foods", "disclaimer"],
    additionalProperties: false
  };

  try {
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Create general educational meal ideas for the user's stated health concern or nutrition goal. This app is for an Indian audience: make the meals affordable, practical and recognisable in an Indian home. Prefer seasonal local vegetables and fruit, dal, chana, rajma, whole grains or millets, rice or roti in suitable portions, curd or milk where suitable, eggs, and locally available fish or chicken where suitable. Include vegetarian choices where practical. Do not assume expensive imported, processed, branded or specialty foods. This localisation is not a clinical diet prescription and must not override safety needs. Never diagnose, infer a diagnosis, claim to treat/cure a condition, prescribe supplements or medication, or give personalized calorie/macro targets. Do not claim nutrient deficiencies from a condition. Nutrient numbers are rough estimates for each suggested serving and must be labeled approximate in the UI. Return JSON only matching the required schema. Include exactly four meals: Breakfast, Lunch, Dinner, Snack. Include a short clinician disclaimer. For symptoms, unexplained issues, kidney disease, pregnancy, food allergy, medication interactions, or multiple conditions, emphasize that a clinician or registered dietitian should review the plan." },
          { role: "user", content: `Health concern or goal: ${concern}\nCreate four varied, practical general meal ideas that are appropriate to discuss with a clinician. Give plausible approximate calories, protein, carbohydrates, and fiber per meal, not medical targets. Keep overview to 1-2 sentences, nutrition_focus to 3-5 short points, helpful_foods to 4-8 foods, and disclaimer to 1-2 concise sentences.` }
        ],
        response_format: { type: "json_schema", json_schema: { name: "condition_meal_plan", strict: true, schema } },
        temperature: 0.3,
        reasoning_effort: "low",
        max_tokens: 1600
      }),
      signal: AbortSignal.timeout(45_000)
    });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Groq meal plan request failed:", upstream.status, result?.error?.message || "upstream error");
      return res.status(502).json({ error: "The meal plan service could not answer just now. Please try again." });
    }
    const raw = result.choices?.[0]?.message?.content;
    let plan;
    try { plan = JSON.parse(raw); } catch { return res.status(502).json({ error: "The meal plan response was not in the expected format. Please try again." }); }
    if (!Array.isArray(plan.meals) || plan.meals.length !== 4 || !Array.isArray(plan.nutrition_focus) || !Array.isArray(plan.helpful_foods) || plan.meals.some(meal => !meal || ![meal.calories, meal.protein_g, meal.carbs_g, meal.fiber_g].every(value => Number.isFinite(value) && value >= 0))) {
      return res.status(502).json({ error: "The meal plan response was incomplete. Please try again." });
    }
    res.json({ concern, ...plan, sources: getTrustedSources(concern) });
  } catch (error) {
    console.error("Meal plan backend error:", error.message);
    res.status(502).json({ error: "Could not reach the meal plan service. Check your connection and try again." });
  }
});

if (require.main === module) {
  app.listen(port, () => console.log(`HealMeal running at http://localhost:${port}`));
}

module.exports = app;

