import type { DocumentStructure } from "./document-structure.service";
import type {
  BusinessIdEntity,
  VendorEntity,
} from "./entities/document-entities.types";
import { clampConfidence } from "./entities/document-entities.types";
import {
  classifyLineWithContext,
  isVendorRejectedLineType,
} from "./line-classifier.service";

function cleanLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function normalizeVendorName(name: string): string {
  return cleanLine(name)
    .replace(/ח\.פ\.?/g, "")
    .replace(/ח פ/g, "")
    .replace(/ע\.מ\.?/g, "")
    .replace(/ע מ/g, "")
    .replace(/\b\d{7,10}\b/g, "")
    .replace(/^[:\-–—]+/, "")
    .replace(/[:\-–—]+$/, "")
    .trim();
}

function hasLetters(text: string): boolean {
  return /[א-תa-zA-Z]/.test(text);
}

function isMostlyNumeric(text: string): boolean {
  const digits = text.match(/\d/g)?.length ?? 0;
  const letters = text.match(/[א-תa-zA-Z]/g)?.length ?? 0;

  return digits > letters;
}

function isWeakVendorName(name: string): boolean {
  const cleaned = cleanLine(name);

  if (!cleaned || cleaned.length < 3) return true;
  if (!hasLetters(cleaned)) return true;
  if (isMostlyNumeric(cleaned)) return true;

  return false;
}

function isRejectedVendorLine(
  line: string,
  previousLine = "",
  nextLine = ""
): boolean {
  const classified = classifyLineWithContext(line, previousLine, nextLine);

  return isVendorRejectedLineType(classified.type);
}

function hasBusinessIndicator(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    lower.includes("בעמ") ||
    lower.includes('בע"מ') ||
    lower.includes("בע״מ") ||
    lower.includes("בעיימ") ||
    lower.includes("חברה") ||
    lower.includes("עמותה") ||
    lower.includes("עמותת") ||
    lower.includes("שירותים") ||
    lower.includes("מוצרי") ||
    lower.includes("שיווק") ||
    lower.includes("מערכות") ||
    lower.includes("ספורט") ||
    lower.includes("סאונד") ||
    lower.includes("sound") ||
    lower.includes("ltd") ||
    lower.includes("group")
  );
}

function hasNearbyBusinessIndicator(
  lines: string[],
  index: number
): boolean {
  const nearby = [
    lines[index - 1] || "",
    lines[index] || "",
    lines[index + 1] || "",
  ].join(" ");

  return hasBusinessIndicator(nearby);
}

function extractVendorFromBusinessIdLine(line: string): string | null {
  const cleaned = cleanLine(line);

  const patterns = [
    /(.*?)\s*ח\.פ\.?\s*\d{7,10}/,
    /(.*?)\s*ח פ\s*\d{7,10}/,
    /(.*?)\s*עוסק מורשה\s*\d{7,10}/,
    /(.*?)\s*ע\.מ\.?\s*\d{7,10}/,
    /(.*?)\s*ע מ\s*\d{7,10}/,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);

    if (match?.[1]) {
      const name = normalizeVendorName(match[1]);

      if (!isWeakVendorName(name)) return name;
    }
  }

  return null;
}

function scoreHeaderVendor(
  line: string,
  index: number,
  headerLines: string[]
): {
  score: number;
  anchored: boolean;
} {
  const previousLine = headerLines[index - 1] || "";
  const nextLine = headerLines[index + 1] || "";

  if (isRejectedVendorLine(line, previousLine, nextLine)) {
    return { score: -999, anchored: false };
  }

  const normalized = normalizeVendorName(line);

  if (isWeakVendorName(normalized)) {
    return { score: -999, anchored: false };
  }

  const anchored =
    hasBusinessIndicator(normalized) ||
    hasNearbyBusinessIndicator(headerLines, index);

  let score = 50;

  score += Math.max(0, 30 - index * 6);

  const wordCount = normalized.split(" ").filter(Boolean).length;

  if (wordCount >= 2) score += 20;
  if (wordCount >= 4) score += 10;

  if (anchored) score += 55;

  if (!anchored && wordCount < 2) score -= 40;
  if (!anchored && index > 2) score -= 25;

  return { score, anchored };
}

export function applyVendorStrategy(
  structure: DocumentStructure,
  businessIds: BusinessIdEntity[],
  currentVendor: VendorEntity
): VendorEntity {
  const candidates: {
    name: string;
    score: number;
    source: VendorEntity["source"];
    signals: string[];
    anchored: boolean;
  }[] = [];

  for (const businessId of businessIds) {
    const nameFromLine = extractVendorFromBusinessIdLine(businessId.line);

    if (nameFromLine) {
      candidates.push({
        name: nameFromLine,
        score: 140 + businessId.confidence * 40,
        source: "business_id",
        anchored: true,
        signals: [
          "vendor strategy: extracted from same line as business id",
          `business_id=${businessId.value}`,
        ],
      });
    }
  }

  const headerLines = structure.headerLines.map(cleanLine).filter(Boolean);

  headerLines.forEach((line, index) => {
    const { score, anchored } = scoreHeaderVendor(line, index, headerLines);

    if (score > 0) {
      candidates.push({
        name: normalizeVendorName(line),
        score,
        source: "header",
        anchored,
        signals: anchored
          ? ["vendor strategy: header candidate with business anchor"]
          : ["vendor strategy: weak header candidate"],
      });
    }
  });

  if (currentVendor.name) {
    const currentLineRejected = isRejectedVendorLine(currentVendor.name);
    const currentWeak = isWeakVendorName(currentVendor.name);
    const currentAnchored = hasBusinessIndicator(currentVendor.name);

    if (!currentLineRejected && !currentWeak) {
      candidates.push({
        name: normalizeVendorName(currentVendor.name),
        score: currentAnchored
          ? currentVendor.confidence * 100
          : Math.min(currentVendor.confidence * 100, 55),
        source: currentVendor.source,
        anchored: currentAnchored,
        signals: currentAnchored
          ? currentVendor.signals
          : [...currentVendor.signals, "vendor strategy: weak unanchored current vendor"],
      });
    }
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0];

  if (!best) {
    return {
      name: currentVendor.name,
      businessId: currentVendor.businessId,
      confidence: 0.35,
      source: currentVendor.source,
      signals: [
        ...currentVendor.signals,
        "vendor strategy: no reliable vendor candidate found",
      ],
      needsReview: true,
      reason: "Vendor requires review because no reliable vendor candidate was found",
    };
  }

  if (!best.anchored) {
    return {
      name: best.name,
      businessId: currentVendor.businessId,
      confidence: 0.55,
      source: best.source,
      signals: [
        ...currentVendor.signals,
        ...best.signals,
        "vendor strategy: selected unanchored vendor for review only",
      ],
      needsReview: true,
      reason:
        "Vendor requires review because it has no business-id or business indicator anchor",
    };
  }

  return {
    name: best.name,
    businessId: currentVendor.businessId,
    confidence: clampConfidence(Math.max(currentVendor.confidence, 0.9)),
    source: best.source,
    signals: [
      ...currentVendor.signals,
      ...best.signals,
      "vendor strategy: selected best anchored vendor",
    ],
    needsReview: false,
    reason: "Vendor selected by strategy layer",
  };
}