export type LineType =
  | "vendor"
  | "total"
  | "subtotal"
  | "vat"
  | "line_item"
  | "payment_amount"
  | "payment_metadata"
  | "date"
  | "noise";

export type ClassifiedLine = {
  type: LineType;
  signals: string[];
};

export function normalizeLineForClassification(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^\u0590-\u05ffa-z0-9%*.]/g, "")
    .trim();
}

function hasMoneyLikeValue(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    /\d+(?:[.,]\d{1,2})/.test(line) ||
    lower.includes("₪") ||
    lower.includes("שח") ||
    lower.includes("ils")
  );
}

function isMostlyDateOrTime(line: string): boolean {
  const raw = line.toLowerCase().trim();

  const hasDate =
    /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/.test(raw) ||
    raw.includes("בנובמבר") ||
    raw.includes("באוקטובר") ||
    raw.includes("בספטמבר") ||
    raw.includes("בדצמבר") ||
    raw.includes("בינואר") ||
    raw.includes("בפברואר") ||
    raw.includes("במרץ") ||
    raw.includes("באפריל") ||
    raw.includes("במאי") ||
    raw.includes("ביוני") ||
    raw.includes("ביולי") ||
    raw.includes("באוגוסט");

  const hasTime = /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(raw);

  if (!hasDate && !hasTime) return false;

  // אם יש סכום אמיתי באותה שורה — לא לסווג כתאריך אוטומטית
  if (hasMoneyLikeValue(raw)) return false;

  const letters = raw.match(/[א-תa-zA-Z]/g)?.length ?? 0;
  const digits = raw.match(/\d/g)?.length ?? 0;

  return digits >= letters;
}

function isPaymentMetadata(line: string): boolean {
  const raw = line.toLowerCase();

  return (
    raw.includes("מספר כרטיס") ||
    raw.includes("כרטיס: xx") ||
    raw.includes("xx") ||
    raw.includes("****") ||
    raw.includes("emv") ||
    raw.includes("contactless") ||
    raw.includes("visa") ||
    raw.includes("mastercard")
  );
}

function isPaymentAmount(line: string): boolean {
  const raw = line.toLowerCase();

  return (
    hasMoneyLikeValue(raw) &&
    (raw.includes("חיוב בכרטיס") ||
      raw.includes("התקבל בכרטיס") ||
      raw.includes("שולם בכרטיס") ||
      raw.includes("שולם") ||
      raw.includes("חיוב"))
  );
}

function isSubtotal(line: string): boolean {
  const raw = line.toLowerCase();

  return (
    raw.includes("סה״כ לפני") ||
    raw.includes('סה"כ לפני') ||
    raw.includes("לפני מע") ||
    raw.includes("ללא מע") ||
    raw.includes("subtotal")
  );
}

function isVat(line: string): boolean {
  const raw = line.toLowerCase();

  return raw.includes("מע״מ") || raw.includes('מע"מ') || raw.includes("vat");
}

function isTotal(line: string): boolean {
  const raw = line.toLowerCase();

  return (
    hasMoneyLikeValue(raw) &&
    (raw.includes("סה״כ") ||
      raw.includes('סה"כ') ||
      raw.includes("סהכ") ||
      raw.includes("לתשלום") ||
      raw.includes("לתשלם") ||
      raw.includes("חייב") ||
      raw.includes("total") ||
      raw.includes("amount due"))
  );
}

function isLineItem(line: string): boolean {
  const raw = line.toLowerCase();

  return (
    raw.includes("כמות") ||
    raw.includes("מחיר") ||
    raw.includes("תיאור") ||
    raw.includes("פריט") ||
    raw.includes("הנחה") ||
    raw.includes("%")
  );
}

function isNoise(line: string): boolean {
  const raw = line.toLowerCase().trim();
  const normalized = normalizeLineForClassification(line);

  if (!normalized || normalized.length < 2) return true;

  return (
    raw === ":" ||
    raw === "-" ||
    raw === "." ||
    raw === "|" ||
    raw.includes("טלפון") ||
    raw.includes("פקס") ||
    raw.includes("לכבוד") ||
    raw.includes("מספרכם") ||
    raw.includes("הזמנה") ||
    raw.includes("אסמכתא")
  );
}

export function classifyLine(line: string): LineType {
  return classifyLineWithContext(line).type;
}

export function classifyLineWithContext(
  line: string,
  previousLine = "",
  nextLine = ""
): ClassifiedLine {
  const current = line || "";
  const context = `${previousLine} ${current} ${nextLine}`;
  const signals: string[] = [];

  if (isPaymentMetadata(current)) {
    signals.push("payment metadata");
    return { type: "payment_metadata", signals };
  }

  if (isPaymentAmount(current) || isPaymentAmount(context)) {
    signals.push("payment amount");
    return { type: "payment_amount", signals };
  }

  if (isSubtotal(current) || isSubtotal(context)) {
    signals.push("subtotal");
    return { type: "subtotal", signals };
  }

  if (isVat(current) || isVat(context)) {
    signals.push("vat");
    return { type: "vat", signals };
  }

  if (isTotal(current) || isTotal(context)) {
    signals.push("total");
    return { type: "total", signals };
  }

  if (isLineItem(current)) {
    signals.push("line item");
    return { type: "line_item", signals };
  }

  if (isMostlyDateOrTime(current)) {
    signals.push("date/time");
    return { type: "date", signals };
  }

  if (isNoise(current)) {
    signals.push("noise");
    return { type: "noise", signals };
  }

  return { type: "vendor", signals: ["vendor candidate"] };
}

export function isAmountAllowedLineType(type: LineType): boolean {
  return (
    type === "total" ||
    type === "payment_amount" ||
    type === "subtotal" ||
    type === "vat"
  );
}

export function isAmountRejectedLineType(type: LineType): boolean {
  return (
    type === "line_item" ||
    type === "payment_metadata" ||
    type === "date" ||
    type === "noise"
  );
}

export function isVendorRejectedLineType(type: LineType): boolean {
  return (
    type === "date" ||
    type === "payment_metadata" ||
    type === "line_item" ||
    type === "total" ||
    type === "subtotal" ||
    type === "vat" ||
    type === "payment_amount" ||
    type === "noise"
  );
}