type Input = {
  goal: "leads" | "exposure" | "trust" | "sales";
  intent: "watch" | "follow" | "message" | "sale";
  selectedFormat: "reel" | "video" | "image" | "post";
  selectedPlatform?: "tiktok" | "instagram" | "facebook";
  businessCategory?: string;
};

export type PlatformIntelligence = {
  platform: "tiktok" | "instagram" | "facebook";
  distributionGoal: "retention" | "shares" | "comments" | "saves";

  hookRules: string[];
  structureRules: string[];
  visualRules: string[];
  ctaRules: string[];
  doNotDo: string[];
};

function getFallbackPlatform(
  input: Pick<Input, "goal" | "intent">
): "tiktok" | "instagram" | "facebook" {
  if (input.goal === "exposure" || input.intent === "watch") {
    return "tiktok";
  }

  if (input.goal === "sales" || input.goal === "leads") {
    return "instagram";
  }

  return "facebook";
}

function buildTikTokRules(
  selectedFormat: Input["selectedFormat"]
): PlatformIntelligence {
  const isShort = selectedFormat === "reel" || selectedFormat === "video";

  return {
    platform: "tiktok",
    distributionGoal: "retention",

    hookRules: [
      "חייב לעצור גלילה תוך שניה אחת",
      "להתחיל בויזואל חזק לפני דיבור",
      "אסור פתיחה רגועה",
    ],

    structureRules: isShort
      ? ["מקסימום 5 שוטים", "קצב מהיר מאוד", "שינוי כל 1–2 שניות"]
      : ["מסר קצר מאוד", "שורה ראשונה חדה", "בלי הקדמות מיותרות"],

    visualRules: [
      "קלוזאפ",
      "תנועה טבעית",
      "לא פרסומי מדי",
      "handheld ולא מושלם",
    ],

    ctaRules: ["CTA לא אגרסיבי", "CTA מרגיש טבעי בתוך התוכן"],

    doNotDo: ["פתיחה איטית", "הסברים ארוכים", "ניסוחים פרסומיים כבדים"],
  };
}

function buildInstagramRules(
  selectedFormat: Input["selectedFormat"]
): PlatformIntelligence {
  const isTextual = selectedFormat === "image" || selectedFormat === "post";

  return {
    platform: "instagram",
    distributionGoal: isTextual ? "saves" : "comments",

    hookRules: [
      "תוך 2 שניות ברור מה יוצא לצופה מזה",
      "פתיחה עם תוצאה או כאב ברור",
    ],

    structureRules: isTextual
      ? ["מסר אחד ברור בלבד", "ערך ברור או takeaway", "קל לשמור ולחזור אליו"]
      : ["hook → value → CTA", "מסר אחד ברור בלבד"],

    visualRules: [
      "נקי אבל לא פרסומי מדי",
      "נראה אורגני",
      "אסתטי יותר מטיקטוק",
    ],

    ctaRules: ["שלחו הודעה", "שמרו את זה", "עקבו לעוד"],

    doNotDo: ["עומס מידע", "יותר מדי מסרים"],
  };
}

function buildFacebookRules(
  selectedFormat: Input["selectedFormat"]
): PlatformIntelligence {
  const isTextual = selectedFormat === "image" || selectedFormat === "post";

  return {
    platform: "facebook",
    distributionGoal: "shares",

    hookRules: ["ליצור רגש או הזדהות", "משהו ששווה לשלוח לחבר"],

    structureRules: isTextual
      ? ["יותר סיפור ופחות punch", "לבנות חיבור רגשי ברור", "לתת מסר נגיש מאוד"]
      : ["יותר סיפור פחות קצב", "לבנות חיבור רגשי"],

    visualRules: ["ברור ונגיש", "פחות אגרסיבי"],

    ctaRules: ["שלח למישהו", "שתף"],

    doNotDo: ["להיראות טרנדי מדי", "להיראות כמו טיקטוק"],
  };
}

export function runPlatformIntelligence(input: Input): PlatformIntelligence {
  const platform =
    input.selectedPlatform || getFallbackPlatform(input);

  if (platform === "tiktok") {
    return buildTikTokRules(input.selectedFormat);
  }

  if (platform === "instagram") {
    return buildInstagramRules(input.selectedFormat);
  }

  return buildFacebookRules(input.selectedFormat);
}