export type LineKind =
  | "email"
  | "phone"
  | "date"
  | "time"
  | "time_range"
  | "money"
  | "identifier"
  | "label"
  | "vendor_candidate"
  | "recipient"
  | "payment_metadata"
  | "noise"
  | "text";

export type UnderstoodLine = {
  index: number;
  raw: string;
  normalized: string;
  kind: LineKind;
  confidence: number;
  signals: string[];
};

function clean(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function hasHebrewOrEnglish(line: string): boolean {
  return /[א-תa-zA-Z]/.test(line);
}

function looksLikeEmail(line: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(line);
}

function looksLikePhone(line: string): boolean {
  return /(?:\+972|0)\d[\d\- ]{7,}/.test(line);
}

function looksLikeDate(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/.test(lower) ||
    lower.includes("בינואר") ||
    lower.includes("בפברואר") ||
    lower.includes("במרץ") ||
    lower.includes("באפריל") ||
    lower.includes("במאי") ||
    lower.includes("ביוני") ||
    lower.includes("ביולי") ||
    lower.includes("באוגוסט") ||
    lower.includes("בספטמבר") ||
    lower.includes("באוקטובר") ||
    lower.includes("בנובמבר") ||
    lower.includes("בדצמבר")
  );
}

function looksLikeTime(line: string): boolean {
  return /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/.test(line);
}

function looksLikeTimeRange(line: string): boolean {
  return /\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}/.test(line);
}

function looksLikeMoney(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    /(?:₪|ש"ח|ש״ח|שח|ils)/i.test(line) ||
    /\b\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\b/.test(line) ||
    /\b\d+(?:\.\d{1,2})\b/.test(line) ||
    lower.includes("סכום") ||
    lower.includes("סהכ") ||
    lower.includes('סה"כ') ||
    lower.includes("סה״כ") ||
    lower.includes("לתשלום")
  );
}

function looksLikeIdentifier(line: string): boolean {
  const lower = line.toLowerCase();
  const digits = line.replace(/[^\d]/g, "");

  return (
    digits.length >= 5 &&
    (lower.includes("מספר") ||
      lower.includes("קוד") ||
      lower.includes("אסמכתא") ||
      lower.includes("קורס") ||
      lower.includes("הזמנה") ||
      lower.includes("חשבונית") ||
      lower.includes("קבלה"))
  );
}

function looksLikeRecipient(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    lower.includes("לכבוד") ||
    lower.includes("לידי") ||
    lower.includes("עבור") ||
    lower.includes("לקוח")
  );
}

function looksLikePaymentMetadata(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    lower.includes("מספר כרטיס") ||
    lower.includes("כרטיס:") ||
    lower.includes("emv") ||
    lower.includes("contactless") ||
    lower.includes("****") ||
    lower.includes("xx")
  );
}

function looksLikeLabel(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    line.includes(":") ||
    lower.includes("שכר לימוד") ||
    lower.includes("שכ״ל") ||
    lower.includes('שכ"ל') ||
    lower.includes("שכיל") ||
    lower.includes("עלות") ||
    lower.includes("מחיר") ||
    lower.includes("דמי הרשמה") ||
    lower.includes("תנאי תשלום") ||
    lower.includes("מקום") ||
    lower.includes("תאריך") ||
    lower.includes("מספר קורס")
  );
}

function isNoise(line: string): boolean {
  const cleaned = clean(line);
  if (!cleaned) return true;
  if (cleaned === ":" || cleaned === "-" || cleaned === "." || cleaned === "|") return true;
  if (!hasHebrewOrEnglish(cleaned) && cleaned.length < 5) return true;
  return false;
}

export function understandLine(raw: string, index: number): UnderstoodLine {
  const normalized = clean(raw);
  const signals: string[] = [];

  if (isNoise(normalized)) {
    return { index, raw, normalized, kind: "noise", confidence: 0.95, signals: ["noise"] };
  }

  if (looksLikeEmail(normalized)) {
    return { index, raw, normalized, kind: "email", confidence: 0.98, signals: ["email pattern"] };
  }

  if (looksLikePaymentMetadata(normalized)) {
    return { index, raw, normalized, kind: "payment_metadata", confidence: 0.98, signals: ["payment metadata"] };
  }

  if (looksLikeRecipient(normalized)) {
    return { index, raw, normalized, kind: "recipient", confidence: 0.9, signals: ["recipient label"] };
  }

  if (looksLikeTimeRange(normalized)) {
    return { index, raw, normalized, kind: "time_range", confidence: 0.95, signals: ["time range"] };
  }

  if (looksLikeTime(normalized)) {
    return { index, raw, normalized, kind: "time", confidence: 0.95, signals: ["time"] };
  }

  if (looksLikeDate(normalized) && !looksLikeMoney(normalized)) {
    return { index, raw, normalized, kind: "date", confidence: 0.9, signals: ["date"] };
  }

  if (looksLikePhone(normalized)) {
    return { index, raw, normalized, kind: "phone", confidence: 0.9, signals: ["phone"] };
  }

  if (looksLikeIdentifier(normalized)) {
    return { index, raw, normalized, kind: "identifier", confidence: 0.9, signals: ["identifier context"] };
  }

  if (looksLikeMoney(normalized)) {
    return { index, raw, normalized, kind: "money", confidence: 0.85, signals: ["money-like"] };
  }

  if (looksLikeLabel(normalized)) {
    return { index, raw, normalized, kind: "label", confidence: 0.75, signals: ["label-like"] };
  }

  if (hasHebrewOrEnglish(normalized)) {
    return { index, raw, normalized, kind: "vendor_candidate", confidence: 0.55, signals: ["text candidate"] };
  }

  return { index, raw, normalized, kind: "text", confidence: 0.4, signals: [] };
}

export function understandLines(text: string): UnderstoodLine[] {
  return text
    .split("\n")
    .map(clean)
    .filter(Boolean)
    .map((line, index) => understandLine(line, index));
}