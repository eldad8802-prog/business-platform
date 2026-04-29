type Confidence = "high" | "medium" | "low";

export type DocumentGuardrailRoute =
  | "financial_transaction"
  | "non_transaction"
  | "uncertain";

export type DocumentGuardrailResult = {
  route: DocumentGuardrailRoute;
  confidence: Confidence;
  shouldContinueExtraction: boolean;
  forceReview: boolean;
  reasons: string[];
  positiveSignals: string[];
  negativeSignals: string[];
};

type EvaluateDocumentGuardrailInput = {
  text: string;
  documentType: string;
  documentTypeConfidence: Confidence;
};

function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();

  return keywords.reduce((count, keyword) => {
    return lower.includes(keyword.toLowerCase()) ? count + 1 : count;
  }, 0);
}

function countMoneySignals(text: string): number {
  const shekelMatches =
    text.match(/₪|ש"ח|ש״ח|שח|nis|ils/gi) ?? [];

  const moneyLikeMatches =
    text.match(/\b\d{1,7}(?:[,.]\d{1,2})?\b/g) ?? [];

  const validMoneyNumbers = moneyLikeMatches.filter((raw) => {
    const cleaned = raw.replace(/,/g, "");
    const value = Number(cleaned);

    if (!Number.isFinite(value)) return false;
    if (value <= 0) return false;

    // לא לספור שנים כתשלום
    if (value >= 1900 && value <= 2099) return false;

    // לא לספור מספרים קטנים מדי כמו 1, 2, 6 תשלומים
    if (value < 10) return false;

    return true;
  });

  return shekelMatches.length + validMoneyNumbers.length;
}

function hasClearTotalArea(text: string): boolean {
  const totalKeywords = [
    "סהכ",
    'סה"כ',
    "סה״כ",
    "סך הכל",
    "לתשלום",
    "סכום לתשלום",
    "total",
    "amount due",
  ];

  return countMatches(text, totalKeywords) > 0;
}

function hasPaymentArea(text: string): boolean {
  const paymentKeywords = [
    "אשראי",
    "כרטיס",
    "מזומן",
    "העברה בנקאית",
    "שולם",
    "חשבונית מס",
    "קבלה",
    "invoice",
    "receipt",
    "payment",
  ];

  return countMatches(text, paymentKeywords) > 0;
}

function hasSupportDocumentSignals(text: string): boolean {
  const supportKeywords = [
    "פוליסה",
    "מבוטח",
    "תביעה",
    "תביעות",
    "מכתב",
    "הודעה",
    "טופס",
    "סעיף",
    "חוק",
    "חתימה",
    "אישור",
    "הסכמה",
    "התנגדות",
    "דרישה",
    "הצהרה",
  ];

  return countMatches(text, supportKeywords) >= 3;
}
function hasIncomeTransactionSignals(text: string): boolean {
  const incomeKeywords = [
    "העברה נכנסת",
    "זיכוי לחשבון",
    "זוכה חשבונך",
    "התקבל בחשבונך",
    "התקבל תשלום",
    "תשלום התקבל",
    "שולם לנו",
    "לקוח שילם",
    "תשלום מלקוח",
    "received payment",
    "incoming transfer",
    "credit received",
  ];

  return countMatches(text, incomeKeywords) > 0;
}
function hasTransactionDocumentSignals(text: string): boolean {
  const transactionKeywords = [
    "חשבונית",
    "קבלה",
    "חשבונית מס",
    "מס קבלה",
    "הזמנה",
    "הצעת מחיר",
    "תיאור פריט",
    "מחיר יחידה",
    "כמות",
    "מע״מ",
    'מע"מ',
    "subtotal",
    "invoice",
    "receipt",
  ];

  return countMatches(text, transactionKeywords) >= 2;
}

export function evaluateDocumentGuardrail(
  input: EvaluateDocumentGuardrailInput
): DocumentGuardrailResult {
  const { text, documentType, documentTypeConfidence } = input;

  const moneySignals = countMoneySignals(text);
  const clearTotalArea = hasClearTotalArea(text);
  const paymentArea = hasPaymentArea(text);
  const transactionSignals = hasTransactionDocumentSignals(text);
  const supportSignals = hasSupportDocumentSignals(text);
const incomeSignals = hasIncomeTransactionSignals(text);
  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];
  const reasons: string[] = [];

  let positiveScore = 0;
  let negativeScore = 0;

  if (moneySignals >= 2) {
    positiveScore += 2;
    positiveSignals.push("multiple money signals");
  } else if (moneySignals === 1) {
    positiveScore += 1;
    positiveSignals.push("single money signal");
  }

  if (clearTotalArea) {
    positiveScore += 2;
    positiveSignals.push("clear total/payment amount area");
  }

  if (paymentArea) {
    positiveScore += 1;
    positiveSignals.push("payment/invoice signal");
  }
if (incomeSignals && moneySignals >= 1) {
  positiveScore += 4;
  positiveSignals.push("income transaction signal");
}
  if (transactionSignals) {
    positiveScore += 2;
    positiveSignals.push("transaction document structure signals");
  }

  if (documentType === "invoice" || documentType === "receipt") {
    positiveScore += documentTypeConfidence === "high" ? 2 : 1;
    positiveSignals.push(`document type detected as ${documentType}`);
  }

  if (supportSignals) {
    negativeScore += 3;
    negativeSignals.push("support/legal/insurance-like document signals");
  }

  if (moneySignals === 0) {
    negativeScore += 2;
    negativeSignals.push("no clear money amount");
  }

  if (!clearTotalArea && !paymentArea && moneySignals <= 1) {
    negativeScore += 2;
    negativeSignals.push("no reliable transaction payment structure");
  }

  if (negativeScore >= positiveScore + 2) {
    reasons.push("Document does not look like a reliable financial transaction");

    return {
      route: "non_transaction",
      confidence: negativeScore >= 5 ? "high" : "medium",
      shouldContinueExtraction: false,
      forceReview: true,
      reasons,
      positiveSignals,
      negativeSignals,
    };
  }

  if (positiveScore >= negativeScore + 2) {
    reasons.push("Document has enough transaction structure to continue extraction");

    return {
      route: "financial_transaction",
      confidence: positiveScore >= 5 ? "high" : "medium",
      shouldContinueExtraction: true,
      forceReview: false,
      reasons,
      positiveSignals,
      negativeSignals,
    };
  }

  reasons.push("Document route is uncertain and requires review");

  return {
    route: "uncertain",
    confidence: "low",
    shouldContinueExtraction: true,
    forceReview: true,
    reasons,
    positiveSignals,
    negativeSignals,
  };
}