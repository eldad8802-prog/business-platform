/**
 * ERASURE DISPOSITIONS — the explicit answer, per column, to "what happens to this
 * when the account is deleted?"
 *
 * WHY A SECOND FILE RATHER THAN MORE MANIFEST
 *
 * The manifest says what is erased. It is silent about everything else, and silence is
 * indistinguishable from an oversight. `Lead.followUpNote` is not in the manifest — is
 * that a decision that it may survive, or did nobody look? The manifest cannot say, so
 * this file exists to make every column on a covered model carry an answer.
 *
 * COVERED_MODELS is the honest boundary. A model listed there has a disposition for
 * every one of its columns, and adding a column to it without adding a disposition
 * fails the build. A model NOT listed is out of scope and is not claimed to be clean —
 * the residual sweep found several such models, and pretending otherwise by leaving
 * them off a list with no visible consequence is exactly the failure this file is
 * meant to make impossible.
 *
 * WHAT THE VALUES MEAN
 *
 *   ERASE            the value is destroyed; the column ends up null or blank
 *   ANONYMISE        the value is replaced with a constant that names nobody
 *   UNLINK           a pointer to a person is nulled; the row stays
 *   RETAIN_BY_DESIGN the value survives on purpose, and says why
 *   STRUCTURAL       identity, timestamps, counters — nothing about a person
 *
 * ERASE, ANONYMISE and UNLINK are claims about behaviour, so the contract guard
 * requires the adapter to actually perform them. RETAIN_BY_DESIGN and STRUCTURAL are
 * claims about intent, so they require a stated basis instead.
 *
 * A basis is never invented. `UNPROVEN` is a real, allowed answer and is preferable to
 * a legal claim nobody has verified.
 */

export type Disposition = "ERASE" | "ANONYMISE" | "UNLINK" | "RETAIN_BY_DESIGN" | "STRUCTURAL";

export type RetentionBasis = "PRODUCT" | "LEGAL/FISCAL" | "SECURITY/AUDIT" | "UNPROVEN";

export type FieldDisposition = {
  disposition: Disposition;
  /** Required for RETAIN_BY_DESIGN. Why this value is allowed to survive. */
  purpose?: string;
  /** Required for RETAIN_BY_DESIGN. Never asserted without evidence. */
  basis?: RetentionBasis;
};

/**
 * The models whose columns are fully dispositioned. Everything here is checked
 * exhaustively; a new column on any of them is a build failure until someone decides
 * what happens to it.
 *
 * The list starts at the four models the manifest already governs by name. Extending
 * it to `Supplier`, `Appointment` and `Notification` is the point of the next
 * increment, and is deliberately NOT done here: adding them would either mean fixing
 * the product in this increment, or listing personal data as RETAIN_BY_DESIGN with a
 * basis nobody has agreed to. Both are worse than an honest boundary.
 */
export const COVERED_MODELS = ["User", "BusinessProfile", "Customer", "Lead"] as const;

export const DISPOSITIONS: Record<string, Record<string, FieldDisposition>> = {
  User: {
    id: { disposition: "STRUCTURAL" },
    email: { disposition: "ANONYMISE" },
    password: { disposition: "ERASE" },
    name: { disposition: "ERASE" },
    businessId: { disposition: "STRUCTURAL" },
    role: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "the retained billing audit trail records who acted, and the role is part of that record",
      basis: "SECURITY/AUDIT",
    },
    lastLoginAt: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "security-audit timestamp; identifies no person once email and name are gone",
      basis: "SECURITY/AUDIT",
    },
    loginCount: { disposition: "STRUCTURAL" },
    tokenVersion: {
      disposition: "RETAIN_BY_DESIGN",
      purpose:
        "not currently changed by the deletion. Sessions are refused by the business " +
        "lifecycle gate rather than by invalidating the token itself. Recorded here as a " +
        "known single-control gap rather than described as a decision.",
      basis: "UNPROVEN",
    },
    createdAt: { disposition: "STRUCTURAL" },
    updatedAt: { disposition: "STRUCTURAL" },
  },

  BusinessProfile: {
    id: { disposition: "STRUCTURAL" },
    businessId: { disposition: "STRUCTURAL" },
    category: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "a fixed vocabulary describing the trade, not the trader",
      basis: "PRODUCT",
    },
    subCategory: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "as category",
      basis: "PRODUCT",
    },
    businessModel: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "as category",
      basis: "PRODUCT",
    },
    city: { disposition: "ERASE" },
    latitude: { disposition: "ERASE" },
    longitude: { disposition: "ERASE" },
    openingHours: { disposition: "ERASE" },
    billingLegalName: { disposition: "ERASE" },
    billingBusinessKind: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "an enum-like legal form (עוסק מורשה / חברה), naming nobody",
      basis: "PRODUCT",
    },
    billingTaxId: { disposition: "ERASE" },
    billingVatNumber: { disposition: "ERASE" },
    billingPhone: { disposition: "ERASE" },
    billingEmail: { disposition: "ERASE" },
    billingAddress: { disposition: "ERASE" },
    billingPaymentNote: {
      disposition: "RETAIN_BY_DESIGN",
      purpose:
        "free text the owner writes onto invoices. NOT erased today, and the residual " +
        "sweep flagged it. Recorded as a gap, not as a decision.",
      basis: "UNPROVEN",
    },
    billingFooterNote: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "as billingPaymentNote — free text, not erased today",
      basis: "UNPROVEN",
    },
    billingPaymentTermsDays: { disposition: "STRUCTURAL" },
    billingLogoDataUrl: { disposition: "ERASE" },
    billingSignatureDataUrl: { disposition: "ERASE" },
    billingPdfTemplateStyle: { disposition: "STRUCTURAL" },
    createdAt: { disposition: "STRUCTURAL" },
    updatedAt: { disposition: "STRUCTURAL" },
  },

  Customer: {
    id: { disposition: "STRUCTURAL" },
    businessId: { disposition: "STRUCTURAL" },
    name: { disposition: "ANONYMISE" },
    phone: { disposition: "ERASE" },
    email: { disposition: "ERASE" },
    city: { disposition: "ERASE" },
    legalName: { disposition: "ERASE" },
    taxId: { disposition: "ERASE" },
    taxIdType: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "an enum saying which kind of identifier was held, once the identifier is gone",
      basis: "PRODUCT",
    },
    notes: { disposition: "ERASE" },
    isActive: { disposition: "STRUCTURAL" },
    createdAt: { disposition: "STRUCTURAL" },
    updatedAt: { disposition: "STRUCTURAL" },
  },

  Lead: {
    id: { disposition: "STRUCTURAL" },
    businessId: { disposition: "STRUCTURAL" },
    customerName: { disposition: "ERASE" },
    phone: { disposition: "ERASE" },
    email: { disposition: "ERASE" },
    sourceChannel: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "which surface the lead arrived on; a fixed vocabulary naming nobody",
      basis: "PRODUCT",
    },
    status: { disposition: "STRUCTURAL" },
    temperature: { disposition: "STRUCTURAL" },
    currentStage: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "a coarse pipeline stage; cannot reconstruct what was said",
      basis: "PRODUCT",
    },
    valueEstimate: { disposition: "STRUCTURAL" },
    quotedPrice: { disposition: "STRUCTURAL" },
    finalPrice: { disposition: "STRUCTURAL" },
    currency: { disposition: "STRUCTURAL" },
    customerId: { disposition: "UNLINK" },
    intentSnapshot: { disposition: "ERASE" },
    nextFollowUpAt: { disposition: "STRUCTURAL" },
    followUpNote: { disposition: "ERASE" },
    lastActivityAt: { disposition: "STRUCTURAL" },
    closedAt: { disposition: "STRUCTURAL" },
    lostReason: { disposition: "ERASE" },
    createdAt: { disposition: "STRUCTURAL" },
    updatedAt: { disposition: "STRUCTURAL" },
  },
};
