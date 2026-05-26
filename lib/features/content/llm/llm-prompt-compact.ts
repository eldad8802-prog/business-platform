import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { LLMPromptContext, LLMPromptPlan, LLMPrompt } from "./llm-prompt-builder";
// StoryPremise type is on LLMPromptContext — imported via context.storyPremise, no direct import needed

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
  "hook": "יש דרך פשוטה יותר לסגור את זה — ורוב הסיכויים שעוד לא ניסיתם אותה.",
  "shots": [
    {"visual": "מומחה עובד עם לקוח, שיחה מקצועית", "voice": "בלי בלגן ובלי סיבוכים — מסדרים לכם את זה צעד אחר צעד."},
    {"visual": "תוצאה ברורה: לפני מול אחרי", "voice": "מה שנראה בלתי אפשרי — הופך לברור ברגע שמישהו שמבין נכנס לתמונה."},
    {"visual": "לקוח מרוצה, בסביבת השירות", "voice": "תשלחו הודעה — נדבר ונראה אם זה בכלל בשבילכם."}
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

  const system = `אתה כותב תוכן לרילים — אמירה חדה וקצב מדובר, לא דף נחיתה ולא מודעה.
ה-hook צריך לעצור גלילה: טענה, מתח, או שבירת תפיסה — לא "רוצים X בלי Y?" כמו באנר.
אתה מקבל חומר רקע פנימי; אסור לצטט אותו מילה במילה. פלט JSON בלבד — ללא markdown, ללא הסברים.`;

  const anchorLines: string[] = [
    `# נושא וקהל`,
    `הסרטון הוא על: ${context.mainOfferLabel} של ${context.businessLabel}`,
    `קהל היעד: ${context.audienceLabel}`,
    `הסרטון פונה אל הלקוחות — לא אל בעל העסק.`,
  ];

  const briefingLines: string[] = [];
  if (context.contentGoalPrompt) {
    briefingLines.push(
      `## רקע מבעל העסק (הבנה בלבד — לא להעתיק)\n${context.contentGoalPrompt}`
    );
  }
  if (context.directionTitle || context.directionDescription || context.directionWhyItFits) {
    const d: string[] = ["## כיוון (רקע — לא לציטוט)"];
    if (context.directionTitle) d.push(`כותרת: ${context.directionTitle}`);
    if (context.directionDescription) d.push(`תיאור: ${context.directionDescription}`);
    if (context.directionWhyItFits) d.push(`התאמה: ${context.directionWhyItFits}`);
    briefingLines.push(d.join("\n"));
  }
  if (context.archetypeBehaviorBrief) {
    briefingLines.push(context.archetypeBehaviorBrief.trim());
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
    `- hook: טענה או מתח — לא פתיח שמסביר את המוצר; לא שפת הצעה מדף נחיתה`,
    `- voice: משפטים קצרים, נקודה אחת לשוט; לא סיסמאות ("הפתרון המושלם", "גלו איך", "הורד עכשיו")`,
    `- מיישם interruption_style: ${blueprint.interruption_style} — הפרעה, לא נימוס שיווקי`,
    `- אסור תוכן גנרי על שיווק/צמיחה עסקית אלא אם זה תחום העסק`,
    `- אסור לצטט את חומר הרקע הפנימי; נסח מחדש בשפה של צופה`,
    `- אסור מטא-שיח ("בחרתם", "רציתם להבהיר", "הכיוון שבחרתם")`,
    `- אסור "רוב האנשים", "אם גם אתם", "יש דרך", "זה ההבדל"`,
    `- לא clickbait מוגזם — עדיין חד ואנושי`,
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

  const parts: string[] = [anchorLines.join("\n")];
  if (briefingLines.length) {
    parts.push(
      `# חומר רקע פנימי — לא להעתיק למלל הסרטון\n${briefingLines.join("\n\n")}`
    );
  }
  if (context.humanInsight) {
    const hi = context.humanInsight;
    parts.push(
      `# שכבת תובנה אנושית — לא לציטוט — לחשיבה בלבד
מצב אנושי: ${hi.humanSituation}
פרשנות רגשית: ${hi.emotionalInterpretation}
אמת נסתרת: ${hi.hiddenTruth}
מתח: ${hi.tension}
הזדמנות נרטיבית: ${hi.narrativeOpportunity}
מה הצופה אמור להרגיש: ${hi.viewerFeeling}
פיצוי רגשי: ${hi.payoff}
נתיב קריאייטיב: ${hi.creativeRoute}
תקשורת ישראלית: ${hi.israeliCommunicationDirection}`
    );
  }
  if (context.storyPremise) {
    const sp = context.storyPremise;
    parts.push(
      `# הסיפור שאתה מספר — לא לציטוט ישיר — כתוב shots שמגשימים אותו, לא שמסבירים אותו
---
רגע פתיחה: ${sp.openingMoment}
דמות: ${sp.protagonist}
ליבת הרגש: ${sp.emotionalCore}
קונפליקט: ${sp.conflict}
הסלמה: ${sp.escalation}
נקודת מפנה: ${sp.turningPoint}
payoff: ${sp.emotionalPayoff}
משמעות שיווקית: ${sp.marketingMeaning}

התקדמות הסצנות — השתמש בהן כ-creative anchor לכל shot במבנה:
${sp.sceneProgression.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    );
  }
  parts.push(
    instructionLines.join("\n"),
    structureLines.join("\n"),
    rulesLines.join("\n")
  );

  if (withFewShot) {
    parts.push(`# דוגמה לסגנון הפלט הנדרש\n${FEW_SHOT_EXAMPLES[bucket].trim()}`);
  }

  parts.push(schemaLines.join("\n"));

  return {
    system,
    user: parts.join("\n\n"),
  };
}
