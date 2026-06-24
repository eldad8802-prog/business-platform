/**
 * Phase C — Document Number detector (label-focused, conservative).
 *
 * Extracts an incoming document's own number (invoice / receipt / reference)
 * from OCR text by anchoring ONLY on explicit accounting labels and capturing
 * the adjacent token. It deliberately does NOT free-scan numbers: a value is
 * returned only when it sits next to a known label and survives the
 * date / phone / amount / tax-id exclusions. When unsure → null.
 *
 * This is a new detector that reuses the same plain-text the engine already
 * cleans; it adds no OCR and changes no existing detection.
 */

export type DocumentNumberEntity = {
  value: string;
  label: string;
  confidence: number;
  source: "label_same_line" | "label_next_line";
};

// Ordered by accountant relevance. `mas` = מס׳/מס'/מס (the "number" abbreviation).
const MAS = "מס['׳`]?";
const LABELS: { name: string; re: RegExp; weight: number }[] = [
  { name: "מספר חשבונית", re: new RegExp("מספר\\s*חשבונית"), weight: 0.95 },
  { name: "חשבונית מספר", re: new RegExp("חשבונית\\s*מספר"), weight: 0.95 },
  { name: "חשבונית מס'", re: new RegExp(`חשבונית\\s*${MAS}`), weight: 0.92 },
  { name: "מס' חשבונית", re: new RegExp(`${MAS}\\s*חשבונית`), weight: 0.92 },
  { name: "מספר קבלה", re: new RegExp("מספר\\s*קבלה"), weight: 0.9 },
  { name: "קבלה מס'", re: new RegExp(`קבלה\\s*${MAS}`), weight: 0.9 },
  { name: "מספר מסמך", re: new RegExp("מספר\\s*מסמך"), weight: 0.85 },
  { name: "אסמכתא", re: new RegExp("אסמכת[אה]"), weight: 0.7 },
];

// A candidate token: starts alphanumeric, then digits/letters/slash/dash. Must
// contain at least one digit (checked after capture).
const VALUE_TOKEN = /[:#.\s]*([A-Za-z0-9][A-Za-z0-9/\-]{1,23})/;

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

function isDateToken(t: string): boolean {
  return (
    /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(t) ||
    /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(t)
  );
}

function isPhoneToken(t: string): boolean {
  const d = digitsOnly(t);
  return /^0/.test(d) && d.length >= 9 && d.length <= 10;
}

function isAmountToken(t: string): boolean {
  return /\d[.,]\d{2}$/.test(t) || /[₪]/.test(t);
}

function isTaxIdLike(token: string, line: string): boolean {
  return (
    /^\d{9}$/.test(digitsOnly(token)) &&
    /ח['.\s]?פ|ע['.\s]?מ|עוסק|ח\.פ|ע\.מ/.test(line)
  );
}

/** Strips trailing separators an OCR line often appends (":", ".", "-", "/"). */
function trimToken(t: string): string {
  return t.replace(/^[\s:#.]+/, "").replace(/[\s:.\-/]+$/, "").trim();
}

function isValidDocNumber(token: string, line: string): boolean {
  const t = trimToken(token);
  if (t.length < 2 || t.length > 24) return false;
  if (!/\d/.test(t)) return false;
  if (isDateToken(t)) return false;
  if (isPhoneToken(t)) return false;
  if (isAmountToken(t)) return false;
  if (isTaxIdLike(t, line)) return false;
  return true;
}

function captureFromSegment(segment: string): string | null {
  const m = segment.match(VALUE_TOKEN);
  if (!m) return null;
  return trimToken(m[1]);
}

/**
 * Returns the best document-number match, or null when no labeled, valid number
 * is found. Prefers same-line captures and higher-relevance labels.
 */
export function extractDocumentNumberEntity(
  text: string
): DocumentNumberEntity | null {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  let best: DocumentNumberEntity | null = null;

  const consider = (candidate: DocumentNumberEntity) => {
    if (!best || candidate.confidence > best.confidence) {
      best = candidate;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const label of LABELS) {
      const match = label.re.exec(line);
      if (!match) continue;

      // Same line: capture the token right after the label.
      const after = line.slice(match.index + match[0].length);
      const sameLine = captureFromSegment(after);
      if (sameLine && isValidDocNumber(sameLine, line)) {
        consider({
          value: sameLine,
          label: label.name,
          confidence: label.weight,
          source: "label_same_line",
        });
        continue;
      }

      // Next non-empty line: capture its leading token (common OCR wrap).
      const next = lines[i + 1];
      if (next) {
        const nextToken = captureFromSegment(next);
        if (nextToken && isValidDocNumber(nextToken, next)) {
          consider({
            value: nextToken,
            label: label.name,
            confidence: Math.max(0.5, label.weight - 0.15),
            source: "label_next_line",
          });
        }
      }
    }
  }

  return best;
}

/** Convenience: the document number string, or null. */
export function extractDocumentNumber(text: string): string | null {
  return extractDocumentNumberEntity(text)?.value ?? null;
}
