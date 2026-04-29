import type { DocumentStructure } from "../document-structure.service";
import {
  BusinessIdEntity,
  clampConfidence,
} from "./document-entities.types";

function cleanLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function normalizeBusinessId(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function detectType(line: string): BusinessIdEntity["type"] {
  const lower = line.toLowerCase();

  if (
    lower.includes("עוסק מורשה") ||
    lower.includes("ע.מ") ||
    lower.includes("ע מ") ||
    lower.includes("מספר עוסק") ||
    lower.includes("מס עוסק")
  ) {
    return "IL_AUTHORIZED_DEALER";
  }

  if (
    lower.includes("ח.פ") ||
    lower.includes("ח פ") ||
    lower.includes("חברה") ||
    lower.includes('בע"מ') ||
    lower.includes("בע״מ")
  ) {
    return "IL_COMPANY";
  }

  if (lower.includes("vat")) {
    return "IL_VAT";
  }

  return "UNKNOWN";
}

function isBusinessIdContext(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    lower.includes("ח.פ") ||
    lower.includes("ח פ") ||
    lower.includes("חפ") ||
    lower.includes("ע.מ") ||
    lower.includes("ע מ") ||
    lower.includes("עמ") ||
    lower.includes("עוסק מורשה") ||
    lower.includes("מספר עוסק") ||
    lower.includes("מס עוסק") ||
    lower.includes("מספר חברה") ||
    lower.includes("חברה בעמ") ||
    lower.includes('בע"מ') ||
    lower.includes("בע״מ") ||
    lower.includes("vat")
  );
}

function hasPhoneContext(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    lower.includes("טל") ||
    lower.includes("טלפון") ||
    lower.includes("נייד") ||
    lower.includes("פלאפון") ||
    lower.includes("mobile") ||
    lower.includes("phone") ||
    lower.includes("fax") ||
    lower.includes("פקס")
  );
}

function hasNonBusinessNumberContext(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    lower.includes("חשבונית") ||
    lower.includes("קבלה") ||
    lower.includes("מסמך") ||
    lower.includes("אסמכתא") ||
    lower.includes("הזמנה") ||
    lower.includes("חשבון בנק") ||
    lower.includes("מספר חשבון") ||
    lower.includes("סניף") ||
    lower.includes("כרטיס") ||
    lower.includes("תאריך") ||
    lower.includes("שעה")
  );
}

function looksLikePhone(value: string, line: string): boolean {
  const digits = normalizeBusinessId(value);
  const compactLine = line.replace(/\s+/g, "");

  if (digits.startsWith("05") && digits.length >= 9 && digits.length <= 10) {
    return true;
  }

  if (digits.startsWith("02") && digits.length === 9) return true;
  if (digits.startsWith("03") && digits.length === 9) return true;
  if (digits.startsWith("04") && digits.length === 9) return true;
  if (digits.startsWith("08") && digits.length === 9) return true;
  if (digits.startsWith("09") && digits.length === 9) return true;

  if (/(05\d[-\s]?\d{7})/.test(compactLine)) return true;
  if (/(0[23489][-]?\d{7})/.test(compactLine)) return true;

  return false;
}

function getNearbyContext(
  line: string,
  allLines: string[],
  windowSize = 1
): string {
  const index = allLines.findIndex(
    (candidate) => cleanLine(candidate) === cleanLine(line)
  );

  if (index < 0) return line;

  return allLines
    .slice(Math.max(0, index - windowSize), Math.min(allLines.length, index + windowSize + 1))
    .join(" ");
}

export function extractBusinessIdEntities(
  text: string,
  structure: DocumentStructure
): BusinessIdEntity[] {
  const priorityLines = [
    ...structure.headerLines,
    ...structure.bodyLines,
    ...structure.footerLines,
  ].map(cleanLine);

  const allLines = structure.allLines.map(cleanLine).filter(Boolean);

  const results: BusinessIdEntity[] = [];
  const seen = new Set<string>();

  for (const line of priorityLines) {
    const matches = line.match(/\b\d{9}\b/g);
    if (!matches) continue;

    const nearbyContext = getNearbyContext(line, allLines, 1);

    for (const raw of matches) {
      const value = normalizeBusinessId(raw);
      if (seen.has(value)) continue;

      const hasDirectContext = isBusinessIdContext(line);
      const hasNearbyContext = isBusinessIdContext(nearbyContext);
      const phoneLike = looksLikePhone(value, line) || hasPhoneContext(line);
      const nonBusinessContext = hasNonBusinessNumberContext(line);

      if (phoneLike && !hasDirectContext && !hasNearbyContext) {
        continue;
      }

      if (nonBusinessContext && !hasDirectContext && !hasNearbyContext) {
        continue;
      }

      const inHeader = structure.headerLines.some(
        (headerLine) => cleanLine(headerLine) === line
      );

      let confidence = 0.35;
      const source = hasDirectContext || hasNearbyContext ? "business_id" : "pattern";

      if (hasDirectContext) confidence += 0.4;
      if (!hasDirectContext && hasNearbyContext) confidence += 0.25;
      if (inHeader) confidence += 0.15;

      if (phoneLike) confidence -= 0.35;
      if (nonBusinessContext) confidence -= 0.25;

      seen.add(value);

      results.push({
        value,
        type: detectType(hasDirectContext ? line : nearbyContext),
        confidence: clampConfidence(confidence),
        source,
        line,
      });
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}