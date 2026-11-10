/**
 * What the owner reads when the server refuses (UI 1.3a). The server decides; the screen only explains, in the wording of
 * the approved 1.3 plan's refusal table. A code the screen should never meet (it does not offer that action) reads as the
 * plain "not available now" line instead of an internal code. Pure — no React, no fetch.
 */
import { ServiceDeskApiError } from "./service-desk-client";

export type ErrorView = {
  text: string;
  /** The screen should reload its data before the owner tries again (someone else changed it). */
  reload?: boolean;
  /** The field the refusal is about, when the server named one. */
  field?: string;
};

const REFUSAL: Record<string, string> = {
  NO_CHANGE: "לא שינית דבר מאז השמירה האחרונה.",
  INTAKE_INCOMPLETE: "כדי לקבל את המכשיר חסר: מצב המכשיר / אביזרים / חתימת הלקוח",
  STAFF_REQUIRED: "בחר טכנאי מטפל לפני תחילת האבחון",
  COVERAGE_NOT_APPROVED: "תיקון בלי הצעת מחיר אפשרי רק עם אחריות מאושרת",
  QA_INCOMPLETE: "השלם את רשימת הבדיקות לפני «עבר בדיקה»",
  REASON_REQUIRED: "ביטול כשהמכשיר אצלנו או אצל ספק דורש סיבה",
  TERMINAL_STATUS: "התיק סגור או מבוטל — אפשר רק לצפות בו.",
};

const SERVER_CHECK: Record<string, string> = {
  STAFF_BELONGS_TO_BUSINESS: "הטכנאי שבחרת כבר לא פעיל בעסק. בחר שוב מהרשימה.",
  CUSTOMER_BELONGS_TO_BUSINESS: "הלקוח שבחרת לא נמצא בעסק. בחר שוב.",
};

const GENERIC = "הפעולה לא זמינה במצב הנוכחי.";

export function errorView(e: unknown): ErrorView {
  if (!(e instanceof ServiceDeskApiError)) return { text: "משהו השתבש. נסה שוב." };
  if (e.status === null) return { text: "אין חיבור כרגע. בדוק את החיבור ונסה שוב." };
  const field = typeof e.details?.field === "string" ? (e.details.field as string) : undefined;
  switch (e.code) {
    case "VERSION_CONFLICT":
      return { text: "המידע עודכן בינתיים — רענן ונסה שוב.", reload: true };
    case "READ_ONLY":
      return { text: "מערכת השירות פתוחה אצלך לצפייה בלבד." };
    case "NOT_AVAILABLE_UNTIL_AUDIT":
      return { text: "השמירה לא זמינה כרגע. לא נשמר דבר — נסה שוב מאוחר יותר." };
    case "BUSINESS_DELETING":
      return { text: "העסק בתהליך מחיקה — אי אפשר לשמור שינויים." };
    case "IDEMPOTENCY_KEY_INVALID":
    case "IDEMPOTENCY_KEY_STALE":
    case "IDEMPOTENCY_KEY_REUSED":
      return { text: "הבקשה פגה. נסה לשמור שוב." };
    case "INVALID_INPUT":
      return { text: "אחד השדות לא תקין. בדוק ונסה שוב.", field };
    case "SERVER_CHECK_FAILED": {
      const check = typeof e.details?.check === "string" ? (e.details.check as string) : "";
      return { text: SERVER_CHECK[check] ?? GENERIC, reload: check === "STAFF_BELONGS_TO_BUSINESS" };
    }
    case "REFUSED": {
      const violations = Array.isArray(e.details?.violations) ? (e.details.violations as unknown[]).map(String) : [];
      const known = violations.map((v) => REFUSAL[v]).filter(Boolean);
      return { text: known.length > 0 ? known.join(" ") : GENERIC };
    }
    default:
      break;
  }
  if (e.status === 404) return { text: "מערכת השירות לא פתוחה לעסק." };
  if (e.status === 401) return { text: "צריך להתחבר מחדש." };
  if (e.status === 429) return { text: "יותר מדי בקשות. נסה שוב בעוד רגע." };
  if (e.status >= 500) return { text: "שגיאה בשרת. לא נשמר דבר — נסה שוב." };
  return { text: GENERIC };
}
