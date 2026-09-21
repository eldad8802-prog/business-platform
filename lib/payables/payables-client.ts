/**
 * Payables — the browser's view of the ledger.
 *
 * Every figure here arrives already derived by the server. The client never
 * adds, subtracts or rounds money: a balance computed in two places is a
 * balance that will eventually disagree with itself, and the one on screen is
 * the one the owner will believe.
 */

export type DerivedState =
  | "SCHEDULED"
  | "DUE"
  | "OVERDUE"
  | "PARTIALLY_PAID"
  | "PAID"
  | "CANCELLED"
  | "SETTLED_LEGACY";

export type ScheduleKind = "ONE_OFF" | "RECURRING" | "INSTALLMENT_PLAN";
export type Cadence = "NONE" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type PayeeApi = { id: number; displayName: string; kind: string };

export type CommitmentListApi = {
  id: number;
  title: string;
  payeeId: number | null;
  payeeNameSnapshot: string;
  currency: string;
  scheduleKind: ScheduleKind;
  status: string;
  total: string | null;
  paid: string;
  remaining: string | null;
  installmentCount: number;
  next: {
    id: number;
    sequence: number;
    dueAt: string;
    scheduled: string;
    remaining: string;
    state: DerivedState;
  } | null;
  attention: DerivedState;
  isLegacy: boolean;
};

export type AllocationApi = {
  id: number;
  paymentId: number;
  amount: string;
  active: boolean;
  reversedAt: string | null;
  reversalReason: string | null;
  paymentStatus: string;
  paymentPaidAt: string;
  paymentMethod: string;
};

export type InstallmentApi = {
  id: number;
  sequence: number;
  dueAt: string;
  scheduled: string;
  paid: string;
  remaining: string;
  state: DerivedState;
  status: string;
  legacyAssertedBy: string | null;
  legacyMetAt: string | null;
  allocations: AllocationApi[];
};

export type PaymentApi = {
  id: number;
  amount: string;
  allocated: string;
  unallocated: string;
  status: string;
  method: string;
  paidAt: string;
  externalReference: string | null;
};

export type CommitmentDetailApi = {
  id: number;
  title: string;
  payeeId: number | null;
  payeeNameSnapshot: string;
  currency: string;
  scheduleKind: ScheduleKind;
  recurrence: Cadence;
  status: string;
  note: string | null;
  total: string | null;
  paid: string;
  remaining: string | null;
  isLegacy: boolean;
  legacy: { assertedBy: string | null; metAt: string | null } | null;
  installments: InstallmentApi[];
  payments: PaymentApi[];
  audit: Array<{
    id: number;
    eventType: string;
    source: string;
    summary: string | null;
    occurredAt: string;
  }>;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON body is reported through the status below */
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `הבקשה נכשלה (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function fetchCommitments(scope: "open" | "all" = "open") {
  return call<{ commitments: CommitmentListApi[] }>(
    `/api/payables/commitments?scope=${scope}`,
  ).then((r) => r.commitments);
}

export function fetchCommitment(id: number) {
  return call<{ commitment: CommitmentDetailApi }>(
    `/api/payables/commitments/${id}`,
  ).then((r) => r.commitment);
}

export function searchPayees(query: string) {
  return call<{ payees: PayeeApi[] }>(
    `/api/payables/payees?q=${encodeURIComponent(query)}`,
  ).then((r) => r.payees);
}

export function createPayee(input: { displayName: string; kind?: string }) {
  return call<{ payee: PayeeApi }>("/api/payables/payees", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((r) => r.payee);
}

export type CreateCommitmentBody = {
  title: string;
  payeeId?: number | null;
  payeeName?: string | null;
  scheduleKind: ScheduleKind;
  totalAmount?: string;
  recurringAmount?: string;
  installmentCount?: number;
  recurrence?: Cadence;
  firstDueAt: string;
  note?: string | null;
};

export function createCommitment(body: CreateCommitmentBody) {
  return call<{ commitment: { id: number } }>("/api/payables/commitments", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((r) => r.commitment);
}

export type RecordPaymentBody = {
  commitmentId: number;
  amount: string;
  paidAt: string;
  method: string;
  installmentIds?: number[] | null;
  externalReference?: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
};

export type RecordPaymentResult = {
  payment: { id: number; amount: string };
  allocations: Array<{ id: number; installmentId: number; allocatedAmount: string }>;
  /**
   * null on a REPLAY. The retry returns the original payment rather than
   * recomputing a surplus for a request that changed nothing, so the caller
   * must not render this without checking `replayed` first.
   */
  unallocated: string | null;
  replayed: boolean;
};

export function recordPayment(body: RecordPaymentBody) {
  return call<RecordPaymentResult>("/api/payables/payments", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function voidPayment(paymentId: number, reason?: string) {
  return call<{ payment: unknown }>(`/api/payables/payments/${paymentId}/void`, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? null }),
  });
}

export function reverseAllocation(allocationId: number, reason?: string) {
  return call<{ allocation: unknown }>(
    `/api/payables/allocations/${allocationId}/reverse`,
    { method: "POST", body: JSON.stringify({ reason: reason ?? null }) },
  );
}

export function cancelInstallment(installmentId: number, reason?: string) {
  return call<{ installment: unknown }>(
    `/api/payables/installments/${installmentId}/cancel`,
    { method: "POST", body: JSON.stringify({ reason: reason ?? null }) },
  );
}

/* ───────────────────────────── presentation ──────────────────────────────── */

export const STATE_LABEL: Record<DerivedState, string> = {
  SCHEDULED: "מתוכנן",
  DUE: "לתשלום",
  OVERDUE: "באיחור",
  PARTIALLY_PAID: "שולם חלקית",
  PAID: "שולם",
  CANCELLED: "בוטל",
  // NOT "שולם". The owner asserted they handled it before this ledger existed;
  // no payment was ever observed, and the wording must not imply one.
  SETTLED_LEGACY: "סומן כטופל",
};

export const SCHEDULE_LABEL: Record<ScheduleKind, string> = {
  ONE_OFF: "חד-פעמי",
  RECURRING: "מתחדש",
  INSTALLMENT_PLAN: "פריסת תשלומים",
};

export const CADENCE_LABEL: Record<Cadence, string> = {
  NONE: "ללא",
  WEEKLY: "שבועי",
  MONTHLY: "חודשי",
  YEARLY: "שנתי",
};

export const METHOD_LABEL: Record<string, string> = {
  CASH: "מזומן",
  BANK_TRANSFER: "העברה בנקאית",
  CREDIT_CARD: "כרטיס אשראי",
  CHECK: "צ'ק",
  DIRECT_DEBIT: "הוראת קבע בחיוב",
  STANDING_ORDER: "הוראת קבע",
  BIT: "ביט",
  PAYBOX: "פייבוקס",
  OTHER: "אחר",
};

/** ILS with grouping. The VALUE is never recomputed — only formatted. */
export function formatMoney(amount: string, currency = "ILS"): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(n);
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/* ──────────────────────── phase 2: reconciliation ────────────────────────── */

export type MatchSignal = "AMOUNT" | "VENDOR" | "DATE" | "PAYEE_LINK";
export type Confidence = "STRONG" | "POSSIBLE" | "WEAK";

export type CandidateApi = {
  target:
    | {
        kind: "PAYMENT";
        paymentId: number;
        commitmentId: number;
        commitmentTitle: string;
        payeeNameSnapshot: string;
        amountMinor: number;
        paidAt: string;
        hasDocumentEvidence: boolean;
      }
    | {
        kind: "INSTALLMENT";
        installmentId: number;
        commitmentId: number;
        commitmentTitle: string;
        payeeNameSnapshot: string;
        remainingMinor: number;
        dueAt: string;
      };
  score: number;
  signals: MatchSignal[];
  reasons: string[];
  dayGap: number;
  confidence: Confidence;
};

export type SuggestionApi = {
  document: {
    id: number;
    amount: string;
    date: string;
    vendorName: string;
    direction: string;
  };
  candidates: CandidateApi[];
  ambiguous: boolean;
  attachedTo: { paymentId: number; evidenceId: number } | null;
};

export function fetchSuggestions(documentId: number) {
  return call<SuggestionApi>(`/api/payables/documents/${documentId}/suggestions`);
}

/** Confirms the document EVIDENCES an existing payment. Moves no money. */
export function attachEvidence(documentId: number, paymentId: number) {
  return call<{ evidence: { id: number } }>(
    `/api/payables/documents/${documentId}/attach`,
    { method: "POST", body: JSON.stringify({ paymentId }) },
  );
}

/** Confirms the document IS a payment not yet recorded. Creates one. */
export function recordPaymentFromDocument(
  documentId: number,
  body: { commitmentId: number; installmentIds?: number[] | null; method?: string },
) {
  return call<RecordPaymentResult>(
    `/api/payables/documents/${documentId}/record-payment`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function rejectMatch(
  documentId: number,
  body: {
    commitmentId?: number | null;
    installmentId?: number | null;
    paymentId?: number | null;
    reason?: string | null;
  },
) {
  return call<{ rejection: { id: number } }>(
    `/api/payables/documents/${documentId}/reject`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function revokeEvidence(evidenceId: number, reason?: string) {
  return call<{ evidence: unknown }>(`/api/payables/evidence/${evidenceId}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? null }),
  });
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  // Never "certain" and never "matched" — the engine narrows the field, the
  // owner settles identity.
  STRONG: "התאמה חזקה",
  POSSIBLE: "ייתכן",
  WEAK: "התאמה חלשה",
};

/** Minor units → a display string. Formatting only; the value is not recomputed. */
export function minorToDisplay(minor: number, currency = "ILS"): string {
  return formatMoney((minor / 100).toFixed(2), currency);
}

/* ─────────────────────── phase 3: cheques and bank accounts ──────────────── */

/**
 * The only shape a bank account ever has in the browser: a label and the last
 * four digits. There is no endpoint that returns more, so there is nothing
 * here that could render more.
 */
export type BankAccountApi = {
  id: number;
  label: string;
  last4: string;
  masked: string;
  isActive: boolean;
  isDefault: boolean;
  note: string | null;
  createdAt: string;
};

export type ChequeStatus =
  | "PLANNED"
  | "ISSUED"
  | "DELIVERED"
  | "PRESENTED"
  | "CLEARED"
  | "BOUNCED"
  | "CANCELLED"
  | "REPLACED";

export type ChequeApi = {
  id: number;
  chequeNumber: string;
  payeeId: number | null;
  payeeNameSnapshot: string;
  amount: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  status: ChequeStatus;
  sourceBankAccount: { id: number; label: string; masked: string; isActive: boolean };
  commitment: { id: number; title: string } | null;
  installment: { id: number; sequence: number; dueAt: string } | null;
  cleared: { assertedAt: string | null; source: "OWNER_ASSERTED" } | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  replaces: { id: number; chequeNumber: string } | null;
  replacedBy: { id: number; chequeNumber: string } | null;
  payment: { id: number; status: string; allocated: string; unallocated: string } | null;
  note: string | null;
  createdAt: string;
  actions: {
    advance: ChequeStatus[];
    clear: boolean;
    bounce: boolean;
    cancel: boolean;
    replace: boolean;
  };
};

export function fetchBankAccounts(includeArchived = false) {
  return call<{ accounts: BankAccountApi[]; configured: boolean }>(
    `/api/payables/bank-accounts${includeArchived ? "?archived=1" : ""}`,
  );
}

export function createBankAccount(body: {
  label: string;
  bankCode: string;
  branchCode: string;
  accountNumber: string;
  isDefault?: boolean;
  note?: string | null;
}) {
  return call<{ account: BankAccountApi; restored: boolean }>("/api/payables/bank-accounts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function setDefaultBankAccount(id: number) {
  return call<{ account: BankAccountApi }>(`/api/payables/bank-accounts/${id}/default`, {
    method: "POST",
  });
}

export function archiveBankAccount(id: number) {
  return call<{ account: BankAccountApi }>(`/api/payables/bank-accounts/${id}/archive`, {
    method: "POST",
  });
}

export function fetchCheques(opts: { scope?: "open" | "all"; commitmentId?: number } = {}) {
  const params = new URLSearchParams();
  params.set("scope", opts.scope ?? "open");
  if (opts.commitmentId) params.set("commitmentId", String(opts.commitmentId));
  return call<{ cheques: ChequeApi[] }>(`/api/payables/cheques?${params}`).then((r) => r.cheques);
}

export type CreateChequeBody = {
  chequeNumber: string;
  amount: string;
  issueDate: string;
  dueDate: string;
  sourceBankAccountId: number;
  commitmentId?: number | null;
  installmentId?: number | null;
  payeeId?: number | null;
  payeeName?: string | null;
  status?: "PLANNED" | "ISSUED";
  note?: string | null;
};

export function createCheque(body: CreateChequeBody) {
  return call<{ cheque: ChequeApi }>("/api/payables/cheques", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((r) => r.cheque);
}

export function advanceCheque(id: number, to: ChequeStatus) {
  return call<{ cheque: ChequeApi }>(`/api/payables/cheques/${id}/advance`, {
    method: "POST",
    body: JSON.stringify({ to }),
  }).then((r) => r.cheque);
}

export function clearCheque(id: number, clearedAt: string) {
  return call<{ cheque: ChequeApi; unallocated: string; replayed: boolean }>(
    `/api/payables/cheques/${id}/clear`,
    { method: "POST", body: JSON.stringify({ clearedAt }) },
  );
}

export function bounceCheque(id: number, reason?: string) {
  return call<{ cheque: ChequeApi }>(`/api/payables/cheques/${id}/bounce`, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? null }),
  }).then((r) => r.cheque);
}

export function cancelCheque(id: number, reason?: string) {
  return call<{ cheque: ChequeApi }>(`/api/payables/cheques/${id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? null }),
  }).then((r) => r.cheque);
}

export function replaceCheque(
  id: number,
  body: {
    chequeNumber: string;
    amount?: string | null;
    issueDate: string;
    dueDate: string;
    sourceBankAccountId?: number | null;
    reason?: string | null;
  },
) {
  return call<{ replaced: ChequeApi; replacement: ChequeApi }>(
    `/api/payables/cheques/${id}/replace`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * CLEARED reads as the owner's statement, because that is all it is. The
 * label must never say "confirmed" or "verified" — there is no bank feed.
 */
export const CHEQUE_STATUS_LABEL: Record<ChequeStatus, string> = {
  PLANNED: "מתוכנן",
  ISSUED: "נכתב",
  DELIVERED: "נמסר",
  PRESENTED: "הופקד",
  CLEARED: "נפרע (לפי דיווחך)",
  BOUNCED: "חזר",
  CANCELLED: "בוטל",
  REPLACED: "הוחלף",
};

export const CHEQUE_ADVANCE_LABEL: Partial<Record<ChequeStatus, string>> = {
  ISSUED: "סמן כנכתב",
  DELIVERED: "סמן כנמסר",
  PRESENTED: "סמן כהופקד",
};
