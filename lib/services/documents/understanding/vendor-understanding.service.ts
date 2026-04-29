import type { UnderstoodLine } from "./line-understanding.service";
import type { SemanticField } from "./semantic-field-mapper.service";

export type UnderstoodVendor = {
  name: string;
  confidence: number;
  signals: string[];
};

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isHardVendorNoise(value: string): boolean {
  const lower = value.toLowerCase();
  const digits = value.replace(/[^\d]/g, "");

  return (
    lower.includes("@") ||
    lower.includes("gmail") ||
    lower.includes("דוא") ||
    lower.includes("לידי") ||
    lower.includes("לכבוד") ||
    lower.includes("טלפון") ||
    lower.includes("פקס") ||
    lower.includes("תאריך") ||
    lower.includes("שעה") ||
    lower.includes("סהכ") ||
    lower.includes("לתשלום") ||
    lower.includes("אשראי") ||
    lower.includes("כרטיס") ||
    lower.includes("שולחן") ||
    lower.includes("מלצר") ||
    lower.includes("סועדים") ||
    digits.length >= 7
  );
}

function looksLikeGarbage(value: string): boolean {
  const cleanValue = clean(value);

  if (!cleanValue) return true;
  if (cleanValue.length < 2) return true;
  if (cleanValue.length > 80) return true;

  const words = cleanValue.split(" ").filter(Boolean);
  if (words.length > 7) return true;

  const hasLetters = /[א-תa-zA-Z]/.test(cleanValue);
  if (!hasLetters) return true;

  return false;
}

function hasBusinessSignal(value: string): boolean {
  const lower = value.toLowerCase();

  return (
    lower.includes("בעמ") ||
    lower.includes('בע"מ') ||
    lower.includes("בע״מ") ||
    lower.includes("בעיימ") ||
    lower.includes("חברה") ||
    lower.includes("מכללה") ||
    lower.includes("אוניברסיטה") ||
    lower.includes("עמותה") ||
    lower.includes("שיווק") ||
    lower.includes("מערכות") ||
    lower.includes("שירותים") ||
    lower.includes("ספורט") ||
    lower.includes("סאונד") ||
    lower.includes("ביטוח") ||
    lower.includes("מסעדה") ||
    lower.includes("קפה") ||
    lower.includes("cafe") ||
    lower.includes("café") ||
    lower.includes("group") ||
    lower.includes("ltd")
  );
}

export function understandVendors(
  lines: UnderstoodLine[],
  fields: SemanticField[]
): UnderstoodVendor[] {
  const candidates: UnderstoodVendor[] = [];

  for (const line of lines) {
    if (line.kind !== "vendor_candidate" && line.kind !== "label") continue;

    const name = clean(line.raw);
    if (!name || isHardVendorNoise(name) || looksLikeGarbage(name)) continue;

    let confidence = 0.35;
    const signals = ["vendor textual candidate"];

    if (hasBusinessSignal(name)) {
      confidence += 0.4;
      signals.push("business signal");
    }

    if (line.index <= 8) {
      confidence += 0.15;
      signals.push("early document position");
    }

    const wordCount = name.split(" ").filter(Boolean).length;

    if (wordCount >= 2 && wordCount <= 5) {
      confidence += 0.1;
      signals.push("reasonable multi-word vendor");
    }

    if (wordCount === 1 && line.index <= 4) {
      confidence += 0.05;
      signals.push("short early brand-like candidate");
    }

    candidates.push({
      name,
      confidence: Math.min(0.95, confidence),
      signals,
    });
  }

  for (const field of fields) {
    if (field.role !== "vendor_candidate") continue;

    const name = clean(String(field.value));
    if (!name || isHardVendorNoise(name) || looksLikeGarbage(name)) continue;

    candidates.push({
      name,
      confidence: hasBusinessSignal(name) ? 0.8 : 0.45,
      signals: ["semantic vendor candidate"],
    });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}