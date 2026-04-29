import type { DocumentStructure } from "./document-structure.service";

export type SemanticFieldType =
  | "vendor"
  | "recipient"
  | "email"
  | "phone"
  | "amount"
  | "fee"
  | "hours"
  | "date"
  | "course"
  | "unknown";

export type SemanticField = {
  type: SemanticFieldType;
  value: string | number | Date;
  raw: string;
  confidence: number;
  signals: string[];
};

function clean(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function isEmail(line: string): boolean {
  return /\S+@\S+\.\S+/.test(line);
}

function isPhone(line: string): boolean {
  return /0\d{8,9}/.test(line);
}

function isTimeRange(line: string): boolean {
  return /\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/.test(line);
}

function isAmount(line: string): boolean {
  return /\d+(\.\d{1,2})?\s?(₪|ש"ח|ILS)?/.test(line);
}

function extractNumber(line: string): number | null {
  const match = line.match(/\d+(\.\d{1,2})?/);
  return match ? Number(match[0]) : null;
}

function hasKeyword(line: string, keywords: string[]): boolean {
  const lower = line.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

export function mapDocumentSemantics(
  structure: DocumentStructure
): SemanticField[] {
  const fields: SemanticField[] = [];

  const lines = structure.allLines.map(clean).filter(Boolean);

  for (const line of lines) {
    // EMAIL
    if (isEmail(line)) {
      fields.push({
        type: "email",
        value: line,
        raw: line,
        confidence: 0.95,
        signals: ["email pattern"],
      });
      continue;
    }

    // PHONE
    if (isPhone(line)) {
      fields.push({
        type: "phone",
        value: line,
        raw: line,
        confidence: 0.9,
        signals: ["phone pattern"],
      });
      continue;
    }

    // HOURS
    if (isTimeRange(line)) {
      fields.push({
        type: "hours",
        value: line,
        raw: line,
        confidence: 0.95,
        signals: ["time range"],
      });
      continue;
    }

    // COURSE / SUBJECT
    if (hasKeyword(line, ["קורס", "הכשרה", "לימוד"])) {
      fields.push({
        type: "course",
        value: line,
        raw: line,
        confidence: 0.85,
        signals: ["course keyword"],
      });
      continue;
    }

    // REGISTRATION FEE
    if (hasKeyword(line, ["דמי הרשמה"])) {
      const num = extractNumber(line);
      if (num) {
        fields.push({
          type: "fee",
          value: num,
          raw: line,
          confidence: 0.9,
          signals: ["registration fee"],
        });
        continue;
      }
    }

    // TUITION / MAIN AMOUNT
    if (hasKeyword(line, ["שכ", "שכר", "סה\"כ"])) {
      const num = extractNumber(line);
      if (num) {
        fields.push({
          type: "amount",
          value: num,
          raw: line,
          confidence: 0.9,
          signals: ["amount keyword"],
        });
        continue;
      }
    }

    // GENERIC AMOUNT (fallback)
    if (isAmount(line)) {
      const num = extractNumber(line);
      if (num && num > 50) {
        fields.push({
          type: "amount",
          value: num,
          raw: line,
          confidence: 0.6,
          signals: ["generic amount"],
        });
        continue;
      }
    }

    // UNKNOWN (רק אם נראה חשוב)
    if (line.length > 10) {
      fields.push({
        type: "unknown",
        value: line,
        raw: line,
        confidence: 0.3,
        signals: [],
      });
    }
  }

  return fields;
}