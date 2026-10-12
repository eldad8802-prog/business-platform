/**
 * The words every identity screen shows — login, signup, email verification and password reset — in
 * one place, in Hebrew. Routes answer with `{ error, code }`: `error` is what the person reads (the
 * clients render it as is), `code` is what a client branches on. Nothing here names whether an address
 * has an account.
 */

export const AUTH_MESSAGES_HE = {
  rateLimited: "יותר מדי ניסיונות. כדאי לחכות כמה דקות ולנסות שוב.",
  missingCredentials: "יש להזין אימייל וסיסמה",
  invalidCredentials: "האימייל או הסיסמה שגויים",
  invalidBody: "הבקשה לא התקבלה. כדאי לרענן את הדף ולנסות שוב.",
  serverError: "משהו השתבש אצלנו. כדאי לנסות שוב בעוד רגע.",
  serviceUnavailable: "השירות לא זמין כרגע. כדאי לנסות שוב מאוחר יותר.",
  signupRejected: "לא הצלחנו לפתוח את החשבון. כדאי לרענן את הדף ולנסות שוב.",
  /** The one answer to every forgot-password request, whether or not the address has an account. */
  resetRequested: "אם הכתובת רשומה אצלנו, שלחנו אליה קישור לבחירת סיסמה חדשה. הקישור בתוקף לשעה.",
  resetDone: "הסיסמה עודכנה. מעכשיו נכנסים עם הסיסמה החדשה.",
  tokenInvalid: "הקישור לא תקין. כדאי לבקש קישור חדש.",
  tokenExpired: "תוקף הקישור פג. כדאי לבקש קישור חדש.",
  tokenUsed: "כבר השתמשו בקישור הזה. כדאי לבקש קישור חדש אם צריך.",
  tokenSuperseded: "נשלח קישור חדש יותר. כדאי להשתמש בקישור האחרון שקיבלתם.",
  emailVerified: "כתובת האימייל אומתה. תודה!",
  verificationSent: "שלחנו קישור אימות לכתובת האימייל שלכם.",
  alreadyVerified: "כתובת האימייל כבר מאומתת.",
  featureUnavailable: "האפשרות הזו עדיין לא זמינה.",
  /** After the third failed sign-in for an address — the owner-approved wording, verbatim. */
  loginLastAttemptWarning: "שים לב, נותר לך ניסיון התחברות אחד לפני חסימה זמנית ל־15 דקות.",
} as const;

/**
 * The temporary sign-in lock, with the time left. Worded about the ADDRESS that was typed, never about
 * an account, and given identically whether or not that address has one.
 */
export function loginLockedMessage(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  const left = minutes === 1 ? "דקה אחת" : `${minutes} דקות`;
  return `מטעמי אבטחה, הכניסה עם כתובת האימייל הזו נחסמה זמנית אחרי כמה ניסיונות שגויים. אפשר לנסות שוב בעוד ${left}.`;
}

/** What a link check / consume answers, as the database functions name it. */
export type EmailTokenStatus = "VALID" | "INVALID" | "EXPIRED" | "USED" | "SUPERSEDED";

/** Client-facing code + Hebrew message for a link that cannot be used. */
export function emailTokenProblem(status: Exclude<EmailTokenStatus, "VALID">): { code: string; error: string } {
  switch (status) {
    case "EXPIRED":
      return { code: "TOKEN_EXPIRED", error: AUTH_MESSAGES_HE.tokenExpired };
    case "USED":
      return { code: "TOKEN_USED", error: AUTH_MESSAGES_HE.tokenUsed };
    case "SUPERSEDED":
      return { code: "TOKEN_SUPERSEDED", error: AUTH_MESSAGES_HE.tokenSuperseded };
    default:
      return { code: "TOKEN_INVALID", error: AUTH_MESSAGES_HE.tokenInvalid };
  }
}
