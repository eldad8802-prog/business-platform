type AnyEntity = Record<string, any>;

export type ResolvedFinalEntities = {
  amount: number | null;
  vendorName: string | null;
  date: Date | string | null;
  uploadedAt?: Date | string | null;
  confidence: number;
  needsReview: boolean;
};

type ResolveInput = {
  entities?: {
    amount?: AnyEntity | null;
    vendor?: AnyEntity | null;
    date?: AnyEntity | Date | string | null;
  };
  understanding?: {
    amounts?: AnyEntity[];
    vendors?: AnyEntity[];
    dates?: AnyEntity[];
  };
  uploadedAt?: Date | string | null;
  rawText?: string | null;
  documentType?: string | null;
};

type VendorDecisionCandidate = {
  text: string;
  source: "understanding" | "composed" | "legacy";
  lineIndex: number;
  confidence: number;
  anchored: boolean;
  score: number;
  signals: string[];
};

const MAIN_AMOUNT_ROLES = ["main_amount", "total", "final_total", "amount_due"];

const MAX_REASONABLE_DOCUMENT_AMOUNT = 1_000_000;

const BUSINESS_ANCHORS = [
  "בעמ",
  'בע"מ',
  "בע״מ",
  "בעיימ",
  "בעימ",
  "חברה",
  "מכללה",
  "מכללת",
  "אוניברסיטה",
  "בית ספר",
  "דיפלומה",
  "עמותה",
  "עוסק",
  "מורשה",
  "שיווק",
  "מערכות",
  "שירותים",
  "ספורט",
  "סאונד",
  "ביטוח",
  "קפה",
  "מסעדה",
  "חנות",
  "מרכז",
  "סטודיו",
  "קליניקה",
  "מוסך",
  "college",
  "university",
  "company",
  "ltd",
  "group",
  "cafe",
  "café",
];

const STANDALONE_BUSINESS_SUFFIXES = [
  "בעמ",
  'בע"מ',
  "בע״מ",
  "בעיימ",
  "בעימ",
  "ltd",
  "limited",
  "company",
  "inc",
];

const TOO_GENERIC_VENDOR_NAMES = [
  "חברת הביטוח",
  "חברה",
  "החברה",
  "מוקד",
  "המוקד",
  "מחלקה",
  "מחלקת",
  "תביעות",
  "תביעה",
  "נזק",
  "חשבונית",
  "קבלה",
];

const BAD_VENDOR_WORDS = [
  "לידי",
  "לכבוד",
  "באמצעות",
  "דוא",
  "מייל",
  "email",
  "gmail",
  "טלפון",
  "פקס",
  "אשראי",
  "כרטיס",
  "תשלום",
  "תנאי תשלום",
  "ניתן לשלם",
  "תשלומים",
  "שעות",
  "מפגשים",
  "תאריך",
  "סהכ",
  'סה"כ',
  "סה״כ",
  "לתשלום",
  "מחיר",
  "עלות",
  "הצעת מחיר",
  "פתיחת",
  "מותנה",
  "תקפה",
  "נוהלי",
  "במקרה של ספק",
  "הנוסח",
  "משרד הבריאות",
  "שכר הלימוד אינו כולל",
  "חשבונית",
  "קבלה",
  "מס/",
  "מספר",
  "מסוף",
  "שובר",
  "סוג פעולה",
  "emv",
  "contactless",
  "תוקף",
  "מוכר",
  "קופאי",
  "מנהל",
  "להתראות",
  "החלפה",
  "מבצעים",
  "שירות גם דרך",
  "וואטסאפ",
  "סליקה",
  "אישור החברה",
  "אישור הלקוח",
  "שם המאשר",
  "שם המוציא",
  "שם המקבל",
  "חתימה",
];

const VENDOR_CONTEXT_NOISE_WORDS = [
  "פריטים",
  "כמות",
  "יחידה",
  "מע״מ",
  'מע"מ',
  "מעמ",
  "לפני מעמ",
  "כולל מעמ",
  "עודף",
  "מזומן",
  "עסקה",
  "אישור",
  "אישרור",
  "חתימה",
  "לקוח",
  "לקוחה",
  "לקוח/ה",
  "מסמך",
  "מקור",
  "העתק",
  "עמוד",
  "footer",
  "header",
];

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeForCompare(value: unknown): string {
  return normalizeText(value)
    .replace(/[״"]/g, '"')
    .replace(/[׳']/g, "'")
    .toLowerCase();
}

function includesAny(text: string, values: string[]): boolean {
  const lower = normalizeForCompare(text);
  return values.some((value) => lower.includes(normalizeForCompare(value)));
}

function isQuoteLikeDocument(input: ResolveInput): boolean {
  const documentType = normalizeForCompare(input.documentType);
  const rawText = normalizeForCompare(input.rawText);

  return (
    documentType.includes("quote") ||
    includesAny(rawText, [
      "הצעת מחיר",
      "הצעה",
      "proposal",
      "quote",
      "טרם שולם",
      "לא שולם",
      "ניתן לשלם",
    ])
  );
}

function hasTotalSignal(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return includesAny(String(value ?? ""), [
      "סהכ",
      'סה"כ',
      "סה״כ",
      "סך הכל",
      "סך-הכול",
      "סך הכול",
      "לתשלום",
      "סכום לתשלום",
      "amount due",
      "total",
    ]);
  }

  const item = value as AnyEntity;
  const raw = normalizeText(
    `${item.raw ?? ""} ${item.normalized ?? ""} ${item.label ?? ""} ${item.role ?? ""}`
  );

  return includesAny(raw, [
    "סהכ",
    'סה"כ',
    "סה״כ",
    "סך הכל",
    "סך-הכול",
    "סך הכול",
    "לתשלום",
    "סכום לתשלום",
    "amount due",
    "total",
    "final_total",
    "amount_due",
  ]);
}

function hasLineItemSignal(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const item = value as AnyEntity;
  const raw = normalizeForCompare(
    `${item.raw ?? ""} ${item.normalized ?? ""} ${item.label ?? ""} ${item.role ?? ""}`
  );

  return includesAny(raw, [
    "מחיר שירות",
    "מחיר יחידה",
    "דמי פתיחה",
    "דמי הרשמה",
    "line_item",
    "secondary_fee",
    "fee",
  ]);
}

function extractNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const raw =
    typeof value === "object" && value !== null
      ? String(
          (value as AnyEntity).value ??
            (value as AnyEntity).amount ??
            (value as AnyEntity).raw ??
            (value as AnyEntity).normalized ??
            ""
        )
      : String(value ?? "");

  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const matches = cleaned.match(/-?\d+(?:\.\d+)?/g);

  if (!matches || matches.length === 0) return null;

  const selected = matches[matches.length - 1];
  const num = Number(selected);

  return Number.isFinite(num) ? num : null;
}

function getAmountRawText(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const item = value as AnyEntity;
    return normalizeText(
      item.raw ?? item.normalized ?? item.value ?? item.amount ?? ""
    );
  }

  return normalizeText(value);
}

function isLikelyTechnicalAmount(value: number, rawValue: unknown): boolean {
  const raw = getAmountRawText(rawValue);
  const digitsOnly = raw.replace(/[^\d]/g, "");
  const integerDigits = String(Math.trunc(Math.abs(value))).length;

  if (!Number.isFinite(value)) return true;
  if (value <= 0) return true;

  if (value >= 1900 && value <= 2099) return true;
  if (value > MAX_REASONABLE_DOCUMENT_AMOUNT) return true;
  if (integerDigits >= 8) return true;
  if (digitsOnly.length >= 10) return true;
  if (/[א-תa-zA-Z]/.test(raw) && digitsOnly.length >= 7) return true;

  return false;
}

function isValidAmount(num: number, rawValue?: unknown): boolean {
  if (!Number.isFinite(num)) return false;
  if (num <= 0) return false;
  if (num >= 1900 && num <= 2099) return false;
  if (isLikelyTechnicalAmount(num, rawValue ?? num)) return false;
  return true;
}

function recoverTrailingMoneyAmount(value: unknown): number | null {
  const raw = getAmountRawText(value)
    .replace(/\s+/g, "")
    .replace(/,/g, ".");

  const match = raw.match(/(\d{7,})\.(\d{2})(?!\d)/);

  if (!match) return null;

  const integerPart = match[1];
  const decimals = match[2];

  const suffixLengths = [3, 4, 2, 5];

  for (const length of suffixLengths) {
    if (integerPart.length < length) continue;

    const suffix = integerPart.slice(-length);
    const candidate = Number(`${suffix}.${decimals}`);

    if (
      Number.isFinite(candidate) &&
      candidate > 0 &&
      candidate < MAX_REASONABLE_DOCUMENT_AMOUNT &&
      !(candidate >= 1900 && candidate <= 2099)
    ) {
      return candidate;
    }
  }

  return null;
}

function resolveAmount(input: ResolveInput): {
  value: number | null;
  confidence: number;
  needsReview: boolean;
} {
  const amounts = Array.isArray(input.understanding?.amounts)
    ? input.understanding.amounts
    : [];

  const quoteLike = isQuoteLikeDocument(input);

  const scoredAmounts = amounts
    .map((item) => {
      const originalValue = extractNumber(item);
      const originalIsValid =
        originalValue !== null && isValidAmount(originalValue, item);

      const recoveredValue =
        originalValue !== null && !originalIsValid
          ? recoverTrailingMoneyAmount(item)
          : null;

      const value = originalIsValid ? originalValue : recoveredValue;
      const recovered = !originalIsValid && recoveredValue !== null;

      const role = normalizeText(item.role).toLowerCase();
      const confidence = Number(item.confidence ?? 0.5);
      const totalSignal = hasTotalSignal(item);
      const lineItemSignal = hasLineItemSignal(item);

      let score = confidence * 100;

      if (recovered) {
        score += 40;
        if (totalSignal) score += 120;
        if (MAIN_AMOUNT_ROLES.includes(role)) score += 80;
      } else {
        if (MAIN_AMOUNT_ROLES.includes(role)) score += 300;
        if (role === "main_amount") score += 100;
        if (role === "payment" || role === "payment_amount") score += 280;
        if (role === "charged_amount") score += 280;

        if (totalSignal) score += quoteLike ? 700 : 360;
      }

      if (role === "secondary_fee") score -= 120;
      if (role === "line_item") score -= 180;
      if (role === "fee") score -= 80;
      if (role === "unknown") score -= 40;

      if (quoteLike && lineItemSignal && !totalSignal) score -= 450;

      return { item, value, role, confidence, score, totalSignal, recovered };
    })
    .filter((item) => item.value !== null)
    .filter((item) =>
      item.recovered
        ? isValidAmount(item.value as number, item.value as number)
        : isValidAmount(item.value as number, item.item)
    )
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.value ?? 0) - (a.value ?? 0);
    });

  if (quoteLike) {
    const bestQuoteTotal = scoredAmounts.find((item) => item.totalSignal);

    if (bestQuoteTotal?.value !== null && bestQuoteTotal?.value !== undefined) {
      return {
        value: bestQuoteTotal.value,
        confidence: bestQuoteTotal.recovered
          ? Math.max(0.62, Math.min(0.72, bestQuoteTotal.confidence))
          : Math.max(0.88, bestQuoteTotal.confidence),
        needsReview: bestQuoteTotal.recovered,
      };
    }
  }

  const bestMainAmount = scoredAmounts.find(
    (item) => MAIN_AMOUNT_ROLES.includes(item.role) || item.totalSignal
  );

  if (bestMainAmount?.value !== null && bestMainAmount?.value !== undefined) {
    return {
      value: bestMainAmount.value,
      confidence: bestMainAmount.recovered
        ? Math.max(0.62, Math.min(0.72, bestMainAmount.confidence))
        : Math.max(0.85, bestMainAmount.confidence),
      needsReview: bestMainAmount.recovered,
    };
  }

  const legacyValue = extractNumber(input.entities?.amount ?? null);
  const legacyConfidence =
    typeof input.entities?.amount === "object" && input.entities.amount !== null
      ? Number(input.entities.amount.confidence ?? 0.45)
      : 0.45;

  const bestUnderstandingAmount = scoredAmounts[0];

  if (
    bestUnderstandingAmount?.value !== null &&
    bestUnderstandingAmount?.value !== undefined
  ) {
    const understandingValue = bestUnderstandingAmount.value;
    const legacyIsValid =
      legacyValue !== null &&
      isValidAmount(legacyValue, input.entities?.amount ?? legacyValue);

    const shouldPreferUnderstanding =
      !legacyIsValid ||
      legacyConfidence < 0.85 ||
      understandingValue > (legacyValue ?? 0) * 1.25 ||
      bestUnderstandingAmount.role === "payment" ||
      bestUnderstandingAmount.role === "payment_amount" ||
      bestUnderstandingAmount.role === "charged_amount" ||
      bestUnderstandingAmount.totalSignal;

    if (shouldPreferUnderstanding) {
      return {
        value: understandingValue,
        confidence: bestUnderstandingAmount.recovered
          ? Math.max(0.62, Math.min(0.72, bestUnderstandingAmount.confidence))
          : Math.max(0.65, bestUnderstandingAmount.confidence),
        needsReview:
          bestUnderstandingAmount.recovered ||
          bestUnderstandingAmount.confidence < 0.85,
      };
    }
  }

  if (
    legacyValue !== null &&
    isValidAmount(legacyValue, input.entities?.amount ?? legacyValue)
  ) {
    return {
      value: legacyValue,
      confidence: legacyConfidence,
      needsReview: legacyConfidence < 0.85,
    };
  }

  return {
    value: null,
    confidence: 0,
    needsReview: true,
  };
}

function isEmail(text: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/i.test(text);
}

function isStandaloneBusinessSuffix(text: string): boolean {
  const normalized = normalizeForCompare(text)
    .replace(/[^\u0590-\u05FFa-zA-Z"]/g, "")
    .trim();

  return STANDALONE_BUSINESS_SUFFIXES.some(
    (suffix) =>
      normalized ===
      normalizeForCompare(suffix).replace(/[^\u0590-\u05FFa-zA-Z"]/g, "")
  );
}

function normalizeVendorKey(text: string): string {
  return normalizeForCompare(text).replace(/[^\u0590-\u05FFa-zA-Z0-9]+/g, "");
}

function areSameVendorText(a: string, b: string): boolean {
  const keyA = normalizeVendorKey(a);
  const keyB = normalizeVendorKey(b);

  if (!keyA || !keyB) return false;
  return keyA === keyB;
}

function isTooGenericVendorName(text: string): boolean {
  const normalized = normalizeVendorKey(text);

  return TOO_GENERIC_VENDOR_NAMES.some(
    (name) => normalizeVendorKey(name) === normalized
  );
}

function isStrongLegacyVendor(entity: unknown): boolean {
  if (!entity || typeof entity !== "object") return false;

  const item = entity as AnyEntity;

  return Boolean(
    item.businessId ||
      item.business_id ||
      item.companyId ||
      item.source === "business_id" ||
      item.source === "businessId"
  );
}

function isTechnicalGarbage(text: string): boolean {
  const clean = normalizeText(text);
  const lower = clean.toLowerCase();
  const digits = clean.replace(/[^\d]/g, "");

  if (!clean) return true;
  if (clean.length < 2) return true;
  if (clean.length > 70) return true;
  if (clean.split(" ").length > 9) return true;
  if (isEmail(clean)) return true;
  if (isStandaloneBusinessSuffix(clean)) return true;
  if (clean.includes("_")) return true;
  if (clean.includes("...")) return true;
  if (clean.includes("###")) return true;
  if (/^[A-Z0-9._\- ]+$/i.test(clean) && /\d/.test(clean)) return true;
  if (/^\d/.test(clean)) return true;
  if (digits.length >= 7) return true;
  if (/₪|ש"ח|ש״ח|שח|ils|nis/i.test(clean)) return true;
  if (lower === "i" || lower === "b" || lower === "on") return true;

  return false;
}

function hasBadVendorWord(text: string): boolean {
  const lower = text.toLowerCase();
  return BAD_VENDOR_WORDS.some((word) => lower.includes(word.toLowerCase()));
}

function hasContextNoiseWord(text: string): boolean {
  const lower = text.toLowerCase();
  return VENDOR_CONTEXT_NOISE_WORDS.some((word) =>
    lower.includes(word.toLowerCase())
  );
}

function hasBusinessAnchor(text: string): boolean {
  const lower = text.toLowerCase();
  return BUSINESS_ANCHORS.some((anchor) =>
    lower.includes(anchor.toLowerCase())
  );
}

function cleanVendorName(text: string): string {
  return normalizeText(text)
    .replace(/,?\s*בכתובת:.*$/i, "")
    .replace(/כתובת:.*$/i, "")
    .replace(/^שם\s*[:\-–—]\s*/i, "")
    .replace(/^ספק\s*[:\-–—]\s*/i, "")
    .replace(/^[:\-–—]+/, "")
    .replace(/[:\-–—]+$/, "")
    .trim();
}

function getVendorText(entity: unknown): string | null {
  if (!entity) return null;

  if (typeof entity === "string") {
    const text = cleanVendorName(entity);
    return text || null;
  }

  if (typeof entity === "object") {
    const item = entity as AnyEntity;
    const text = cleanVendorName(
      item.name ?? item.vendorName ?? item.value ?? item.raw ?? item.normalized
    );

    return text || null;
  }

  return null;
}

function getLineIndex(entity: AnyEntity): number {
  const raw = entity.lineIndex ?? entity.index;
  const lineIndex = Number(raw);
  return Number.isFinite(lineIndex) ? lineIndex : 999;
}

function hasRealLineIndex(entity: AnyEntity): boolean {
  const raw = entity.lineIndex ?? entity.index;
  const lineIndex = Number(raw);
  return Number.isFinite(lineIndex) && lineIndex >= 0 && lineIndex < 999;
}

function getVendorConfidence(entity: AnyEntity): number {
  const raw = Number(entity.confidence ?? 0.3);
  if (!Number.isFinite(raw)) return 0.3;
  return Math.max(0, Math.min(1, raw));
}

function isLikelyPersonRole(text: string): boolean {
  const lower = text.toLowerCase();

  return (
    lower.includes("מוכר") ||
    lower.includes("קופאי") ||
    lower.includes("מנהל") ||
    lower.includes("מלצר") ||
    lower.includes("נהג") ||
    lower.includes("סוכן")
  );
}

function isLikelyItemOrReceiptLine(text: string): boolean {
  const lower = text.toLowerCase();

  return (
    lower.includes("תיאור") ||
    lower.includes("פריט") ||
    lower.includes("מוצר") ||
    lower.includes("שורות מוצרים") ||
    lower.includes("נייקי") ||
    lower.includes("בלייזר") ||
    lower.includes("חזה") ||
    lower.includes("עוף") ||
    lower.includes("פרגית") ||
    lower.includes("קולה") ||
    lower.includes("ציפס") ||
    lower.includes("קרלסברג")
  );
}

function looksLikeHumanNameOnly(text: string): boolean {
  const words = normalizeText(text).split(" ").filter(Boolean);

  if (words.length < 2 || words.length > 3) return false;
  if (hasBusinessAnchor(text)) return false;
  if (/\d/.test(text)) return false;
  if (isLikelyPersonRole(text)) return true;

  return false;
}

function isDocumentTitleLike(text: string): boolean {
  const lower = text.toLowerCase();

  const documentIndicators = [
    "אישור",
    "קבלה",
    "חשבונית",
    "מסמך",
    "פירוט",
    'דו"ח',
    "דוח",
    "תעודה",
    "סיכום",
  ];

  const actionIndicators = [
    "תשלום",
    "עסקה",
    "הרשמה",
    "חיוב",
    "זיכוי",
    "הזמנה",
  ];

  const startsWithDocumentWord = documentIndicators.some((word) =>
    lower.startsWith(word)
  );

  const hasAction = actionIndicators.some((word) => lower.includes(word));

  return startsWithDocumentWord && hasAction;
}

function isLikelySentence(text: string): boolean {
  const lower = text.toLowerCase();

  if (text.split(" ").length > 6) return true;

  const sentenceIndicators = [
    "אנו",
    "מודים",
    "מאשרים",
    "נשלח",
    "יש לבצע",
    "בהתאם",
    "במידה",
    "הנך",
    "הינך",
  ];

  if (sentenceIndicators.some((word) => lower.includes(word))) {
    return true;
  }

  if (text.includes(",") || text.includes(".")) return true;

  return false;
}

function isReasonableVendorText(text: string): boolean {
  if (!text) return false;
  if (isStandaloneBusinessSuffix(text)) return false;
  if (isTechnicalGarbage(text)) return false;
  if (hasBadVendorWord(text)) return false;
  if (isLikelyItemOrReceiptLine(text)) return false;
  if (isDocumentTitleLike(text)) return false;
  if (isLikelySentence(text)) return false;

  const words = text.split(" ").filter(Boolean);
  if (words.length === 1 && text.length < 5) return false;

  return true;
}

function scoreVendor(entity: AnyEntity): {
  text: string | null;
  score: number;
  anchored: boolean;
} {
  const text = getVendorText(entity);

  if (!text) return { text: null, score: -999, anchored: false };
  if (!isReasonableVendorText(text)) {
    return { text, score: -999, anchored: false };
  }

  const anchored = hasBusinessAnchor(text);
  const lineIndex = getLineIndex(entity);
  const wordCount = text.split(" ").filter(Boolean).length;
  const confidence = getVendorConfidence(entity);

  let score = 0;

  score += confidence * 100;

  if (anchored) score += 220;

  if (lineIndex <= 2) score += 140;
  else if (lineIndex <= 6) score += 90;
  else if (lineIndex <= 10) score += 40;
  else if (lineIndex > 25) score -= 120;

  if (wordCount === 1 && text.length <= 12 && lineIndex <= 5) {
    score += 70;
  }

  if (wordCount >= 2 && wordCount <= 5) {
    score += 55;
  }

  if (wordCount > 6) score -= 120;
  if (/\d/.test(text)) score -= 90;
  if (looksLikeHumanNameOnly(text)) score -= 120;
  if (hasContextNoiseWord(text)) score -= 80;
  if (isTooGenericVendorName(text)) score -= 140;

  return { text, score, anchored };
}

function mergeStandaloneBusinessSuffixCandidates(
  vendors: AnyEntity[]
): AnyEntity[] {
  const merged: AnyEntity[] = [];

  for (let index = 0; index < vendors.length; index++) {
    const current = vendors[index];
    const currentText = getVendorText(current);

    if (!currentText) continue;

    if (isStandaloneBusinessSuffix(currentText)) {
      const currentLineIndex = getLineIndex(current);

      let previousCandidate: AnyEntity | null = null;

      for (let j = index - 1; j >= 0; j--) {
        const previous = vendors[j];
        const previousText = getVendorText(previous);
        const previousLineIndex = getLineIndex(previous);

        if (!previousText) continue;
        if (isStandaloneBusinessSuffix(previousText)) continue;
        if (!isReasonableVendorText(previousText)) continue;
        if (areSameVendorText(previousText, currentText)) continue;
        if (currentLineIndex - previousLineIndex > 2) continue;

        previousCandidate = previous;
        break;
      }

      if (previousCandidate) {
        const previousText = getVendorText(previousCandidate);

        if (previousText && !areSameVendorText(previousText, currentText)) {
          merged.push({
            ...previousCandidate,
            name: `${previousText} ${currentText}`,
            value: `${previousText} ${currentText}`,
            raw: `${previousText} ${currentText}`,
            confidence: Math.max(
              getVendorConfidence(previousCandidate),
              getVendorConfidence(current)
            ),
            lineIndex: getLineIndex(previousCandidate),
            signals: [
              ...((previousCandidate.signals as string[] | undefined) ?? []),
              "vendor decision: merged standalone business suffix from nearby line",
            ],
          });
        }
      }

      continue;
    }

    merged.push(current);
  }

  return merged;
}

function dedupeVendorCandidates(
  candidates: VendorDecisionCandidate[]
): VendorDecisionCandidate[] {
  const byKey = new Map<string, VendorDecisionCandidate>();

  for (const candidate of candidates) {
    const key = normalizeVendorKey(candidate.text);
    if (!key) continue;

    const existing = byKey.get(key);

    if (!existing || candidate.score > existing.score) {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()];
}

function buildVendorDecisionCandidate(
  text: string,
  entity: AnyEntity,
  source: VendorDecisionCandidate["source"],
  extraScore = 0,
  extraSignals: string[] = []
): VendorDecisionCandidate | null {
  const cleanText = cleanVendorName(text);

  if (!cleanText) return null;
  if (!isReasonableVendorText(cleanText)) return null;

  const base = scoreVendor({
    ...entity,
    name: cleanText,
    value: cleanText,
    raw: cleanText,
  });

  if (!base.text || base.score <= 0) return null;

  const anchored = hasBusinessAnchor(cleanText);
  const lineIndex = getLineIndex(entity);
  const confidence = getVendorConfidence(entity);
  const wordCount = cleanText.split(" ").filter(Boolean).length;

  let score = base.score + extraScore;
  const signals = [...extraSignals];

  if (source === "composed") {
    score += 90;
    signals.push("vendor decision: composed candidate from nearby lines");
  }

  if (anchored) {
    score += 60;
    signals.push("vendor decision: contains business anchor");
  }

  if (lineIndex <= 5) {
    score += 50;
    signals.push("vendor decision: appears in document header area");
  }

  if (wordCount >= 2 && wordCount <= 5) {
    score += 35;
    signals.push("vendor decision: reasonable business name length");
  }

  if (hasContextNoiseWord(cleanText)) {
    score -= 100;
    signals.push("vendor decision: contains context noise");
  }

  if (isTooGenericVendorName(cleanText)) {
    score -= 160;
    signals.push("vendor decision: too generic as standalone vendor");
  }

  return {
    text: cleanText,
    source,
    lineIndex,
    confidence,
    anchored,
    score,
    signals,
  };
}

function buildComposedVendorCandidates(
  vendors: AnyEntity[]
): VendorDecisionCandidate[] {
  const candidates: VendorDecisionCandidate[] = [];

  const sorted = [...vendors].sort((a, b) => getLineIndex(a) - getLineIndex(b));

  for (let index = 0; index < sorted.length; index++) {
    const current = sorted[index];
    const currentText = getVendorText(current);
    const currentLineIndex = getLineIndex(current);

    if (!currentText || !isReasonableVendorText(currentText)) continue;

    const currentCandidate = buildVendorDecisionCandidate(
      currentText,
      current,
      "understanding",
      0,
      ["vendor decision: direct understanding candidate"]
    );

    if (currentCandidate) candidates.push(currentCandidate);

    const next = sorted[index + 1];
    const nextText = next ? getVendorText(next) : null;
    const nextLineIndex = next ? getLineIndex(next) : 999;

    if (!next || !nextText) continue;
    if (!hasRealLineIndex(current) || !hasRealLineIndex(next)) continue;
    if (nextLineIndex - currentLineIndex > 2) continue;
    if (areSameVendorText(currentText, nextText)) continue;

    if (isStandaloneBusinessSuffix(nextText)) {
      const composedText = `${currentText} ${nextText}`;
      const composed = buildVendorDecisionCandidate(
        composedText,
        {
          ...current,
          confidence: Math.max(
            getVendorConfidence(current),
            getVendorConfidence(next)
          ),
          lineIndex: currentLineIndex,
        },
        "composed",
        160,
        ["vendor decision: current line plus standalone business suffix"]
      );

      if (composed) candidates.push(composed);
    }

    if (
      !isStandaloneBusinessSuffix(nextText) &&
      hasBusinessAnchor(nextText) &&
      isReasonableVendorText(nextText)
    ) {
      const composedText = `${currentText} ${nextText}`;
      const composedWordCount = composedText.split(" ").filter(Boolean).length;

      if (
        composedWordCount <= 7 &&
        !areSameVendorText(currentText, nextText) &&
        !isTooGenericVendorName(currentText) &&
        !isTooGenericVendorName(nextText)
      ) {
        const composed = buildVendorDecisionCandidate(
          composedText,
          {
            ...current,
            confidence: Math.max(
              getVendorConfidence(current),
              getVendorConfidence(next)
            ),
            lineIndex: currentLineIndex,
          },
          "composed",
          95,
          ["vendor decision: nearby business-anchored continuation"]
        );

        if (composed) candidates.push(composed);
      }
    }
  }

  return candidates;
}

function resolveVendor(input: ResolveInput): {
  value: string | null;
  confidence: number;
  needsReview: boolean;
} {
  const legacyText = getVendorText(input.entities?.vendor ?? null);
  const legacyIsStrong = isStrongLegacyVendor(input.entities?.vendor ?? null);

  if (legacyText && legacyIsStrong && isReasonableVendorText(legacyText)) {
    return {
      value: legacyText,
      confidence: 0.94,
      needsReview: false,
    };
  }

  const vendors = Array.isArray(input.understanding?.vendors)
    ? input.understanding.vendors
    : [];

  const enrichedVendors = mergeStandaloneBusinessSuffixCandidates(vendors);

  const directCandidates = enrichedVendors
    .map((vendor) => {
      const text = getVendorText(vendor);
      if (!text) return null;

      return buildVendorDecisionCandidate(
        text,
        vendor,
        "understanding",
        0,
        ["vendor decision: scored direct candidate"]
      );
    })
    .filter(
      (candidate): candidate is VendorDecisionCandidate => Boolean(candidate)
    );

  const composedCandidates = buildComposedVendorCandidates(enrichedVendors);

  const candidates = dedupeVendorCandidates([
    ...directCandidates,
    ...composedCandidates,
  ]).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (Number(b.anchored) !== Number(a.anchored)) {
      return Number(b.anchored) - Number(a.anchored);
    }
    return a.lineIndex - b.lineIndex;
  });

  const bestUnderstandingVendor = candidates[0];

 if (bestUnderstandingVendor?.text) {
  const isGeneric = isTooGenericVendorName(bestUnderstandingVendor.text);

  const isWeakCandidate =
    !bestUnderstandingVendor.anchored ||
    isGeneric ||
    bestUnderstandingVendor.score < 180;

  // 🟢 במקום להחזיר null — תמיד נחזיר את הישות
  if (isWeakCandidate) {
    return {
      value: bestUnderstandingVendor.text,
      confidence: Math.max(0.4, bestUnderstandingVendor.confidence),
      needsReview: true,
    };
  }

  // 🟢 ישות חזקה
  return {
    value: bestUnderstandingVendor.text,
    confidence: Math.max(0.9, bestUnderstandingVendor.confidence),
    needsReview: false,
  };
}
  if (legacyText && isReasonableVendorText(legacyText)) {
    const anchored = hasBusinessAnchor(legacyText);
    const isGeneric = isTooGenericVendorName(legacyText);

    return {
      value: legacyText,
      confidence: anchored && !isGeneric ? 0.84 : 0.55,
      needsReview: isGeneric || !anchored,
    };
  }

  return {
    value: null,
    confidence: 0,
    needsReview: true,
  };
}

function safeParseDate(value: unknown): Date | null {
  if (!value) return null;

  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const item = value as AnyEntity;
    return safeParseDate(item.value ?? item.date ?? item.raw ?? item.normalized);
  }

  const text = normalizeText(value);
  const parsed = new Date(text);

  if (!isNaN(parsed.getTime())) return parsed;

  const hebrewMonths: Record<string, number> = {
    ינואר: 0,
    פברואר: 1,
    מרץ: 2,
    אפריל: 3,
    מאי: 4,
    יוני: 5,
    יולי: 6,
    אוגוסט: 7,
    ספטמבר: 8,
    אוקטובר: 9,
    נובמבר: 10,
    דצמבר: 11,
  };

  const match = text.match(/(\d{1,2})\s+([א-ת]+)\s+(\d{4})/);
  if (match) {
    const day = Number(match[1]);
    const month = hebrewMonths[match[2]];
    const year = Number(match[3]);

    if (month !== undefined) {
      return new Date(year, month, day);
    }
  }

  return null;
}

function resolveDate(input: ResolveInput): {
  value: Date | null;
  confidence: number;
  needsReview: boolean;
} {
  const legacyDate = safeParseDate(input.entities?.date ?? null);

  if (legacyDate) {
    return {
      value: legacyDate,
      confidence:
        typeof input.entities?.date === "object" && input.entities.date !== null
          ? Number((input.entities.date as AnyEntity).confidence ?? 0.65)
          : 0.65,
      needsReview: true,
    };
  }

  const dates = Array.isArray(input.understanding?.dates)
    ? input.understanding.dates
    : [];

  const parsed = dates
    .map((date) => ({
      value: safeParseDate(date),
      confidence: Number(date.confidence ?? 0.4),
    }))
    .filter((item) => item.value)
    .sort((a, b) => b.confidence - a.confidence)[0];

  if (parsed?.value) {
    return {
      value: parsed.value,
      confidence: parsed.confidence,
      needsReview: parsed.confidence < 0.85,
    };
  }

  return {
    value: null,
    confidence: 0,
    needsReview: true,
  };
}

export function resolveFinalEntities(
  input: ResolveInput
): ResolvedFinalEntities {
  const amount = resolveAmount(input);
  const vendor = resolveVendor(input);
  const date = resolveDate(input);

  const confidenceParts = [
    amount.confidence,
    vendor.confidence,
    date.confidence,
  ].filter((value) => Number.isFinite(value));

  const confidence =
    confidenceParts.length > 0
      ? Number(
          (
            confidenceParts.reduce((sum, value) => sum + value, 0) /
            confidenceParts.length
          ).toFixed(2)
        )
      : 0;

  const needsReview =
    amount.needsReview ||
    vendor.needsReview ||
    date.needsReview ||
    confidence < 0.75;

  return {
    amount: amount.value,
    vendorName: vendor.value,
    date: date.value,
    uploadedAt: input.uploadedAt ?? null,
    confidence,
    needsReview,
  };
}

export default resolveFinalEntities;