/**
 * WP1 — Uniform Export Assembler types.
 *
 * Internal projection types ONLY. This is NOT the official "מבנה אחיד" file
 * format. No fixed-width layout, no INI/BKMVDATA, no encoding/control-sums here.
 * Those are WP2+ and gated on transcribing the official spec (WP0).
 *
 * Everything here is plain data (read-only). Money/quantity values are carried
 * as decimal strings to stay deterministic and avoid float drift.
 */

/** Our projection schema version — unrelated to the official spec version. */
export const UNIFORM_EXPORT_PROJECTION_SCHEMA_VERSION = 1 as const;

export type UniformBusinessIdentity = {
  businessId: number;
  name: string;
  billingLegalName: string | null;
  billingBusinessKind: string | null; // EXEMPT_DEALER | AUTHORIZED_DEALER | LTD_COMPANY | null
  billingTaxId: string | null;
  billingVatNumber: string | null;
  billingAddress: string | null;
  billingPhone: string | null;
  billingEmail: string | null;
};

export type UniformCustomer = {
  id: number | null;
  name: string | null;
  legalName: string | null;
  taxId: string | null;
  taxIdType: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
};

export type UniformLine = {
  lineIndex: number;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRatePercent: string;
  lineSubtotal: string;
  vatAmount: string;
  lineTotal: string;
};

export type UniformPayment = {
  lineIndex: number;
  method: string; // PaymentMethod enum value
  amount: string;
  currency: string;
  paymentDate: string | null; // ISO
  bankName: string | null;
  bankBranch: string | null;
  bankAccountNumber: string | null;
  checkNumber: string | null;
  checkDueDate: string | null; // ISO
  cardBrand: string | null;
  cardLast4: string | null;
  reference: string | null;
};

/** Minimal typed view of our own frozen `issuedSnapshot` (preferred source). */
export type ParsedIssuedSnapshot = {
  document?: {
    type?: string;
    number?: number;
    numberFormatted?: string;
    currency?: string;
    allocationNumber?: string | null;
    referenceDocumentId?: number | null;
  };
  customer?: UniformCustomer | null;
  lines?: UniformLine[];
  totals?: { subtotal?: string; vat?: string; total?: string };
};

/** One issued document as loaded (live columns + optional parsed snapshot). */
export type UniformDocumentInput = {
  id: number;
  documentType: string; // BillingDocumentType
  status: string; // BillingDocumentStatus
  documentNumber: number | null;
  documentNumberFormatted: string | null;
  issuedAt: string | null; // ISO
  lockedAt: string | null; // ISO
  currency: string;
  subtotalAmount: string;
  vatAmount: string;
  totalAmount: string;
  allocationNumber: string | null;
  allocationApprovedAt: string | null; // ISO
  isEmergencyAllocation: boolean;
  legalSnapshotHash: string | null;
  referenceDocumentId: number | null;
  customer: UniformCustomer | null;
  customerNameSnapshot: string | null;
  lines: UniformLine[];
  payments: UniformPayment[];
  /** Frozen legal snapshot (preferred over live columns when present). */
  issuedSnapshot: ParsedIssuedSnapshot | null;
};

export type UniformExportAssemblerInput = {
  businessId: number;
  period: { start: string; end: string }; // ISO, inclusive
  business: UniformBusinessIdentity;
  documents: UniformDocumentInput[];
};

export type UniformWarningScope =
  | "business"
  | "period"
  | "document"
  | "customer"
  | "line"
  | "payment";

export type UniformWarning = {
  code: string;
  scope: UniformWarningScope;
  ref: string | null; // document id/number etc. — never a value/secret
  message: string;
};

export type UniformExcluded = {
  documentId: number;
  reason: string;
};

export type AllocationSource = "ISSUED_SNAPSHOT" | "LIVE_COLUMN" | "NONE";
export type RecordSource = "ISSUED_SNAPSHOT" | "LIVE_COLUMNS";

export type UniformDocumentRecord = {
  documentId: number;
  documentType: string;
  documentNumber: number | null;
  documentNumberFormatted: string | null;
  issuedAt: string | null;
  currency: string;
  subtotal: string;
  vat: string;
  total: string;
  /** Copied ONLY when present in the input. Never fabricated. */
  allocationNumber: string | null;
  allocationSource: AllocationSource;
  legalSnapshotHash: string | null;
  customer: UniformCustomer | null;
  lineCount: number;
  paymentCount: number;
  source: RecordSource;
};

export type UniformLineRecord = { documentId: number } & UniformLine;
export type UniformPaymentRecord = { documentId: number } & UniformPayment;

export type UniformExportProjection = {
  schemaVersion: number;
  business: UniformBusinessIdentity;
  period: { start: string; end: string };
  documentRecords: UniformDocumentRecord[];
  lineRecords: UniformLineRecord[];
  paymentRecords: UniformPaymentRecord[];
  totals: {
    documentCount: number;
    lineCount: number;
    paymentCount: number;
    byDocumentType: Record<string, number>;
    sumTotal: string;
    sumVat: string;
    withAllocationCount: number;
  };
  warnings: UniformWarning[];
  excluded: UniformExcluded[];
};
