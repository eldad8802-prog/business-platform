import type { UnderstoodLine } from "./line-understanding.service";
import type { SemanticField } from "./semantic-field-mapper.service";

export type UnderstoodAmount = {
  role: "main_amount" | "secondary_fee" | "vat" | "subtotal" | "unknown";
  value: number;
  raw: string;
  label?: string;
  confidence: number;
  signals: string[];
};

const PAYMENT_BLOCK_LOOKBACK_LINES = 12;
const PAYMENT_BLOCK_LOOKAHEAD_LINES = 2;
const CURRENCY_NEARBY_RADIUS = 2;

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function isPaymentContext(text: string): boolean {
  const lower = normalize(text);

  return (
    lower.includes("אשראי") ||
    lower.includes("כרטיס") ||
    lower.includes("ביצוע עסקה") ||
    lower.includes("שולם") ||
    lower.includes("לתשלום") ||
    lower.includes("סהכ") ||
    lower.includes('סה"כ') ||
    lower.includes("סה״כ") ||
    lower.includes("סך הכל") ||
    lower.includes("mastercard") ||
    lower.includes("visa") ||
    lower.includes("emv") ||
    lower.includes("contactless") ||
    lower.includes("מאסטרכרד") ||
    lower.includes("מסטרקרד") ||
    lower.includes("יורוקרד") ||
    lower.includes("מטבע") ||
    lower.includes("סכום עיסקה")
  );
}

/** Decimal-ish money (e.g. 162.68); rejects long integer-only lines like 901046. */
function looksLikeDecimalMoneyAmount(raw: string): boolean {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!/\d/.test(t)) return false;
  if (/^\d{5,}$/.test(t)) return false;
  if (/\d{13,}/.test(t.replace(/[^\d]/g, ""))) return false;
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(t) && !/\d+[.,]\d{1,2}/.test(t)) {
    return false;
  }
  return /\d+[.,]\d{1,2}\b/.test(t) || /\d{1,3}(?:,\d{3})+[.,]\d{2}\b/.test(t);
}

function joinLinesRaw(
  lines: UnderstoodLine[],
  start: number,
  endInclusive: number
): string {
  if (start > endInclusive || start < 0) return "";
  const slice = lines.slice(
    start,
    Math.min(endInclusive + 1, lines.length)
  );
  return slice.map((l) => l.raw).join(" ");
}

function widePaymentBlockText(
  lines: UnderstoodLine[],
  lineIndex: number
): string {
  const start = Math.max(0, lineIndex - PAYMENT_BLOCK_LOOKBACK_LINES);
  const end = Math.min(
    lines.length - 1,
    lineIndex + PAYMENT_BLOCK_LOOKAHEAD_LINES
  );
  return joinLinesRaw(lines, start, end);
}

function hasNearbyCurrencyLabel(lines: UnderstoodLine[], lineIndex: number): boolean {
  const from = Math.max(0, lineIndex - CURRENCY_NEARBY_RADIUS);
  const to = Math.min(lines.length - 1, lineIndex + CURRENCY_NEARBY_RADIUS);
  for (let i = from; i <= to; i++) {
    const r = lines[i]?.raw ?? "";
    if (/₪|ש"ח|ש״ח|שח\b|מטבע|\bnis\b/i.test(r)) return true;
  }
  return false;
}

function hasNegativePaymentBlockGuards(
  field: SemanticField,
  lines: UnderstoodLine[]
): boolean {
  const idx = Number(field.lineIndex ?? -1);
  if (!Number.isFinite(idx) || idx < 0) return true;

  const from = Math.max(0, idx - 1);
  const to = Math.min(lines.length - 1, idx + 1);
  let windowText = "";
  for (let i = from; i <= to; i++) {
    windowText += `${lines[i]?.raw ?? ""}\n`;
  }

  if (/\buid\s*:/i.test(windowText)) return true;
  if (/\brrn\s*:/i.test(windowText)) return true;
  if (/\batc\s*:/i.test(windowText)) return true;
  if (/\btvr\s*:/i.test(windowText)) return true;
  if (/\baid\s*:/i.test(windowText)) return true;
  if (/\bcsn\s*:/i.test(windowText)) return true;

  const raw = field.raw.replace(/\s+/g, " ").trim();
  if (/x{3,}/i.test(raw) && /\d/.test(raw)) return true;
  if (/\d{12,19}/.test(raw.replace(/[^\d]/g, "")) && !/\d+[.,]\d{1,2}/.test(raw)) {
    return true;
  }

  const heVoucher = /מס(?:'|׳)?\s*שובר|מספר\s+שובר|שובר\s*:/i.test(windowText);
  const heTxn = /מס(?:'|׳)?\s*עסקה|מספר\s+עסקה|עסקה\s*:/i.test(windowText);
  if (
    (heVoucher || heTxn) &&
    /^\d{4,}$/.test(raw.replace(/\s/g, ""))
  ) {
    return true;
  }

  return false;
}

function getContextForField(
  field: SemanticField,
  lines: UnderstoodLine[]
): string {
  const index = Number(field.lineIndex ?? -1);

  if (!Number.isFinite(index) || index < 0) {
    return `${field.label ?? ""} ${field.raw ?? ""}`;
  }

  const previous = lines[index - 1]?.raw ?? "";
  const current = lines[index]?.raw ?? "";
  const next = lines[index + 1]?.raw ?? "";
  const next2 = lines[index + 2]?.raw ?? "";

  return `${previous} ${current} ${next} ${next2}`;
}

function resolveRole(
  field: SemanticField,
  lines: UnderstoodLine[]
): UnderstoodAmount["role"] {
  const context = getContextForField(field, lines);

  if (field.role === "main_amount") return "main_amount";
  if (field.role === "secondary_fee") return "secondary_fee";
  if (field.role === "vat") return "vat";
  if (field.role === "subtotal") return "subtotal";

  if (isPaymentContext(context)) {
    return "main_amount";
  }

  if (field.role === "unknown" && typeof field.value === "number") {
    if (!looksLikeDecimalMoneyAmount(field.raw)) return "unknown";
    if (hasNegativePaymentBlockGuards(field, lines)) return "unknown";
    const wide = widePaymentBlockText(lines, field.lineIndex);
    if (
      hasNearbyCurrencyLabel(lines, field.lineIndex) ||
      isPaymentContext(wide)
    ) {
      return "main_amount";
    }
  }

  return "unknown";
}

export function understandAmounts(
  fields: SemanticField[],
  lines: UnderstoodLine[] = []
): UnderstoodAmount[] {
  return fields
    .filter((field) => typeof field.value === "number")
    .map((field): UnderstoodAmount | null => {
      const role = resolveRole(field, lines);

      let confidence = field.confidence;
      const signals = [...field.signals];

      if (role === "main_amount" && field.role !== "main_amount") {
        confidence = Math.max(confidence, 0.75);
        signals.push("amount understanding: promoted by payment/total context");
      }

      return {
        role,
        value: field.value as number,
        raw: field.raw,
        label: field.label,
        confidence,
        signals,
      };
    })
    .filter((item): item is UnderstoodAmount => item !== null)
    .sort((a, b) => {
      if (a.role === "main_amount" && b.role !== "main_amount") return -1;
      if (b.role === "main_amount" && a.role !== "main_amount") return 1;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return b.value - a.value;
    });
}
