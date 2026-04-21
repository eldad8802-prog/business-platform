import type { GoalType } from "./interpretation.service";

type LocalizationInput = {
  selectedFormat?: "reel" | "video" | "image" | "post";
  goal: GoalType;
  variantId: "desire" | "trust" | "result";
};

export type LocalizationRules = {
  preferredTone: string;
  bannedPhrases: string[];
  antiGenericRules: string[];
  shortSentenceRules: string[];
};

const BANNED_PHRASES = [
  "רוב האנשים",
  "יש דרך",
  "אם גם אתה",
  "העסק שלך",
  "הגיע הזמן",
  "אנו מציעים",
  "לקוחות רבים",
  "באמצעות",
  "פתרון מושלם",
  "מהפכני",
];

export function getLocalizationRules(
  input: LocalizationInput
): LocalizationRules {
  const isVisual =
    input.selectedFormat === "reel" || input.selectedFormat === "video";

  let preferredTone = "עברית ישראלית חיה, פשוטה, ישירה ולא מתאמצת";

  if (input.variantId === "trust" || input.goal === "trust") {
    preferredTone =
      "עברית ישראלית מקצועית, רגועה, בטוחה ולא פלצנית או מכירתית מדי";
  } else if (input.variantId === "result" || input.goal === "sales") {
    preferredTone =
      "עברית ישראלית חדה, ברורה, ישירה לפעולה, בלי סיבובים ובלי קשקושים";
  } else if (isVisual) {
    preferredTone =
      "עברית ישראלית קצרה, קליטה, שוברות גלילה, עם אנרגיה טבעית";
  }

  return {
    preferredTone,
    bannedPhrases: BANNED_PHRASES,
    antiGenericRules: [
      "לא להישמע כמו מודעת פרסום ישנה",
      "לא להשתמש במילים גבוהות כשאפשר לומר פשוט",
      "לא לבנות משפטים ארוכים מדי",
      "לא לכתוב משהו שנשמע כמו AI",
      "לא להסביר יותר מדי אם אפשר להראות",
    ],
    shortSentenceRules: [
      "משפטים קצרים",
      "שורה אחת = רעיון אחד",
      "פתיחה חדה מאוד",
      "עדיף פעולות ברורות על ניסוחים עמומים",
    ],
  };
}

export function applyLocalizationPostProcessing(text: string): string {
  if (!text) return text;

  return text
    .replace(/לקוחות רבים/g, "הרבה אנשים")
    .replace(/אנו מציעים/g, "יש לנו")
    .replace(/באמצעות/g, "עם")
    .replace(/פתרון מושלם/g, "פתרון חזק")
    .replace(/העסק שלך/g, "העסק")
    .replace(/אם גם אתה/g, "אם זה מוכר לך")
    .trim();
}