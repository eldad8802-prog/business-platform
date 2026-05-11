import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { LLMPromptContext, LLMPromptPlan, LLMPrompt } from "./llm-prompt-builder";

// ─── Domain bucket detection ──────────────────────────────────────────────────

type DomainBucket = "legal" | "beauty" | "services" | "design" | "retail" | "generic";

function detectDomainBucket(context: LLMPromptContext): DomainBucket {
  const haystack = [
    context.mainOfferLabel,
    context.businessLabel,
    context.businessCategory ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (/עורך דין|עורכת דין|משפטי|עורכי דין|ייעוץ משפטי|נוטריון/.test(haystack)) return "legal";
  if (/קוסמטיק|מניקור|פדיקור|איפור|פנים|עור|טיפולי פנים|ספא|יופי|שיער|תסרוקת|נייל/.test(haystack)) return "beauty";
  if (/חשמלאי|אינסטלטור|מנעולן|גז|תיקון|שירות חירום|טכנאי/.test(haystack)) return "services";
  if (/אדריכל|עיצוב פנים|אדריכלות|שיפוץ|בינוי|קבלן/.test(haystack)) return "design";
  if (/חנות|ביגוד|אופנה|מוצר|מכירה|קניה|חנות בגדים|פריט/.test(haystack)) return "retail";
  return "generic";
}

// ─── Few-shot example library ─────────────────────────────────────────────────

const FEW_SHOT_EXAMPLES: Record<DomainBucket, string> = {
  legal: `
דוגמה — עורך דין גירושין, 3 שוטים:
{
  "hook": "טעות אחת בהסכם הגירושין עלולה לעלות לך בכל הרכוש.",
  "shots": [
    {"visual": "עורך דין יושב מול זוג בפגישת ייעוץ, מסמכים על השולחן", "voice": "טעות אחת בהסכם הגירושין עלולה לעלות לך בכל הרכוש."},
    {"visual": "אצבע מצביעת על סעיף בחוזה, תוך כדי הסבר", "voice": "אנחנו בודקים כל סעיף לפני שאתם חותמים — כדי שתצאו עם מה שמגיע לכם."},
    {"visual": "לחיצת יד בסיום פגישה, פנים רגועות", "voice": "קבעו פגישת ייעוץ ראשונה ללא עלות."}
  ],
  "caption": "לא חותמים לפני שיודעים. ייעוץ ראשון ללא עלות. #עורךדין #גירושין #זכויותיך",
  "cta": "קבעו פגישה עכשיו — ייעוץ ראשון ללא עלות."
}`,
  beauty: `
דוגמה — קוסמטיקאית טיפולי פנים, 3 שוטים:
{
  "hook": "העור שלך מדבר — אנחנו פשוט יודעים להקשיב.",
  "shots": [
    {"visual": "לקוחה שוכבת עם מסיכת פנים, אורות רכים, אווירה שקטה", "voice": "העור שלך מדבר — אנחנו פשוט יודעים להקשיב."},
    {"visual": "ידיים מורחות סרום על עור הפנים בתנועות עדינות", "voice": "כל טיפול מותאם אישית לפי מה שהעור שלך צריך — לא מה שאחרות עשו."},
    {"visual": "לפני ואחרי — עור זוהר, מחויך, מרוצה", "voice": "קבעי עכשיו ותרגישי את ההבדל כבר בטיפול הראשון."}
  ],
  "caption": "עור שמח מתחיל בטיפול אחד. קבעי עוד היום 💆‍♀️ #קוסמטיקאית #טיפולפנים #יופי",
  "cta": "קבעי טיפול ראשון עכשיו."
}`,
  services: `
דוגמה — חשמלאי מוסמך 24/7, 3 שוטים:
{
  "hook": "תקלת חשמל בלילה? אנחנו מגיעים תוך שעה.",
  "shots": [
    {"visual": "טכנאי עם כלים בידיים עומד מול לוח חשמל, לילה ברקע", "voice": "תקלת חשמל בלילה? אנחנו מגיעים תוך שעה."},
    {"visual": "חשמלאי בודק חיווט, עובד בצורה מסודרת ומקצועית", "voice": "מוסמכים, מבוטחים, ועם ניסיון של מעל 15 שנה."},
    {"visual": "לקוח מקבל חשבונית ולוחץ יד עם טכנאי, פנים מרוצות", "voice": "חייגו עכשיו לתיקון מהיר ובמחיר שקוף."}
  ],
  "caption": "זמינים 24/7, מגיעים תוך שעה. ☎️ #חשמלאי #שירותחירום #תיקוןחשמל",
  "cta": "חייגו עכשיו — מגיעים תוך שעה."
}`,
  design: `
דוגמה — אדריכל עיצוב דירות, 3 שוטים:
{
  "hook": "דירה של 70 מטר שנראתה צפופה — עכשיו נראית כמו פנטהאוז.",
  "shots": [
    {"visual": "לפני: חדר מחולק וצפוף. אחרי: מרחב פתוח ומואר", "voice": "דירה של 70 מטר שנראתה צפופה — עכשיו נראית כמו פנטהאוז."},
    {"visual": "אדריכל יושב מול לקוח עם תוכנית קומה על המסך", "voice": "אנחנו לא מעצבים בשבילנו — אנחנו מעצבים את החיים שאתם רוצים לחיות."},
    {"visual": "תוצאה סופית: חדר מעוצב, אסתטי, עם תאורה טבעית", "voice": "צרו קשר לשיחת ייעוץ ראשונה ללא עלות."}
  ],
  "caption": "הפוטנציאל של הדירה שלך ממתין. 🏡 #אדריכלות #עיצובפנים #שיפוץ",
  "cta": "קבעו שיחת ייעוץ ראשונה — ללא עלות."
}`,
  retail: `
דוגמה — חנות ביגוד, 3 שוטים:
{
  "hook": "הפריט הזה נגמר פעמיים השבוע — הגענו שוב בשבילך.",
  "shots": [
    {"visual": "שלט 'נגמר במלאי' בחנות, ואז קופסאות חדשות מגיעות", "voice": "הפריט הזה נגמר פעמיים השבוע — הגענו שוב בשבילך."},
    {"visual": "לקוחה מנסה בגד חדש, מסתכלת במראה בהנאה", "voice": "קולקציה חדשה נחתה — מידות מלאות, סטייל שלא מתפשר."},
    {"visual": "שקית קניות יוצאת מהחנות, לקוחה מחייכת", "voice": "הגיעו היום — המבצע לא יחכה."}
  ],
  "caption": "קולקציה חדשה, מידות מלאות, מחירים שמפתיעים. 🛍️ #אופנה #ביגוד #חנות",
  "cta": "הגיעו עוד היום — כמויות מוגבלות."
}`,
  generic: `
דוגמה — שירות מקצועי, 3 שוטים:
{
  "hook": "רוב האנשים לא יודעים שיש דרך פשוטה יותר לעשות את זה.",
  "shots": [
    {"visual": "מומחה עובד עם לקוח, שיחה מקצועית", "voice": "רוב האנשים לא יודעים שיש דרך פשוטה יותר לעשות את זה."},
    {"visual": "תוצאה ברורה: לפני מול אחרי", "voice": "אנחנו לוקחים על עצמנו את כל הכאב ראש — ואתם נהנים מהתוצאה."},
    {"visual": "לקוח מרוצה, בסביבת השירות", "voice": "פנו אלינו היום לפגישת ייעוץ ראשונה."}
  ],
  "caption": "מקצועי, אמין, מביא תוצאות. #שירות #מקצועי",
  "cta": "פנו אלינו עכשיו."
}`,
};

// ─── Structure labels (Hebrew) ────────────────────────────────────────────────

const STRUCTURE_LABELS: Record<string, string> = {
  hook:        "פתיחה",
  pain:        "כאב / בעיה",
  context:     "הקשר",
  explanation: "הסבר",
  solution:    "פתרון",
  proof:       "הוכחה",
  result:      "תוצאה",
  offer:       "הצעה",
  trust:       "אמון",
  value:       "ערך",
  cta:         "קריאה לפעולה",
};

function formatStructure(parts: string[]): string {
  return parts
    .map((p, i) => `  ${i + 1}. ${STRUCTURE_LABELS[p] ?? p}`)
    .join("\n");
}

// ─── Compact prompt builder ────────────────────────────────────────────────────

export function buildCompactPrompt(
  blueprint: CreativeBlueprint,
  context: LLMPromptContext,
  plan: LLMPromptPlan,
  withFewShot = false
): LLMPrompt {
  const bucket = detectDomainBucket(context);

  const system = `אתה מנהל קריאייטיב AI. כתוב תסריט ל${context.businessLabel} על ${context.mainOfferLabel} עבור ${context.audienceLabel}. פלט JSON בלבד — ללא markdown, ללא הסברים.`;

  const anchorLines: string[] = [
    `# נושא הסרטון`,
    `הסרטון הוא על: ${context.mainOfferLabel} של ${context.businessLabel}`,
    `קהל היעד: ${context.audienceLabel}`,
    `הסרטון פונה אל הלקוחות — לא אל בעל העסק.`,
  ];
  if (context.contentGoalPrompt) {
    anchorLines.push(`דרישה חובה: ${context.contentGoalPrompt}`);
  }
  if (context.directionTitle) {
    anchorLines.push(`כיוון: ${context.directionTitle}`);
    if (context.directionDescription) {
      anchorLines.push(`פירוט: ${context.directionDescription}`);
    }
  }

  const instructionLines = [
    `# הוראות קריאייטיב`,
    `storytelling: ${blueprint.storytelling_model} | טון: ${blueprint.narration_tone} | CTA: ${blueprint.cta_psychology} | פתיחה: ${blueprint.interruption_style}`,
  ];

  const structureLines = [
    `# מבנה — ${plan.structure.length} שוטים בדיוק`,
    formatStructure(plan.structure),
  ];

  const rulesLines = [
    `# חוקים`,
    `- כל hook, שוט ו-CTA חייבים להתייחס ישירות ל: ${context.mainOfferLabel}`,
    `- פונה לקהל: ${context.audienceLabel} — לא לבעל העסק`,
    `- הכל בעברית`,
    `- אסור תוכן גנרי על שיווק/צמיחה עסקית אלא אם זה תחום העסק`,
  ];

  const schemaLines = [
    `# פורמט JSON`,
    `{
  "hook": "...",
  "shots": [
    {"visual": "...", "voice": "..."}
  ],
  "caption": "...",
  "cta": "..."
}`,
  ];

  const parts: string[] = [
    anchorLines.join("\n"),
    instructionLines.join("\n"),
    structureLines.join("\n"),
    rulesLines.join("\n"),
  ];

  if (withFewShot) {
    parts.push(`# דוגמה לסגנון הפלט הנדרש\n${FEW_SHOT_EXAMPLES[bucket].trim()}`);
  }

  parts.push(schemaLines.join("\n"));

  return {
    system,
    user: parts.join("\n\n"),
  };
}
