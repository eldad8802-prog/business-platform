/**
 * The Hebrew notices a Google round trip can come back with (`?google=<reason>` on /login and /register).
 * Shared by the server pages (which validate the reason) and the client components (which show it).
 * Hebrew only (owner decision, 22.10.2026).
 */
export const GOOGLE_NOTICES: Record<string, string> = {
  cancelled: "ההתחברות עם Google בוטלה. אפשר לנסות שוב או להמשיך עם אימייל וסיסמה.",
  existing: "כבר קיים בדוביז חשבון עם הכתובת הזו, והוא עדיין לא מקושר ל־Google. יש להתחבר עם האימייל והסיסמה.",
  admin: "חשבון ניהול מתחבר רק עם אימייל, סיסמה ואימות נוסף.",
  unavailable: "לא ניתן להתחבר לחשבון הזה כרגע.",
  closed: "ההרשמה לדוביז סגורה כרגע, ולכן לא ניתן לפתוח חשבון חדש עם Google. משתמשים קיימים יכולים להתחבר כרגיל.",
  expired: "פג תוקף הבקשה להתחברות עם Google. אפשר להתחיל שוב.",
  error: "ההתחברות עם Google לא הצליחה. אפשר לנסות שוב.",
  busy: "יותר מדי ניסיונות. כדאי לנסות שוב בעוד כמה דקות.",
};

/** A known reason, or null (an unknown value is never echoed into the page). */
export function googleNoticeFor(value: string | string[] | undefined): string | null {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GOOGLE_NOTICES, value) ? value : null;
}
