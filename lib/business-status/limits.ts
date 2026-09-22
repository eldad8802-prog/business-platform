/** Hard per-domain fetch caps (before global merge). */
export const BS_GLOBAL_ITEM_CAP = 50;

export const BS_OPEN_CONVERSATION_SCAN_CAP = 120;

export const BS_ATTENTION_WAITING_CAP = 12;
export const BS_ATTENTION_PENDING_SUGGESTION_CAP = 12;

export const BS_DOCUMENTS_CAP = 15;

export const BS_INVENTORY_CAP = 15;

export const BS_BILLING_PENDING_CAP = 8;
export const BS_BILLING_PDF_FAILED_CAP = 8;

/** Leads asking for the owner. Capped like every other domain so Attention
 * stays a shortlist and never becomes a second Leads Inbox. */
export const BS_LEADS_CAP = 8;

export const BS_SUPPLIER_CAP = 8;

/** M1 — money leaving the business. Capped like every other domain. */
export const BS_PAYABLES_OVERDUE_CAP = 10;
export const BS_PAYABLES_DUE_SOON_CAP = 8;

/**
 * How far ahead "due soon" looks.
 *
 * Fourteen days is chosen to be USEFUL rather than merely true. A commitment the owner cannot act on
 * yet is noise, and one they hear about on the due date is already late. This is a deliberate product
 * judgement, not a derived number — there is no evidence base for it yet, and pretending otherwise
 * would be the first fake-precision in the knowledge layer.
 */
export const BS_PAYABLES_DUE_SOON_DAYS = 14;

/** M1 — money the owner has already asked for, or nearly. */
export const BS_BILLING_STALE_DRAFT_CAP = 8;
export const BS_PAYMENT_LINK_STALE_CAP = 8;

/**
 * How long something sits before sitting becomes the fact.
 *
 * A draft written this morning is work in progress; one from three weeks ago is money the owner
 * probably meant to bill and forgot. Fourteen days is the point where "in progress" stops being the
 * likelier explanation — a judgement, openly, because there is no evidence base for it yet.
 */
export const BS_STALE_AFTER_DAYS = 14;
