/**
 * Revenue report guard — a Z report or a card settlement report must not become an ordinary income record.
 *
 * Both describe sales Dubiz will learn about from their own source (the register's Z, the acquirer's
 * settlement). Approved through the documents inbox as income, the same day's sales would be a second
 * income: once as a FinancialRecord, and again when the report itself is brought in. So before an approval
 * creates a FinancialRecord, the document's OWN TEXT (OCR) is checked for the phrases these reports carry.
 *
 * This is a question, never a block: when a phrase is found, the owner is asked what the document is and
 * decides (record it anyway / keep it as a document only). The file name plays no part — only the content.
 *
 * Deliberately narrow, so an ordinary invoice is not questioned:
 *   - only whole phrases ("דוח Z", "סגירת קופה", "דוח סליקה", "פירוט זיכויים"…), never a lone word such as
 *     "סליקה" or "זיכוי" — an acquirer's fee invoice says "דמי סליקה", a credit note says "חשבונית זיכוי";
 *   - a settlement phrase is asked about only for INCOME: a settlement report approved as an expense is the
 *     acquirer's fees, which is a real expense;
 *   - a Z phrase is asked about in both directions: a Z is never an expense.
 */

export type RevenueReportKind = "z_report" | "settlement_report";

export type RevenueReportSuspicion = {
  kind: RevenueReportKind;
  /** The phrases found (normalized), for the review log — never shown as a verdict. */
  markers: string[];
};

/** Gershayim / quotes / geresh in all their forms → one ASCII quote; whitespace collapsed. */
function normalize(text: string): string {
  return text
    .replace(/[״“”„″"]/g, '"')
    .replace(/[׳‘’`']/g, "'")
    .replace(/\s+/g, " ");
}

// דוח / דו"ח / דו''ח
const REPORT = `דו(?:"|'')?ח`;

const Z_PATTERNS: Array<[string, RegExp]> = [
  ["דוח Z", new RegExp(`${REPORT} ?(?:סגירה ?|יומי ?)?[Zz](?![A-Za-z])`)],
  ["Z report", /\bZ[ -]?report\b/i],
  ["מספר Z", /(?:מספר|מס') ?[Zz](?![A-Za-z])/],
  ["סגירת קופה", /סגירת ?קופה/],
  ["סגירה יומית", /סגירה ?יומית/],
  ["דוח סוף יום", new RegExp(`${REPORT} ?סוף ?(?:ה)?יום`)],
];

const SETTLEMENT_PATTERNS: Array<[string, RegExp]> = [
  ["דוח סליקה", new RegExp(`${REPORT} ?(?:ה)?סליקה`)],
  ["דוח זיכויים", new RegExp(`${REPORT} ?(?:ה)?זיכויים`)],
  ["פירוט זיכויים", /פירוט ?(?:ה)?זיכויים/],
  ["פירוט עסקאות בכרטיסי אשראי", /פירוט ?עסקאות ?ב?כרטיס(?:י)? ?(?:ה)?אשראי/],
  ["דוח תקבולים", new RegExp(`${REPORT} ?(?:ה)?תקבולים`)],
  ["settlement report", /\bsettlement (?:report|statement)\b/i],
];

export function detectRevenueReport(text: string | null | undefined): RevenueReportSuspicion | null {
  if (!text) return null;
  const t = normalize(text);
  const z = Z_PATTERNS.filter(([, re]) => re.test(t)).map(([name]) => name);
  if (z.length > 0) return { kind: "z_report", markers: z };
  const s = SETTLEMENT_PATTERNS.filter(([, re]) => re.test(t)).map(([name]) => name);
  if (s.length > 0) return { kind: "settlement_report", markers: s };
  return null;
}

/**
 * Whether a financial approval must first ask the owner. `confirmed` is the owner's answer from that question
 * ("זה לא דוח Z / סליקה"); once given, the approval proceeds.
 */
export function revenueReportQuestion(input: {
  ocrText: string | null | undefined;
  direction: "income" | "expense";
  confirmed: boolean;
}): RevenueReportSuspicion | null {
  if (input.confirmed) return null;
  const s = detectRevenueReport(input.ocrText);
  if (!s) return null;
  if (s.kind === "settlement_report" && input.direction !== "income") return null;
  return s;
}

export const REVENUE_REPORT_SUSPECTED = "REVENUE_REPORT_SUSPECTED" as const;

export function revenueReportQuestionText(kind: RevenueReportKind): string {
  return kind === "z_report"
    ? "המסמך נראה כמו דוח Z (סגירת קופה). דוח Z אינו חשבונית: אם נרשום אותו כהכנסה, המכירות של אותו יום עלולות להיספר פעמיים. מה זה המסמך?"
    : "המסמך נראה כמו דוח סליקה מחברת האשראי. דוח סליקה אינו חשבונית: אם נרשום אותו כהכנסה, אותן מכירות עלולות להיספר פעמיים. מה זה המסמך?";
}
