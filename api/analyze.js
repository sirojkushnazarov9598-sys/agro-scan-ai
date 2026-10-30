// AGRO SCAN AI: сурат таҳлили. Claude API калити фақат шу серверда туради.
// Vercel Serverless Function (Node.js). Муҳит ўзгарувчилари:
//   ANTHROPIC_API_KEY  (мажбурий)
//   ANTHROPIC_MODEL    (ихтиёрий, одатда claude-sonnet-5-5)

const db = require("../public/diseases.json");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_IMAGE_CHARS = 3500000; // base64 узунлиги, тахминан 2.6 МБ
const LIMIT_PER_HOUR = 30;       // битта IP учун (оддий, ҳар serverless нусхада алоҳида)
const hits = new Map();

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > LIMIT_PER_HOUR;
}

function buildPrompt(crop) {
  const list = db.diseases
    .map((d) => `- ${d.id} | crop: ${d.crop} (${db.crops[d.crop].name}) | ${d.name} | typical signs: ${d.signs}`)
    .join("\n");
  return (
    "You are the vision component of AGRO SCAN AI, a plant-disease screening aid for farmers in Uzbekistan. The attached photo was taken by a farmer.\n" +
    "Task: decide whether the plant in the photo looks healthy, shows one of the KNOWN problems below, or cannot be determined from this photo.\n\n" +
    "Known crops: cotton, wheat, tomato, grape.\nKnown problems (use ONLY these ids):\n" + list + "\n\n" +
    "Farmer's crop choice: " + (crop === "auto" ? "not given, identify the crop yourself" : crop) + ".\n\n" +
    "Rules:\n" +
    "- Describe only what is actually visible. Never invent symptoms.\n" +
    "- Use a disease_id only if the crop matches and the visible signs fit; otherwise status must be \"uncertain\" (the plant may have another problem, such as a nutrient deficiency, sunburn or a different pest) and disease_id null.\n" +
    "- If the photo is blurry, dark, too far away or shows no plant, set photo_quality \"poor\" and explain in photo_issue. Keep confidence under 60 in that case.\n" +
    "- confidence is your honest certainty from 0 to 100.\n" +
    "- Do NOT recommend any treatment, pesticide or dose.\n" +
    "- Write signs, photo_issue and note in Uzbek (Cyrillic script), short and plain.\n\n" +
    "Reply with ONLY one JSON object of this shape:\n" +
    '{"plant_visible": true, "photo_quality": "good" | "poor", "photo_issue": string | null, "crop_id": "cotton" | "wheat" | "tomato" | "grape" | "other" | null, "status": "healthy" | "disease" | "uncertain", "disease_id": string | null, "confidence": 0-100, "severity": "initial" | "moderate" | "severe" | null, "signs": [up to 3 short strings], "alternatives": [up to 2 other known disease ids], "note": one short sentence}'
  );
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) { /* пастга тушади */ }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { /* ... */ } }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "server_not_configured" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "rate_limited" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body.image !== "string" || body.image.length < 100 || body.image.length > MAX_IMAGE_CHARS) {
    return res.status(400).json({ error: "bad_image" });
  }
  const crop = body.crop === "auto" || db.crops[body.crop] ? body.crop : "auto";

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 55000);
  try {
    const up = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: body.image } },
            { type: "text", text: buildPrompt(crop) }
          ]
        }]
      })
    });
    if (up.status === 429) return res.status(429).json({ error: "rate_limited" });
    if (!up.ok) return res.status(502).json({ error: "upstream_error" });
    const j = await up.json();
    const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const data = parseJson(text);
    if (!data || typeof data !== "object") return res.status(422).json({ error: "invalid_json" });
    return res.status(200).json({ data });
  } catch (e) {
    return res.status(502).json({ error: "upstream_error" });
  } finally {
    clearTimeout(timer);
  }
};
