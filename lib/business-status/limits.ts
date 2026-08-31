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
