type TasteInput = {
  goal: "leads" | "exposure" | "trust" | "sales";
  intent: "watch" | "follow" | "message" | "sale";
  businessCategory: string;
  pattern:
    | "PATTERN_BREAK"
    | "WAIT_FOR_IT"
    | "BEFORE_AFTER"
    | "POV"
    | "MISTAKE"
    | "SECRET"
    | "PROCESS"
    | "RESULT"
    | "REACTION";
};

export type ContentTaste = {
  tone:
    | "bold"
    | "premium"
    | "clean"
    | "direct"
    | "emotional"
    | "street"
    | "professional";
  energy: "low" | "medium" | "high";
  pace: "slow" | "normal" | "fast";
  style: "raw" | "polished" | "cinematic" | "social_native";
  flavorWords: string[];
  antiGenericRules: string[];
};

function isFoodBusiness(category: string) {
  const value = category.toLowerCase();

  return (
    value.includes("food") ||
    value.includes("restaurant") ||
    value.includes("אוכל") ||
    value.includes("מסעדה") ||
    value.includes("מטבח") ||
    value.includes("מזון")
  );
}

export function buildContentTaste(input: TasteInput): ContentTaste {
  const food = isFoodBusiness(input.businessCategory);

  if (food && input.goal === "exposure") {
    return {
      tone: "bold",
      energy: "high",
      pace: "fast",
      style: "social_native",
      flavorWords: ["מגרה", "חד", "עסיסי", "קרוב", "שובר גלילה", "חי"],
      antiGenericRules: [
        "אסור פתיחות חלשות",
        "אסור הסברים ארוכים",
        "אסור ניסוחים תבניתיים",
        "חייבים רגע ויזואלי ברור",
      ],
    };
  }

  if (input.goal === "trust") {
    return {
      tone: "professional",
      energy: "medium",
      pace: "normal",
      style: "polished",
      flavorWords: ["מדויק", "אמין", "נקי", "ברור", "מקצועי", "בטוח"],
      antiGenericRules: [
        "אסור להישמע מכירתי מדי",
        "אסור דרמה מזויפת",
        "אסור הבטחות חלולות",
        "חייבים הוכחה אמיתית או תהליך",
      ],
    };
  }

  if (input.goal === "sales") {
    return {
      tone: "direct",
      energy: "high",
      pace: "fast",
      style: "social_native",
      flavorWords: ["חד", "ברור", "ישיר", "ממיר", "פעולה", "תוצאה"],
      antiGenericRules: [
        "אסור לפתוח לאט",
        "אסור ללכת סחור סחור",
        "אסור CTA חלש",
        "חייבים להראות תוצאה או שימוש אמיתי",
      ],
    };
  }

  if (input.goal === "leads") {
    return {
      tone: "direct",
      energy: "high",
      pace: "fast",
      style: "social_native",
      flavorWords: ["מושך", "נגיש", "ברור", "מיידי", "חי", "מזיז"],
      antiGenericRules: [
        "אסור להישמע רחוק או כבד",
        "אסור לפתוח חלש",
        "חייבים להוביל לפעולה פשוטה",
        "חייב להיות ברור למה לפנות עכשיו",
      ],
    };
  }

  return {
    tone: "clean",
    energy: "medium",
    pace: "normal",
    style: "social_native",
    flavorWords: ["קל", "נעים", "ברור", "חי"],
    antiGenericRules: [
      "אסור גנרי",
      "אסור פתיחות חלשות",
      "חייבים לדבר פשוט וברור",
    ],
  };
}