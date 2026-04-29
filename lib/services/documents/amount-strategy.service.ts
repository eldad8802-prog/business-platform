import { getAmountCandidates } from "./field-candidates.service";
import { extractFinancialRoles } from "./financial-roles.service";
import type { AmountEntity } from "./entities/document-entities.types";
import { clampConfidence } from "./entities/document-entities.types";
import {
  classifyLine,
  classifyLineWithContext,
  isAmountAllowedLineType,
  isAmountRejectedLineType,
  type LineType,
} from "./line-classifier.service";

function isValidAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 1_000_000;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function isVatRatio(subtotal: number, vat: number): boolean {
  if (!subtotal || !vat) return false;

  const ratio = vat / subtotal;
  return ratio >= 0.12 && ratio <= 0.25;
}

function getLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isIdentifierNoiseLine(line: string): boolean {
  const lower = line.toLowerCase();
  const compactDigits = line.replace(/[^\d]/g, "");

  return (
    compactDigits.length >= 7 ||
    lower.includes("טלפון") ||
    lower.includes("פקס") ||
    lower.includes("רכב מספר") ||
    lower.includes("הזמנה") ||
    lower.includes("מספרכם") ||
    lower.includes("מספר כרטיס") ||
    lower.includes("כרטיס:") ||
    lower.includes("emv") ||
    lower.includes("contactless") ||
    lower.includes("****") ||
    lower.includes("xx")
  );
}

function isStartOfLineItems(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    lower.includes("תיאור וקוד פריט") ||
    lower.includes("תיאור") ||
    lower.includes("קוד פריט") ||
    lower.includes("פריט")
  );
}

function isEndOfLineItems(line: string): boolean {
  const lower = line.toLowerCase();

  return (
    lower.includes("סהכ") ||
    lower.includes('סה"כ') ||
    lower.includes("סה״כ") ||
    lower.includes("לתשלום") ||
    lower.includes("חייב") ||
    lower.includes("חיוב") ||
    lower.includes("שולם") ||
    lower.includes("אשראי")
  );
}

function isInsideLineItemBlock(lines: string[], index: number): boolean {
  let seenStart = false;

  for (let i = Math.max(0, index - 8); i <= index; i++) {
    if (isStartOfLineItems(lines[i] || "")) {
      seenStart = true;
    }

    if (i < index && seenStart && isEndOfLineItems(lines[i] || "")) {
      return false;
    }
  }

  if (!seenStart) return false;

  const current = lines[index] || "";
  const next = lines[index + 1] || "";

  if (isEndOfLineItems(current) || isEndOfLineItems(next)) {
    return false;
  }

  return true;
}

function getLineMatchesForRaw(
  text: string,
  raw: string
): {
  line: string;
  previousLine: string;
  nextLine: string;
  type: LineType;
  index: number;
  inLineItemBlock: boolean;
}[] {
  const lines = getLines(text);
  const compactRaw = raw.replace(/\s+/g, "");

  const matches: {
    line: string;
    previousLine: string;
    nextLine: string;
    type: LineType;
    index: number;
    inLineItemBlock: boolean;
  }[] = [];

  lines.forEach((line, index) => {
    const lineCompact = line.replace(/\s+/g, "");

    if (!line.includes(raw) && !lineCompact.includes(compactRaw)) return;

    const previousLine = lines[index - 1] || "";
    const nextLine = lines[index + 1] || "";
    const classified = classifyLineWithContext(line, previousLine, nextLine);

    let type = classified.type;

    if (isInsideLineItemBlock(lines, index)) {
      type = "line_item";
    }

    if (isIdentifierNoiseLine(line)) {
      type = "noise";
    }

    matches.push({
      line,
      previousLine,
      nextLine,
      type,
      index,
      inLineItemBlock: isInsideLineItemBlock(lines, index),
    });
  });

  return matches;
}

function typePriority(type: LineType): number {
  if (type === "payment_amount") return 7;
  if (type === "total") return 6;
  if (type === "subtotal") return 4;
  if (type === "vat") return 3;
  if (type === "vendor") return 1;
  if (type === "line_item") return -3;
  if (type === "payment_metadata") return -6;
  if (type === "date") return -6;
  if (type === "noise") return -6;
  return 0;
}

function bestLineInfoForRaw(
  text: string,
  raw: string
): {
  line: string | null;
  type: LineType;
  index: number;
} {
  const matches = getLineMatchesForRaw(text, raw);

  if (matches.length === 0) {
    return {
      line: null,
      type: classifyLine(raw),
      index: -1,
    };
  }

  const best = matches.sort((a, b) => {
    const byType = typePriority(b.type) - typePriority(a.type);
    if (byType !== 0) return byType;

    return b.index - a.index;
  })[0];

  return {
    line: best.line,
    type: best.type,
    index: best.index,
  };
}

function isSafeAmountCandidate(
  text: string,
  candidate: ReturnType<typeof getAmountCandidates>[number]
): boolean {
  const { line, type } = bestLineInfoForRaw(text, candidate.raw);

  if (isAmountRejectedLineType(type)) return false;
  if (line && isIdentifierNoiseLine(line)) return false;

  return true;
}

function findBestSemanticAmount(
  text: string,
  currentAmount: AmountEntity,
  candidates: ReturnType<typeof getAmountCandidates>
): {
  value: number;
  raw: string;
  confidence: number;
  source: AmountEntity["source"];
  signals: string[];
  reason: string;
} | null {
  const scored = candidates
    .filter((candidate) => isValidAmount(candidate.value))
    .filter((candidate) => candidate.value >= 10)
    .map((candidate) => {
      const { line, type } = bestLineInfoForRaw(text, candidate.raw);

      let score = candidate.score;
      const signals = [`amount strategy: classified line as ${type}`];

      if (type === "payment_amount") score += 280;
      if (type === "total") score += 260;
      if (type === "subtotal") score += 40;
      if (type === "vat") score -= 120;

      if (isAmountRejectedLineType(type)) score -= 700;
      if (line && isIdentifierNoiseLine(line)) score -= 700;

      if (candidate.raw.includes(".") || candidate.raw.includes(",")) {
        score += 25;
      }

      if (
        candidate.raw.includes("₪") ||
        candidate.raw.includes("שח") ||
        candidate.raw.toLowerCase().includes("ils")
      ) {
        score += 35;
      }

      if (candidate.value < 20) score -= 80;

      return {
        value: candidate.value,
        raw: candidate.raw,
        score,
        type,
        line,
        signals,
      };
    })
    .filter((item) => isAmountAllowedLineType(item.type))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;

      if (typePriority(b.type) !== typePriority(a.type)) {
        return typePriority(b.type) - typePriority(a.type);
      }

      return b.value - a.value;
    });

  const best = scored[0];
  if (!best || best.score < 120) return null;

  const currentType = bestLineInfoForRaw(text, currentAmount.raw).type;
  const currentIsRejected = isAmountRejectedLineType(currentType);
  const currentIsWeak =
    currentAmount.isSuspicious ||
    currentAmount.confidence < 0.85 ||
    currentIsRejected;

  if (
    currentIsWeak ||
    best.type === "total" ||
    best.type === "payment_amount" ||
    Math.abs(best.value - currentAmount.value) > 0.05
  ) {
    return {
      value: best.value,
      raw: best.raw,
      confidence: best.type === "payment_amount" ? 0.94 : 0.96,
      source: best.type === "payment_amount" ? "structure" : "label",
      signals: [
        ...best.signals,
        `amount strategy: selected semantic amount from line "${
          best.line ?? best.raw
        }"`,
      ],
      reason:
        best.type === "payment_amount"
          ? "Amount selected from payment amount line"
          : "Amount selected from final total line",
    };
  }

  return null;
}

function findAccountingConsistencyAmount(
  text: string,
  candidates: ReturnType<typeof getAmountCandidates>
): {
  value: number;
  raw: string;
  signals: string[];
} | null {
  const valid = candidates
    .filter((candidate) => isValidAmount(candidate.value))
    .filter((candidate) => candidate.value >= 10)
    .filter((candidate) => isSafeAmountCandidate(text, candidate))
    .sort((a, b) => b.value - a.value);

  for (const totalCandidate of valid) {
    for (const subtotalCandidate of valid) {
      if (subtotalCandidate.value >= totalCandidate.value) continue;

      const vatValue = round2(totalCandidate.value - subtotalCandidate.value);

      const vatCandidate = valid.find(
        (candidate) => Math.abs(candidate.value - vatValue) <= 0.05
      );

      if (!vatCandidate) continue;

      if (isVatRatio(subtotalCandidate.value, vatCandidate.value)) {
        return {
          value: totalCandidate.value,
          raw: totalCandidate.raw,
          signals: [
            "amount strategy: exact subtotal + vat consistency",
            `subtotal=${subtotalCandidate.value}`,
            `vat=${vatCandidate.value}`,
            `total=${totalCandidate.value}`,
          ],
        };
      }
    }
  }

  for (const subtotalTail of valid) {
    for (const vatCandidate of valid) {
      if (vatCandidate.value >= subtotalTail.value) continue;

      for (const totalTail of valid) {
        if (totalTail.value <= subtotalTail.value) continue;

        for (let thousands = 1000; thousands <= 9000; thousands += 1000) {
          const reconstructedSubtotal = round2(thousands + subtotalTail.value);
          const reconstructedTotal = round2(
            reconstructedSubtotal + vatCandidate.value
          );

          const totalTailMatches =
            Math.abs((reconstructedTotal % 1000) - totalTail.value) <= 0.05 ||
            Math.abs(reconstructedTotal - totalTail.value) <= 0.05;

          if (!totalTailMatches) continue;
          if (!isVatRatio(reconstructedSubtotal, vatCandidate.value)) continue;

          return {
            value: reconstructedTotal,
            raw: String(reconstructedTotal),
            signals: [
              "amount strategy: reconstructed broken thousands using subtotal + vat + total tail",
              `subtotal_tail=${subtotalTail.value}`,
              `vat=${vatCandidate.value}`,
              `total_tail=${totalTail.value}`,
              `reconstructed_subtotal=${reconstructedSubtotal}`,
              `reconstructed_total=${reconstructedTotal}`,
            ],
          };
        }
      }
    }
  }

  return null;
}

function isSafeFinancialTotalRole(
  totalRole: ReturnType<typeof extractFinancialRoles>["totalAmount"]
): boolean {
  if (!totalRole) return false;

  const type = classifyLine(totalRole.line);
  if (isAmountRejectedLineType(type)) return false;
  if (isIdentifierNoiseLine(totalRole.line)) return false;

  return true;
}

export function applyAmountStrategy(
  text: string,
  currentAmount: AmountEntity
): AmountEntity {
  const candidates = getAmountCandidates(text);
  const financialRoles = extractFinancialRoles(text);

  const consistencyAmount = findAccountingConsistencyAmount(text, candidates);

  if (
    consistencyAmount &&
    consistencyAmount.value >= 10 &&
    Math.abs(consistencyAmount.value - currentAmount.value) > 0.05
  ) {
    return {
      ...currentAmount,
      value: consistencyAmount.value,
      raw: consistencyAmount.raw,
      type: "total",
      confidence: 0.97,
      source: "reconstructed",
      isSuspicious: false,
      needsReview: false,
      signals: [...currentAmount.signals, ...consistencyAmount.signals],
      reason: "Amount selected by strategy layer using accounting consistency",
    };
  }

  const semanticAmount = findBestSemanticAmount(text, currentAmount, candidates);

  if (semanticAmount) {
    return {
      ...currentAmount,
      value: semanticAmount.value,
      raw: semanticAmount.raw,
      type: "total",
      confidence: semanticAmount.confidence,
      source: semanticAmount.source,
      isSuspicious: false,
      needsReview: false,
      signals: [...currentAmount.signals, ...semanticAmount.signals],
      reason: semanticAmount.reason,
    };
  }

  if (
    financialRoles.totalAmount &&
    isSafeFinancialTotalRole(financialRoles.totalAmount) &&
    financialRoles.totalAmount.value > currentAmount.value * 1.5 &&
    financialRoles.totalAmount.value >= 100
  ) {
    return {
      ...currentAmount,
      value: financialRoles.totalAmount.value,
      raw: financialRoles.totalAmount.raw,
      type: "total",
      confidence: clampConfidence(
        Math.max(
          currentAmount.confidence,
          financialRoles.totalAmount.confidence === "high" ? 0.92 : 0.78
        )
      ),
      source: "structure",
      isSuspicious: false,
      needsReview: false,
      signals: [
        ...currentAmount.signals,
        "amount strategy: promoted explicit total role over lower amount",
      ],
      reason: "Amount selected by strategy layer from explicit total role",
    };
  }

  const currentType = bestLineInfoForRaw(text, currentAmount.raw).type;

  if (isAmountRejectedLineType(currentType)) {
    return {
      ...currentAmount,
      confidence: 0.35,
      isSuspicious: true,
      needsReview: true,
      signals: [
        ...currentAmount.signals,
        `amount strategy: current amount rejected by line classification ${currentType}`,
      ],
      reason: "Amount requires review because it came from a rejected line type",
    };
  }

  return currentAmount;
}