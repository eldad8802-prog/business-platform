export type Confidence = "high" | "medium" | "low";

export type FinancialAmountRole = {
  value: number;
  raw: string;
  confidence: Confidence;
  source:
    | "explicit_total"
    | "amount_due"
    | "transfer_amount"
    | "subtotal"
    | "unknown";
  line: string;
  reason: string;
};

export type FinancialRoles = {
  totalAmount: FinancialAmountRole | null;
  subtotalAmount: FinancialAmountRole | null;
  vatAmount: FinancialAmountRole | null;
  feeAmount: FinancialAmountRole | null;
};

function cleanLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function normalizeMoneyText(text: string): string {
  return text
    .replace(/₪\s*(\d{1,3})\s*,\s*(\d{3}(?:\.\d{1,2})?)/g, "₪$1,$2")
    .replace(/₪\s*(\d{1,3})\s+(\d{3}(?:\.\d{1,2})?)/g, "₪$1,$2")
    .replace(
      /₪\s*(\d{1,3})\s+(\d{3})\s+(\d{3}(?:\.\d{1,2})?)/g,
      "₪$1,$2,$3"
    )
    .replace(/₪/g, " ₪ ")
    .replace(/ש״ח/g, " שח ")
    .replace(/ש"ח/g, " שח ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\u0590-\u05ffa-z0-9]/g, "")
    .trim();
}

function parseAmount(raw: string): number {
  const cleaned = raw.replace(/,/g, "").replace(/[^\d.]/g, "");
  return Number(cleaned);
}

function extractAmountsFromText(text: string): { raw: string; value: number }[] {
  const normalized = normalizeMoneyText(text);

  const patterns = [
    /₪\s*\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?/g,
    /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\s*(?:₪|שח)/g,
    /₪\s*\d+(?:\.\d{1,2})?/g,
    /\d+(?:\.\d{1,2})?\s*(?:₪|שח)/g,
    /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?/g,
    /\d+(?:\.\d{1,2})?/g,
  ];

  const results: { raw: string; value: number }[] = [];
  const usedRanges: { start: number; end: number }[] = [];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(normalized)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      const overlaps = usedRanges.some(
        (range) => start < range.end && range.start < end
      );

      if (overlaps) continue;

      const raw = match[0].trim();
      const value = parseAmount(raw);

      if (!Number.isFinite(value)) continue;
      if (value <= 0) continue;

      usedRanges.push({ start, end });
      results.push({ raw, value });
    }
  }

  return results;
}

function isDateLike(line: string): boolean {
  return /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/.test(line);
}

function isValidFinancialAmount(value: number, line: string): boolean {
  if (value < 10) return false;
  if (value > 1_000_000) return false;
  if (value >= 1900 && value <= 2099 && isDateLike(line)) return false;
  return true;
}

function isPaymentNoiseLine(line: string): boolean {
  const normalized = normalizeForLabel(line);
  const lower = line.toLowerCase();

  return (
    normalized.includes("כרטיס") ||
    normalized.includes("מספרכרטיס") ||
    normalized.includes("אשראי") ||
    normalized.includes("התקבלבכרטיס") ||
    lower.includes("emv") ||
    lower.includes("contactless") ||
    lower.includes("visa") ||
    lower.includes("mastercard") ||
    lower.includes("card")
  );
}

function getBestAmountFromLine(
  line: string
): { raw: string; value: number } | null {
  if (isPaymentNoiseLine(line)) return null;

  const amounts = extractAmountsFromText(line).filter((amount) =>
    isValidFinancialAmount(amount.value, line)
  );

  if (amounts.length === 0) return null;

  return amounts.sort((a, b) => b.value - a.value)[0];
}

function makeRole(
  amount: { raw: string; value: number },
  confidence: Confidence,
  source: FinancialAmountRole["source"],
  line: string,
  reason: string
): FinancialAmountRole {
  return {
    value: amount.value,
    raw: amount.raw,
    confidence,
    source,
    line,
    reason,
  };
}

function findAmountNearLine(
  lines: string[],
  index: number
): { amount: { raw: string; value: number }; line: string } | null {
  const current = lines[index] || "";
  const prev1 = lines[index - 1] || "";
  const prev2 = lines[index - 2] || "";
  const next1 = lines[index + 1] || "";
  const next2 = lines[index + 2] || "";

  const searchLines = [
    current,
    `${prev1} ${current}`,
    `${prev2} ${prev1} ${current}`,
    `${current} ${next1}`,
    `${current} ${next1} ${next2}`,
    `${prev1} ${current} ${next1}`,
  ]
    .map((line) => cleanLine(line || ""))
    .filter(Boolean)
    .filter((line) => !isPaymentNoiseLine(line));

  for (const line of searchLines) {
    const amount = getBestAmountFromLine(line);
    if (amount) {
      return { amount, line };
    }
  }

  return null;
}

function isExplicitFinalTotalLabel(line: string): boolean {
  const normalized = normalizeForLabel(line);

  if (isPaymentNoiseLine(line)) {
    return false;
  }

  return (
    normalized.includes("סהכלתשלום") ||
    normalized.includes("סךהכללתשלום") ||
    normalized.includes("סהככולל") ||
    normalized.includes("סהכבשח") ||
    normalized.includes("לתשלום") ||
    normalized.includes("amountdue") ||
    normalized.includes("totaldue") ||
    normalized.includes("grandtotal") ||
    normalized.includes("סהכ") ||
    normalized.includes("כסה")
  );
}

function isSubtotalLabel(line: string): boolean {
  const normalized = normalizeForLabel(line);

  if (isPaymentNoiseLine(line)) {
    return false;
  }

  return (
    normalized.includes("לפנימעמ") ||
    normalized.includes("סהכלפנימעמ") ||
    normalized.includes("סהכחייבבמעמ") ||
    normalized.includes("subtotal") ||
    normalized.includes("סכוםביניים")
  );
}

function isVatLabel(line: string): boolean {
  const normalized = normalizeForLabel(line);

  if (isPaymentNoiseLine(line)) {
    return false;
  }

  return normalized.includes("מעמ") || normalized.includes("vat");
}

function isFeeLabel(line: string): boolean {
  const normalized = normalizeForLabel(line);

  if (isPaymentNoiseLine(line)) {
    return false;
  }

  return (
    normalized.includes("עמלה") ||
    normalized.includes("fee") ||
    normalized.includes("commission")
  );
}

function isTransferAmountLabel(line: string): boolean {
  const normalized = normalizeForLabel(line);

  if (isPaymentNoiseLine(line)) {
    return false;
  }

  return (
    normalized.includes("סכום") ||
    normalized.includes("סכוםהעברה") ||
    normalized.includes("סכוםההעברה") ||
    normalized.includes("הועבר") ||
    normalized.includes("העברה")
  );
}

function isLikelyNotFinalAmountLine(line: string): boolean {
  const normalized = normalizeForLabel(line);

  return (
    isPaymentNoiseLine(line) ||
    normalized.includes("מחיריחידה") ||
    normalized.includes("כמות") ||
    normalized.includes("עמלה") ||
    normalized.includes("ריבית") ||
    normalized.includes("יתרה") ||
    normalized.includes("אסמכתא") ||
    normalized.includes("מספרחשבון") ||
    normalized.includes("חשבוןמספר") ||
    normalized.includes("סניף") ||
    normalized.includes("טלפון") ||
    normalized.includes("פקס") ||
    normalized.includes("חפ") ||
    normalized.includes("עמ") ||
    normalized.includes("תז") ||
    normalized.includes("כרטיס") ||
    normalized.includes("אשראי") ||
    normalized.includes("תוקף") ||
    normalized.includes("emv")
  );
}

export function extractFinancialRoles(text: string): FinancialRoles {
  const lines = text
    .split("\n")
    .map(cleanLine)
    .filter(Boolean);

  let totalAmount: FinancialAmountRole | null = null;
  let subtotalAmount: FinancialAmountRole | null = null;
  let vatAmount: FinancialAmountRole | null = null;
  let feeAmount: FinancialAmountRole | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = normalizeMoneyText(lines[i]);

    const hasFinalTotalLabel = isExplicitFinalTotalLabel(line);
    const hasTransferLabel = isTransferAmountLabel(line);
    const hasSubtotalLabel = isSubtotalLabel(line);
    const hasVatLabel = isVatLabel(line);
    const hasFeeLabel = isFeeLabel(line);

    if (
      !hasFinalTotalLabel &&
      !hasTransferLabel &&
      !hasSubtotalLabel &&
      !hasVatLabel &&
      !hasFeeLabel
    ) {
      continue;
    }

    const amountNear = findAmountNearLine(lines, i);
    if (!amountNear) continue;

    if (isPaymentNoiseLine(amountNear.line)) {
      continue;
    }

    if (hasFinalTotalLabel) {
      totalAmount = makeRole(
        amountNear.amount,
        "high",
        "explicit_total",
        amountNear.line,
        "explicit final total label found, excluding payment/card metadata"
      );
      continue;
    }

    if (
      hasTransferLabel &&
      !isLikelyNotFinalAmountLine(line) &&
      !isPaymentNoiseLine(line)
    ) {
      totalAmount = makeRole(
        amountNear.amount,
        "high",
        "transfer_amount",
        amountNear.line,
        "explicit transfer/payment amount label"
      );
      continue;
    }

    if (hasSubtotalLabel && !subtotalAmount) {
      subtotalAmount = makeRole(
        amountNear.amount,
        "medium",
        "subtotal",
        amountNear.line,
        "subtotal label"
      );
      continue;
    }

    if (hasVatLabel && !vatAmount) {
      vatAmount = makeRole(
        amountNear.amount,
        "medium",
        "unknown",
        amountNear.line,
        "vat label"
      );
      continue;
    }

    if (hasFeeLabel && !feeAmount) {
      feeAmount = makeRole(
        amountNear.amount,
        "medium",
        "unknown",
        amountNear.line,
        "fee label"
      );
    }
  }

  return {
    totalAmount,
    subtotalAmount,
    vatAmount,
    feeAmount,
  };
}