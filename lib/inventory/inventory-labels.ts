// UI label maps for inventory — keeps raw enum/code values out of the user-facing UI.

const MOVEMENT_REASON_LABELS: Record<string, string> = {
  INITIAL_STOCK: "מלאי התחלתי",
  MANUAL_ADD: "הוספה ידנית",
  MANUAL_REMOVE: "הפחתה ידנית",
  SALE: "מכירה",
  RETURN: "החזרה",
  DAMAGE: "נזק",
  INVENTORY_COUNT_CORRECTION: "תיקון ספירת מלאי",
  SUPPLIER_PURCHASE: "קנייה מספק",
};

export function getMovementReasonLabel(reason: string): string {
  return MOVEMENT_REASON_LABELS[reason] ?? reason;
}

const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  IN: "הוספה",
  OUT: "הפחתה",
  ADJUSTMENT: "תיקון",
};

export function getMovementTypeLabel(type: string): string {
  return MOVEMENT_TYPE_LABELS[type] ?? type;
}

const DECISION_REASON_LABELS: Record<string, string> = {
  "No matches found": "לא נמצאה התאמה",
  "Exact or near-exact match": "נמצאה התאמה כמעט מדויקת",
  "Low similarity": "דמיון נמוך בין הפריטים",
  "Possible match requires confirmation": "ייתכן שזו התאמה — נדרש אישור",
};

export function getDecisionReasonLabel(reason: string): string {
  return DECISION_REASON_LABELS[reason] ?? reason;
}

/** Decision confidence arrives on a 0–1 scale; show a human band, not a raw number. */
export function getConfidenceBandLabel(
  confidence: number | null | undefined
): string | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  if (confidence >= 0.85) return "גבוהה";
  if (confidence >= 0.6) return "בינונית";
  return "נמוכה";
}
