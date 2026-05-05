type Direction = "income" | "expense" | "unknown";

type NormalizedDocument = {
  direction: Direction;
  amount: number;
  documentDate: Date | null;
  counterpartyName: string;
  needsReview: boolean;
  searchableText: string;
};

type Confidence = "high" | "medium" | "low";

type Input = {
  amount: number;
  vendorName: string;
  date: Date | null;
  amountConfidence: Confidence;
  vendorConfidence: Confidence;
  dateConfidence: Confidence;
  rawText: string;
  documentType?: string | null;
  documentTypeConfidence?: Confidence | null;
  guardrailRoute?: string | null;
};

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function includesAny(text: string, signals: string[]): boolean {
  return signals.some((signal) => text.includes(signal.toLowerCase()));
}

function hasNegativePaymentSignal(text: string): boolean {
  return includesAny(text, [
    "טרם שולם",
    "לא שולם",
    "לא בוצע חיוב",
    "לא בוצע תשלום",
    "ממתין לתשלום",
    "טרם בוצע תשלום",
    "pending payment",
    "unpaid",
    "not paid",
  ]);
}

function hasClearIncomeSignal(text: string): boolean {
  return includesAny(text, [
    "התקבל בחשבונך",
    "התקבל לחשבונך",
    "זוכה חשבונך",
    "זיכוי לחשבון",
    "העברה נכנסת",
    "כניסה לחשבון",
    "שולם לנו",
    "קיבלנו תשלום",
    "התקבל תשלום מלקוח",
    "לקוח שילם",
    "received payment",
    "incoming transfer",
    "credit received",
  ]);
}

function hasPaymentProof(text: string): boolean {
  return includesAny(text, [
    "אישור תשלום",
    "אישור על קבלת תשלום",
    "קבלת תשלום",
    "סכום תשלום",
    "שולם",
    "שולמה",
    "שולם באמצעות",
    "חיוב בכרטיס",
    "חויב בכרטיס",
    "חויב",
    "אשראי",
    "כרטיס אשראי",
    "מספר אישור",
    "שבא",
    "ישראכרט",
    "ויזה",
    "מאסטרקארד",
    "mastercard",
    "visa",
    "paid",
    "payment approved",
    "receipt",
  ]);
}

function hasReceiptRole(text: string): boolean {
  return includesAny(text, [
    "קבלה",
    "חשבונית מס קבלה",
    "חשבונית/קבלה",
    "חשבונית מס",
    "אנו מודים לך על התשלומים",
    "פרטי התשלום",
    "מקור התשלום",
  ]);
}

/** Quote / order / future payment — block direction unless strong payment evidence exists. */
function hasPendingQuoteBlocking(text: string): boolean {
  return includesAny(text, [
    "הצעת מחיר",
    "הזמנה",
    "פירוט מחיר",
    "לתשלום עד",
    "תשלום עתידי",
    "דרישת תשלום",
    "quote",
    "proposal",
    "order summary",
  ]);
}

/** ₪ / ש"ח alone must not imply executed payment (regulatory PDFs use "בש\"ח"). */
const CURRENCY_HINT_SIGNALS = ["₪", 'ש"ח'];

/** Card/network tokens — strong for retail slips, not alone on tax/pension certificates. */
const CARD_OR_APPROVAL_MARKERS = [
  "מספר אישור",
  "שבא",
  "ישראכרט",
  "ויזה",
  "מאסטרקארד",
  "מאסטרכרד",
  "מסטרקרד",
  "mastercard",
  "visa",
];

/**
 * Completed payment / tender / slip signals excluding bare currency.
 * Includes card brands (see regulatory branch in hasStrongPaymentExecution).
 */
const EXECUTION_CORE_SIGNALS = [
  "אישור תשלום",
  "אישור על קבלת תשלום",
  "קבלת תשלום",
  "סכום תשלום",
  "סכום עסקה",
  "שולם",
  "שולמה",
  "שולם באמצעות",
  "חיוב בכרטיס",
  "חויב בכרטיס",
  "חויב",
  "אשראי",
  "כרטיס אשראי",
  "מזומן",
  ...CARD_OR_APPROVAL_MARKERS,
  "paid",
  "payment approved",
];

/** Tax/pension / declaration — card line OCR must not imply expense without real payment verbs. */
const REGULATORY_CERTIFICATE_MARKERS = [
  "אישור מס",
  "הצהרת הון",
  "קרן פנסיה",
  "פנסיה מקיפה",
  "הפקדה לקצבה",
  "פקודת מס הכנסה",
  "תיק ניכויים",
  "ניכוי מס במקור",
];

/** On regulatory docs, only these (plus currency+retail bridge) count as executed payment. */
const REGULATORY_PAID_EXECUTION_SIGNALS = [
  "אישור תשלום",
  "אישור על קבלת תשלום",
  "קבלת תשלום",
  "סכום תשלום",
  "סכום עסקה",
  "שולם",
  "שולמה",
  "שולם באמצעות",
  "חיוב בכרטיס",
  "חויב בכרטיס",
  "חויב",
  "כרטיס אשראי",
  "מזומן",
  "ספח אשראי",
  "paid",
  "payment approved",
];

function hasCurrencyHint(text: string): boolean {
  return includesAny(text, CURRENCY_HINT_SIGNALS);
}

function hasRegulatoryCertificateContext(text: string): boolean {
  return includesAny(text, REGULATORY_CERTIFICATE_MARKERS);
}

/** Retail / POS framing — currency may reinforce payment only with this (not regulatory boilerplate). */
function hasRetailPaymentContextForCurrency(text: string): boolean {
  return hasReceiptRole(text);
}

function hasExecutionCore(text: string): boolean {
  return includesAny(text, EXECUTION_CORE_SIGNALS);
}

function hasRegulatoryPaidExecution(text: string): boolean {
  return includesAny(text, REGULATORY_PAID_EXECUTION_SIGNALS);
}

/**
 * Strong execution: real tender / completion signals.
 * Currency hints (₪, ש"ח) count only together with retail receipt-like context.
 * On regulatory certificates, card-brand OCR lines do not suffice unless explicit paid verbs/tender.
 */
function hasStrongPaymentExecution(text: string): boolean {
  const regulatory = hasRegulatoryCertificateContext(text);

  if (regulatory) {
    return (
      hasRegulatoryPaidExecution(text) ||
      (hasCurrencyHint(text) && hasRetailPaymentContextForCurrency(text))
    );
  }

  return (
    hasExecutionCore(text) ||
    (hasCurrencyHint(text) && hasRetailPaymentContextForCurrency(text))
  );
}

function extractIncomeCounterparty(text: string): string | null {
  const patterns = [
    /שם\s+מעביר\s*:?\s*(.+)/i,
    /שם\s+משלם\s*:?\s*(.+)/i,
    /שם\s+לקוח\s*:?\s*(.+)/i,
    /מאת\s*:?\s*(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();

    if (value) {
      return value.replace(/[.,;]+$/, "").trim();
    }
  }

  return null;
}

function detectDirection(input: {
  rawText: string;
  documentType?: string | null;
  documentTypeConfidence?: Confidence | null;
  guardrailRoute?: string | null;
}): Direction {
  const text = normalizeText(input.rawText);
  const documentType = normalizeText(input.documentType);
  const guardrailRoute = normalizeText(input.guardrailRoute);

  if (!text) return "unknown";

  const receiptRole = hasReceiptRole(text);
  const isReceiptLike =
    documentType === "receipt" ||
    documentType.includes("receipt") ||
    documentType.includes("invoice") ||
    receiptRole;

  const isFinancialTransaction =
    guardrailRoute === "financial_transaction" ||
    guardrailRoute.includes("financial_transaction");

  const strongExecution = hasStrongPaymentExecution(text);
  const strongPaymentBundle =
    (receiptRole || isReceiptLike || isFinancialTransaction) &&
    strongExecution;

  if (hasNegativePaymentSignal(text) && !strongPaymentBundle) {
    return "unknown";
  }

  if (strongPaymentBundle) {
    return "expense";
  }

  if (hasClearIncomeSignal(text)) {
    return "income";
  }

  if (hasPendingQuoteBlocking(text)) {
    return "unknown";
  }

  const paymentProof = hasPaymentProof(text);

  if ((isReceiptLike || isFinancialTransaction) && paymentProof) {
    return "expense";
  }

  if (receiptRole && paymentProof) {
    return "expense";
  }

  return "unknown";
}

export function normalizeFinancialDocument(input: Input): NormalizedDocument {
  const {
    amount,
    vendorName,
    date,
    amountConfidence,
    vendorConfidence,
    dateConfidence,
    rawText,
    documentType,
    documentTypeConfidence,
    guardrailRoute,
  } = input;

  const direction = detectDirection({
    rawText,
    documentType,
    documentTypeConfidence,
    guardrailRoute,
  });

  const counterpartyName =
    direction === "income" && !vendorName
      ? extractIncomeCounterparty(rawText) ?? ""
      : vendorName;

  const needsReview =
    amountConfidence !== "high" ||
    vendorConfidence === "low" ||
    dateConfidence === "low" ||
    direction === "unknown" ||
    !counterpartyName;

  return {
    direction,
    amount,
    documentDate: date,
    counterpartyName,
    needsReview,
    searchableText: rawText,
  };
}