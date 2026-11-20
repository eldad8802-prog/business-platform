/**
 * Path A — "מעבר לעוסק מורשה" (owner decision 2026-11-20): an exempt dealer (עוסק פטור) becomes an authorized dealer
 * (עוסק מורשה) inside the SAME business file. Same legal entity, same id number, same legal name.
 *
 * This module is the pure core of that flow: who may start it, what the owner must type and acknowledge, the exact
 * statement the owner confirms (and its digest, so the server can prove WHAT was confirmed), and the list of effects
 * shown before confirming. It never writes. The write itself needs a separately approved database function (the
 * signup lock DZL04 and the issuer-declaration lock DZD35 refuse a kind change from the application roles), so
 * nothing here is wired to a route yet.
 *
 * What the flow must never do (enforced by the database, restated here for the reader):
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

/** What the server knows about the business when the flow opens. Every field is server-derived. */
export type KindTransitionState = {
  billingBusinessKind: string | null;
  billingLegalName: string | null;
  billingTaxId: string | null;
  billingVatNumber: string | null;
  /** Business.deletionRequestedAt / deletedAt set. */
  businessBeingDeleted: boolean;
  /** The signed-in user is the business's authorized user (today: the only user of the business). */
  actorIsAuthorizedUser: boolean;
};

export type KindTransitionBlock =
  | "NOT_EXEMPT_DEALER"
  | "BUSINESS_BEING_DELETED"
  | "NOT_AUTHORIZED_USER"
  | "IDENTITY_INCOMPLETE";

export type KindTransitionEligibility = { eligible: true } | { eligible: false; block: KindTransitionBlock; message: string };

const BLOCK_MESSAGES: Record<KindTransitionBlock, string> = {
  NOT_EXEMPT_DEALER: "המעבר זמין רק לעסק שמוגדר כעוסק פטור.",
  BUSINESS_BEING_DELETED: "החשבון בתהליך מחיקה, ולכן אי אפשר לבצע מעבר.",
  NOT_AUTHORIZED_USER: "רק בעל העסק המורשה יכול לבצע את המעבר.",
  IDENTITY_INCOMPLETE: "כדי לבצע מעבר צריך שם משפטי ומספר זהות תקין בפרטי העסק.",
};

/** Whether the "מעבר לעוסק מורשה" action may be offered and started. */
export function evaluateKindTransitionEligibility(s: KindTransitionState): KindTransitionEligibility {
  const block = (b: KindTransitionBlock): KindTransitionEligibility => ({ eligible: false, block: b, message: BLOCK_MESSAGES[b] });
  if (s.businessBeingDeleted) return block("BUSINESS_BEING_DELETED");
  if (parseBillingBusinessKind(s.billingBusinessKind) !== "EXEMPT_DEALER") return block("NOT_EXEMPT_DEALER");
  if (!s.actorIsAuthorizedUser) return block("NOT_AUTHORIZED_USER");
  if ((s.billingLegalName ?? "").trim().length < 2 || authoritativeTaxId(s.billingTaxId) === null) return block("IDENTITY_INCOMPLETE");
  return { eligible: true };
}

/**
 * The acknowledgements the owner must tick, each one explicitly. Ids are stable (they are part of the confirmed
 * statement); the text is what the screen shows.
 */
export const KIND_TRANSITION_ACKNOWLEDGEMENTS = [
  { id: "registered_with_vat_authority", text: "אני רשום/ה כעוסק מורשה ברשות המסים. דוביז לא משנה את הרישום ברשות המסים — היא מעדכנת את סוג העסק בדוביז לפי ההצהרה שלי." },
  { id: "same_legal_entity", text: "מדובר באותו אדם, באותו שם משפטי ובאותו מספר זהות. שינוי שם או מספר מחייב פתיחת תיק עסק חדש." },
  { id: "issued_documents_unchanged", text: "מסמכים שכבר הונפקו כעוסק פטור נשארים בדיוק כפי שהונפקו." },
  { id: "new_documents_as_authorized", text: "מרגע המעבר, מסמכים חדשים יונפקו כעוסק מורשה, כולל חשבוניות מס ומע״מ לפי הכללים." },
  { id: "not_reversible_in_dubiz", text: "המעבר לא ניתן לביטול עצמי בדוביז." },
] as const;

export type KindTransitionAcknowledgementId = (typeof KIND_TRANSITION_ACKNOWLEDGEMENTS)[number]["id"];

export type KindTransitionInput = {
  /** The owner retypes the id number on the business file — proves it is the same entity, never edits it. */
  confirmTaxId: string;
  /** The VAT registration number (מספר עוסק מורשה). */
  vatNumber: string;
  acknowledged: string[];
};

export type KindTransitionField = "confirmTaxId" | "vatNumber" | "acknowledged";
export type KindTransitionProblem = { field: KindTransitionField; code: string; message: string };

export type KindTransitionValidation =
  | { ok: true; vatNumber: string; taxId: string }
  | { ok: false; problems: KindTransitionProblem[] };

/**
 * Policy switch, owner decision pending: for an individual authorized dealer the VAT file number is normally the
 * person's own id number. When true, a VAT number different from the id number on the file is refused (safer: it
 * cannot smuggle in a different entity). Default true until the owner decides otherwise.
 */
export const VAT_NUMBER_MUST_EQUAL_TAX_ID = true;

/** Validate what the owner typed and ticked. Every problem at once; no message echoes a value. */
export function validateKindTransitionInput(
  s: Pick<KindTransitionState, "billingTaxId">,
  input: KindTransitionInput,
  opts: { vatMustEqualTaxId?: boolean } = {}
): KindTransitionValidation {
  const vatMustEqual = opts.vatMustEqualTaxId ?? VAT_NUMBER_MUST_EQUAL_TAX_ID;
  const problems: KindTransitionProblem[] = [];
  const fileTax = authoritativeTaxId(s.billingTaxId);

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
  } else if (vatMustEqual && fileTax !== null && vat !== fileTax) {
    problems.push({ field: "vatNumber", code: "DIFFERS_FROM_TAX_ID", message: "לעוסק מורשה יחיד, מספר העוסק המורשה זהה למספר הזהות. מספר אחר מעיד על ישות אחרת — יש לפתוח תיק עסק חדש." });
  }

  const ticked = new Set(input.acknowledged ?? []);
  const missing = KIND_TRANSITION_ACKNOWLEDGEMENTS.filter((a) => !ticked.has(a.id));
  const unknown = [...ticked].filter((id) => !KIND_TRANSITION_ACKNOWLEDGEMENTS.some((a) => a.id === id));
  if (missing.length > 0 || unknown.length > 0) {
    problems.push({ field: "acknowledged", code: "INCOMPLETE", message: "יש לאשר את כל הסעיפים לפני המעבר." });
  }

  if (problems.length > 0 || vat === null || fileTax === null) return { ok: false, problems };
  return { ok: true, vatNumber: vat, taxId: fileTax };
}

export type KindTransitionStatementFields = {
  businessId: number;
  actorUserId: number;
  legalName: string;
  taxId: string;
  vatNumber: string;
};

/**
 * The exact text the owner confirms. Canonical: fixed field order, one line each, normalised values. The server
 * recomputes it from the database at confirmation time and refuses if the digest the screen showed differs
 * (the business file changed in between).
 */
export function canonicalKindTransitionStatement(f: KindTransitionStatementFields): string {
  const lines = [
    `statement=${KIND_TRANSITION_STATEMENT_VERSION}`,
    `business=${f.businessId}`,
    `actor=${f.actorUserId}`,
    `from=EXEMPT_DEALER`,
    `to=AUTHORIZED_DEALER`,
    `legalName=${f.legalName.trim().replace(/\s+/g, " ")}`,
    `taxId=${authoritativeTaxId(f.taxId) ?? f.taxId.trim()}`,
    `vatNumber=${authoritativeTaxId(f.vatNumber) ?? f.vatNumber.trim()}`,
    ...KIND_TRANSITION_ACKNOWLEDGEMENTS.map((a) => `ack=${a.id}`),
  ];
  return lines.join("\n");
}

export function kindTransitionStatementSha256(f: KindTransitionStatementFields): string {
  return createHash("sha256").update(canonicalKindTransitionStatement(f), "utf8").digest("hex");
}

/** The effects list shown on the review screen, before the owner confirms. Facts, not promises. */
export const KIND_TRANSITION_EFFECTS = [
  "סוג העסק בדוביז יתעדכן לעוסק מורשה, באותו תיק עסק. השם המשפטי ומספר הזהות לא משתנים.",
  "סוג העסק הקודם ומועד המעבר יישמרו בהיסטוריה.",
  "מסמכים שכבר הונפקו לא משתנים — גם אם מפיקים מהם PDF מחדש.",
  "יתאפשר להנפיק חשבונית מס וחשבונית מס-קבלה. מספור חשבוניות המס מתחיל מסדרה חדשה; מספור הקבלות ממשיך.",
  "בטיוטות חדשות יוצע מע״מ בשיעור הרגיל. כדאי לבדוק טיוטות פתוחות שנוצרו לפני המעבר.",
  "אם קיימת הצהרת מנפיק, תירשם לה גרסה חדשה מסוג שינוי מעמד.",
] as const;
