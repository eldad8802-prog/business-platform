/**
 * Hebrew wording for the payables audit trail ("תיעוד"). Display only: the
 * stored events (PayablesAuditEvent.eventType / summary) are unchanged. A
 * summary written in Hebrew is shown as is; an English one (most server
 * summaries, e.g. "Migrated from BusinessObligation #6") is replaced by the
 * event type's Hebrew label, never shown raw.
 */

const AUDIT_EVENT_LABEL: Record<string, string> = {
  COMMITMENT_CREATED: "ההתחייבות נוצרה",
  COMMITMENT_UPDATED: "פרטי ההתחייבות עודכנו",
  COMMITMENT_RELEASED: "ההתחייבות הוסרה מהמעקב",
  COMMITMENT_CLOSED: "ההתחייבות נסגרה",
  COMMITMENT_ENDED: "נקבע תאריך סיום להתחייבות",
  COMMITMENT_MIGRATED_FROM_OBLIGATION: "הועברה מהמזכירה",
  INSTALLMENT_CREATED: "נוצר מועד תשלום",
  INSTALLMENT_CANCELLED: "מועד תשלום בוטל",
  INSTALLMENT_AMOUNT_CHANGED: "הסכום של מועדי התשלום עודכן",
  PAYMENT_RECORDED: "נרשם תשלום",
  PAYMENT_VOIDED: "רישום תשלום בוטל",
  ALLOCATION_CREATED: "תשלום שויך למועד",
  ALLOCATION_REVERSED: "שיוך תשלום בוטל",
  CHEQUE_CREATED: "נרשם צ׳ק",
  CHEQUE_ADVANCED: "מצב הצ׳ק עודכן",
  CHEQUE_CLEARED_OWNER_ASSERTED: "הצ׳ק סומן כנפרע",
  CHEQUE_BOUNCED: "הצ׳ק סומן כחוזר",
  CHEQUE_CANCELLED: "הצ׳ק בוטל",
  CHEQUE_REPLACED: "הצ׳ק הוחלף",
  PREPARATION_CREATED: "הוכן תשלום",
  PREPARATION_APPROVED: "תשלום מוכן אושר",
  PREPARATION_CANCELLED: "תשלום מוכן בוטל",
  PREPARATION_COMPLETED: "תשלום מוכן סומן כבוצע",
  EXTERNAL_TRANSACTION_ATTACHED: "תנועת בנק שויכה",
  EXTERNAL_TRANSACTION_REJECTED: "הצעת שיוך לתנועת בנק נדחתה",
  EXTERNAL_TRANSACTION_DISMISSED: "תנועת בנק סומנה כלא רלוונטית",
  EXTERNAL_EVIDENCE_REVOKED: "ראיה מתנועת בנק בוטלה",
  EXECUTION_REQUESTED: "נשלחה בקשת ביצוע",
  EXECUTION_UPDATED: "מצב הביצוע עודכן",
  EXECUTION_SETTLED: "הביצוע הושלם",
  EXECUTION_FAILED: "הביצוע נכשל",
  DESTINATION_CREATED: "נשמר חשבון יעד",
  DESTINATION_REPLACED: "חשבון היעד הוחלף",
  DESTINATION_ARCHIVED: "חשבון יעד הועבר לארכיון",
  DESTINATION_DEFAULT_SET: "נקבע חשבון יעד ברירת מחדל",
  DESTINATION_REVEALED: "פרטי חשבון היעד הוצגו במלואם",
  PAYEE_CREATED: "נוצר מוטב",
};

const HEBREW = /[֐-׿]/;

export function auditLabel(event: { eventType: string; summary: string | null }): string {
  if (event.summary && HEBREW.test(event.summary)) return event.summary;
  if (event.eventType === "COMMITMENT_UPDATED" && event.summary && /total cleared/i.test(event.summary)) {
    return "הסכום הכולל הוסר: להתחייבות מתחדשת אין סכום כולל";
  }
  return AUDIT_EVENT_LABEL[event.eventType] ?? "עדכון בהתחייבות";
}
