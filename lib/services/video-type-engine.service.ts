export type VideoType =
  | "lead"
  | "offer"
  | "trust"
  | "education"
  | "before_after";

type Goal = "leads" | "trust" | "exposure" | "sales";
type Intent = "message" | "follow" | "watch" | "sale";

export type VideoTypeResult = {
  type: VideoType;
  label: string;
  description: string;
};

export function runVideoTypeEngine(input: {
  goal: Goal;
  intent: Intent;
}) : VideoTypeResult {
  const { goal, intent } = input;

  // 🔥 החלטה לפי מטרה
  if (goal === "leads") {
    return {
      type: "lead",
      label: "סרטון לפניות",
      description: "סרטון שמניע לשליחת הודעה או יצירת קשר",
    };
  }

  if (goal === "sales") {
    return {
      type: "offer",
      label: "סרטון מבצע",
      description: "סרטון שמדגיש הצעה או ערך כדי להוביל לסגירה",
    };
  }

  if (goal === "trust") {
    return {
      type: "trust",
      label: "סרטון אמון",
      description: "סרטון שבונה אמון ומציג מקצועיות",
    };
  }

  if (goal === "exposure") {
    return {
      type: "education",
      label: "סרטון חשיפה",
      description: "סרטון שמטרתו להגיע לכמה שיותר אנשים",
    };
  }

  // 🔁 fallback לפי intent
  if (intent === "message") {
    return {
      type: "lead",
      label: "סרטון לפניות",
      description: "סרטון שמוביל לפנייה",
    };
  }

  if (intent === "sale") {
    return {
      type: "offer",
      label: "סרטון מבצע",
      description: "סרטון שמניע לרכישה",
    };
  }

  if (intent === "watch") {
    return {
      type: "education",
      label: "סרטון חשיפה",
      description: "סרטון שמייצר צפיות",
    };
  }

  return {
    type: "education",
    label: "סרטון כללי",
    description: "סרטון מותאם למטרה כללית",
  };
}