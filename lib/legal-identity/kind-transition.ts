/**
 * Path A — "מעבר לעוסק מורשה" (owner decisions 2026-11-20): an exempt dealer (עוסק פטור) becomes an authorized dealer
 * (עוסק מורשה) inside the SAME business file. Same legal entity, same id number, same legal name.
 *
 * This module is the pure core of that flow: who may start it, what the owner must type and acknowledge, the exact
 * statement the owner confirms (and its digest, so the server can prove WHAT was confirmed), the two dates, and the
 * mapping of the database answer to a response. It never writes. The only writer is the database function
 * business_kind_transition_to_authorized (migration 20261221090000, wired to the 4a issuer declaration writer by
 * 20261225090000), which re-checks everything in one transaction. For a business with a live issuer declaration the
 * same transaction files declaration version+1 (STATUS_CHANGE) before the profile changes, so the profile keeps
 * following the declaration; anything the declaration writer refuses writes nothing.
 *
 * Two dates, never mixed (owner 11-20):
 *   statusEffectiveDate  the day the owner declares the authorized-dealer status started at the Tax Authority. It may
 *                        be earlier than today; it is RECORDED only. Nothing issued before the confirmation changes,
 *                        and nothing is issued retroactively.
 *   confirmedAt          the moment the owner confirms in Dubiz (server clock). New documents follow the new kind
 *                        from this moment.
 *
 * What the flow never does (enforced by the database):
 *   - change an issued document (issuedSnapshot is frozen: DZ010 FISCAL_IMMUTABLE);
 *   - change the legal name or the id number (Path B: a new business file);
 *   - claim that Dubiz changed anything at the Tax Authority — it records what the owner declares.
 *
 * Pure: no database, no network. Messages never carry a typed value.
 */

import { createHash } from "node:crypto";

import { authoritativeTaxId } from "@/lib/identity/tax-id";
import { parseBillingBusinessKind } from "@/lib/billing/business-identity";

export const KIND_TRANSITION_STATEMENT_VERSION = "kind-transition-exempt-to-authorized-v1";

/** The earliest status start date accepted (the database CHECK says the same). */
export const KIND_TRANSITION_EARLIEST_EFFECTIVE_DATE = "2000-01-01";

/** What the server knows about the business when the flow opens. Every field is server-derived. */
export type KindTransitionState = {
  billingBusinessKind: string | null;
  billingLegalName: string | null;
  billingTaxId: string | null;
  billingVatNumber: string | null;
  /** Business.deletionRequestedAt / deletedAt set. */
  businessBeingDeleted: boolean;
  /** The signed-in user is the business's ONLY user (v1 authority rule, as account deletion). */
  actorIsSoleUser: boolean;
  /**
   * The latest issuer declaration exists and is not anonymised. Informational since the 4a T1 wiring
   * (20261225090000): it no longer blocks — the database files the declaration's new version in the same transaction.
   */
  hasLiveIssuerDeclaration: boolean;
};

export type KindTransitionBlock =
  | "NOT_EXEMPT_DEALER"
  | "BUSINESS_BEING_DELETED"
  | "NOT_SOLE_USER"
  | "IDENTITY_INCOMPLETE";

export type KindTransitionEligibility = { eligible: true } | { eligible: false; block: KindTransitionBlock; message: string };

export const KIND_TRANSITION_BLOCK_MESSAGES: Record<KindTransitionBlock, string> = {
  NOT_EXEMPT_DEALER: "המעבר זמין רק לעסק שמוגדר כעוסק פטור.",
  BUSINESS_BEING_DELETED: "החשבון בתהליך מחיקה, ולכן אי אפשר לבצע מעבר.",
  NOT_SOLE_USER: "בעסק יש יותר ממשתמש אחד. כרגע המעבר זמין רק כשבעל העסק הוא המשתמש היחיד.",
  IDENTITY_INCOMPLETE: "כדי לבצע מעבר צריך שם משפטי ומספר זהות תקין (9 ספרות) בפרטי העסק.",
};

/** The id number exactly as stored must already be canonical (9 digits, check digit) — the database requires it. */
const canonicalOnFile = (v: string | null | undefined) => (v != null && authoritativeTaxId(v) === v ? v : null);

/** Whether the "מעבר לעוסק מורשה" action may be offered and started. */
export function evaluateKindTransitionEligibility(s: KindTransitionState): KindTransitionEligibility {
  const block = (b: KindTransitionBlock): KindTransitionEligibility => ({ eligible: false, block: b, message: KIND_TRANSITION_BLOCK_MESSAGES[b] });
  if (s.businessBeingDeleted) return block("BUSINESS_BEING_DELETED");
  if (parseBillingBusinessKind(s.billingBusinessKind) !== "EXEMPT_DEALER") return block("NOT_EXEMPT_DEALER");
  if (!s.actorIsSoleUser) return block("NOT_SOLE_USER");
  if ((s.billingLegalName ?? "").trim().length < 2 || canonicalOnFile(s.billingTaxId) === null) return block("IDENTITY_INCOMPLETE");
  // A live issuer declaration does not block (4a T1 wiring): the database files its new version in the same
  // transaction, or refuses and writes nothing (kindTransitionOutcome maps those answers).
  return { eligible: true };
}

/**
 * The acknowledgements the owner must tick, each one explicitly. Ids are stable (they are part of the confirmed
 * statement, and the database restates them); the text is what the screen shows.
 */
export const KIND_TRANSITION_ACKNOWLEDGEMENTS = [
  { id: "registered_with_vat_authority", text: "אני רשום/ה כעוסק מורשה ברשות המסים. דוביז לא משנה את הרישום ברשות המסים — היא מעדכנת את סוג העסק בדוביז לפי ההצהרה שלי." },
  { id: "same_legal_entity", text: "מדובר באותו אדם, באותו שם משפטי ובאותו מספר זהות. שינוי שם או מספר מחייב פתיחת תיק עסק חדש." },
  { id: "issued_documents_unchanged", text: "מסמכים שכבר הונפקו כעוסק פטור נשארים בדיוק כפי שהונפקו, ודוביז לא מנפיקה מסמכים בדיעבד." },
  { id: "new_documents_as_authorized", text: "מרגע האישור בדוביז, מסמכים חדשים יונפקו כעוסק מורשה, כולל חשבוניות מס ומע״מ לפי הכללים." },
  { id: "not_reversible_in_dubiz", text: "המעבר לא ניתן לביטול עצמי בדוביז." },
] as const;

export type KindTransitionAcknowledgementId = (typeof KIND_TRANSITION_ACKNOWLEDGEMENTS)[number]["id"];

export type KindTransitionInput = {
  /** The owner retypes the id number on the business file — proves it is the same entity, never edits it. */
  confirmTaxId: string;
  /** The VAT registration number (מספר עוסק מורשה). For an individual it equals the id number (owner 11-20). */
  vatNumber: string;
  /** YYYY-MM-DD: the day the status started at the Tax Authority. */
  statusEffectiveDate: string;
  acknowledged: string[];
};

export type KindTransitionField = "confirmTaxId" | "vatNumber" | "statusEffectiveDate" | "acknowledged";
export type KindTransitionProblem = { field: KindTransitionField; code: string; message: string };

export type KindTransitionValidation =
  | { ok: true; vatNumber: string; taxId: string; statusEffectiveDate: string }
  | { ok: false; problems: KindTransitionProblem[] };

/** Today's date in Israel, YYYY-MM-DD (the database uses the same zone). */
export function israelToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function isRealDate(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/** Validate what the owner typed and ticked. Every problem at once; no message echoes a value. */
export function validateKindTransitionInput(
  s: Pick<KindTransitionState, "billingTaxId">,
  input: KindTransitionInput,
  opts: { today?: string } = {}
): KindTransitionValidation {
  const today = opts.today ?? israelToday();
  const problems: KindTransitionProblem[] = [];
  const fileTax = canonicalOnFile(s.billingTaxId);

  const typedTax = authoritativeTaxId(input.confirmTaxId);
  if (!(input.confirmTaxId ?? "").trim()) {
    problems.push({ field: "confirmTaxId", code: "REQUIRED", message: "יש להקליד את מספר הזהות שמופיע בפרטי העסק." });
  } else if (typedTax === null || fileTax === null || typedTax !== fileTax) {
    problems.push({ field: "confirmTaxId", code: "MISMATCH", message: "המספר שהוקלד לא תואם למספר הזהות של תיק העסק. אם המספר בתיק שגוי, יש לפתוח תיק עסק חדש." });
  }

  const vat = authoritativeTaxId(input.vatNumber);
  if (!(input.vatNumber ?? "").trim()) {
    problems.push({ field: "vatNumber", code: "REQUIRED", message: "יש להזין מספר עוסק מורשה." });
  } else if (vat === null) {
    problems.push({ field: "vatNumber", code: "INVALID", message: "מספר העוסק המורשה אינו תקין (9 ספרות עם ספרת ביקורת)." });
  } else if (fileTax !== null && vat !== fileTax) {
    problems.push({ field: "vatNumber", code: "DIFFERS_FROM_TAX_ID", message: "לעוסק מורשה יחיד, מספר העוסק המורשה זהה למספר הזהות. מספר אחר מעיד על ישות אחרת — יש לפתוח תיק עסק חדש." });
  }

  const date = (input.statusEffectiveDate ?? "").trim();
  if (!date) {
    problems.push({ field: "statusEffectiveDate", code: "REQUIRED", message: "יש להזין את התאריך שבו המעמד כעוסק מורשה נכנס לתוקף ברשות המסים." });
  } else if (!isRealDate(date) || date < KIND_TRANSITION_EARLIEST_EFFECTIVE_DATE) {
    problems.push({ field: "statusEffectiveDate", code: "INVALID", message: "התאריך אינו תקין." });
  } else if (date > today) {
    problems.push({ field: "statusEffectiveDate", code: "IN_FUTURE", message: "אי אפשר לבצע מעבר לפני שהמעמד נכנס לתוקף. אפשר לחזור לכאן בתאריך התחילה." });
  }

  const ticked = new Set(input.acknowledged ?? []);
  const missing = KIND_TRANSITION_ACKNOWLEDGEMENTS.filter((a) => !ticked.has(a.id));
  const unknown = [...ticked].filter((id) => !KIND_TRANSITION_ACKNOWLEDGEMENTS.some((a) => a.id === id));
  if (missing.length > 0 || unknown.length > 0) {
    problems.push({ field: "acknowledged", code: "INCOMPLETE", message: "יש לאשר את כל הסעיפים לפני המעבר." });
  }

  if (problems.length > 0 || vat === null || fileTax === null) return { ok: false, problems };
  return { ok: true, vatNumber: vat, taxId: fileTax, statusEffectiveDate: date };
}

export type KindTransitionStatementFields = {
  businessId: number;
  actorUserId: number;
  /** As stored on the profile — byte for byte; the database recomputes from the same stored value. */
  legalName: string;
  /** As stored (canonical 9 digits). */
  taxId: string;
  /** Canonical 9 digits (validated). */
  vatNumber: string;
  /** YYYY-MM-DD. */
  statusEffectiveDate: string;
};

/**
 * The exact text the owner confirms. Byte-identical to the database's business_kind_transition_statement() (the
 * migration lab proves it on a fixed vector, and KIND_TRANSITION_VECTOR below pins the same digest here). The
 * database recomputes it at confirmation time and answers STATEMENT_STALE if anything changed in between.
 */
export function canonicalKindTransitionStatement(f: KindTransitionStatementFields): string {
  return [
    `statement=${KIND_TRANSITION_STATEMENT_VERSION}`,
    `business=${f.businessId}`,
    `actor=${f.actorUserId}`,
    `from=EXEMPT_DEALER`,
    `to=AUTHORIZED_DEALER`,
    `legalName=${f.legalName}`,
    `taxId=${f.taxId}`,
    `vatNumber=${f.vatNumber}`,
    `statusEffectiveDate=${f.statusEffectiveDate}`,
    ...KIND_TRANSITION_ACKNOWLEDGEMENTS.map((a) => `ack=${a.id}`),
  ].join("\n");
}

export function kindTransitionStatementSha256(f: KindTransitionStatementFields): string {
  return createHash("sha256").update(canonicalKindTransitionStatement(f), "utf8").digest("hex");
}

/** The fixed vector the migration's evidence (check 11) and lab (K2) compute in SQL. */
export const KIND_TRANSITION_VECTOR = {
  fields: { businessId: 7, actorUserId: 11, legalName: "ישראל ישראלי", taxId: "123456782", vatNumber: "123456782", statusEffectiveDate: "2026-11-01" },
  sha256: "8ab5a6b2df827ed27147ea10e49802bea06810d49f4eeba878afe39c88b2d464",
} as const satisfies { fields: KindTransitionStatementFields; sha256: string };

/**
 * The database function's answers (20261221090000, wired by 20261225090000) and what the route makes of them.
 * ISSUER_DECLARATION_ACTIVE is the unwired function's answer: kept so this code is safe on either side of the
 * wiring migration (and after a rollback of it). ISSUER_DECLARATION_<status> are the 4a writer's refusals, passed on
 * by the wired function; nothing is written when it answers one of them.
 */
export type KindTransitionDbStatus =
  | "TRANSITIONED"
  | "NOT_ALLOWED"
  | "NOT_SOLE_USER"
  | "REAUTH_REQUIRED"
  | "IDENTITY_INCOMPLETE"
  | "NOT_EXEMPT_DEALER"
  | "VAT_NUMBER_INVALID"
  | "VAT_NUMBER_DIFFERS_FROM_TAX_ID"
  | "EFFECTIVE_DATE_INVALID"
  | "ISSUER_DECLARATION_ACTIVE"
  | "ISSUER_DECLARATION_NOT_AUTHORIZED_USER"
  | "ISSUER_DECLARATION_IDENTITY_MISMATCH"
  | "ISSUER_DECLARATION_DECLARATION_NOT_EXEMPT"
  | "ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE"
  | "STATEMENT_STALE";

/**
 * Hebrew texts for the issuer declaration answers (owner approval pending — see the release package). Every one
 * says that nothing was saved. None offers a way to change the legal name or the id number.
 */
export const KIND_TRANSITION_DECLARATION_MESSAGES = {
  ISSUER_DECLARATION_ACTIVE: "לעסק יש הצהרת מנפיק פעילה, והמעבר לעסק עם הצהרה עדיין לא זמין. לא נשמר שום שינוי.",
  ISSUER_DECLARATION_NOT_AUTHORIZED_USER:
    "את המעבר יכול לאשר רק המשתמש שמוגדר בהצהרת המנפיק של העסק כמורשה לפעול בשמו. לא נשמר שום שינוי.",
  ISSUER_DECLARATION_IDENTITY_MISMATCH:
    "השם המשפטי או מספר הזהות בפרטי העסק אינם זהים לאלה שבהצהרת המנפיק, ולכן אי אפשר לבצע את המעבר. לא נשמר שום שינוי. כדי לבדוק את הפרטים יש לפנות לתמיכה של דוביז.",
  ISSUER_DECLARATION_DECLARATION_NOT_EXEMPT:
    "לפי הצהרת המנפיק העסק אינו רשום כעוסק פטור, ולכן אי אפשר לבצע את המעבר. לא נשמר שום שינוי. כדי לבדוק את הפרטים יש לפנות לתמיכה של דוביז.",
  ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE:
    "הצהרת המנפיק של העסק עדיין לא נכנסה לתוקף. אפשר לנסות שוב בעוד כמה דקות. לא נשמר שום שינוי.",
} as const;

export type KindTransitionOutcome = { status: number; code: KindTransitionDbStatus | "UNKNOWN"; message: string };

export function kindTransitionOutcome(db: string): KindTransitionOutcome {
  switch (db as KindTransitionDbStatus) {
    case "TRANSITIONED": return { status: 200, code: "TRANSITIONED", message: "סוג העסק עודכן לעוסק מורשה." };
    case "NOT_ALLOWED": return { status: 403, code: "NOT_ALLOWED", message: "אין הרשאה לבצע את המעבר בעסק הזה." };
    case "NOT_SOLE_USER": return { status: 409, code: "NOT_SOLE_USER", message: KIND_TRANSITION_BLOCK_MESSAGES.NOT_SOLE_USER };
    case "REAUTH_REQUIRED": return { status: 401, code: "REAUTH_REQUIRED", message: "יש לאמת את הזהות מחדש ולנסות שוב." };
    case "IDENTITY_INCOMPLETE": return { status: 409, code: "IDENTITY_INCOMPLETE", message: KIND_TRANSITION_BLOCK_MESSAGES.IDENTITY_INCOMPLETE };
    case "NOT_EXEMPT_DEALER": return { status: 409, code: "NOT_EXEMPT_DEALER", message: KIND_TRANSITION_BLOCK_MESSAGES.NOT_EXEMPT_DEALER };
    case "VAT_NUMBER_INVALID": return { status: 400, code: "VAT_NUMBER_INVALID", message: "מספר העוסק המורשה אינו תקין." };
    case "VAT_NUMBER_DIFFERS_FROM_TAX_ID": return { status: 400, code: "VAT_NUMBER_DIFFERS_FROM_TAX_ID", message: "מספר העוסק המורשה חייב להיות זהה למספר הזהות." };
    case "EFFECTIVE_DATE_INVALID": return { status: 400, code: "EFFECTIVE_DATE_INVALID", message: "תאריך תחילת המעמד אינו תקין." };
    case "ISSUER_DECLARATION_ACTIVE":
    case "ISSUER_DECLARATION_NOT_AUTHORIZED_USER":
    case "ISSUER_DECLARATION_IDENTITY_MISMATCH":
    case "ISSUER_DECLARATION_DECLARATION_NOT_EXEMPT":
    case "ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE": {
      const code = db as keyof typeof KIND_TRANSITION_DECLARATION_MESSAGES;
      return { status: 409, code, message: KIND_TRANSITION_DECLARATION_MESSAGES[code] };
    }
    // Any other ISSUER_DECLARATION_* (NOT_ALLOWED, REAUTH_REQUIRED, STATEMENT_INVALID, VAT_NUMBER_INVALID,
    // NO_LIVE_DECLARATION, UNKNOWN) is unreachable after the transition's own checks: it falls to the 500 below.
    case "STATEMENT_STALE": return { status: 409, code: "STATEMENT_STALE", message: "פרטי העסק השתנו מאז שנפתח המסך. יש לפתוח את המסך מחדש ולאשר שוב." };
    default: return { status: 500, code: "UNKNOWN", message: "המעבר לא בוצע. לא נשמר שום שינוי." };
  }
}

/** The effects list shown on the review screen, before the owner confirms. Facts, not promises. */
export const KIND_TRANSITION_EFFECTS = [
  "סוג העסק בדוביז יתעדכן לעוסק מורשה, באותו תיק עסק. השם המשפטי ומספר הזהות לא משתנים.",
  "תאריך תחילת המעמד ברשות המסים ומועד האישור בדוביז יישמרו בהיסטוריה, יחד עם סוג העסק הקודם.",
  "מסמכים שכבר הונפקו לא משתנים — גם אם מפיקים מהם PDF מחדש. דוביז לא מנפיקה מסמכים בדיעבד.",
  "יתאפשר להנפיק חשבונית מס וחשבונית מס-קבלה. מספור חשבוניות המס מתחיל מסדרה חדשה; מספור הקבלות ממשיך.",
  "בטיוטות חדשות יוצע מע״מ בשיעור הרגיל. כדאי לבדוק טיוטות פתוחות שנוצרו לפני המעבר.",
] as const;
