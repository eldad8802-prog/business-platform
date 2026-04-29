import type { UnderstoodLine } from "./line-understanding.service";

export type UnderstoodDate = {
  raw: string;
  role: "document_date" | "event_date" | "print_date" | "unknown";
  confidence: number;
  signals: string[];
};

function lower(value: string): string {
  return value.toLowerCase();
}

export function understandDates(lines: UnderstoodLine[]): UnderstoodDate[] {
  return lines
    .filter((line) => line.kind === "date")
    .map((line): UnderstoodDate => {
      const l = lower(line.raw);

      if (l.includes("הדפסה") || l.includes("הופק") || l.includes("print")) {
        return {
          raw: line.raw,
          role: "print_date",
          confidence: 0.85,
          signals: ["print/system date"],
        };
      }

      if (
        l.includes("תחילת") ||
        l.includes("סיום") ||
        l.includes("אירוח") ||
        l.includes("לימודים") ||
        l.includes("קורס")
      ) {
        return {
          raw: line.raw,
          role: "event_date",
          confidence: 0.8,
          signals: ["event/course date"],
        };
      }

      if (l.includes("תאריך")) {
        return {
          raw: line.raw,
          role: "document_date",
          confidence: 0.9,
          signals: ["document date label"],
        };
      }

      return {
        raw: line.raw,
        role: "unknown",
        confidence: 0.55,
        signals: ["date without clear label"],
      };
    });
}