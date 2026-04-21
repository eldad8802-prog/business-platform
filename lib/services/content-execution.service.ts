// lib/services/content-execution.service.ts

type ContentType =
  | "lead_generation"
  | "trust_building"
  | "promotion"
  | "education";

type ExecutionResult = {
  hook: string;
  idea: string;
  structure: string[];
};

export function generateContent(type: ContentType): ExecutionResult {
  switch (type) {
    case "lead_generation":
      return {
        hook: "נמאס לך לבזבז זמן ולא לקבל פניות?",
        idea: "פוסט שמציג בעיה נפוצה ומציע פתרון פשוט",
        structure: [
          "שאלה/כאב של הלקוח",
          "הסבר קצר למה זה קורה",
          "הצגת פתרון",
          "קריאה לפעולה (שלח הודעה / השאר פרטים)",
        ],
      };

    case "trust_building":
      return {
        hook: "לקוח אמיתי, תוצאה אמיתית 👇",
        idea: "שיתוף סיפור לקוח או הצלחה",
        structure: [
          "מי הלקוח ומה הבעיה",
          "מה עשית עבורו",
          "התוצאה",
          "למה לבחור בך",
        ],
      };

    case "promotion":
      return {
        hook: "מבצע מוגבל לזמן קצר!",
        idea: "הצגת הצעה עם דחיפות",
        structure: [
          "מה ההצעה",
          "למי זה מתאים",
          "למה עכשיו",
          "קריאה לפעולה",
        ],
      };

    case "education":
      return {
        hook: "3 דברים שאתה חייב לדעת לפני שאתה בוחר...",
        idea: "תוכן שנותן ערך ומלמד",
        structure: [
          "טיפ 1",
          "טיפ 2",
          "טיפ 3",
          "סיכום + חיזוק סמכות",
        ],
      };

    default:
      return {
        hook: "בוא נדבר על משהו חשוב",
        idea: "תוכן כללי",
        structure: ["פתיחה", "אמצע", "סיום"],
      };
  }
}