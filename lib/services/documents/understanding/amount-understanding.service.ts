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
    lower.includes("סך הכל")
  );
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