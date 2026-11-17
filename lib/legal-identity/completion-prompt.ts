/**
 * The completion prompt for an EXISTING business (runbook §5, step 1): pure rules, no I/O.
 * Shown only while the completion is enabled (LEGAL_IDENTITY_COMPLETION_ENABLED) and the business is not confirmed.
 * Never blocks anything: dismissible, and the business keeps working without confirming.
 */

export type CompletionResult =
  | "CONFIRMED"
  | "ALREADY_CONFIRMED"
  | "INCOMPLETE"
  | "INVALID_TAX_ID"
  | "LEGAL_NAME_TOO_LONG"
  | "NOT_ALLOWED";

export function shouldOfferCompletion(s: { enabled: boolean; locked: boolean; dismissed: boolean }): boolean {
  return s.enabled && !s.locked && !s.dismissed;
}

/** What the business is told after "אישור הפרטים". `done` = the details are now confirmed and locked. */
export function completionOutcome(result: unknown): { done: boolean; message: string } {
  switch (result) {
    case "CONFIRMED":
    case "ALREADY_CONFIRMED":
      return { done: true, message: "פרטי העסק החוקיים אושרו. מעכשיו הם נעולים לשינוי, ותיקון ייעשה דרך בקשה מסודרת." };
    case "INCOMPLETE":
      return { done: false, message: "חסרים פרטים: יש למלא סוג עסק, שם חוקי ומספר עוסק / ח״פ, לשמור, ואז לאשר." };
    case "INVALID_TAX_ID":
      return { done: false, message: "המספר שנשמר אינו תקין (ספרת ביקורת). יש לתקן אותו בטופס, לשמור, ואז לאשר." };
    case "LEGAL_NAME_TOO_LONG":
      return { done: false, message: "השם החוקי ארוך מדי. יש לקצר אותו בטופס, לשמור, ואז לאשר." };
    case "NOT_ALLOWED":
      return { done: false, message: "רק בעל העסק יכול לאשר את הפרטים החוקיים." };
    default:
      return { done: false, message: "האישור לא הושלם. אפשר לנסות שוב מאוחר יותר; העסק ממשיך לעבוד כרגיל." };
  }
}

export const COMPLETION_DISMISS_KEY = "legalIdentityCompletionDismissed";
