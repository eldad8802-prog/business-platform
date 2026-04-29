export type AmountCandidate = {
  value: number;
  raw: string;
  score: number;
  reasons: string[];
};

export type VendorCandidate = {
  value: string;
  score: number;
  reasons: string[];
};

type NumberMatch = {
  value: number;
  raw: string;
  index: number;
};

function normalizeMoneyText(text: string): string {
  return text
    .replace(/₪/g, " ₪ ")
    .replace(/ש״ח/g, " שח ")
    .replace(/ש"ח/g, " שח ")
    .replace(/\s+/g, " ");
}

function parseMoneyValue(raw: string): number {
  const cleaned = raw.replace(/,/g, "").replace(/[^\d.]/g, "");
  return Number(cleaned);
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function extractAllMoneyLikeNumbers(text: string): NumberMatch[] {
  const result: NumberMatch[] = [];
  const usedRanges: { start: number; end: number }[] = [];

  const patterns = [
    /₪\s*\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?/g,
    /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\s*(?:₪|שח)/g,
    /₪\s*\d+(?:\.\d{1,2})?/g,
    /\d+(?:\.\d{1,2})?\s*(?:₪|שח)/g,
    /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?/g,
    /\d+(?:\.\d{1,2})?/g,
  ];

  for (const regex of patterns) {
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const raw = match[0].trim();
      const start = match.index;
      const end = start + match[0].length;

      const overlapsExisting = usedRanges.some((range) =>
        rangesOverlap(start, end, range.start, range.end)
      );

      if (overlapsExisting) continue;

      const value = parseMoneyValue(raw);
      if (!Number.isFinite(value)) continue;

      usedRanges.push({ start, end });
      result.push({ value, raw, index: start });
    }
  }

  return result.sort((a, b) => a.index - b.index);
}

function buildSplitCurrencyCandidatesFromNumbers(numbers: NumberMatch[]): NumberMatch[] {
  const synthetic: NumberMatch[] = [];

  for (let i = 0; i < numbers.length; i++) {
    const current = numbers[i];

    if (!current.raw.includes("₪")) continue;

    // חשוב:
    // לא משחזרים 1–9 כי זה בדרך כלל כמות, למשל:
    // 6₪2,350.00₪14,100.00
    // אחרת המערכת יוצרת בטעות 6350.
    if (current.value < 10 || current.value > 99) continue;

    const next = numbers.slice(i + 1).find((candidate) => {
      const closeEnough = candidate.index - current.index <= 80;
      const looksLikeTail =
        candidate.value >= 100 &&
        candidate.value <= 999.99 &&
        candidate.raw.includes(".");

      return closeEnough && looksLikeTail;
    });

    if (!next) continue;

    synthetic.push({
      value: current.value * 1000 + next.value,
      raw: `${current.raw} ${next.raw}`,
      index: current.index,
    });
  }

  return synthetic;
}

function getContext(text: string, index: number, windowSize = 120): string {
  return text.slice(Math.max(0, index - windowSize), index + windowSize);
}

function isPartOfDate(text: string, index: number): boolean {
  const area = text.slice(Math.max(0, index - 15), index + 25);
  return /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/.test(area);
}

function containsAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function isLikelyLineItemContext(context: string): boolean {
  return (
    context.includes("כמות") ||
    context.includes("מחיר") ||
    context.includes("מחיר יחידה") ||
    context.includes("תיאור")
  );
}

function isStrongFinalAmountContext(context: string): boolean {
  return containsAny(context, [
    "סהכ",
    'סה"כ',
    "סה״כ",
    'כ"סה',
    "כ״סה",
    "סך הכל",
    "לתשלום",
    "סהכ לתשלום",
    'סה"כ לתשלום',
    "amount due",
    "total due",
    "grand total",
  ]);
}

export function getAmountCandidates(text: string): AmountCandidate[] {
  const normalizedText = normalizeMoneyText(text).toLowerCase();

  const baseNumbers = extractAllMoneyLikeNumbers(normalizedText);
  const splitCurrencyNumbers = buildSplitCurrencyCandidatesFromNumbers(baseNumbers);

  const numbers = [...baseNumbers, ...splitCurrencyNumbers];

  const candidates: AmountCandidate[] = [];

  for (const number of numbers) {
    let score = 0;
    const reasons: string[] = [];
    const context = getContext(normalizedText, number.index).toLowerCase();

    if (isPartOfDate(normalizedText, number.index)) {
      score -= 90;
      reasons.push("part of date");
    }

    if (number.value >= 1900 && number.value <= 2099) {
      score -= 70;
      reasons.push("looks like year");
    }

    if (number.value > 1_000_000) {
      score -= 120;
      reasons.push("above supported automatic amount range");
    }

    if (String(Math.floor(number.value)).length >= 8) {
      score -= 80;
      reasons.push("too long");
    }

    if (number.value < 10) {
      score -= 100;
      reasons.push("too small");
    }

    if (number.raw.includes("₪") || number.raw.includes("שח")) {
      score += 90;
      reasons.push("explicit currency");
    }

    if (number.raw.includes(",") || number.raw.includes(".")) {
      score += 35;
      reasons.push("money format");
    }

    if (number.raw.includes("₪") && number.value >= 1000) {
      score += 120;
      reasons.push("explicit shekel amount");
    }

    if (number.value >= 1000 && number.value <= 1_000_000) {
      score += 80;
      reasons.push("large realistic amount");
    }

    if (isStrongFinalAmountContext(context)) {
      score += 90;
      reasons.push("strong final amount context");
    }

    if (isLikelyLineItemContext(context)) {
      score -= 20;
      reasons.push("line item context");

      // בשורת פריט צפופה, סכום גבוה ומפורמט הוא בדרך כלל total של השורה.
      if (number.value >= 1000 && (number.raw.includes(",") || number.raw.includes("₪"))) {
        score += 60;
        reasons.push("likely line total amount");
      }

      // מספר קטן בתוך שורת פריט הוא בדרך כלל כמות.
      if (number.value < 100 && !number.raw.includes(",") && !number.raw.includes(".")) {
        score -= 120;
        reasons.push("likely quantity, not amount");
      }
    }

    if (
      containsAny(context, [
        "עמלה",
        "ריבית",
        "יתרה",
        "מספר חשבון",
        "חשבון מספר",
        "אסמכתא",
        "מספר אסמכתה",
        "מספר האישורים",
        "סניף",
        "טלפון",
        "פקס",
        "ח.פ",
        "ע.מ",
        "ת.ז",
        "כרטיס",
        "אשראי",
        "תוקף",
        "emv",
      ])
    ) {
      score -= 140;
      reasons.push("reference noise");
    }

    if (
      number.value >= 100 &&
      number.value <= 999 &&
      !number.raw.includes("₪") &&
      !number.raw.includes("שח") &&
      !number.raw.includes(",")
    ) {
      score -= 60;
      reasons.push("mid number without money signal");
    }

    if (number.value >= 20 && number.value <= 1_000_000) {
      score += 20;
      reasons.push("reasonable range");
    }

    candidates.push({
      value: number.value,
      raw: number.raw,
      score,
      reasons,
    });
  }

  return candidates
    .filter((candidate) => candidate.value > 0)
    .sort((a, b) => b.score - a.score);
}

function cleanLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function looksLikeBusinessName(text: string): boolean {
  return text.length >= 3 && text.length <= 100 && !/\d{4,}/.test(text);
}

function containsBusinessIndicators(text: string): boolean {
  return (
    text.includes('בע"מ') ||
    text.includes("בע״מ") ||
    text.includes("ltd") ||
    text.includes("group") ||
    text.includes("גרופ") ||
    text.includes("חברה")
  );
}

function containsVendorNoise(text: string): boolean {
  return (
    text.includes("פרטי העסקה") ||
    text.includes("העסקה") ||
    text.includes("חשבון") ||
    text.includes("סניף") ||
    text.includes("מספר") ||
    text.includes("טלפון") ||
    text.includes("פקס") ||
    text.includes("העברה") ||
    text.includes("עובר ושב") ||
    text.includes("יתרה") ||
    text.includes("כרטיס") ||
    text.includes("הוראת") ||
    text.includes("תשלום") ||
    text.includes("תבוצע") ||
    text.includes("יום עסקים") ||
    text.includes("הנוכחי") ||
    text.includes("הערות")
  );
}

export function getVendorCandidates(text: string): VendorCandidate[] {
  const lines = text.split("\n").map(cleanLine).filter(Boolean);
  const candidates: VendorCandidate[] = [];

  const transferMatch = text.match(/העברת כספים\s*-\s*([^\n\r]+)/);

  if (transferMatch?.[1]) {
    candidates.push({
      value: cleanLine(transferMatch[1]),
      score: 150,
      reasons: ["after transfer dash"],
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];
    const line = originalLine.toLowerCase();

    if (
      line.includes("לחשבון") ||
      line.includes("לכבוד") ||
      line.includes("מקבל") ||
      line.includes("מוטב")
    ) {
      const nextLine = lines[i + 1];

      if (
        nextLine &&
        looksLikeBusinessName(nextLine) &&
        !containsVendorNoise(nextLine.toLowerCase())
      ) {
        candidates.push({
          value: nextLine,
          score: 140,
          reasons: ["after receiver label"],
        });
      }
    }

    if (!looksLikeBusinessName(originalLine)) continue;

    let score = 0;
    const reasons: string[] = [];

    if (containsBusinessIndicators(line)) {
      score += 100;
      reasons.push("business indicator");
    }

    if (!containsVendorNoise(line)) {
      score += 25;
      reasons.push("clean text");
    }

    if (originalLine.split(" ").filter(Boolean).length >= 2) {
      score += 20;
      reasons.push("multi-word name");
    }

    if (containsVendorNoise(line)) {
      score -= 100;
      reasons.push("vendor noise");
    }

    if (/\d{3,}/.test(line)) {
      score -= 40;
      reasons.push("contains numbers");
    }

    candidates.push({
      value: originalLine,
      score,
      reasons,
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}