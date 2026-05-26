import { CATEGORY_MAP } from "@/lib/constants/categories";
import { formatAmountDisplay, formatDateShort } from "./format";
import type {
  ExtractionConfidenceMeta,
  ReviewDraft,
  ReviewMode,
  TrustLevel,
} from "./types";
import { hasNonEmptyText, isValidPositiveAmount } from "./validation";
import {
  trafficForAmount,
  trafficForCategory,
  trafficForDate,
  trafficForDirection,
  trafficForVendor,
} from "./traffic";

export type TrustContext = {
  trustLevel: TrustLevel;
  trustTitle: string;
  trustSummary: string;
  trustReasons: string[];
  approvalImpact: string;
  aiSummaryBody: string;
  amountDisplay: string;
  vendorDisplay: string;
  dateDisplay: string;
  categoryDisplay: string;
  directionDisplay: string;
};

export function computeTrustContext(input: {
  draft: ReviewDraft;
  extractionMeta: ExtractionConfidenceMeta | null;
  reviewMode: ReviewMode;
  profileId: string;
}): TrustContext {
  const { draft, extractionMeta, reviewMode } = input;
  const pid = input.profileId;

  const amountLevel = trafficForAmount(extractionMeta, draft);
  const vendorLevel = trafficForVendor(extractionMeta, draft);
  const dateLevel = trafficForDate(extractionMeta, draft);
  const categoryLevel = trafficForCategory(extractionMeta, draft);
  const directionLevel = trafficForDirection(draft);

  const amountDisplay =
    typeof draft.amount === "number" && Number.isFinite(draft.amount)
      ? formatAmountDisplay(draft.amount)
      : "סכום לא זוהה";
  const vendorDisplay = hasNonEmptyText(draft.vendorName) ? draft.vendorName : "ספק לא זוהה";
  const dateDisplay = formatDateShort(draft.date) || "תאריך לא זוהה";
  const categoryDisplay = CATEGORY_MAP[draft.category] || draft.category || "כללי";

  const directionDisplay =
    draft.direction === "income"
      ? "הכנסה"
      : draft.direction === "expense"
        ? "הוצאה"
        : "עסקה לא מסווגת";

  const aiSummaryBody =
    reviewMode === "financial"
      ? `${directionDisplay} בסך ${amountDisplay}, בתאריך ${dateDisplay}, בקטגוריית ${categoryDisplay}.`
      : "המסמך יישמר בארכיון המסמכים, אבל לא ייצור עסקה ולא ישפיע על הדוחות.";

  const trustReasons = [
    reviewMode === "financial" && !isValidPositiveAmount(draft.amount)
      ? "לא זוהה סכום תקין לעסקה. צריך להשלים סכום לפני שהוא נכנס לדוחות."
      : reviewMode === "financial" && amountLevel !== "high"
        ? "הסכום זוהה, אבל כדאי לוודא שהוא הסכום הסופי של העסקה."
        : null,
    reviewMode === "financial" && !hasNonEmptyText(draft.vendorName)
      ? "לא זוהה ספק או לקוח ברור. זה חשוב כדי שהדוח והחיפוש יהיו שימושיים."
      : vendorLevel === "low"
        ? "שם הספק נראה חלקי או לא חד-משמעי במסמך."
        : vendorLevel === "medium"
          ? "שם הספק זוהה, אבל כדאי לוודא שהוא הגורם העסקי הנכון."
          : null,
    reviewMode === "financial" && (!draft.date || !formatDateShort(draft.date))
      ? "לא זוהה תאריך עסקה ברור, ולכן אי אפשר לשייך אותה בביטחון לחודש הנכון."
      : dateLevel === "low"
        ? "התאריך דורש בדיקה; ייתכן שהמסמך כולל כמה תאריכים או תאריך לא ברור."
        : dateLevel === "medium"
          ? "התאריך נראה סביר, אבל כדאי לוודא שזה תאריך העסקה ולא תאריך אחר במסמך."
          : null,
    reviewMode === "financial" && directionLevel === "low"
      ? "לא ברור אם זו הכנסה או הוצאה. הבחירה הזו קובעת איך הדוח יתעדכן."
      : null,
    categoryLevel === "low"
      ? "הקטגוריה לא מספיק ברורה. תיקון שלה יעזור לדוחות ולחבילה לרו״ח."
      : categoryLevel === "medium"
        ? "הקטגוריה היא הערכה טובה, אבל אפשר לדייק אותה לפני האישור."
        : null,
    pid === "unknown_review"
      ? "לא זוהתה עסקה פיננסית חד-משמעית, לכן המערכת מבקשת החלטה שלך לפני השפעה על הדוחות."
      : null,
    pid === "non_financial"
      ? "המסמך נראה כמו מידע כללי ולא כמו קבלה או עסקה פיננסית."
      : null,
    pid === "tax_or_pension_document"
      ? "המסמך נראה כמו אישור/מידע פיננסי, לא בהכרח עסקה שצריכה להיכנס לדוח כהכנסה או הוצאה."
      : null,
    pid === "quote_or_order"
      ? "המסמך נראה כמו הצעה או הזמנה. לא כל הצעה היא עסקה שבוצעה בפועל."
      : null,
  ].filter((reason): reason is string => Boolean(reason));

  const trustLevel: TrustLevel =
    reviewMode !== "financial" || pid !== "financial_transaction"
      ? "ambiguous"
      : trustReasons.length === 0
        ? "high"
        : trustReasons.length <= 2
          ? "medium"
          : "low";

  const trustTitle =
    trustLevel === "high"
      ? "אפשר לסמוך על ההבנה העסקית"
      : trustLevel === "medium"
        ? "צריך בדיקה קצרה לפני אישור"
        : trustLevel === "low"
          ? "צריך לתקן לפני שזה נכנס לדוחות"
          : "צריך החלטה עסקית שלך";

  const trustSummary =
    trustReasons.length === 0
      ? "הסכום, הצד השני והתאריך נראים עקביים. אפשר לאשר במהירות."
      : trustReasons[0];

  const approvalImpact =
    reviewMode === "financial"
      ? "אישור יוסיף את העסקה לדוח החודשי, לחיפוש המסמכים ולחבילה לרו״ח."
      : "שמירה כמסמך מידע תשמור את המסמך, בלי להוסיף אותו לדוחות או לחיפוש העסקאות.";

  return {
    trustLevel,
    trustTitle,
    trustSummary,
    trustReasons,
    approvalImpact,
    aiSummaryBody,
    amountDisplay,
    vendorDisplay,
    dateDisplay,
    categoryDisplay,
    directionDisplay,
  };
}

export function trafficLevelsForDraft(
  extractionMeta: ExtractionConfidenceMeta | null,
  draft: ReviewDraft
) {
  return {
    amountLevel: trafficForAmount(extractionMeta, draft),
    vendorLevel: trafficForVendor(extractionMeta, draft),
    dateLevel: trafficForDate(extractionMeta, draft),
    categoryLevel: trafficForCategory(extractionMeta, draft),
    directionLevel: trafficForDirection(draft),
  };
}
