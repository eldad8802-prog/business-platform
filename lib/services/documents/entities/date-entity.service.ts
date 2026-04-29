import type { DocumentStructure } from "../document-structure.service";
import { DateEntity, clampConfidence } from "./document-entities.types";

function cleanLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

type DateCandidate = {
  raw: string;
  date: Date;
  line: string | null;
  score: number;
  signals: string[];
};

function normalizeYear(year: number): number {
  if (year < 100) return year >= 70 ? 1900 + year : 2000 + year;
  return year;
}

function buildDate(day: number, month: number, year: number): Date | null {
  const normalizedYear = normalizeYear(year);

  if (day < 1 || day > 31) return null;
  if (month < 1 || month > 12) return null;
  if (normalizedYear < 1990 || normalizedYear > 2100) return null;

  const date = new Date(normalizedYear, month - 1, day);

  if (
    date.getFullYear() !== normalizedYear ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function extractDates(text: string): { raw: string; date: Date }[] {
  const patterns = [
    /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g,
    /\b\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}\b/g,
  ];

  const results: { raw: string; date: Date }[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const raw = match[0];
      if (seen.has(raw)) continue;

      const parts = raw.split(/[\/\-.]/).map(Number);
      let date: Date | null = null;

      if (/^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}$/.test(raw)) {
        const [year, month, day] = parts;
        date = buildDate(day, month, year);
      } else {
        const [day, month, year] = parts;
        date = buildDate(day, month, year);
      }

      if (date) {
        seen.add(raw);
        results.push({ raw, date });
      }
    }
  }

  return results;
}

function findDateLine(lines: string[], raw: string): string | null {
  return lines.find((line) => line.includes(raw)) ?? null;
}

function isInHeader(line: string, structure: DocumentStructure): boolean {
  return structure.headerLines.some(
    (headerLine) => cleanLine(headerLine) === cleanLine(line)
  );
}

function isPrintOrSystemDate(line: string | null): boolean {
  if (!line) return false;

  const lower = line.toLowerCase();

  return (
    lower.includes("הדפסה") ||
    lower.includes("שעת הדפסה") ||
    lower.includes("print") ||
    lower.includes("printed") ||
    lower.includes("הופק")
  );
}

function isInvoiceDateSignal(line: string | null): boolean {
  if (!line) return false;

  const lower = line.toLowerCase();

  return (
    lower.includes("תאריך מסמך") ||
    lower.includes("תאריך חשבונית") ||
    lower.includes("תאריך קבלה") ||
    lower.includes("תאריך") ||
    lower.includes("invoice date") ||
    lower.includes("date")
  );
}

function isPaymentDateSignal(line: string | null): boolean {
  if (!line) return false;

  const lower = line.toLowerCase();

  return (
    lower.includes("תאריך תשלום") ||
    lower.includes("מועד תשלום") ||
    lower.includes("payment date")
  );
}

function scoreDateCandidate(
  raw: string,
  date: Date,
  line: string | null,
  structure: DocumentStructure
): DateCandidate {
  let score = 40;
  const signals: string[] = ["date pattern"];

  if (line && isInHeader(line, structure)) {
    score += 25;
    signals.push("date in header");
  }

  if (isInvoiceDateSignal(line)) {
    score += 35;
    signals.push("invoice/date label");
  }

  if (isPaymentDateSignal(line)) {
    score += 15;
    signals.push("payment date label");
  }

  if (isPrintOrSystemDate(line)) {
    score -= 45;
    signals.push("print/system date penalty");
  }

  if (line?.includes("לכבוד")) {
    score -= 25;
    signals.push("recipient area penalty");
  }

  if (/\d{1,2}\.\d{1,2}\.\d{2,4}/.test(raw)) {
    score += 8;
    signals.push("dot date format");
  }

  if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(raw)) {
    score += 8;
    signals.push("slash date format");
  }

  return { raw, date, line, score, signals };
}

export function extractDateEntity(
  text: string,
  structure: DocumentStructure
): DateEntity {
  const allLines = structure.allLines.map(cleanLine).filter(Boolean);
  const rawDates = extractDates(text);

  if (rawDates.length === 0) {
    return {
      value: null,
      type: "unknown",
      confidence: 0.2,
      source: "fallback",
      line: null,
      needsReview: true,
      reason: "No reliable date found",
    };
  }

  const nonSystemDates = rawDates.filter((item) => {
    const line = findDateLine(allLines, item.raw);
    return !isPrintOrSystemDate(line);
  });

  if (nonSystemDates.length === 1) {
    const onlyDate = nonSystemDates[0];
    const line = findDateLine(allLines, onlyDate.raw);

    return {
      value: onlyDate.date,
      type: "invoice",
      confidence: 0.92,
      source: line && isInHeader(line, structure) ? "header" : "pattern",
      line,
      needsReview: false,
      reason: "Single non-system date in document",
    };
  }

  const candidates = rawDates
    .map((item) =>
      scoreDateCandidate(
        item.raw,
        item.date,
        findDateLine(allLines, item.raw),
        structure
      )
    )
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];

  const confidence =
    best.score >= 85
      ? 0.95
      : best.score >= 65
        ? 0.85
        : best.score >= 45
          ? 0.65
          : 0.45;

  const finalConfidence = clampConfidence(confidence);

  return {
    value: best.date,
    type: isPaymentDateSignal(best.line) ? "payment" : "invoice",
    confidence: finalConfidence,
    source: best.line && isInHeader(best.line, structure) ? "header" : "pattern",
    line: best.line,
    needsReview: finalConfidence < 0.85,
    reason:
      finalConfidence >= 0.85
        ? "Date selected by date strategy signals"
        : "Date requires confirmation",
  };
}