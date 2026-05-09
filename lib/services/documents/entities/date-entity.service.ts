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

const HEBREW_MONTHS: Readonly<Record<string, number>> = {
  "ינואר": 1,
  "פברואר": 2,
  "מרץ": 3,
  "מארס": 3,
  "אפריל": 4,
  "מאי": 5,
  "יוני": 6,
  "יולי": 7,
  "אוגוסט": 8,
  "ספטמבר": 9,
  "אוקטובר": 10,
  "נובמבר": 11,
  "דצמבר": 12,
};

const HEBREW_MONTH_GROUP = Object.keys(HEBREW_MONTHS).join("|");

const ENGLISH_MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const ENGLISH_MONTH_GROUP =
  "January|February|March|April|May|June|July|August|September|October|November|December|" +
  "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";

function extractDates(text: string): { raw: string; date: Date }[] {
  const results: { raw: string; date: Date }[] = [];
  const seen = new Set<string>();

  // Existing strict numeric patterns: dot/slash/dash, no spaces.
  // Kept verbatim so that documents that already work continue to score
  // exactly the same as before (slash/dot bonus, ISO detection, etc.).
  const strictNumericPatterns = [
    /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g,
    /\b\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}\b/g,
  ];

  for (const pattern of strictNumericPatterns) {
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

  // Whitespace-tolerant numeric: e.g. "12 / 05 / 25", "12 - 05 - 2025".
  // Strict matches above already populated `seen`, so identical no-space
  // strings won't be double-counted. Whitespace is stripped before parsing
  // so the ISO check still works for "2025 / 05 / 12".
  const looseNumericPatterns = [
    /\b\d{1,2}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{2,4}\b/g,
    /\b\d{4}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{1,2}\b/g,
  ];

  for (const pattern of looseNumericPatterns) {
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const raw = match[0];
      if (seen.has(raw)) continue;

      const compact = raw.replace(/\s+/g, "");
      const parts = compact.split(/[\/\-.]/).map(Number);
      let date: Date | null = null;

      if (/^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}$/.test(compact)) {
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

  // Hebrew month names: "12 במאי 2025", "1 ביוני 2024", "12 מאי 2025".
  // Day must be 1–2 digits followed by whitespace; month may be preceded by
  // an optional ב prefix; year is 2–4 digits with no trailing digit.
  // No \b on the Hebrew side because Hebrew letters aren't word characters
  // in JavaScript regex; the explicit \s+ acts as the boundary instead.
  const hebrewPattern = new RegExp(
    `(\\d{1,2})\\s+ב?(${HEBREW_MONTH_GROUP})\\s+(\\d{2,4})(?!\\d)`,
    "g"
  );

  let hebrewMatch: RegExpExecArray | null;

  while ((hebrewMatch = hebrewPattern.exec(text)) !== null) {
    const raw = hebrewMatch[0];
    if (seen.has(raw)) continue;

    const day = Number(hebrewMatch[1]);
    const month = HEBREW_MONTHS[hebrewMatch[2]];
    const year = Number(hebrewMatch[3]);

    if (
      !Number.isFinite(day) ||
      !Number.isFinite(year) ||
      month === undefined
    ) {
      continue;
    }

    const date = buildDate(day, month, year);

    if (date) {
      seen.add(raw);
      results.push({ raw, date });
    }
  }

  // English month names, day-first: "12 May 2025", "12 May, 2025", "12 May. 2025".
  const englishForwardPattern = new RegExp(
    `\\b(\\d{1,2})\\s+(${ENGLISH_MONTH_GROUP})\\.?,?\\s+(\\d{2,4})\\b`,
    "gi"
  );

  let englishForwardMatch: RegExpExecArray | null;

  while ((englishForwardMatch = englishForwardPattern.exec(text)) !== null) {
    const raw = englishForwardMatch[0];
    if (seen.has(raw)) continue;

    const day = Number(englishForwardMatch[1]);
    const monthKey = englishForwardMatch[2].toLowerCase();
    const month = ENGLISH_MONTHS[monthKey];
    const year = Number(englishForwardMatch[3]);

    if (
      !Number.isFinite(day) ||
      !Number.isFinite(year) ||
      month === undefined
    ) {
      continue;
    }

    const date = buildDate(day, month, year);

    if (date) {
      seen.add(raw);
      results.push({ raw, date });
    }
  }

  // English month names, month-first: "May 12, 2025", "May 12 2025".
  const englishReversePattern = new RegExp(
    `\\b(${ENGLISH_MONTH_GROUP})\\.?\\s+(\\d{1,2}),?\\s+(\\d{2,4})\\b`,
    "gi"
  );

  let englishReverseMatch: RegExpExecArray | null;

  while ((englishReverseMatch = englishReversePattern.exec(text)) !== null) {
    const raw = englishReverseMatch[0];
    if (seen.has(raw)) continue;

    const monthKey = englishReverseMatch[1].toLowerCase();
    const month = ENGLISH_MONTHS[monthKey];
    const day = Number(englishReverseMatch[2]);
    const year = Number(englishReverseMatch[3]);

    if (
      !Number.isFinite(day) ||
      !Number.isFinite(year) ||
      month === undefined
    ) {
      continue;
    }

    const date = buildDate(day, month, year);

    if (date) {
      seen.add(raw);
      results.push({ raw, date });
    }
  }

  return results;
}

function findDateLine(lines: string[], raw: string): string | null {
  return lines.find((line) => line.includes(raw)) ?? null;
}

function findDateLineIndex(lines: string[], raw: string): number {
  return lines.findIndex((line) => line.includes(raw));
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
  previousLine: string | null,
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

  // When the current line has no date label but the previous line does
  // (e.g. "תאריך מסמך" on one line and the actual value on the next),
  // grant the same boost. Reuses isInvoiceDateSignal to avoid duplicated rules.
  // Only applies when current line is unlabeled, to avoid double-counting
  // the same signal that already fired above.
  if (
    previousLine !== null &&
    !isInvoiceDateSignal(line) &&
    isInvoiceDateSignal(previousLine)
  ) {
    score += 35;
    signals.push("invoice/date label on previous line");
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
    .map((item) => {
      const lineIndex = findDateLineIndex(allLines, item.raw);
      const line = lineIndex >= 0 ? allLines[lineIndex] : null;
      const previousLine = lineIndex > 0 ? allLines[lineIndex - 1] : null;

      return scoreDateCandidate(
        item.raw,
        item.date,
        line,
        previousLine,
        structure
      );
    })
    .sort((a, b) => b.score - a.score);

  console.log(
    "DATE_CANDIDATES_DEBUG:",
    candidates.map((candidate) => {
      const lineIndex = findDateLineIndex(allLines, candidate.raw);
      const previousLine = lineIndex > 0 ? allLines[lineIndex - 1] : null;

      return {
        raw: candidate.raw,
        date: candidate.date.toISOString().slice(0, 10),
        score: candidate.score,
        lineIndex: lineIndex >= 0 ? lineIndex : null,
        currentHasDateLabel: isInvoiceDateSignal(candidate.line),
        previousHasDateLabel: isInvoiceDateSignal(previousLine),
      };
    })
  );

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