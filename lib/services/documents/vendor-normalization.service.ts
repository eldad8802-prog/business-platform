export type NormalizedVendor = {
  displayName: string;
  normalizedKey: string;
};

function cleanBase(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[״"]/g, "")
    .replace(/[׳']/g, "")
    .replace(/[־–—-]/g, " ")
    .replace(/[.,:;(){}\[\]]/g, " ")
    .trim()
    .toLowerCase();
}

// 🔥 שכבת תיקון וריאציות כתיב (בטוחה בלבד)
function normalizeSpellingVariants(token: string): string {
  const map: Record<string, string> = {
    "תקווה": "תקוה",
    "בע\"מ": "בעמ",
    "בע״מ": "בעמ",
    "בע מ": "בעמ",
  };

  return map[token] || token;
}

// 🔥 הסרת מילים כלליות שלא תורמות לזיהוי ספק
function removeNoiseWords(tokens: string[]): string[] {
  const noiseWords = [
    "שם",
    "הספק",
    "ספק",
    "לכבוד",
    "עבור",
    "חשבונית",
    "קבלה",
    "מס",
    "מספר",
  ];

  return tokens.filter((t) => !noiseWords.includes(t));
}

// 🔥 הסרת כפילויות
function uniqueTokens(tokens: string[]): string[] {
  return Array.from(new Set(tokens));
}

// 🔥 ניקוי שם לתצוגה בלבד
function normalizeDisplayName(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[:\-–—]+/, "")
    .trim();
}

export function normalizeVendorForLearning(
  vendorName: string
): NormalizedVendor {
  const raw = String(vendorName ?? "").trim();

  const displayName = normalizeDisplayName(raw);

  const cleaned = cleanBase(displayName);

  let tokens = cleaned.split(" ").filter(Boolean);

  // 🔥 תיקון וריאציות
  tokens = tokens.map(normalizeSpellingVariants);

  // 🔥 הסרת מילים לא רלוונטיות
  tokens = removeNoiseWords(tokens);

  // 🔥 הסרת כפילויות
  tokens = uniqueTokens(tokens);

  const normalizedKey = tokens.join(" ");

  return {
    displayName: displayName || "Unknown",
    normalizedKey: normalizedKey || "unknown",
  };
}