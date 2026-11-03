/**
 * Bank file import (B1) — the browser side of /api/payables/bank-import. CLIENT-ONLY.
 *
 * The app authenticates API calls with a Bearer token kept in localStorage (lib/client-session); there is no
 * auth cookie. Every request here carries it. The upload is multipart, so only the Authorization header is
 * added — never a Content-Type (buildClientAuthHeaders would force application/json and break the boundary).
 */
import { getClientAuthToken } from "@/lib/client-session";

export type BankImportDecision = "IMPORT" | "SKIP";

/** The Authorization header for the current session, or nothing when signed out. */
export function bankImportAuthHeaders(): Record<string, string> {
  const token = getClientAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class BankImportRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: Record<string, string | number> = {}
  ) {
    super(code || `HTTP_${status}`);
    this.name = "BankImportRequestError";
  }
}

/** True when bank file import is open for this business (the status route answers 404 while the flag is OFF). */
export async function fetchBankImportOpen(): Promise<boolean> {
  try {
    const res = await fetch("/api/payables/bank-import", { headers: bankImportAuthHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}

/** The multipart body analyze and commit take. Decisions are keyed by row number. */
export function buildBankImportForm(input: {
  file: Blob & { name?: string };
  accountId: number;
  mapping?: Record<string, number | null> | null;
  token?: string | null;
  decisions?: Record<number, BankImportDecision> | null;
  /** Commit only: the account shown on the preview that the owner confirmed. */
  confirmAccountId?: number | null;
}): FormData {
  const body = new FormData();
  body.set("file", input.file, input.file.name ?? "statement");
  body.set("accountId", String(input.accountId));
  if (input.mapping) body.set("mapping", JSON.stringify(input.mapping));
  if (input.token) body.set("token", input.token);
  if (input.decisions && Object.keys(input.decisions).length) body.set("decisions", JSON.stringify(input.decisions));
  if (typeof input.confirmAccountId === "number") body.set("confirmAccountId", String(input.confirmAccountId));
  return body;
}

/** POST analyze or commit. Resolves to the JSON body; rejects with the HTTP status and the server's error code. */
export async function postBankImport<T>(step: "analyze" | "commit", body: FormData): Promise<T> {
  const res = await fetch(`/api/payables/bank-import/${step}`, { method: "POST", body, headers: bankImportAuthHeaders() });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const details = json.details && typeof json.details === "object" && !Array.isArray(json.details) ? (json.details as Record<string, string | number>) : {};
    throw new BankImportRequestError(res.status, typeof json.error === "string" ? json.error : "", details);
  }
  return json as T;
}

/** What the file's own account number said about the chosen account (preview.account.numberCheck). */
export type BankAccountNumberCheck = "VERIFIED_FULL" | "PARTIAL_MATCH" | "NOT_IN_FILE";

/** Whether a full account comparison was possible at all (preview.account.fullVerification). */
export type BankFullVerification = "AVAILABLE" | "UNAVAILABLE";

/** Said whenever the fingerprint key is missing or malformed: never "verified" then. */
export const FULL_VERIFICATION_UNAVAILABLE_TEXT = "אימות מלא של החשבון אינו זמין כרגע.";

/**
 * The preview's sentence about the target account. Only VERIFIED_FULL — the full account (bank, branch,
 * account) printed in the file compared with the chosen one — may say "verified" (אומת), and only when full
 * verification is available. When it is not (the account-verification key is missing or malformed), the sentence
 * opens with FULL_VERIFICATION_UNAVAILABLE_TEXT and never says verified. A last-four match says plainly that the
 * account is NOT verified; a file without a number says it cannot identify the account. The owner confirms the
 * account in every case.
 */
export function accountCheckText(check: BankAccountNumberCheck, fullVerification: BankFullVerification = "AVAILABLE"): string {
  const partial = "החשבון לא אומת. רק 4 הספרות האחרונות של מספר החשבון בקובץ תואמות לחשבון הזה, וזה לא מספיק כדי לדעת שזה אותו חשבון. ודאו בעצמכם שבחרתם את החשבון הנכון.";
  const none = "הקובץ לא מאפשר לזהות את החשבון: לא מופיע בו מספר חשבון שאפשר לבדוק. ודאו בעצמכם שבחרתם את החשבון הנכון.";
  if (fullVerification === "UNAVAILABLE") {
    // Defensive: VERIFIED_FULL cannot come with an unavailable verification; it is never shown as verified anyway.
    return `${FULL_VERIFICATION_UNAVAILABLE_TEXT} ${check === "NOT_IN_FILE" ? none : partial}`;
  }
  if (check === "VERIFIED_FULL") return "החשבון אומת: מספר החשבון המלא שמופיע בקובץ (בנק, סניף וחשבון) הוא של החשבון הזה.";
  if (check === "PARTIAL_MATCH") return partial;
  return none;
}

/** Where the business's bank accounts are managed (the bank accounts section of the cheques screen). */
export const BANK_ACCOUNTS_SCREEN = "/payables/cheques";

/** The original export the owner is asked for when a file's currency cannot be confirmed. Generic: no bank named. */
const ORIGINAL_EXPORT = "ייצוא מקורי מהבנק של דף החשבון, ללא עריכה";

const ERROR_TEXT: Record<string, string> = {
  FILE_UNREADABLE: `לא הצלחנו לקרוא את הקובץ. העלו ${ORIGINAL_EXPORT}, בפורמט CSV או Excel ‏(XLSX), כפי שהבנק מוריד אותו.`,
  HEADER_NOT_FOUND: "לא מצאנו בקובץ טבלת תנועות עם שורת כותרות. בדקו שזה קובץ התנועות שהבנק מייצא, ולא קובץ אחר.",
  MAPPING_INVALID: "שיוך העמודות לא תקין. חייבים תאריך, וסכום או חובה / זכות, וכל עמודה פעם אחת.",
  TOO_MANY_LINES: "בקובץ יותר מדי תנועות. ייצאו מהבנק קובץ לתקופה קצרה יותר.",
  NO_LINES: "לא נמצאו תנועות בקובץ.",
  ACCOUNT_REQUIRED: "בחרו לאיזה חשבון בנק שייך הקובץ.",
  ACCOUNT_NOT_FOUND: "חשבון הבנק לא נמצא. רעננו את הדף ובחרו שוב.",
  TOKEN_INVALID: "הבדיקה פגה או לא תקפה. בדקו את הקובץ שוב לפני הקליטה.",
  FILE_CHANGED: "הקובץ או השיוך השתנו מאז הבדיקה. בדקו את הקובץ שוב לפני הקליטה.",
  DECISIONS_REQUIRED: "יש תנועות שאולי כבר קיימות ועדיין לא החלטתם עליהן. בחרו לכל אחת אם לקלוט או לדלג.",
  DECISIONS_INVALID: "מאז הבדיקה השתנו התנועות שאולי כבר קיימות. בדקו את הקובץ שוב.",
  FOREIGN_CURRENCY:
    "ייבוא קובץ בנק תומך כרגע רק בחשבון בשקלים. בקובץ הזה מופיע מטבע אחר (למשל דולר או אירו), ולכן הוא לא נקלט. אנחנו לא ממירים סכומים בין מטבעות. לא נשמר דבר.",
  CURRENCY_UNVERIFIABLE: `לא הצלחנו לוודא שהסכומים בקובץ בשקלים (למשל מטבע לא מוכר, או פורמט סכום ב-Excel שמציג מטבע לפי הגדרות המחשב). קובץ שאי אפשר לוודא את המטבע שלו לא נקלט. העלו ${ORIGINAL_EXPORT}, כפי שהבנק מוריד אותו. לא נשמר דבר.`,
  ACCOUNT_NUMBER_MISMATCH:
    "מספר החשבון שמופיע בקובץ לא תואם לחשבון שבחרתם. ייתכן שהקובץ שייך לחשבון אחר. בחרו את החשבון הנכון ובדקו שוב. לא נשמר דבר.",
  MULTIPLE_ACCOUNTS_IN_FILE:
    "בקובץ מופיע יותר מחשבון בנק אחד, ולכן הוא לא נקלט. בשלב הזה אפשר לקלוט רק קובץ של חשבון אחד: ייצאו מהבנק קובץ נפרד לכל חשבון, והעלו כל קובץ לחשבון שלו. לא נשמר דבר.",
  CROSS_ACCOUNT_LINES:
    "חלק מהתנועות בקובץ כבר נמצאות בדוביז תחת חשבון בנק אחר של העסק, ולכן הקובץ לא נקלט. ייתכן שבחרתם חשבון לא נכון, או שבקובץ יש תנועות של כמה חשבונות. בשלב הזה אפשר לקלוט רק קובץ של חשבון אחד: העלו קובץ נפרד לכל חשבון, לחשבון שלו. לא נשמר דבר.",
  ACCOUNT_CONFIRMATION_REQUIRED: "יש לאשר לאיזה חשבון בנק נקלט הקובץ לפני הקליטה.",
  ACCOUNT_CONFIRMATION_MISMATCH: "החשבון שאישרתם אינו החשבון שנבדק. בדקו את הקובץ שוב.",
};

/** Refusals after which the owner may need to check or fix the target account's details (BANK_ACCOUNTS_SCREEN). */
export function needsAccountFix(code: string): boolean {
  return code === "ACCOUNT_NUMBER_MISMATCH" || code === "MULTIPLE_ACCOUNTS_IN_FILE" || code === "CROSS_ACCOUNT_LINES";
}

/**
 * A refusal in plain Hebrew, with the details the server returned when they help (the owner's own last four
 * digits, a count). It never advises editing the file, changing an Excel number format or re-saving it as CSV: that
 * can strip the evidence of the currency and does not prove shekels — the owner is asked for the bank's original
 * export instead.
 */
export function bankImportErrorText(code: string, details: Record<string, string | number> = {}): string {
  if (code === "ACCOUNT_NUMBER_MISMATCH" && typeof details.fileLast4 === "string" && typeof details.accountLast4 === "string") {
    if (details.basis === "FULL") {
      return `מספר החשבון המלא שמופיע בקובץ (מסתיים ב-${details.fileLast4}) אינו החשבון שבחרתם, גם אם הספרות האחרונות דומות. בחרו את החשבון הנכון ובדקו שוב. אם בחרתם את החשבון הנכון, ייתכן שפרטי החשבון נשמרו בדוביז אחרת ממה שהבנק מדפיס (למשל אפס בתחילת המספר). לא נשמר דבר.`;
    }
    return `בקובץ מופיע חשבון שמסתיים ב-${details.fileLast4}, אבל בחרתם חשבון שמסתיים ב-${details.accountLast4}. ייתכן שהקובץ שייך לחשבון אחר. בחרו את החשבון הנכון ובדקו שוב. לא נשמר דבר.`;
  }
  if (code === "CURRENCY_UNVERIFIABLE" && details.signal === "NO_ILS_EVIDENCE") {
    return `לא מצאנו בקובץ סימון שמראה שהסכומים בשקלים (למשל ₪ או ש"ח בכותרת עמודת הסכום או היתרה, או עמודת מטבע). בלי סימון כזה אי אפשר לדעת באיזה מטבע החשבון, ולכן הקובץ לא נקלט. העלו ${ORIGINAL_EXPORT}, כפי שהבנק מוריד אותו. לא נשמר דבר.`;
  }
  if (code === "CROSS_ACCOUNT_LINES" && typeof details.lines === "number") {
    const where = typeof details.otherAccounts === "string" && details.otherAccounts ? ` (${details.otherAccounts})` : "";
    return `${details.lines} מהתנועות בקובץ כבר נמצאות בדוביז תחת חשבון בנק אחר של העסק${where}, ולכן הקובץ לא נקלט. ייתכן שבחרתם חשבון לא נכון, או שבקובץ יש תנועות של כמה חשבונות. בשלב הזה אפשר לקלוט רק קובץ של חשבון אחד: העלו קובץ נפרד לכל חשבון, לחשבון שלו. לא נשמר דבר.`;
  }
  return ERROR_TEXT[code] ?? "משהו השתבש. נסו שוב.";
}

/** Shown under a refusal for which `needsAccountFix` is true; the screen links BANK_ACCOUNTS_SCREEN beside it. */
export const ACCOUNT_FIX_TEXT =
  "פרטי חשבונות הבנק מנוהלים במסך המחאות, בחלק חשבונות הבנק. מספר חשבון שנשמר אינו ניתן לעריכה: אם הוא נשמר לא נכון, מוסיפים את החשבון מחדש עם הבנק, הסניף ומספר החשבון בדיוק כפי שהם מופיעים בדף החשבון מהבנק (כולל אפסים בתחילת המספר), ומעבירים לארכיון את החשבון השגוי. אחר כך חוזרים לכאן ובוחרים את החשבון הנכון.";
