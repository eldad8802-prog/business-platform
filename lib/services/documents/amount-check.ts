/**
 * Does the document's own summary contradict the amount we read? Said to the owner in words, at review time.
 *
 * Extraction lowers the confidence of a contradicted amount (amount-entity.service.ts); this module says WHY,
 * so the review screen can show "the lines on the document do not add up" instead of a generic "worth a check".
 * It reads the OCR text already stored on the document — nothing new is stored, no schema involved — and uses
 * the same conservative summary reader, so it never invents a doubt.
 */
import { cleanOCRText } from "./text-cleaner.service";
import { readSummaryLines, summaryContradiction } from "./entities/amount-entity.service";

const fmt = (n: number) => n.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function amountCheckMessage(ocrText: string | null | undefined, amount: number | null | undefined): string | null {
  if (!ocrText || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  const summary = readSummaryLines(cleanOCRText(ocrText));
  const signal = summaryContradiction(amount, summary);
  if (!signal) return null;
  if (signal.includes("VAT line")) {
    return `הסכום שזוהה (${fmt(amount)}) הוא שורת המע״מ במסמך, לא הסכום לתשלום. בדקו את הסכום לפני האישור.`;
  }
  if (signal.includes("add up") && summary.subtotal !== null && summary.vat !== null) {
    return `הסכומים במסמך לא מסתדרים: לפני מע״מ ${fmt(summary.subtotal)} ועוד מע״מ ${fmt(summary.vat)} אינם ${fmt(amount)}. בדקו את הסכום לפני האישור.`;
  }
  if (signal.includes("larger") && summary.total !== null) {
    return `במסמך מופיע סה״כ של ${fmt(summary.total)}, גדול מהסכום שזוהה (${fmt(amount)}). בדקו את הסכום לפני האישור.`;
  }
  return "הסכומים במסמך לא מסתדרים עם הסכום שזוהה. בדקו את הסכום לפני האישור.";
}
