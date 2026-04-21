import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Input = {
  goal: string;
  intent: string;
  businessCategory: string;
  serviceLabel: string;
  audienceDescription: string;
  creatorContext: string;
  creativeStrategy: any;
};

export type AIConcept = {
  id: string;
  label: string;
  idea: string;
  visual: string;
  hook: string;
};

// -------------------------
// PROMPT
// -------------------------

function buildPrompt(input: Input) {
  return `
אתה מומחה ביצירת רעיונות לתוכן וידאו ברמה גבוהה מאוד.

מידע:
עסק: ${input.businessCategory}
שירות: ${input.serviceLabel}
קהל: ${input.audienceDescription || "כללי"}
מה המשתמש רוצה: ${input.creatorContext}

אסטרטגיה:
pillar: ${input.creativeStrategy?.contentPillar}
angle: ${input.creativeStrategy?.creativeAngle}

חוקים:
- כל רעיון חייב להיות ספציפי
- חייב להיות רגע ויזואלי ברור
- אסור משפטים כלליים
- אסור "רוב האנשים"
- כל רעיון חייב להיות משהו שאפשר לצלם

תחזיר JSON בלבד:

[
  {
    "id": "desire",
    "label": "מושך ומעורר עניין",
    "idea": "...",
    "visual": "...",
    "hook": "..."
  },
  {
    "id": "trust",
    "label": "מקצועי ובונה אמון",
    "idea": "...",
    "visual": "...",
    "hook": "..."
  },
  {
    "id": "result",
    "label": "ישיר ומניע לפעולה",
    "idea": "...",
    "visual": "...",
    "hook": "..."
  }
]
`;
}

// -------------------------
// 🔥 SAFE JSON PARSER
// -------------------------

function safeParse(text: string) {
  try {
    let cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return null;

    let jsonString = match[0];

    // תיקון escaping
    jsonString = jsonString
      .replace(/\\"/g, '"')
      .replace(/\\n/g, " ")
      .replace(/\\t/g, " ");

    return JSON.parse(jsonString);
  } catch (err) {
    console.error("SAFE PARSE ERROR:", err);
    return null;
  }
}

// -------------------------
// MAIN
// -------------------------

export async function runConceptAI(
  input: Input
): Promise<AIConcept[]> {
  try {
    const prompt = buildPrompt(input);

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });

    const text = response.choices[0]?.message?.content || "";

    console.log("AI RAW RESPONSE:", text);

    const parsed = safeParse(text);

    if (!parsed || !Array.isArray(parsed)) {
      throw new Error("AI returned invalid JSON");
    }

    return parsed;
  } catch (error) {
    console.error("AI CONCEPT ERROR:", error);

    return [
      {
        id: "desire",
        label: "מושך ומעורר עניין",
        idea: "קלוזאפ על רגע מושך שמושך תשומת לב",
        visual: "צילום קרוב עם תנועה",
        hook: "חכה שתראה את זה",
      },
      {
        id: "trust",
        label: "מקצועי ובונה אמון",
        idea: "הצגת שלב חשוב בתהליך",
        visual: "הדגמה אמיתית",
        hook: "זה מה שעושה את ההבדל",
      },
      {
        id: "result",
        label: "ישיר ומניע לפעולה",
        idea: "הצגת תוצאה ברורה",
        visual: "לפני ואחרי",
        hook: "זה ההבדל",
      },
    ];
  }
}