/**
 * Every code the historical engine can emit, in the owner's Hebrew.
 *
 * # Why this is a module and not strings in a component
 *
 * The engine speaks in codes — `REVERSAL_TARGET_AFTER_CREDIT`,
 * `AMBIGUOUS_DECIMAL_COMMA`, `STRONG_CANDIDATE` — because a code is stable,
 * loggable and carries no business data. None of that is any use to a small
 * business owner looking at a spreadsheet they exported from their old system.
 * Somewhere the two have to meet, and doing it in a screen would scatter fiscal
 * wording across JSX where nothing can check it is complete.
 *
 * So the translation is a set of TOTAL maps, typed as `Record<Code, string>`
 * over the engine's own unions. Adding a code to the engine and forgetting the
 * owner is then a compile error rather than an `undefined` rendered into a
 * fiscal screen. The verifier additionally asserts that no map is missing an
 * entry at runtime and that no entry leaks implementation vocabulary.
 *
 * # The rules the wording obeys
 *
 *  1. Say what happened to the OWNER'S document, not what the engine decided.
 *  2. Never imply Dubiz issued anything. These documents came from elsewhere.
 *  3. Never call a warning a failure, and never soften a blocker into a warning.
 *  4. `CREATE_ANYWAY` is an ADDITIONAL record. Never "overwrite", "replace",
 *     "merge", "update" or "fix".
 *  5. No jargon: no token, no hash, no fingerprint, no run, no row marker, no
 *     tenant, no RLS, no fiscal identity, no Prisma, no advisory lock.
 */

import type {
  HistoricalMappingBlockerCode,
  HistoricalRowErrorCode,
  HistoricalRowState,
  HistoricalRowWarningCode,
} from "@/lib/data-transfer/historical/historical-analyze";
import type {
  DuplicateErrorCode,
  DuplicateWarningCode,
} from "@/lib/data-transfer/historical/historical-analyze-duplicates";
import type {
  ComparableFacts,
  DatabaseDuplicateState,
  InFileDuplicateState,
  ReversalState,
} from "@/lib/data-transfer/historical/historical-duplicates";
import type {
  BlockingReasonCode,
  HistoricalAction,
} from "@/lib/data-transfer/historical/historical-decisions";
import type { ReversalTargetClass } from "@/lib/data-transfer/historical/historical-preview";
import type {
  HistoricalExecuteErrorCode,
  HistoricalRowResultCode,
} from "@/lib/data-transfer/historical/historical-execute";
import {
  HISTORICAL_TYPE_LABELS,
  type HistoricalDocumentType,
} from "@/lib/data-transfer/historical/historical-vocabulary";

/* ------------------------------------------------------------ row state -- */

export const ROW_STATE_LABEL: Record<HistoricalRowState, string> = {
  READY: "מוכן",
  WARNING: "שווה מבט",
  ERROR: "לא ניתן לייבא",
};

/* -------------------------------------------------------------- errors --- */

/**
 * Structural problems. Every one of these stops the row, and the text says what
 * to fix in the FILE — because that is the only place it can be fixed.
 */
export const ROW_ERROR_TEXT: Record<HistoricalRowErrorCode, string> = {
  MISSING_DOCUMENT_TYPE: "לא נכתב סוג מסמך",
  UNKNOWN_DOCUMENT_TYPE: "סוג המסמך אינו אחד מהסוגים שאפשר לקלוט",
  MISSING_DOCUMENT_NUMBER: "חסר מספר המסמך המקורי",
  MISSING_DATE: "חסר תאריך המסמך",
  AMBIGUOUS_DATE:
    "אי אפשר לדעת אם התאריך הזה נכתב יום/חודש או חודש/יום. בחרו למעלה איך לקרוא תאריכים בקובץ",
  INVALID_DATE: "התאריך אינו תאריך אמיתי",
  UNSUPPORTED_DATE_FORMAT: "צורת התאריך אינה מוכרת",
  MISSING_TOTAL: "חסר הסכום הכולל",
  INVALID_AMOUNT: "הסכום אינו מספר תקין",
  AMBIGUOUS_DECIMAL_COMMA:
    "אי אפשר לדעת אם הפסיק בסכום מפריד אלפים או מסמן אגורות",
  TOO_MANY_DECIMALS: "בסכום יש יותר משתי ספרות אחרי הנקודה",
  AMOUNT_OUT_OF_RANGE: "הסכום גדול מדי",
  MISSING_CURRENCY: "חסר מטבע. לא נניח מטבע במקומכם",
  UNSUPPORTED_CURRENCY: "המטבע אינו נתמך. כרגע נקלטים שקלים בלבד",
  MISSING_SOURCE_SYSTEM: 'חסרה מערכת המקור. אם אין מערכת מסוימת, כתבו "ידני"',
  INVALID_SOURCE_SYSTEM: "שם מערכת המקור אינו תקין",
  INVALID_CUSTOMER_TAX_ID: "מספר העוסק או הח.פ. של הלקוח אינו תקין",
};

/** Problems the existing history raises. Each one blocks the row. */
export const DUPLICATE_ERROR_TEXT: Record<DuplicateErrorCode, string> = {
  DUPLICATE_AMBIGUOUS:
    "כבר יש בהיסטוריה יותר ממסמך אחד עם המספר הזה, ולכן אי אפשר לדעת לְמה השורה מתייחסת",
  REVERSAL_TARGET_AMBIGUOUS:
    "יותר ממסמך אחד מתאים למספר שהזיכוי מבטל, ואי אפשר לנחש איזה מהם",
  REVERSAL_TARGET_AFTER_CREDIT:
    "המסמך שהזיכוי מבטל מופיע בקובץ אחרי הזיכוי. סדרו את הקובץ כך שהמסמך המקורי יופיע לפניו",
  REVERSAL_TARGET_UNSUPPORTED_TYPE:
    "אי אפשר לזכות את סוג המסמך שהזיכוי מפנה אליו",
};

/* ------------------------------------------------------------ warnings --- */

/** Worth a look. None of these stops anything. */
export const ROW_WARNING_TEXT: Record<HistoricalRowWarningCode, string> = {
  FUTURE_ISSUE_DATE: "תאריך המסמך עתידי",
  SUBTOTAL_MISSING: "המערכת הקודמת לא רשמה סכום לפני מע״מ. נשמור רק את הסכום הכולל",
  VAT_ARITHMETIC_MISMATCH:
    "הסכום לפני מע״מ והמע״מ לא מסתכמים לסכום הכולל. נשמור את שלושתם בדיוק כפי שנכתבו",
  CREDIT_NOTE_POSITIVE_AMOUNT: "מסמך זיכוי עם סכום חיובי",
  NON_CREDIT_NEGATIVE_AMOUNT: "מסמך שאינו זיכוי עם סכום שלילי",
  CREDIT_NOTE_WITHOUT_REFERENCE: "מסמך זיכוי בלי מספר המסמך שהוא מזכה",
};

export const DUPLICATE_WARNING_TEXT: Record<DuplicateWarningCode, string> = {
  DUPLICATE_EXISTS: "המסמך הזה כבר קיים בהיסטוריה שלכם",
  DUPLICATE_CONFLICT:
    "כבר קיים מסמך עם אותו מספר, אבל חלק מהפרטים שונים",
  IN_FILE_DUPLICATE: "שורה מוקדמת יותר בקובץ מתארת בדיוק את אותו מסמך",
  IN_FILE_CONFLICT:
    "שורה מוקדמת יותר בקובץ נושאת את אותו מספר עם פרטים שונים",
  REVERSAL_TARGET_NOT_FOUND:
    "לא נמצא המסמך שהזיכוי מבטל. נשמור את המספר שנכתב, בלי קישור",
};

/* ------------------------------------------------------------- mapping --- */

export const MAPPING_BLOCKER_TEXT: Record<HistoricalMappingBlockerCode, string> = {
  MAPPING_REQUIRED_MISSING: "עמודת חובה שלא נמצאה בקובץ",
  MAPPING_DUPLICATE_TARGET: "יותר מעמודה אחת בקובץ הותאמה לאותו שדה",
  MAPPING_AMBIGUOUS: "הכותרת יכולה להתאים ליותר משדה אחד",
};

/** How confident Dubiz was about a column. */
export const MAPPING_STATUS_LABEL: Record<
  "EXACT" | "SUGGESTED" | "AMBIGUOUS" | "UNMAPPED",
  string
> = {
  EXACT: "זוהה",
  SUGGESTED: "הצעה",
  AMBIGUOUS: "צריך בחירה",
  UNMAPPED: "לא זוהה",
};

/* ------------------------------------------------------------ decisions -- */

/**
 * The three actions.
 *
 * `CREATE_ANYWAY` is the one that must not be misread. It appends an
 * ADDITIONAL historical record beside the one already there. It does not
 * overwrite it, replace it, merge into it, update it or repair it — the
 * historical table is written once and never revised.
 */
export const ACTION_LABEL: Record<HistoricalAction, string> = {
  CREATE: "ייקלט",
  SKIP: "ידולג",
  CREATE_ANYWAY: "ייקלט בכל זאת",
};

/** The button the owner presses to CHOOSE that action. */
export const ACTION_BUTTON: Record<HistoricalAction, string> = {
  CREATE: "לקלוט",
  SKIP: "לדלג",
  CREATE_ANYWAY: "לקלוט בכל זאת, כרשומה נוספת",
};

export const ACTION_HELP: Record<HistoricalAction, string> = {
  CREATE: "המסמך יישמר בהיסטוריה שלכם.",
  SKIP: "השורה לא תישמר. שום דבר קיים לא ישתנה.",
  CREATE_ANYWAY:
    "תישמר רשומה היסטורית נוספת לצד זו שכבר קיימת. הרשומה הקיימת נשארת כפי שהיא — היא לא מתעדכנת, לא מוחלפת ולא נמחקת.",
};

/* ----------------------------------------------------------- duplicates -- */

export const DATABASE_DUPLICATE_TEXT: Record<DatabaseDuplicateState, string> = {
  NONE: "לא נמצא מסמך כזה בהיסטוריה",
  EXACT: "כבר קיים בהיסטוריה, עם אותם פרטים בדיוק",
  STRONG_CANDIDATE: "קיים מסמך עם אותו מספר, אבל חלק מהפרטים שונים",
  AMBIGUOUS: "יותר ממסמך אחד בהיסטוריה נושא את המספר הזה",
};

export const IN_FILE_DUPLICATE_TEXT: Record<InFileDuplicateState, string> = {
  NONE: "אין שורה נוספת בקובץ עם אותו מספר",
  EXACT_DUPLICATE: "אותו מסמך מופיע בקובץ פעמיים",
  CONFLICTING_DUPLICATE: "אותו מספר מופיע בקובץ פעמיים, עם פרטים שונים",
};

/** The comparable facts, as the owner knows them. */
export const FACT_LABEL: Record<keyof ComparableFacts, string> = {
  originalIssueDate: "תאריך המסמך",
  totalAmount: "סכום כולל",
  subtotalAmount: "סכום לפני מע״מ",
  vatAmount: "מע״מ",
  currency: "מטבע",
  customerNameSnapshot: "שם לקוח",
  customerTaxIdSnapshot: "מספר עוסק / ח.פ. לקוח",
};

/* ------------------------------------------------------------- reversal -- */

export const REVERSAL_TEXT: Record<ReversalState, string> = {
  NOT_APPLICABLE: "לא רלוונטי — זה אינו מסמך זיכוי",
  NO_REFERENCE: "לא נכתב איזה מסמך הזיכוי מבטל",
  RESOLVED_EXISTING: "המסמך שהזיכוי מבטל כבר קיים בהיסטוריה שלכם",
  RESOLVED_IN_FILE: "המסמך שהזיכוי מבטל נמצא מוקדם יותר באותו קובץ",
  NOT_FOUND:
    "לא נמצא המסמך שהזיכוי מבטל. המספר שנכתב יישמר כפי שהוא, בלי קישור למסמך",
  AMBIGUOUS: "יותר ממסמך אחד מתאים למספר שהזיכוי מבטל",
  TARGET_AFTER_CREDIT: "המסמך שהזיכוי מבטל מופיע בקובץ אחרי הזיכוי",
  UNSUPPORTED_TARGET_TYPE: "אי אפשר לזכות את סוג המסמך שהזיכוי מפנה אליו",
};

/** What the credit will actually be attached to, once the import runs. */
export const REVERSAL_TARGET_TEXT: Record<ReversalTargetClass, string> = {
  NOT_APPLICABLE: "",
  EXISTING_RECORD: "יקושר למסמך שכבר קיים בהיסטוריה",
  ROW_TO_BE_CREATED: "יקושר למסמך שייקלט מאותו קובץ",
  ROW_NOT_BEING_CREATED:
    "המסמך שהזיכוי מבטל לא ייקלט, ולכן המספר יישמר כטקסט בלבד",
  TEXT_ONLY: "המספר יישמר כטקסט בלבד, בלי קישור למסמך",
  BLOCKED: "לא ניתן לקלוט את הזיכוי במצב הזה",
};

/* ------------------------------------------------------------- blocking -- */

export const BLOCKING_REASON_TEXT: Record<BlockingReasonCode, string> = {
  STRUCTURAL_ERROR: "יש בשורה פרט שאי אפשר לקרוא",
  DUPLICATE_AMBIGUOUS: "כבר יש בהיסטוריה יותר ממסמך אחד עם המספר הזה",
  REVERSAL_AMBIGUOUS: "יותר ממסמך אחד מתאים למספר שהזיכוי מבטל",
  REVERSAL_TARGET_AFTER_CREDIT: "המסמך שהזיכוי מבטל מופיע בקובץ אחרי הזיכוי",
  REVERSAL_TARGET_UNSUPPORTED_TYPE:
    "אי אפשר לזכות את סוג המסמך שהזיכוי מפנה אליו",
};

/**
 * Why the file is not ready to be confirmed.
 *
 * The codes come from the preview's `notReadyReasons`. A blocked row does not
 * by itself stop the file — it is skipped, visibly — so the reasons here are
 * about what would actually RUN.
 */
export const NOT_READY_TEXT: Record<string, string> = {
  OWNER_DECISION_REQUIRED: "יש שורות שממתינות להחלטה שלכם",
  BLOCKED_ROW_SELECTED: "נבחרה לקליטה שורה שלא ניתן לקלוט",
  ERROR_ROW_SELECTED: "נבחרה לקליטה שורה שיש בה פרט שאי אפשר לקרוא",
  NO_ROWS: "לא נמצאו שורות בקובץ",
  NOTHING_TO_IMPORT: "לא נבחרה אף שורה לקליטה",
};

/* -------------------------------------------------------------- results -- */

export const ROW_RESULT_TEXT: Record<HistoricalRowResultCode, string> = {
  CREATED: "נשמר בהיסטוריה",
  SKIPPED: "דולג",
  ALREADY_EXECUTED: "כבר נשמר בהרצה קודמת של אותו קובץ",
  DUPLICATE_CHANGED: "ההיסטוריה השתנתה בזמן הקליטה, ולכן השורה לא נשמרה",
  REVERSAL_CHANGED:
    "המסמך שהזיכוי מבטל השתנה בזמן הקליטה, ולכן השורה לא נשמרה",
  ROW_PERSISTENCE_FAILED: "השמירה נכשלה",
};

/* --------------------------------------------------------- failure codes - */

/**
 * Server refusals, in the owner's words.
 *
 * Two of these are the states the brief singles out, and neither may become a
 * generic "אירעה שגיאה": the preview EXPIRED, and the data MOVED since the
 * check. Both are recoverable and the text says how.
 */
export const FAILURE_TEXT: Record<
  HistoricalExecuteErrorCode | string,
  string
> = {
  /* -- the two states that must never be generic -- */
  TOKEN_EXPIRED:
    "התצוגה המקדימה פגה. יש לבדוק את הקובץ מחדש לפני הייבוא.",
  ANALYSIS_STALE:
    "הנתונים השתנו מאז הבדיקה. יש לבצע תצוגה מקדימה מחדש כדי לוודא שהייבוא עדיין נכון.",
  PREVIEW_STALE:
    "הנתונים השתנו מאז הבדיקה. יש לבצע תצוגה מקדימה מחדש כדי לוודא שהייבוא עדיין נכון.",

  /* -- approval no longer matches what the owner saw -- */
  DECISION_CHANGED:
    "ההחלטות שאישרתם כבר אינן מתאימות לקובץ. עברו על הבדיקה שוב.",
  TOKEN_MISMATCH:
    "האישור אינו מתאים לקובץ הזה. התחילו את הבדיקה מחדש.",
  TOKEN_INVALID: "האישור אינו תקין. התחילו את הבדיקה מחדש.",
  TOKEN_MISSING: "חסר אישור הבדיקה. התחילו את הבדיקה מחדש.",
  NOT_READY: "הקובץ עדיין לא מוכן לקליטה.",
  DECISIONS_INVALID: "אחת הבחירות אינה אפשרית עבור השורה שלה.",
  MAPPING_INCOMPLETE:
    "יש להשלים את התאמת העמודות לפני שאפשר להציג תצוגה מקדימה.",

  /* -- the file itself -- */
  FILE_MISSING: "לא נבחר קובץ.",
  FILE_TOO_LARGE: "הקובץ גדול מדי.",
  TOO_MANY_ROWS: "יש בקובץ יותר שורות ממה שאפשר לקלוט בבת אחת.",
  SHEET_CHOICE_REQUIRED: "בקובץ יש כמה גיליונות. בחרו את הגיליון לייבוא.",
  EMPTY_SHEET: "הגיליון שנבחר ריק.",
  MISSING_HEADERS: "לא נמצאה שורת כותרות בקובץ.",
  UNSUPPORTED_TYPE: "אפשר להעלות קובץ אקסל או קובץ טבלה מופרד בפסיקים.",
  INVALID_BODY: "הבקשה לא נשלחה כראוי. נסו שוב.",

  /* -- the server could not finish -- */
  ANALYZE_FAILED: "בדיקת הקובץ נכשלה. נסו שוב מאוחר יותר.",
  PREVIEW_FAILED: "בניית התצוגה המקדימה נכשלה. נסו שוב מאוחר יותר.",
  EXECUTE_FAILED: "הקליטה נכשלה. נסו שוב מאוחר יותר.",
  RECORDS_FAILED: "טעינת ההיסטוריה נכשלה. נסו שוב מאוחר יותר.",
};

/**
 * The owner-facing text for a server refusal.
 *
 * The server's own message is the fallback rather than the first choice: every
 * message the historical routes produce is already owner-safe Hebrew, but a
 * code this module knows is the one that has been reviewed for THIS screen.
 */
export function failureText(
  code: string | null | undefined,
  serverMessage?: string | null
): string {
  if (code && FAILURE_TEXT[code]) return FAILURE_TEXT[code];
  if (serverMessage && serverMessage.trim() !== "") return serverMessage;
  return "משהו השתבש. נסו שוב.";
}

/* ------------------------------------------------------------ documents -- */

/** The four historical document types, as the owner writes and reads them. */
export const DOCUMENT_TYPE_LABEL: Record<HistoricalDocumentType, string> =
  HISTORICAL_TYPE_LABELS;

/**
 * A type code as a label, without asserting the code is one of the four.
 *
 * Historical records can, in principle, carry a code written before a
 * vocabulary change. Falling back to the code keeps such a row readable instead
 * of rendering an empty cell where a document type should be.
 */
export function documentTypeLabel(code: string): string {
  return (
    (DOCUMENT_TYPE_LABEL as Record<string, string>)[code] ?? code
  );
}

/**
 * The line that must appear wherever a historical record is shown.
 *
 * Not decoration: an owner looking at a list of invoices must never be able to
 * conclude that Dubiz issued one of them. The counterpart wording for a Dubiz
 * document is "הופק בדוביז", and the two are deliberately different sentences
 * rather than a shared one with a flag.
 */
export const EXTERNAL_ORIGIN_BADGE = "יובא ממערכת אחרת";
export const EXTERNAL_ORIGIN_EXPLANATION =
  "המסמכים כאן הופקו במערכת אחרת לפני המעבר לדוביז, ונשמרים כהיסטוריה בלבד. דוביז לא הפיקה אותם, לא הקצתה להם מספר ולא דיווחה עליהם.";
export const DUBIZ_ORIGIN_BADGE = "הופק בדוביז";
