import { getAmountCandidates } from "../field-candidates.service";
import { extractFinancialRoles } from "../financial-roles.service";
import { resolveFinalAmount } from "../amount-decision.service";
import { validateAmount } from "../amount-validation.service";
import { AmountEntity, clampConfidence } from "./document-entities.types";

function confidenceLabelToNumber(confidence: "low" | "medium" | "high"): number {
  if (confidence === "high") return 0.9;
  if (confidence === "medium") return 0.72;
  return 0.45;
}

function normalizeForLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\u0590-\u05ffa-z0-9]/g, "")
    .trim();
}

function parseAmount(raw: string): number {
  const cleaned = raw.replace(/,/g, "").replace(/[^\d.]/g, "");
  return Number(cleaned);
}

function isValidAutoAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 1_000_000;
}

function isPaymentContext(text: string, raw: string): boolean {
  const index = text.indexOf(raw);
  if (index === -1) return false;

  const context = text
    .slice(Math.max(0, index - 70), index + raw.length + 70)
    .toLowerCase();

  return (
    context.includes("מספר כרטיס") ||
    context.includes("כרטיס") ||
    context.includes("אשראי") ||
    context.includes("התקבל בכרטיס") ||
    context.includes("emv") ||
    context.includes("contactless") ||
    context.includes("visa") ||
    context.includes("mastercard") ||
    context.includes("card")
  );
}

function isStrongAmountLabel(text: string): boolean {
  const normalized = normalizeForLabel(text);

  return (
    normalized.includes("סכום") ||
    normalized.includes("סכוםהתשלום") ||
    normalized.includes("סהכ") ||
    normalized.includes("סךהכל") ||
    normalized.includes("לתשלום") ||
    normalized.includes("amountdue") ||
    normalized.includes("totaldue") ||
    normalized.includes("grandtotal") ||
    normalized.includes("כסה")
  );
}

function getFinalTotalLabelStrength(text: string): number {
  const normalized = normalizeForLabel(text);

  let score = 0;

  if (normalized.includes("סהככוללמעמ")) score += 220;
  if (normalized.includes("כוללמעמ")) score += 200;
  if (normalized.includes("סהכלתשלום")) score += 190;
  if (normalized.includes("סךהכללתשלום")) score += 190;
  if (normalized.includes("לתשלום")) score += 150;
  if (normalized.includes("grandtotal")) score += 160;
  if (normalized.includes("totaldue")) score += 160;
  if (normalized.includes("amountdue")) score += 140;
  if (normalized.includes("סהכ")) score += 100;
  if (normalized.includes("סךהכל")) score += 100;
  if (normalized.includes("total")) score += 90;
  if (normalized.includes("כסה")) score += 90;

  if (normalized.includes("לפנימעמ")) score -= 180;
  if (normalized.includes("ללאמעמ")) score -= 160;
  if (normalized.includes("מחיריחידה")) score -= 160;
  if (normalized.includes("כמות")) score -= 120;
  if (normalized.includes("הנחה")) score -= 80;

  if (
    normalized === "מעמ" ||
    normalized.includes("מעמ17") ||
    normalized.includes("מעמ18")
  ) {
    score -= 160;
  }

  return score;
}

function isDateLikeText(text: string): boolean {
  return /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/.test(text);
}

function isLikelyYear(value: number, context: string): boolean {
  return value >= 1900 && value <= 2100 && isDateLikeText(context);
}

function extractAmountsFromText(
  text: string
): { raw: string; value: number; score: number }[] {
  const results: { raw: string; value: number; score: number }[] = [];
  const seen = new Set<string>();

  const patterns = [
    /₪\s*\d{1,3}(?:[,\s]\d{3})+(?:\.\d{1,2})?/g,
    /₪\s*\d+(?:\.\d{1,2})?/g,
    /\d{1,3}(?:[,\s]\d{3})+(?:\.\d{1,2})?\s*(?:₪|שח)/g,
    /\d+(?:\.\d{1,2})?\s*(?:₪|שח)/g,
    /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?/g,
    /\d+\.\d{1,2}/g,
    /\b\d+\b/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const raw = match[0].trim();
      const value = parseAmount(raw);

      if (!isValidAutoAmount(value)) continue;
      if (isPaymentContext(text, raw)) continue;

      let score = 0;

      if (raw.includes("₪") || raw.includes("שח")) score += 80;
      if (/\.\d{1,2}/.test(raw)) score += 40;
      if (raw.includes(",")) score += 30;
      if (value >= 10 && value <= 1_000_000) score += 20;

      const key = `${raw}-${value}`;
      if (seen.has(key)) continue;

      seen.add(key);
      results.push({ raw, value, score });
    }
  }

  return results;
}

function extractSyntheticTrailingAmounts(
  line: string
): { raw: string; value: number; score: number }[] {
  const results: { raw: string; value: number; score: number }[] = [];

  const longDecimalMatches = line.match(/\d{7,}\.\d{2}/g);
  if (!longDecimalMatches) return results;

  for (const rawLong of longDecimalMatches) {
    const [integerPart, decimals] = rawLong.split(".");
    const possibleLengths = [3, 4, 5, 6];

    for (const length of possibleLengths) {
      if (integerPart.length <= length) continue;

      const amountRaw = `${integerPart.slice(-length)}.${decimals}`;
      const value = Number(amountRaw);

      if (!isValidAutoAmount(value)) continue;
      if (value < 10) continue;
      if (isPaymentContext(line, amountRaw)) continue;

      results.push({
        raw: amountRaw,
        value,
        score: 75 - length,
      });
    }
  }

  return results;
}

function isLikelyDocumentNumber(value: number, text: string): boolean {
  const valueText = String(Math.floor(value));

  const suspiciousPatterns = [
    new RegExp(`קבלה\\s+על\\s+תרומה\\s*-\\s*${valueText}`),
    new RegExp(`מספר\\s+קבלה\\s+לתשלום\\s*${valueText}`),
    new RegExp(`${valueText}\\s*מספר\\s+קבלה\\s+לתשלום`),
    new RegExp(`מספר\\s+${valueText}`),
    new RegExp(`רפסמ\\s+${valueText}`),
    new RegExp(`אסמכתה\\s*:?\\s*${valueText}`),
    new RegExp(`מספר\\s+אסמכתה\\s*:?\\s*${valueText}`),
    new RegExp(`מסמך\\s*:?\\s*${valueText}`),
    new RegExp(`חשבונית\\s+מס\\s+קבלה\\s+מס\\s+${valueText}`),
    new RegExp(`${valueText}\\s+רפסמ`),
  ];

  return suspiciousPatterns.some((pattern) => pattern.test(text));
}

function findConsistentTotalFromCandidates(
  candidates: ReturnType<typeof getAmountCandidates>
): {
  value: number;
  raw: string;
  reason: string;
} | null {
  const valid = candidates
    .filter((candidate) => isValidAutoAmount(candidate.value))
    .filter((candidate) => candidate.value >= 10)
    .filter((candidate) => !isPaymentContext(candidate.raw, candidate.raw))
    .sort((a, b) => b.value - a.value);

  for (const possibleTotal of valid) {
    for (const possibleSubtotal of valid) {
      if (possibleSubtotal.value >= possibleTotal.value) continue;

      const expectedVat = Number(
        (possibleTotal.value - possibleSubtotal.value).toFixed(2)
      );

      const vatCandidate = valid.find((candidate) => {
        const diff = Math.abs(candidate.value - expectedVat);
        return diff <= 0.05;
      });

      if (!vatCandidate) continue;

      const vatRatio = expectedVat / possibleSubtotal.value;

      if (vatRatio >= 0.12 && vatRatio <= 0.25) {
        return {
          value: possibleTotal.value,
          raw: possibleTotal.raw,
          reason: "selected via subtotal + vat consistency",
        };
      }
    }
  }

  return null;
}

function findBestFinalTotalAmount(text: string): {
  value: number;
  raw: string;
  reason: string;
} | null {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const scoredAmounts: {
    value: number;
    raw: string;
    score: number;
    lineIndex: number;
  }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    const labelStrength = getFinalTotalLabelStrength(currentLine);

    if (labelStrength <= 0 && !isStrongAmountLabel(currentLine)) continue;

    const windowText = [
      lines[i - 2] || "",
      lines[i - 1] || "",
      currentLine,
      lines[i + 1] || "",
      lines[i + 2] || "",
      lines[i + 3] || "",
      lines[i + 4] || "",
      lines[i + 5] || "",
      lines[i + 6] || "",
      lines[i + 7] || "",
      lines[i + 8] || "",
    ].join(" ");

    const directAmounts = extractAmountsFromText(windowText);
    const syntheticAmounts = extractSyntheticTrailingAmounts(windowText);

    const amounts = [...directAmounts, ...syntheticAmounts]
      .filter((amount) => amount.value >= 10)
      .filter((amount) => !isLikelyYear(amount.value, windowText))
      .filter((amount) => !isLikelyDocumentNumber(amount.value, text))
      .filter((amount) => !isPaymentContext(windowText, amount.raw))
      .filter((amount) => {
        const hasDecimal = /\.\d{1,2}/.test(amount.raw);
        const hasCurrency =
          amount.raw.includes("₪") || amount.raw.includes("שח");
        const isLargeRoundAmount = amount.value >= 1000;

        return hasDecimal || hasCurrency || isLargeRoundAmount;
      });

    for (const amount of amounts) {
      let score = labelStrength + amount.score;

      score += i * 2;

      if (amount.raw.includes("₪") || amount.raw.includes("שח")) score += 35;
      if (/\.\d{1,2}/.test(amount.raw)) score += 15;

      if (amount.value >= 100) score += 20;
      if (amount.value >= 1000) score += 90;

      const normalizedWindow = normalizeForLabel(windowText);

      if (normalizedWindow.includes("כוללמעמ")) score += 80;
      if (normalizedWindow.includes("לתשלום")) score += 50;

      if (normalizedWindow.includes("לפנימעמ")) score -= 120;
      if (normalizedWindow.includes("ללאמעמ")) score -= 120;
      if (normalizedWindow.includes("מחיריחידה")) score -= 120;
      if (normalizedWindow.includes("כמות")) score -= 80;

      scoredAmounts.push({
        value: amount.value,
        raw: amount.raw,
        score,
        lineIndex: i,
      });
    }
  }

  if (scoredAmounts.length === 0) return null;

  const best = scoredAmounts.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.lineIndex !== a.lineIndex) return b.lineIndex - a.lineIndex;
    return b.value - a.value;
  })[0];

  if (!best || best.score < 90) return null;

  return {
    value: best.value,
    raw: best.raw,
    reason: "best final total amount selected from summary area",
  };
}

function findAmountNearFinalTotalLabel(
  text: string,
  candidates: ReturnType<typeof getAmountCandidates>
): {
  value: number;
  raw: string;
  reason: string;
} | null {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const matches: { value: number; raw: string; score: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    const labelStrength = getFinalTotalLabelStrength(currentLine);

    if (labelStrength <= 0) continue;

    const windowText = [
      lines[i - 2] || "",
      lines[i - 1] || "",
      currentLine,
      lines[i + 1] || "",
      lines[i + 2] || "",
      lines[i + 3] || "",
      lines[i + 4] || "",
      lines[i + 5] || "",
      lines[i + 6] || "",
      lines[i + 7] || "",
      lines[i + 8] || "",
    ].join(" ");

    const windowDigits = windowText.replace(/[^\d]/g, "");

    for (const candidate of candidates) {
      if (!isValidAutoAmount(candidate.value)) continue;
      if (candidate.value < 10) continue;
      if (isLikelyYear(candidate.value, windowText)) continue;
      if (isLikelyDocumentNumber(candidate.value, text)) continue;
      if (isPaymentContext(windowText, candidate.raw)) continue;

      const candidateDigits = String(Math.floor(candidate.value));
      const rawDigits = candidate.raw.replace(/[^\d]/g, "");
      const rawCompact = candidate.raw.replace(/\s+/g, "");

      const appearsNearLabel =
        windowText.includes(candidate.raw) ||
        windowText.replace(/\s+/g, "").includes(rawCompact) ||
        windowDigits.includes(candidateDigits) ||
        windowDigits.includes(rawDigits);

      if (!appearsNearLabel) continue;

      let score = candidate.score + labelStrength;

      if (candidate.value >= 1000) score += 90;
      if (candidate.raw.includes("₪") || candidate.raw.includes("שח")) {
        score += 35;
      }

      matches.push({
        value: candidate.value,
        raw: candidate.raw,
        score,
      });
    }
  }

  if (matches.length === 0) return null;

  const best = matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.value - a.value;
  })[0];

  if (!best || best.score < 120) return null;

  return {
    value: best.value,
    raw: best.raw,
    reason: "candidate found near final total label",
  };
}

function findRawForAmount(
  value: number,
  financialRoles: ReturnType<typeof extractFinancialRoles>,
  candidates: ReturnType<typeof getAmountCandidates>
): string {
  if (
    financialRoles.totalAmount?.value === value &&
    !isPaymentContext(financialRoles.totalAmount.line, financialRoles.totalAmount.raw)
  ) {
    return financialRoles.totalAmount.raw;
  }

  const candidate = candidates.find((item) => item.value === value);
  return candidate?.raw ?? String(value);
}

function hasLargerCurrencyCandidate(
  value: number,
  candidates: ReturnType<typeof getAmountCandidates>
): boolean {
  return candidates.some((candidate) => {
    const hasCurrency =
      candidate.raw.includes("₪") || candidate.raw.includes("שח");

    return hasCurrency && candidate.value > value * 3;
  });
}

export function extractAmountEntity(text: string): AmountEntity {
  const financialRoles = extractFinancialRoles(text);
  const rawCandidates = getAmountCandidates(text);
  const candidates = rawCandidates.filter(
    (candidate) => !isPaymentContext(text, candidate.raw)
  );

  const consistentTotal = findConsistentTotalFromCandidates(candidates);
  const bestFinalTotal = findBestFinalTotalAmount(text);
  const amountNearLabel = findAmountNearFinalTotalLabel(text, candidates);
  const decision = resolveFinalAmount(
    financialRoles.totalAmount &&
      !isPaymentContext(financialRoles.totalAmount.line, financialRoles.totalAmount.raw)
      ? financialRoles.totalAmount
      : null,
    candidates
  );

  let finalAmount = decision.amount;
  let raw = findRawForAmount(finalAmount, financialRoles, candidates);
  let source: AmountEntity["source"] =
    decision.source === "financial_role" ? "label" : "candidate";
  let type: AmountEntity["type"] =
    decision.source === "financial_role" ? "total" : "unknown";
  let confidence = confidenceLabelToNumber(decision.confidence);
  const signals: string[] = [];

  if (consistentTotal) {
    finalAmount = consistentTotal.value;
    raw = consistentTotal.raw;
    source = "label";
    type = "total";
    confidence = 0.97;
    signals.push(consistentTotal.reason);
  } else if (bestFinalTotal) {
    finalAmount = bestFinalTotal.value;
    raw = bestFinalTotal.raw;
    source = "label";
    type = "total";
    confidence = 0.96;
    signals.push("selected best final total from summary area");
  } else if (
    financialRoles.totalAmount &&
    !isPaymentContext(financialRoles.totalAmount.line, financialRoles.totalAmount.raw) &&
    !isLikelyDocumentNumber(financialRoles.totalAmount.value, text) &&
    !hasLargerCurrencyCandidate(financialRoles.totalAmount.value, candidates)
  ) {
    finalAmount = financialRoles.totalAmount.value;
    raw = financialRoles.totalAmount.raw;
    source = "label";
    type = "total";
    confidence = confidenceLabelToNumber(financialRoles.totalAmount.confidence);
    signals.push(
      "selected from explicit financial total role before near-label fallback"
    );
  } else if (amountNearLabel) {
    finalAmount = amountNearLabel.value;
    raw = amountNearLabel.raw;
    source = "label";
    type = "total";
    confidence = 0.9;
    signals.push("candidate promoted because it appears near final total label");
  } else if (decision.source === "candidate_override") {
    signals.push("candidate override was required");
  }

  const validation = validateAmount(finalAmount, text);

  if (validation.confidenceAdjustment === "upgrade") {
    confidence += 0.05;
    signals.push("amount validation upgraded confidence");
  }

  if (validation.confidenceAdjustment === "downgrade") {
    confidence -= 0.2;
    signals.push("amount validation downgraded confidence");
  }

  const documentNumber = isLikelyDocumentNumber(finalAmount, text);
  const yearLike = isLikelyYear(finalAmount, text);

  if (documentNumber) {
    confidence -= 0.45;
    signals.push("amount looks like document/reference number");
  }

  if (yearLike) {
    confidence -= 0.45;
    signals.push("amount looks like year/date");
  }

  const suspicious =
    !isValidAutoAmount(finalAmount) ||
    finalAmount < 10 ||
    documentNumber ||
    yearLike;

  if (suspicious) {
    confidence -= 0.2;
    signals.push("amount is suspicious");
  }

  const finalConfidence = clampConfidence(confidence);

  return {
    value: finalAmount,
    raw,
    type,
    confidence: finalConfidence,
    source,
    isSuspicious: suspicious,
    needsReview: suspicious || finalConfidence < 0.85,
    signals,
    reason:
      finalConfidence >= 0.85 && !suspicious
        ? "Amount identified with high confidence"
        : "Amount requires confirmation",
  };
}