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

function hasPendingOrQuoteRole(text: string): boolean {
  return includesAny(text, [
    "הצעת מחיר",
    "הזמנה",
    "פירוט מחיר",
    "לתשלום עד",
    "תשלום עתידי",
    "דרישת תשלום",
    "טרם שולם",
    "לא שולם",
    "ממתין לתשלום",
    "pending payment",
    "quote",
    "proposal",
    "order summary",
  ]);
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

  if (hasNegativePaymentSignal(text)) {
    return "unknown";
  }

  if (hasClearIncomeSignal(text)) {
    return "income";
  }

  const paymentProof = hasPaymentProof(text);
  const receiptRole = hasReceiptRole(text);
  const pendingOrQuote = hasPendingOrQuoteRole(text);

  if (pendingOrQuote) {
    return "unknown";
  }

  const isReceiptLike =
    documentType === "receipt" ||
    documentType.includes("receipt") ||
    documentType.includes("invoice") ||
    receiptRole;

  const isFinancialTransaction =
    guardrailRoute === "financial_transaction" ||
    guardrailRoute.includes("financial_transaction");

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