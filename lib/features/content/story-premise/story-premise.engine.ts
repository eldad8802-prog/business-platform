import OpenAI from "openai";
import type { StoryPremise, StoryPremiseInput } from "./types";

// ─── Model ────────────────────────────────────────────────────────────────────

function getActiveModel(): string {
  const m = process.env.CONTENT_LLM_MODEL?.trim();
  return m && m.length > 3 ? m : "gpt-4.1-mini";
}

// ─── Parsing + validation ─────────────────────────────────────────────────────

const SCALAR_FIELDS: (keyof Omit<StoryPremise, "sceneProgression">)[] = [
  "openingMoment",
  "protagonist",
  "emotionalCore",
  "conflict",
  "escalation",
  "turningPoint",
  "emotionalPayoff",
  "marketingMeaning",
];

function safeParse(text: string): unknown {
  try {
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function validate(raw: unknown): StoryPremise | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  for (const f of SCALAR_FIELDS) {
    if (typeof r[f] !== "string" || !(r[f] as string).trim()) return null;
  }

  if (!Array.isArray(r.sceneProgression) || r.sceneProgression.length < 2) return null;
  const scenes = (r.sceneProgression as unknown[])
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
  if (scenes.length < 2) return null;

  return {
    openingMoment:    (r.openingMoment    as string).trim(),
    protagonist:      (r.protagonist      as string).trim(),
    emotionalCore:    (r.emotionalCore    as string).trim(),
    conflict:         (r.conflict         as string).trim(),
    escalation:       (r.escalation       as string).trim(),
    turningPoint:     (r.turningPoint     as string).trim(),
    emotionalPayoff:  (r.emotionalPayoff  as string).trim(),
    marketingMeaning: (r.marketingMeaning as string).trim(),
    sceneProgression: scenes,
  };
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `אתה בונה בסיס לסיפור — לא כותב פרסומת, לא מחפש "אנגל שיווקי", לא מחפש "קונספט".
המשימה שלך: לתת ל-LLM שיכתוב את הסרטון "סיפור אמיתי לספר" במקום "מבנה למלא".

חוקים:
• אדם ספציפי — לא "לקוח פוטנציאלי", לא "קהל יעד", לא "אנשים שרוצים". אדם אחד. גיל, מצב, מה הוא עושה עכשיו.
• רגע ספציפי — לא מצב כללי. מה קורה היום, בשעה הזאת, במקום הזה.
• sceneProgression: כל scene = פעולה אחת שאפשר לצלם. לא רגש, לא מסקנה, לא הסבר — מה עושים בפועל.
• קונפליקט אנושי — לא "בעיה שיווקית". משהו שמושך לשני כיוונים. אפשר גם קטן וספציפי.
• payoff לא מושלם — לא "כל הבעיות נפתרו". "היה רגע" / "קצת יותר קל" / "בינתיים" / "לפחות זה".
• ישראליות — ישירות, פרגמטיות, הומור שלא מוצהר, לא דרמה מוגזמת, לא מוטיבציה אמריקאית.

אסור לחלוטין — אם אחד מהביטויים האלה מופיע בפלט, התחל מחדש:
"מסע", "journey", "פוטנציאל", "potential", "מגיע לך", "השינוי מתחיל", "גלה את",
"החלום שלך", "לחיות את החיים", "ביחד נצליח", "הדרך שלך", "אפשרי להצליח",
"transform", "empower", "level up", "elevate", "הצלחה מובטחת", "הפתרון המושלם",
"להגשים", "לממש חלומות", "חיים טובים יותר", "העתיד שלך", "הגרסה הטובה ביותר"

בדיקת איכות לפני פלט:
הסר את שם העסק מכל scene ב-sceneProgression. האם הסיפור עדיין מעניין ואנושי?
אם לא — שנה. הסיפור חייב לעמוד בפני עצמו.

פלט: JSON בלבד. ללא markdown, ללא הסברים.`;

function buildUserPrompt(input: StoryPremiseInput): string {
  const hi = input.humanInsight;

  const sceneCountNote = input.structure?.length
    ? `sceneProgression: כתוב בדיוק ${input.structure.length} scenes — אחד לכל שוט.`
    : `sceneProgression: כתוב ${input.durationSeconds && input.durationSeconds > 45 ? "5–7" : "3–5"} scenes — כמספר שוטים הגיוני לסרטון הזה.`;

  const goalNote = input.contentGoalPrompt
    ? `\nמה בעל העסק רוצה להעביר: ${input.contentGoalPrompt.slice(0, 180)}`
    : "";
  const categoryNote = input.businessCategory ? `\nקטגוריה: ${input.businessCategory}` : "";
  const directionNote = input.directionTitle
    ? `\nכיוון שנבחר: ${input.directionTitle}${input.directionDescription ? ` — ${input.directionDescription}` : ""}`
    : "";

  return `עסק: ${input.businessLabel}
מה מציעים: ${input.mainOfferLabel}
קהל: ${input.audienceLabel}
מטרה: ${input.goalLabel}${categoryNote}${directionNote}${goalNote}

תובנה אנושית (שכבת הבנה — לא לציטוט, רק כבסיס):
מצב: ${hi.humanSituation}
רגש: ${hi.emotionalInterpretation}
אמת נסתרת: ${hi.hiddenTruth}
מתח: ${hi.tension}
נתיב קריאייטיב: ${hi.creativeRoute}

קח את התובנה הזאת ותאנכר אותה ברגע ספציפי, עם אדם ספציפי, בסיטואציה קונקרטית.
${sceneCountNote}
sceneProgression: כל משפט = פעולה שאפשר לצלם. לא מצב. לא רגש. מה עושים ממש.

החזר JSON עם כל השדות הבאים (כולם חובה, כולם בעברית, 1–2 משפטים קצרים לכל שדה חוץ מsceneProgression):
{
  "openingMoment": "...",
  "protagonist": "...",
  "emotionalCore": "...",
  "conflict": "...",
  "escalation": "...",
  "turningPoint": "...",
  "emotionalPayoff": "...",
  "marketingMeaning": "...",
  "sceneProgression": ["...", "...", "..."]
}`;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export async function buildStoryPremise(
  input: StoryPremiseInput
): Promise<StoryPremise | null> {
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model  = getActiveModel();

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: buildUserPrompt(input) },
      ],
      temperature: 0.9,
      max_tokens:  900,
    });

    const text = response.choices[0]?.message?.content ?? "";
    if (!text.trim()) {
      console.warn("[story-premise] EMPTY_RESPONSE");
      return null;
    }

    const raw = safeParse(text);
    if (raw == null) {
      console.warn("[story-premise] PARSE_FAILED");
      return null;
    }

    const validated = validate(raw);
    if (!validated) {
      console.warn("[story-premise] VALIDATION_FAILED");
      return null;
    }

    console.info("[story-premise] SUCCESS scenes=" + validated.sceneProgression.length);
    return validated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[story-premise] ERROR detail=${msg}`);
    return null;
  }
}
