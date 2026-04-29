export type DocumentType =
  | "invoice"
  | "receipt"
  | "donation_receipt"
  | "bank_transfer"
  | "quote"
  | "non_financial";

type Confidence = "high" | "medium" | "low";

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function hasFinancialKeywords(text: string): boolean {
  return (
    text.includes("₪") ||
    text.includes("שח") ||
    text.includes('ש"ח') ||
    text.includes("סהכ") ||
    text.includes('סה"כ') ||
    text.includes("סה״כ") ||
    text.includes("סך הכל") ||
    text.includes("לתשלום") ||
    text.includes("חשבונית") ||
    text.includes("קבלה") ||
    text.includes("תרומה") ||
    text.includes("סכום") ||
    text.includes("תשלום") ||
    text.includes("העברה") ||
    text.includes("אשראי") ||
    text.includes("total") ||
    text.includes("amount") ||
    text.includes("payment") ||
    text.includes("invoice") ||
    text.includes("receipt")
  );
}

function hasNonFinancialSignals(text: string): boolean {
  return (
    text.includes("קורות חיים") ||
    text.includes("resume") ||
    text.includes("cv") ||
    text.includes("ניסיון תעסוקתי") ||
    text.includes("השכלה") ||
    text.includes("מיומנויות") ||
    text.includes("חוזה") ||
    text.includes("הסכם") ||
    text.includes("contract")
  );
}

export function detectDocumentType(text: string): {
  documentType: DocumentType;
  confidence: Confidence;
  isFinancial: boolean;
  signals: string[];
  reasons: string[];
} {
  const t = normalize(text);

  const signals: string[] = [];
  const reasons: string[] = [];

  let score = {
    invoice: 0,
    receipt: 0,
    donation_receipt: 0,
    bank_transfer: 0,
    quote: 0,
  };

  // 🧾 Invoice
  if (t.includes("חשבונית")) {
    score.invoice += 20;
    signals.push("invoice_keyword");
  }
  if (t.includes("חשבונית מס")) score.invoice += 30;
  if (t.includes("עוסק מורשה")) score.invoice += 10;
  if (t.includes("מע\"מ") || t.includes("מע״מ")) score.invoice += 15;

  // 🧾 Receipt
  if (t.includes("קבלה")) {
    score.receipt += 25;
    signals.push("receipt_keyword");
  }
  if (t.includes("לתשלום")) score.receipt += 10;
  if (t.includes("סה\"כ") || t.includes("סה״כ")) score.receipt += 10;

  // 🎁 Donation
  if (t.includes("תרומה")) {
    score.donation_receipt += 30;
    signals.push("donation_keyword");
  }

  // 🏦 Bank transfer
  if (t.includes("העברת כספים")) score.bank_transfer += 30;
  if (t.includes("חשבון מספר")) score.bank_transfer += 20;
  if (t.includes("בנק")) score.bank_transfer += 10;

  // 📄 Quote
  if (t.includes("הצעת מחיר")) score.quote += 30;

  const sorted = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [bestType, bestScore] = sorted[0];

  const financialKeywords = hasFinancialKeywords(t);
  const nonFinancial = hasNonFinancialSignals(t);

  if (nonFinancial && !financialKeywords) {
    return {
      documentType: "non_financial",
      confidence: "high",
      isFinancial: false,
      signals,
      reasons: ["non_financial_keywords"],
    };
  }

  if (bestScore < 15 && !financialKeywords) {
    return {
      documentType: "non_financial",
      confidence: "medium",
      isFinancial: false,
      signals,
      reasons: ["low_score_no_financial_signals"],
    };
  }

  return {
    documentType: bestType as DocumentType,
    confidence: bestScore >= 30 ? "high" : "medium",
    isFinancial: true,
    signals,
    reasons,
  };
}