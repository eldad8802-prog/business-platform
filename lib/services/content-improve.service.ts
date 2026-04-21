type ImproveInput = {
  mode: string;
  goal: string;
  intent: string;
  audienceDescription?: string;
  selectedFormat?: string;
  script: string;
  instructions: string[];
  userPrompt: string;
};

type ImproveResult = {
  message: string;
  updatedScript?: string;
  updatedInstructions?: string[];
};

export async function improveContent(
  input: ImproveInput
): Promise<ImproveResult> {
  const {
    script,
    instructions,
    userPrompt,
  } = input;

  // v1 — לוגיקה פשוטה (אפשר להחליף ל-AI בהמשך)
  const normalizedPrompt = userPrompt.toLowerCase();

  // שיפור פתיחה
  if (normalizedPrompt.includes("פתיחה")) {
    const improvedScript = `🔥 ${script}`;

    return {
      message:
        "שיפרתי לך את הפתיחה כדי שתהיה יותר מושכת ותמשוך תשומת לב כבר בשנייה הראשונה.",
      updatedScript: improvedScript,
    };
  }

  // שיפור ניסוח כללי
  if (normalizedPrompt.includes("ניסוח") || normalizedPrompt.includes("יותר טוב")) {
    const improvedScript = script + "\n\n👉 תזכור לדבר ברור, קצר וישיר מול הלקוח.";

    return {
      message:
        "חידדתי את הניסוח כדי שיהיה ברור יותר ומכוון לפעולה.",
      updatedScript: improvedScript,
    };
  }

  // שיפור הוראות צילום
  if (normalizedPrompt.includes("לצלם") || normalizedPrompt.includes("איך לצלם")) {
    const updatedInstructions = [
      ...instructions,
      "צלם באור טבעי או תאורה חזקה",
      "החזק את המצלמה יציבה",
      "דבר בקצב רגוע וברור",
    ];

    return {
      message:
        "הוספתי לך הנחיות צילום שיעזרו לך להוציא תוצאה הרבה יותר מקצועית.",
      updatedInstructions,
    };
  }

  // fallback
  return {
    message:
      "כדי לדייק אותך יותר, נסה להיות ספציפי יותר (למשל: שפר פתיחה, ניסוח, או איך לצלם).",
  };
}