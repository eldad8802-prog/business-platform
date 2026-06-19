import type { BillingAuditEventType } from "@/lib/services/billing/billing-audit.service";

/** Short Hebrew labels for billing audit timeline display. */
export const BILLING_AUDIT_EVENT_LABELS_HE: Record<
  BillingAuditEventType,
  string
> = {
  BILLING_DRAFT_CREATED: "טיוטה נוצרה",
  BILLING_DRAFT_HEADER_UPDATED: "כותרת טיוטה עודכנה",
  BILLING_DRAFT_LINES_REPLACED: "שורות טיוטה הוחלפו",
  BILLING_DOC_SUBMITTED_FOR_REVIEW: "הוגש לאישור",
  BILLING_DOC_REVERTED_TO_DRAFT: "הוחזר לטיוטה",
  BILLING_DOC_ISSUED: "מסמך הונפק",
  BILLING_CREDIT_NOTE_ISSUED: "זיכוי הונפק",
  BILLING_RECEIPT_ISSUED: "קבלה הונפקה",
  BILLING_TAX_INVOICE_RECEIPT_ISSUED: "חשבונית מס-קבלה הונפקה",
  BILLING_PAYMENT_RECORDED: "תקבול נרשם",
  BILLING_QUOTE_CONVERTED_TO_INVOICE: "הצעת מחיר הומרה לחשבונית",
  BILLING_CREDIT_NOTE_DRAFT_CREATED: "טיוטת זיכוי נוצרה",
  BILLING_PDF_RENDERED: "PDF נוצר",
  BILLING_PDF_RENDER_FAILED: "יצירת PDF נכשלה",
  BILLING_QUOTE_PDF_RENDERED: "PDF הצעת מחיר נוצר",
  BILLING_AUTHORITY_READINESS_CREATED: "מוכנות רשות המסים נוצרה",
  BILLING_AUTHORITY_MARKED_NOT_REQUIRED: "הקצאה — לא נדרש",
  BILLING_AUTHORITY_SUBMISSION_ATTEMPTED: "ניסיון שליחה לרשות המסים",
  BILLING_AUTHORITY_APPROVED: "הקצאה אושרה",
  BILLING_AUTHORITY_REJECTED: "רשות המסים דחתה",
  BILLING_AUTHORITY_FAILED: "שליחה לרשות המסים נכשלה",
  BILLING_AUTHORITY_RETRY_SCHEDULED: "ניסיון חוזר מתוזמן",
  BILLING_AUTHORITY_OAUTH_STARTED: "התחברות לרשות המסים החלה",
  BILLING_AUTHORITY_OAUTH_COMPLETED: "התחברות לרשות המסים הושלמה",
  BILLING_AUTHORITY_OAUTH_FAILED: "התחברות לרשות המסים נכשלה",
  BILLING_AUTHORITY_CONNECTION_VALIDATED: "חיבור רשות המסים אומת",
  BILLING_AUTHORITY_TOKEN_REFRESHED: "אסימון רשות המסים רוענן",
  BILLING_AUTHORITY_TOKEN_REFRESH_FAILED: "רענון אסימון נכשל",
  BILLING_AUTHORITY_AUTH_FAILURE: "אימות רשות המסים נכשל",
  BILLING_AUTHORITY_CONNECTION_REVOKED: "חיבור רשות המסים בוטל",
  BILLING_AUTHORITY_HELD_DECISION_REPORTED: "החלטה בחשבונית מוחזקת דווחה",
  BILLING_AUTHORITY_EMERGENCY_ALLOCATED: "הקצאת חירום התקבלה",
  BILLING_AUTHORITY_EMERGENCY_SYNCED: "הקצאת חירום סונכרנה",
  BILLING_AUTHORITY_MULTI_BATCH_SUBMITTED: "אצווה נשלחה לרשות המסים",
};

export function formatBillingAuditEventLabel(eventType: string): string {
  const labels = BILLING_AUDIT_EVENT_LABELS_HE as Record<string, string>;
  return labels[eventType] ?? eventType;
}
