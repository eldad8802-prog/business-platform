export type AmountClass =
  | "total"
  | "subtotal"
  | "vat"
  | "fee"
  | "hours"
  | "id"
  | "noise";

export function classifyAmountLine(line: string): AmountClass {
  const lower = line.toLowerCase().trim();

  if (/^\d{5,}$/.test(lower)) return "id";

  if (
    lower.includes("מספר קורס") ||
    lower.includes("קוד") ||
    lower.includes("אסמכתא") ||
    lower.includes("מספר מסמך") ||
    lower.includes("מספר:")
  ) {
    return "id";
  }

  if (
    lower.includes("שעות") ||
    lower.includes("שעות אקדמיות") ||
    /\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/.test(lower)
  ) {
    return "hours";
  }

  if (lower.includes("דמי הרשמה")) return "fee";

  if (
    lower.includes('מע"מ') ||
    lower.includes("מע״מ") ||
    lower.includes("vat")
  ) {
    return "vat";
  }

  if (
    lower.includes("סהכ") ||
    lower.includes('סה"כ') ||
    lower.includes("סה״כ") ||
    lower.includes("לתשלום") ||
    lower.includes("סכום כולל") ||
    lower.includes("שכר לימוד") ||
    lower.includes("שכיל לקורס") ||
    lower.includes("שכ״ל") ||
    lower.includes("שכ\"ל")
  ) {
    return "total";
  }

  return "noise";
}