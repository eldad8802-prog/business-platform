export type GoalType = "leads" | "trust" | "exposure" | "sales";
export type IntentType = "message" | "follow" | "watch" | "sale";

type InterpretationInput = {
  goal?: GoalType;
  goalDescription?: string;
  intent?: IntentType;
  audienceDescription?: string;
  selectedFormat?: "reel" | "video" | "image" | "post";
  creatorContext?: string;
  contentGoalPrompt?: string;

  // NEW
  audienceTypes?: string[];
  contentAngle?: string;
};

export type FunnelStage = "TOFU" | "MOFU" | "BOFU";
export type EmotionalDriver =
  | "curiosity"
  | "trust"
  | "desire"
  | "urgency"
  | "fear"
  | "proof";

export type InterpretationResult = {
  inferredGoal: GoalType;
  inferredIntent: IntentType;
  stage: FunnelStage;
  pain: string;
  desire: string;
  urgency: "low" | "medium" | "high";
  emotionalDriver: EmotionalDriver;
  audienceMindset: string;
  summary: string;
};

const HEBREW_SALES_HINTS = [
  "לקנות",
  "מכירה",
  "לרכוש",
  "לסגור",
  "הזמנה",
  "לקוחה",
  "לקוחות עכשיו",
];

const HEBREW_LEADS_HINTS = [
  "פניות",
  "לידים",
  "הודעות",
  "שישלחו הודעה",
  "שיפנו",
  "ליצור קשר",
  "לשלוח הודעה",
];

const HEBREW_TRUST_HINTS = [
  "אמון",
  "להכיר",
  "מקצועי",
  "מקצועיות",
  "ביטחון",
  "לסמוך",
  "מאחורי הקלעים",
  "תהליך",
];

const HEBREW_EXPOSURE_HINTS = [
  "חשיפה",
  "צפיות",
  "שיראו",
  "ויראלי",
  "שיעצור גלילה",
  "שיגיע ליותר",
];

const MESSAGE_HINTS = ["הודעה", "ליצור קשר", "דברו איתי", "שלחו לי"];
const FOLLOW_HINTS = ["לעקוב", "פולו", "לעוד תוכן", "עקבו"];
const SALE_HINTS = ["לקנות", "להזמין", "לסגור", "רכישה"];
const WATCH_HINTS = ["לצפות", "שיראו עד הסוף", "לעצור גלילה", "שלא ידלגו"];

function includesAny(text: string, values: string[]) {
  return values.some((value) => text.includes(value.toLowerCase()));
}

function normalizeText(input: InterpretationInput) {
  return [
    input.goalDescription || "",
    input.audienceDescription || "",
    input.creatorContext || "",
    input.contentGoalPrompt || "",
    input.contentAngle || "",
    Array.isArray(input.audienceTypes) ? input.audienceTypes.join(", ") : "",
  ]
    .join("\n")
    .trim()
    .toLowerCase();
}

function extractPain(text: string, angle: string): string {
  if (!text.trim() && !angle.trim()) {
    return "אין מספיק חדות על הכאב ולכן נעדיף מסר פשוט וברור";
  }

  if (includesAny(text, ["לא עובדים", "לא עובד", "לא מגיעים", "לא סוגרים"])) {
    return "יש קושי בתוצאה העסקית הנוכחית וצריך להראות שינוי ברור";
  }

  if (includesAny(text, ["לא מכירים", "לא יודעים", "לא סומכים"])) {
    return "הקהל עדיין לא מספיק מכיר או סומך ולכן צריך לחזק אמון";
  }

  if (includesAny(text, ["אין פניות", "מעט הודעות", "לא שולחים"])) {
    return "יש מחסור בפניות ולכן התוכן צריך לייצר תגובה מהירה";
  }

  if (includesAny(angle, ["להסביר איך זה עובד"])) {
    return "הקהל עדיין לא מבין מספיק את הערך או את הדרך שבה זה עובד";
  }

  if (includesAny(angle, ["לבנות אמון", "לבנות אמון וביטחון"])) {
    return "יש צורך להוריד התנגדות ולגרום לקהל להרגיש ביטחון";
  }

  if (includesAny(angle, ["להניע לפעולה"])) {
    return "הקהל צריך דחיפה ברורה כדי לעבור מצפייה לפעולה";
  }

  return "הכאב המרכזי הוא חוסר תשומת לב או חוסר תנועה לפעולה";
}

function extractDesire(text: string, angle: string): string {
  if (!text.trim() && !angle.trim()) {
    return "לייצר תוכן ברור וחזק שמוביל לתגובה";
  }

  if (includesAny(text, ["לקוחות", "פניות", "הודעות"])) {
    return "לייצר תנועה אמיתית של לקוחות פוטנציאליים";
  }

  if (includesAny(text, ["אמון", "מקצועי", "להכיר"])) {
    return "לגרום לקהל להרגיש ביטחון ומקצועיות";
  }

  if (includesAny(text, ["ויראלי", "חשיפה", "צפיות"])) {
    return "לתפוס תשומת לב רחבה ולעצור גלילה";
  }

  if (includesAny(text, ["מכירה", "לקנות", "להזמין"])) {
    return "לדחוף את הקהל לפעולה ברורה כאן ועכשיו";
  }

  if (includesAny(angle, ["להראות תוצאה"])) {
    return "להמחיש תוצאה ברורה שאי אפשר לפספס";
  }

  if (includesAny(angle, ["להסביר איך זה עובד"])) {
    return "לגרום לקהל להבין את הערך דרך הסבר ברור ופשוט";
  }

  if (includesAny(angle, ["להראות הבדל"])) {
    return "להמחיש למה זה שונה או טוב יותר מאחרים";
  }

  if (includesAny(angle, ["לתפוס תשומת לב"])) {
    return "ליצור עצירת גלילה וסקרנות מהירה";
  }

  if (includesAny(angle, ["לבנות אמון"])) {
    return "לחזק אמון וביטחון לפני החלטה";
  }

  if (includesAny(angle, ["להניע לפעולה"])) {
    return "להוביל את הקהל לצעד הבא בלי בלבול";
  }

  return "לגרום לאנשים להרגיש עניין ברור ולהתקדם צעד אחד קדימה";
}

function inferAudienceMindset(
  audienceDescription?: string,
  audienceTypes?: string[]
) {
  if ((audienceDescription || "").trim()) {
    return `הקהל מחפש רלוונטיות מהירה ותגובה ברורה סביב: ${audienceDescription?.trim()}`;
  }

  const types = Array.isArray(audienceTypes) ? audienceTypes : [];

  if (types.length === 0) {
    return "קהל כללי שצריך מסר פשוט, ברור ולא מתאמץ";
  }

  const map: Record<string, string> = {
    new: "קהל חדש שצריך להבין מהר למה לעצור ולמה זה רלוונטי אליו",
    interested: "קהל שכבר מתעניין וצריך עוד חיזוק כדי להתקדם",
    ready: "קהל בשל יותר שצריך דחיפה ברורה לפעולה",
    existing: "קהל שכבר מכיר וצריך חיזוק, קשר והעמקה",
    all: "קהל רחב שצריך מסר פשוט, חד ונגיש",
  };

  return types.map((type) => map[type] || type).join(" | ");
}

export function interpretContent(
  input: InterpretationInput
): InterpretationResult {
  const text = normalizeText(input);
  const angle = (input.contentAngle || "").trim().toLowerCase();

  let inferredGoal: GoalType = input.goal || "exposure";

  if (includesAny(text, HEBREW_SALES_HINTS)) {
    inferredGoal = "sales";
  } else if (includesAny(text, HEBREW_LEADS_HINTS)) {
    inferredGoal = "leads";
  } else if (includesAny(text, HEBREW_TRUST_HINTS)) {
    inferredGoal = "trust";
  } else if (includesAny(text, HEBREW_EXPOSURE_HINTS)) {
    inferredGoal = "exposure";
  }

  if (angle) {
    if (includesAny(angle, ["להראות תוצאה", "להניע לפעולה"])) {
      inferredGoal = inferredGoal === "trust" ? inferredGoal : "leads";
    }

    if (includesAny(angle, ["לבנות אמון", "לבנות אמון וביטחון"])) {
      inferredGoal = "trust";
    }

    if (includesAny(angle, ["לתפוס תשומת לב"])) {
      inferredGoal = "exposure";
    }
  }

  let inferredIntent: IntentType = input.intent || "watch";

  if (includesAny(text, MESSAGE_HINTS)) {
    inferredIntent = "message";
  } else if (includesAny(text, FOLLOW_HINTS)) {
    inferredIntent = "follow";
  } else if (includesAny(text, SALE_HINTS)) {
    inferredIntent = "sale";
  } else if (includesAny(text, WATCH_HINTS)) {
    inferredIntent = "watch";
  }

  if (angle) {
    if (includesAny(angle, ["להניע לפעולה"])) {
      inferredIntent = inferredGoal === "sales" ? "sale" : "message";
    }

    if (includesAny(angle, ["לבנות אמון", "להסביר איך זה עובד"])) {
      inferredIntent = inferredIntent === "sale" ? inferredIntent : "watch";
    }

    if (includesAny(angle, ["לתפוס תשומת לב"])) {
      inferredIntent = "watch";
    }
  }

  let stage: FunnelStage = "TOFU";

  if (inferredGoal === "sales" || inferredIntent === "sale") {
    stage = "BOFU";
  } else if (
    inferredGoal === "trust" ||
    inferredIntent === "follow" ||
    inferredGoal === "leads"
  ) {
    stage = "MOFU";
  }

  let emotionalDriver: EmotionalDriver = "curiosity";

  if (inferredGoal === "trust") {
    emotionalDriver = "trust";
  } else if (inferredGoal === "sales") {
    emotionalDriver = "urgency";
  } else if (inferredGoal === "leads") {
    emotionalDriver = "desire";
  } else if (includesAny(text, ["טעות", "נופלים", "בעיה", "הורס"])) {
    emotionalDriver = "fear";
  } else if (includesAny(text, ["הוכחה", "לפני אחרי", "תוצאה"])) {
    emotionalDriver = "proof";
  }

  if (includesAny(angle, ["להראות תוצאה"])) {
    emotionalDriver = "proof";
  }

  if (includesAny(angle, ["לתפוס תשומת לב"])) {
    emotionalDriver = "curiosity";
  }

  if (includesAny(angle, ["לבנות אמון", "לבנות אמון וביטחון"])) {
    emotionalDriver = "trust";
  }

  if (includesAny(angle, ["להניע לפעולה"])) {
    emotionalDriver = inferredGoal === "sales" ? "urgency" : "desire";
  }

  let urgency: "low" | "medium" | "high" = "medium";

  if (inferredGoal === "sales" || inferredIntent === "sale") {
    urgency = "high";
  } else if (inferredGoal === "trust" && inferredIntent === "watch") {
    urgency = "low";
  }

  if (includesAny(angle, ["להניע לפעולה"])) {
    urgency = "high";
  }

  if (includesAny(angle, ["לבנות אמון", "להסביר איך זה עובד"])) {
    urgency = "low";
  }

  const pain = extractPain(text, angle);
  const desire = extractDesire(text, angle);
  const audienceMindset = inferAudienceMindset(
    input.audienceDescription,
    input.audienceTypes
  );

  return {
    inferredGoal,
    inferredIntent,
    stage,
    pain,
    desire,
    urgency,
    emotionalDriver,
    audienceMindset,
    summary: `המטרה המשוערת היא ${inferredGoal}, הכוונה המשוערת היא ${inferredIntent}, והשלב השיווקי הוא ${stage}`,
  };
}