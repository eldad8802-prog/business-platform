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
  isPlausibleDocumentDate,
  validateFinancialAmount,
} from "@/lib/documents/financial-validation";
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
  const vendorDisplay = hasNonEmptyText(draft.vendorName)
    ? draft.vendorName
    : "ספק לא זוהה";
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
      : "המסמך יישמר בארכיון המסמכים, בלי ליצור רשומה פיננסית.";

  const amountCheck = validateFinancialAmount(draft.amount);

  const trustReasons = [
    reviewMode === "financial" && !isValidPositiveAmount(draft.amount)
      ? "לא זוהה סכום תקין. צריך להשלים סכום לפני שהמסמך נשמר כרשומה פיננסית."
      : reviewMode === "financial" && !amountCheck.ok && amountCheck.message
        ? amountCheck.message
        : reviewMode === "financial" && amountLevel !== "high"
          ? "הסכום זוהה, אבל כדאי לוודא שזה הסכום הסופי במסמך."
          : null,
    reviewMode === "financial" && !hasNonEmptyText(draft.vendorName)
      ? "לא זוהה ספק או לקוח ברור. זה חשוב לזיהוי הרשומה בהמשך."
      : vendorLevel === "low"
        ? "שם הספק לא מזוהה בוודאות."
        : vendorLevel === "medium"
          ? "שם הספק זוהה, אבל כדאי לוודא שהוא נכון."
          : null,
    reviewMode === "financial" && (!draft.date || !formatDateShort(draft.date))
      ? "לא זוהה תאריך ברור, ולכן אי אפשר לשייך את המסמך לתקופה הנכונה בביטחון."
      : draft.date && !isPlausibleDocumentDate(draft.date)
        ? "התאריך שזוהה חריג (עתידי או ישן מאוד). ודא שזה תאריך המסמך הנכון."
        : dateLevel === "low"
        ? "התאריך דורש בדיקה; ייתכן שמופיעים כמה תאריכים במסמך."
        : dateLevel === "medium"
          ? "התאריך נראה סביר, אבל כדאי לוודא שזה תאריך העסקה."
          : null,
    reviewMode === "financial" && directionLevel === "low"
      ? "לא ברור אם זו הכנסה או הוצאה. הבחירה הזו קובעת איך הרשומה תישמר."
      : null,
    categoryLevel === "low"
      ? "הקטגוריה לא מספיק ברורה. תיקון שלה יעזור לרשומות ולחבילת רו״ח."
      : categoryLevel === "medium"
        ? "הקטגוריה היא הערכה טובה, אבל אפשר לדייק אותה לפני האישור."
        : null,
    pid === "unknown_review"
      ? "לא זוהתה רשומה פיננסית בוודאות, לכן נדרשת בחירה לפני שמירה."
      : null,
    pid === "non_financial"
      ? "המסמך נראה כמו מידע כללי ולא כמו קבלה או עסקה פיננסית."
      : null,
    pid === "tax_or_pension_document"
      ? "המסמך נראה כמו אישור או מסמך מידע פיננסי, לא בהכרח עסקה רגילה."
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
      ? "אפשר לאשר במהירות"
      : trustLevel === "medium"
        ? "צריך בדיקה קצרה"
        : trustLevel === "low"
          ? "צריך לתקן לפני אישור"
          : "נדרשת בחירה שלך";

  const trustSummary =
    trustReasons.length === 0
      ? "הסכום, הספק והתאריך נראים עקביים. אפשר לאשר בביטחון."
      : trustReasons[0];

  const approvalImpact =
    reviewMode === "financial"
      ? "אישור ישמור את המסמך כרשומה פיננסית מאושרת."
      : "שמירה כמסמך מידע תשמור את המסמך בלי ליצור רשומה פיננסית.";

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
