import OpenAI from "openai";
import type { HumanInsight, HumanInsightInput } from "./types";

// ─── Reasoning context maps (signals, not templates) ─────────────────────────

const HOOK_CONTEXT: Record<string, string> = {
  pain_first:    "נכנסת דרך הכאב — הבן מה כואב, ואז שאל: מה ה-payoff הרגשי? הקלה? ביטחון? שקט? התחלה חדשה?",
  trust_first:   "נכנסת דרך ביטחון — הבן מה גורם לאנשים להסס, ואז שאל: איזה רגש יוצר קשר אמיתי כאן — רוגע, שייכות, ודאות?",
  result_first:  "נכנסת דרך התוצאה — הבן מה הצופה רוצה להיות: גאווה? קלות? שאיפה שמתגשמת? ניצחון?",
  offer_first:   "נכנסת דרך ההצעה — מה הרגש שנוצר כשמגלים משהו מפתיע? סקרנות? שמחה? הקלה שלא ציפו לה?",
  pattern_break: "נכנסת דרך שבירת תפיסה — מה הרגש שנוצר מפתיחה מפתיעה? הומור? סקרנות? הכרה עצמית פתאומית?",
};

const ANGLE_CONTEXT: Record<string, string> = {
  educational:     "הכיוון הסברתי — הרגש כאן יכול להיות סקרנות, הפתעה, או 'לא ידעתי את זה'",
  behind_scenes:   "הכיוון מאחורי הקלעים — הרגש יכול להיות קרבה, אמון, או תחושת 'הם לא מסתירים כלום'",
  social_proof:    "הכיוון של עדות — הרגש הוא שייכות, הכרה, או 'גם אני חווה את זה'",
  proof:           "הכיוון של ראיה — הרגש הוא ודאות, הקלה, או הפחתת ספק",
  inspirational:   "הכיוון של השראה — הרגש הוא שאיפה, גאווה עצמית, או 'גם אני יכול'",
  direct:          "הכיוון הישיר — הרגש הוא בהירות, החלטיות, או 'סוף כל סוף מישהו אומר את זה ישר'",
  show_result:     "הכיוון של תוצאה — הרגש הוא ניצחון, הקלה, או ציפייה לתוצאה דומה",
  explain:         "הכיוון של הסבר — הרגש הוא סקרנות שמתמלאת, או 'עכשיו זה הגיוני לי'",
  show_difference: "הכיוון של הבדל — הרגש הוא הכרה, ביטחון, או 'עכשיו אני יודע מה לבחור'",
  attention:       "הכיוון של עצירה — הרגש יכול להיות הפתעה, הומור, או 'חיכיתי שמישהו יגיד את זה'",
  trust:           "הכיוון של אמון — הרגש הוא ביטחון, רוגע, או 'אפשר לסמוך עליהם'",
  cta:             "הכיוון של הנעה — הרגש הוא דחיפות עדינה, או 'הגיע הזמן, אני מוכן'",
};

// ─── Reasoning instructions builder ─────────────────────────────────────────

function buildCreativeReasoningInstructions(input: HumanInsightInput): string {
  const hookSignal = input.hookStyle ? (HOOK_CONTEXT[input.hookStyle] ?? "") : "";
  const angleSignal = input.contentAngle ? (ANGLE_CONTEXT[input.contentAngle] ?? "") : "";
  const signals = [hookSignal, angleSignal].filter(Boolean);
  const signalBlock = signals.length
    ? `אותות כניסה לגנרציה הזאת:\n${signals.map((s) => `• ${s}`).join("\n")}\n\n`
    : "";

  const avoidBlock = input.avoidCreativeRoutes?.length
    ? `נתיבי קריאייטיב שכבר שימשו לוריאנטים קודמים בסשן זה — אל תחזור עליהם:\n${input.avoidCreativeRoutes.map((r, i) => `${i + 1}. ${r}`).join("\n")}\nחובה לבחור פרספקטיבה שונה לחלוטין — לא רק שינוי מילים.\n\n`
    : "";

  return `${signalBlock}${avoidBlock}לפני שתכתוב את ה-JSON, עבור תהליך reasoning פנימי:
• איזה רגש הכי נכון לסיטואציה הזאת? האם הסיפור צריך להתחיל מכאב, תקווה, גאווה, הקלה, הומור, סקרנות, רוגע, פחד, ביטחון, שייכות, התרגשות, געגוע, שאיפה, מבוכה או ניצחון קטן? לא לבחור אוטומטית כאב — לבחור את הרגש שמשרת הכי טוב את המטרה והקהל.
• מה הרגש שיהיה הכי ישראלי, אנושי ושיווקי עבור העסק הזה ולקהל הזה?
• מה הרגש שייצור הזדהות בלי להפוך את התוכן לשלילי מדי או לפרסומת?
• מה הקלישאה הכי נפוצה שעסקים כאלה נופלים בה — ואיך להימנע ממנה?
• מה הפרשנות הפחות ברורה, יותר מפתיעה, שעדיין אמיתית ומשרתת את המטרה?
• מה הצופה צריך להרגיש בסוף — לפני שמחליט לפנות?

סנתז את כל זה לשדה creativeRoute אחד, ממוקד ומדויק — פרספקטיבה רגשית, לא תיאור שיווקי.`;
}

// ─── Parsing + validation ────────────────────────────────────────────────────

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

const REQUIRED_FIELDS: (keyof HumanInsight)[] = [
  "humanSituation",
  "emotionalInterpretation",
  "hiddenTruth",
  "tension",
  "narrativeOpportunity",
  "viewerFeeling",
  "payoff",
  "creativeRoute",
  "israeliCommunicationDirection",
];

function validateHumanInsight(raw: unknown): HumanInsight | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  for (const f of REQUIRED_FIELDS) {
    if (typeof r[f] !== "string" || !(r[f] as string).trim()) return null;
  }
  return {
    humanSituation:                (r.humanSituation as string).trim(),
    emotionalInterpretation:       (r.emotionalInterpretation as string).trim(),
    hiddenTruth:                   (r.hiddenTruth as string).trim(),
    tension:                       (r.tension as string).trim(),
    narrativeOpportunity:          (r.narrativeOpportunity as string).trim(),
    viewerFeeling:                 (r.viewerFeeling as string).trim(),
    payoff:                        (r.payoff as string).trim(),
    creativeRoute:                 (r.creativeRoute as string).trim(),
    israeliCommunicationDirection: (r.israeliCommunicationDirection as string).trim(),
  };
}

function getActiveModel(): string {
  const m = process.env.CONTENT_LLM_MODEL?.trim();
  return m && m.length > 3 ? m : "gpt-4.1-mini";
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export async function generateHumanInsight(
  input: HumanInsightInput
): Promise<HumanInsight | null> {
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = getActiveModel();
    const reasoningInstructions = buildCreativeReasoningInstructions(input);

    const systemPrompt = `אתה אנליסט מצבים אנושיים ואסטרטג קריאייטיב.
המשימה שלך היחידה: לפרש מה קורה אצל האדם שעומד לצפות בתוכן הזה — לא מה העסק עושה.
אתה חושב בשפת רגשות, מצבי חיים, מתחים אנושיים — לא בשפת שיווק ולא בשפת מכירות.
פלט: JSON בלבד. ללא markdown, ללא הסברים. אובייקט JSON תקין בלבד.`;

    const directionBlock = input.directionTitle
      ? `\nכיוון שנבחר: ${input.directionTitle}${input.directionDescription ? ` — ${input.directionDescription}` : ""}`
      : "";
    const goalNoteBlock = input.contentGoalPrompt
      ? `\nמה שבעל העסק רצה להדגיש: ${input.contentGoalPrompt.slice(0, 150)}`
      : "";
    const categoryBlock = input.businessCategory
      ? `\nקטגוריה: ${input.businessCategory}`
      : "";

    const userPrompt = `עסק: ${input.businessLabel}
מה הם מציעים: ${input.mainOfferLabel}
קהל: ${input.audienceLabel}
מטרה: ${input.goalLabel}${categoryBlock}${directionBlock}${goalNoteBlock}

${reasoningInstructions}

החזר JSON עם השדות הבאים (כולם חובה, כולם בעברית, כל שדה 1-3 משפטים קצרים):
{
  "humanSituation": "...",
  "emotionalInterpretation": "...",
  "hiddenTruth": "...",
  "tension": "...",
  "narrativeOpportunity": "...",
  "viewerFeeling": "...",
  "payoff": "...",
  "creativeRoute": "...",
  "israeliCommunicationDirection": "..."
}`;

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0.85,
      max_tokens: 600,
    });

    const text = response.choices[0]?.message?.content ?? "";
    if (!text.trim()) {
      console.warn("[human-insight] EMPTY_RESPONSE");
      return null;
    }

    const raw = safeParse(text);
    if (raw == null) {
      console.warn("[human-insight] PARSE_FAILED");
      return null;
    }

    const validated = validateHumanInsight(raw);
    if (!validated) {
      console.warn("[human-insight] VALIDATION_FAILED");
      return null;
    }

    console.info("[human-insight] SUCCESS");
    return validated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[human-insight] ERROR detail=${msg}`);
    return null;
  }
}
