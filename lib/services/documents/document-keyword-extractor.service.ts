type KeywordCandidate = {
  value: string;
  score: number;
  count: number;
  source: "header" | "body";
};

const STOP_WORDS = [
  "של",
  "עם",
  "על",
  "זה",
  "גם",
  "כל",
  "או",
  "כי",
  "אם",
  "אל",
  "לא",
  "כן",
];

function cleanWord(word: string): string {
  return word
    .replace(/[^\u0590-\u05FFa-zA-Z0-9]/g, "")
    .trim()
    .toLowerCase();
}

function isValidWord(word: string): boolean {
  if (!word) return false;
  if (word.length < 3) return false;
  if (/^\d+$/.test(word)) return false;
  if (STOP_WORDS.includes(word)) return false;

  return true;
}

function getLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// 🧠 שורה עשירה = יש בה הרבה מילים או מידע
function isRichLine(line: string): boolean {
  const words = line.split(" ").filter(Boolean);
  return words.length >= 3;
}

// 🧠 שורה עם כסף = חשובה
function hasMoney(line: string): boolean {
  return /₪|\d{2,},?\d{2,}/.test(line);
}

// 🧠 שורה עם פעולה עסקית
function hasAction(line: string): boolean {
  const keywords = ["תשלום", "תביעה", "נזק", "שירות", "פריט"];
  return keywords.some((k) => line.includes(k));
}

export function extractKeywordCandidates(text: string): KeywordCandidate[] {
  const lines = getLines(text);

  const map = new Map<
    string,
    { count: number; score: number; source: "header" | "body" }
  >();

  lines.forEach((line, index) => {
    const words = line.split(" ");

    const rich = isRichLine(line);
    const money = hasMoney(line);
    const action = hasAction(line);

    for (const rawWord of words) {
      const word = cleanWord(rawWord);

      if (!isValidWord(word)) continue;

      let score = 0.3;

      // 🔹 שורות body מקבלות עדיפות על header
      if (index >= 5) score += 0.2;

      // 🔹 שורה עשירה
      if (rich) score += 0.2;

      // 🔹 שורה עם כסף
      if (money) score += 0.3;

      // 🔹 שורה עם פעולה עסקית
      if (action) score += 0.3;

      const existing = map.get(word);

      if (!existing) {
        map.set(word, {
          count: 1,
          score,
          source: index < 5 ? "header" : "body",
        });
      } else {
        existing.count += 1;

        // 🔥 חזרתיות = חיזוק אמיתי
        const repeatBoost = existing.count * 0.25;

        existing.score = Math.min(
          1,
          existing.score + score * 0.3 + repeatBoost
        );
      }
    }
  });

  const result: KeywordCandidate[] = [];

  for (const [value, data] of map.entries()) {
    // 🔥 פילטר כללי (לא לפי מילים ספציפיות)
    if (data.score < 0.7 && data.count < 2) continue;

    result.push({
      value,
      count: data.count,
      score: Math.min(1, data.score),
      source: data.source,
    });
  }

  return result.sort((a, b) => b.score - a.score).slice(0, 15);
}