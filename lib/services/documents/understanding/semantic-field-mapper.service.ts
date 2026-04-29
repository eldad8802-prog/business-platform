import type { UnderstoodLine } from "./line-understanding.service";

export type SemanticFieldRole =
  | "main_amount"
  | "secondary_fee"
  | "vat"
  | "subtotal"
  | "identifier"
  | "hours"
  | "email"
  | "phone"
  | "recipient"
  | "vendor_candidate"
  | "document_subject"
  | "date"
  | "unknown";

export type SemanticField = {
  role: SemanticFieldRole;
  value: string | number;
  raw: string;
  label?: string;
  lineIndex: number;
  confidence: number;
  signals: string[];
};

function parseMoney(raw: string): number | null {
  const match = raw.replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/);
  if (!match) return null;

  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function hasCurrency(raw: string): boolean {
  return /₪|ש"ח|ש״ח|שח|ils/i.test(raw);
}

function lower(raw: string): string {
  return raw.toLowerCase();
}

function isMainAmountLabel(raw: string): boolean {
  const l = lower(raw);

  return (
    l.includes("שכר לימוד") ||
    l.includes("שכ״ל") ||
    l.includes('שכ"ל') ||
    l.includes("שכיל") ||
    l.includes("עלות") ||
    l.includes("מחיר") ||
    l.includes("סהכ") ||
    l.includes('סה"כ') ||
    l.includes("סה״כ") ||
    l.includes("לתשלום")
  );
}

function isFeeLabel(raw: string): boolean {
  return lower(raw).includes("דמי הרשמה");
}

function isIdentifierLabel(raw: string): boolean {
  const l = lower(raw);
  return l.includes("מספר קורס") || l.includes("קוד") || l.includes("אסמכתא");
}

function isHoursLabel(raw: string): boolean {
  const l = lower(raw);
  return l.includes("שעות") || l.includes("מפגשים") || /\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}/.test(raw);
}

function findNearbyMoney(lines: UnderstoodLine[], startIndex: number): UnderstoodLine | null {
  const window = lines.slice(startIndex + 1, startIndex + 5);

  return (
    window.find((line) => line.kind === "money" && hasCurrency(line.raw)) ||
    window.find((line) => line.kind === "money") ||
    null
  );
}

function findNearbyText(lines: UnderstoodLine[], startIndex: number): UnderstoodLine | null {
  const window = lines.slice(startIndex + 1, startIndex + 4);
  return window.find((line) => line.kind === "vendor_candidate" || line.kind === "label") || null;
}

export function mapSemanticFields(lines: UnderstoodLine[]): SemanticField[] {
  const fields: SemanticField[] = [];

  for (const line of lines) {
    if (line.kind === "email") {
      fields.push({
        role: "email",
        value: line.raw,
        raw: line.raw,
        lineIndex: line.index,
        confidence: 0.98,
        signals: ["email"],
      });
      continue;
    }

    if (line.kind === "phone") {
      fields.push({
        role: "phone",
        value: line.raw,
        raw: line.raw,
        lineIndex: line.index,
        confidence: 0.9,
        signals: ["phone"],
      });
      continue;
    }

    if (line.kind === "recipient") {
      fields.push({
        role: "recipient",
        value: line.raw,
        raw: line.raw,
        lineIndex: line.index,
        confidence: 0.85,
        signals: ["recipient"],
      });
      continue;
    }

    if (line.kind === "date") {
      fields.push({
        role: "date",
        value: line.raw,
        raw: line.raw,
        lineIndex: line.index,
        confidence: 0.75,
        signals: ["date"],
      });
      continue;
    }

    if (isHoursLabel(line.raw)) {
      fields.push({
        role: "hours",
        value: line.raw,
        raw: line.raw,
        lineIndex: line.index,
        confidence: 0.9,
        signals: ["hours label/time"],
      });
      continue;
    }

    if (isIdentifierLabel(line.raw)) {
      const nearby = findNearbyText(lines, line.index);
      fields.push({
        role: "identifier",
        value: nearby?.raw ?? line.raw,
        raw: nearby?.raw ?? line.raw,
        label: line.raw,
        lineIndex: nearby?.index ?? line.index,
        confidence: 0.9,
        signals: ["identifier label-value"],
      });
      continue;
    }

    if (isFeeLabel(line.raw)) {
      const nearbyMoney = findNearbyMoney(lines, line.index);
      if (nearbyMoney) {
        const value = parseMoney(nearbyMoney.raw);
        if (value !== null) {
          fields.push({
            role: "secondary_fee",
            value,
            raw: nearbyMoney.raw,
            label: line.raw,
            lineIndex: nearbyMoney.index,
            confidence: hasCurrency(nearbyMoney.raw) ? 0.95 : 0.82,
            signals: ["fee label linked to nearby money"],
          });
        }
      }
      continue;
    }

    if (isMainAmountLabel(line.raw)) {
      const valueInSameLine = parseMoney(line.raw);

      if (valueInSameLine !== null && line.kind === "money") {
        fields.push({
          role: "main_amount",
          value: valueInSameLine,
          raw: line.raw,
          label: line.raw,
          lineIndex: line.index,
          confidence: hasCurrency(line.raw) ? 0.95 : 0.85,
          signals: ["main amount label same line"],
        });
        continue;
      }

      const nearbyMoney = findNearbyMoney(lines, line.index);
      if (nearbyMoney) {
        const value = parseMoney(nearbyMoney.raw);
        if (value !== null) {
          fields.push({
            role: "main_amount",
            value,
            raw: nearbyMoney.raw,
            label: line.raw,
            lineIndex: nearbyMoney.index,
            confidence: hasCurrency(nearbyMoney.raw) ? 0.96 : 0.84,
            signals: ["main amount label linked to nearby money"],
          });
        }
      }
      continue;
    }

    if (line.kind === "money") {
      const value = parseMoney(line.raw);
      if (value !== null) {
        fields.push({
          role: "unknown",
          value,
          raw: line.raw,
          lineIndex: line.index,
          confidence: hasCurrency(line.raw) ? 0.65 : 0.45,
          signals: ["unlabeled money"],
        });
      }
      continue;
    }

    if (line.kind === "vendor_candidate") {
      fields.push({
        role: "vendor_candidate",
        value: line.raw,
        raw: line.raw,
        lineIndex: line.index,
        confidence: 0.45,
        signals: ["vendor candidate"],
      });
    }
  }

  return fields;
}