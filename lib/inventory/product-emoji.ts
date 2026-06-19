/**
 * Derive a product-representative emoji from a product's name/category, for use
 * as a warm thumb placeholder when the item has no real image (mirrors the
 * approved mockup's tinted product squares). Presentation-only — no data/schema
 * dependency. Real `imageUrl` always takes precedence at the call site.
 */

// Ordered: more specific keywords first. Hebrew + a few English fallbacks.
const EMOJI_RULES: Array<{ kw: string[]; emoji: string }> = [
  { kw: ["גבינ", "קוטג", "צהוב", "מוצרלה", "פטה"], emoji: "🧀" },
  { kw: ["שמנת", "חלב", "יוגורט", "מעדן", "לבן", "milk"], emoji: "🥛" },
  { kw: ["ביצ", "egg"], emoji: "🥚" },
  { kw: ["גלידה", "שלגון"], emoji: "🍦" },
  { kw: ["לחם", "מאפה", "חלה", "לחמני", "באגט", "פיתה", "bread"], emoji: "🍞" },
  { kw: ["עוגה", "עוגי", "קרואסון"], emoji: "🥐" },
  { kw: ["מים", "מינרלי", "water"], emoji: "💧" },
  { kw: ["קולה", "סודה", "ספרייט", "משקה מוגז", "פחית", "cola", "soda"], emoji: "🥤" },
  { kw: ["מיץ", "juice"], emoji: "🧃" },
  { kw: ["קפה", "coffee"], emoji: "☕" },
  { kw: ["תה", "חליטה"], emoji: "🍵" },
  { kw: ["יין", "וודקה", "וויסקי", "בירה", "אלכוהול", "wine", "beer"], emoji: "🍷" },
  { kw: ["עוף", "פרגית", "שניצל", "chicken"], emoji: "🍗" },
  { kw: ["בשר", "המבורגר", "קבב", "נקניק", "meat", "beef"], emoji: "🥩" },
  { kw: ["דג", "סלמון", "טונה", "fish"], emoji: "🐟" },
  { kw: ["עגבני", "מלפפון", "חסה", "ירק", "בצל", "גזר", "פלפל"], emoji: "🥦" },
  { kw: ["תפוח", "בננה", "תפוז", "ענב", "אבטיח", "פרי", "לימון"], emoji: "🍎" },
  { kw: ["שוקולד", "ממתק", "סוכריה", "חטיף", "וופל", "ביסקוויט"], emoji: "🍫" },
  { kw: ["במבה", "ביסלי", "תפוצ", "פופקורן", "צ׳יפס", "chips"], emoji: "🍿" },
  { kw: ["שמן", "זית", "oil"], emoji: "🫒" },
  { kw: ["מלח", "תבלין", "פלפל שחור", "salt"], emoji: "🧂" },
  { kw: ["סוכר", "קמח", "אורז", "פסטה", "אטריות", "rice", "pasta"], emoji: "🍚" },
  { kw: ["ניקוי", "סבון", "דטרגנט", "אקונומיקה", "מרכך", "soap"], emoji: "🧴" },
  { kw: ["נייר", "טישו", "מגבת", "חיתול", "טואלט", "paper"], emoji: "🧻" },
  { kw: ["שקי", "אריזה", "ניילון", "כוסות", "צלחות", "bag"], emoji: "🛍️" },
];

const DEFAULT_EMOJI = "📦";

export function getProductEmoji(name?: string | null, category?: string | null): string {
  const haystack = `${name ?? ""} ${category ?? ""}`.toLowerCase();
  if (!haystack.trim()) return DEFAULT_EMOJI;
  for (const rule of EMOJI_RULES) {
    if (rule.kw.some((k) => haystack.includes(k))) return rule.emoji;
  }
  return DEFAULT_EMOJI;
}
