import type { DocumentStructure } from "../document-structure.service";
import { getVendorCandidates } from "../field-candidates.service";
import type { BusinessIdEntity, VendorEntity } from "./document-entities.types";
import { clampConfidence } from "./document-entities.types";

function cleanLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function normalizeVendorName(name: string): string {
  let result = cleanLine(name);

  const removablePrefixes = [
    "פרטי חשבון אליו תתבצע העברת כספים",
    "פרטי חשבון אליו תתבצע",
    "העברת כספים",
    "חשבון מקבל שם",
    "שם חשבון",
    "שם העסק",
    "שם",
    "לכבוד",
    "דובכל",
    "לחשבון",
    "מקור",
    "רוקמ",
  ];

  for (const prefix of removablePrefixes) {
    if (result.startsWith(prefix)) {
      result = result.replace(prefix, "").replace(/^[:\-–—]+/, "").trim();
    }
  }

  return result || cleanLine(name);
}

function getVendorNoisePenalty(line: string): {
  penalty: number;
  signals: string[];
} {
  const lower = line.toLowerCase();
  let penalty = 0;
  const signals: string[] = [];

  const softNoise = [
    "לכבוד",
    "דובכל",
    "שם",
    "חשבון",
    "מקבל",
    "מקור",
    "רוקמ",
    "העתק",
    "מסמך",
    "תאריך",
    "ךיראת",
    "אסמכתא",
    "אתכמסא",
    "סניף",
    "ףינס",
    "שם הלקוח",
    "חוקלה םש",
    "לקוח נכבד",
  ];

  const financialNoise = [
    "חשבונית",
    "תינובשח",
    "קבלה",
    "הלבק",
    "סהכ",
    'סה"כ',
    "סה״כ",
    "כסה",
    "לתשלום",
    "םולשתל",
    "אשראי",
    "יארשא",
    "כרטיס",
    "סיטרכ",
  ];

  for (const keyword of softNoise) {
    if (lower.includes(keyword)) {
      penalty += 0.12;
      signals.push(`soft noise: ${keyword}`);
    }
  }

  for (const keyword of financialNoise) {
    if (lower.includes(keyword)) {
      penalty += 0.18;
      signals.push(`financial noise: ${keyword}`);
    }
  }

  return {
    penalty: Math.min(penalty, 0.55),
    signals,
  };
}

function hasBusinessIndicator(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    lower.includes('בע"מ') ||
    lower.includes("בע״מ") ||
    lower.includes('מ"עב') ||
    lower.includes("מ״עב") ||
    lower.includes("ltd") ||
    lower.includes("group") ||
    lower.includes("גרופ") ||
    lower.includes("חברה") ||
    lower.includes("הרבח") ||
    lower.includes("עמותת") ||
    lower.includes("עמותה") ||
    lower.includes("התומע") ||
    lower.includes("שיווק") ||
    lower.includes("קוויש") ||
    lower.includes("שירותים") ||
    lower.includes("םיתוריש") ||
    lower.includes("פתרונות") ||
    lower.includes("תונורתפ") ||
    lower.includes("מערכות") ||
    lower.includes("תוכרעמ") ||
    lower.includes("מוצרי") ||
    lower.includes("ירצומ") ||
    lower.includes("אלקטריק") ||
    lower.includes("קירטקלא") ||
    lower.includes("אינטראקטיב") ||
    lower.includes("ביטקראטניא")
  );
}

function looksStructurallyPossibleVendor(line: string): boolean {
  const cleaned = cleanLine(line);

  if (cleaned.length < 2 || cleaned.length > 120) return false;
  if (/^\d+$/.test(cleaned)) return false;
  if (/\d{7,}/.test(cleaned) && !hasBusinessIndicator(cleaned)) return false;

  return true;
}

function isLikelyPersonName(line: string): boolean {
  const words = cleanLine(line).split(" ").filter(Boolean);

  if (words.length < 2 || words.length > 3) return false;
  if (hasBusinessIndicator(line)) return false;
  if (line.includes("(") || line.includes(")")) return false;

  return true;
}

function isAfterCustomerOrRecipientArea(line: string, allLines: string[]): boolean {
  const index = allLines.findIndex(
    (candidate) => cleanLine(candidate) === cleanLine(line)
  );

  if (index < 0) return false;

  const previousWindow = allLines
    .slice(Math.max(0, index - 5), index + 1)
    .join(" ")
    .toLowerCase();

  return (
    previousWindow.includes("לכבוד") ||
    previousWindow.includes("דובכל") ||
    previousWindow.includes("שם הלקוח") ||
    previousWindow.includes("חוקלה םש") ||
    previousWindow.includes("ת.ז") ||
    previousWindow.includes("זת")
  );
}

function lineNearBusinessId(
  line: string,
  allLines: string[],
  businessIds: BusinessIdEntity[]
): boolean {
  if (businessIds.length === 0) return false;

  const index = allLines.findIndex(
    (candidate) => cleanLine(candidate) === cleanLine(line)
  );

  if (index < 0) return false;

  const nearby = allLines
    .slice(Math.max(0, index - 2), Math.min(allLines.length, index + 4))
    .join(" ");

  return businessIds.some((businessId) => nearby.includes(businessId.value));
}

export function extractVendorEntity(
  text: string,
  structure: DocumentStructure,
  businessIds: BusinessIdEntity[]
): VendorEntity {
  const headerLines = structure.headerLines.map(cleanLine).filter(Boolean);
  const allLines = structure.allLines.map(cleanLine).filter(Boolean);

  const scored: {
    name: string;
    confidence: number;
    source: VendorEntity["source"];
    signals: string[];
  }[] = [];

  for (const line of headerLines) {
    if (!looksStructurallyPossibleVendor(line)) continue;

    const normalizedName = normalizeVendorName(line);
    if (!looksStructurallyPossibleVendor(normalizedName)) continue;

    let confidence = 0.45;
    const signals = ["appears in header"];

    const noise = getVendorNoisePenalty(line);
    confidence -= noise.penalty;
    signals.push(...noise.signals);

    if (hasBusinessIndicator(line) || hasBusinessIndicator(normalizedName)) {
      confidence += 0.35;
      signals.push("business indicator");
    }

    if (lineNearBusinessId(line, allLines, businessIds)) {
      confidence += 0.2;
      signals.push("near business id");
    }

    if (normalizedName.split(" ").filter(Boolean).length >= 2) {
      confidence += 0.1;
      signals.push("multi-word name");
    }

    if (isLikelyPersonName(normalizedName)) {
      confidence -= 0.2;
      signals.push("looks like person name");
    }

    if (isAfterCustomerOrRecipientArea(line, allLines)) {
      confidence -= 0.25;
      signals.push("appears after customer/recipient area");
    }

    scored.push({
      name: normalizedName,
      confidence: clampConfidence(confidence),
      source: lineNearBusinessId(line, allLines, businessIds)
        ? "business_id"
        : "header",
      signals,
    });
  }

  const candidates = getVendorCandidates(text);

  for (const candidate of candidates.slice(0, 5)) {
    const name = normalizeVendorName(candidate.value);
    if (!looksStructurallyPossibleVendor(name)) continue;

    let confidence = Math.min(0.72, candidate.score / 200);
    const signals = [...candidate.reasons];

    const noise = getVendorNoisePenalty(candidate.value);
    confidence -= noise.penalty;
    signals.push(...noise.signals);

    if (hasBusinessIndicator(name)) {
      confidence += 0.2;
      signals.push("business indicator");
    }

    if (lineNearBusinessId(candidate.value, allLines, businessIds)) {
      confidence += 0.15;
      signals.push("near business id");
    }

    if (isLikelyPersonName(name)) {
      confidence -= 0.2;
      signals.push("looks like person name");
    }

    if (isAfterCustomerOrRecipientArea(candidate.value, allLines)) {
      confidence -= 0.25;
      signals.push("appears after customer/recipient area");
    }

    scored.push({
      name,
      confidence: clampConfidence(confidence),
      source: "candidate",
      signals,
    });
  }

  const best = scored.sort((a, b) => b.confidence - a.confidence)[0];

  if (!best) {
    return {
      name: null,
      businessId: businessIds[0]?.value ?? null,
      confidence: 0.2,
      source: "fallback",
      signals: [],
      needsReview: true,
      reason: "No reliable vendor entity found",
    };
  }

  return {
    name: best.name,
    businessId: businessIds[0]?.value ?? null,
    confidence: best.confidence,
    source: best.source,
    signals: best.signals,
    needsReview: best.confidence < 0.85,
    reason:
      best.confidence >= 0.85
        ? "Vendor identified with strong structural signals"
        : "Vendor requires confirmation",
  };
}