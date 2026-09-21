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

/**
 * A retention that is only safe because SOMETHING ELSE is erased.
 *
 * `ReceivingSession.createdByUserId` is kept as provenance — who received the goods —
 * and that is defensible for exactly one reason: by the time anyone could follow the
 * pointer, the `User` row it names has had its email, name and password destroyed. It
 * is an id, not an identity.
 *
 * Which makes the retention CONDITIONAL, and a condition nobody checks is a condition
 * that expires quietly. If `User.email` were reclassified as retained, or the adapter
 * simply stopped writing it, these pointers would become identifying again and nothing
 * in the contract would say so.
 *
 * So the condition is declared and the guard proves it: every named column must still
 * be dispositioned ERASE or ANONYMISE **and** still be written by the adapter. Break
 * either half and the build goes red instead of the classification going stale.
 */
export type RetentionDependency = {
  /** The model whose erasure is what makes this retention safe. */
  model: string;
  /** The columns on it that must actually be destroyed. */
  fields: readonly string[];
};

export type FieldDisposition = {
  disposition: Disposition;
  /** Required for RETAIN_BY_DESIGN. Why this value is allowed to survive. */
  purpose?: string;
  /** Required for RETAIN_BY_DESIGN. Never asserted without evidence. */
  basis?: RetentionBasis;
  /** Optional for RETAIN_BY_DESIGN: the erasure this retention leans on. */
  dependsOn?: RetentionDependency;
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
 *
 * C12-E1 adds `ReceivingSession` and `PurchaseOrderLine` on those terms and no others:
 * the product IS fixed in the same increment, and nothing personal is retained without
 * a basis. Joining this list is also what makes the two decisions behind them checkable
 * rather than remembered — the provenance pointers carry a declared dependency on the
 * `User` anonymisation, and the product-identity columns are written down as such, so a
 * new text column on either model fails the build instead of inheriting a classification
 * nobody gave it.
 */
export const COVERED_MODELS = [
  "User",
  "BusinessProfile",
  "Customer",
  "Lead",
  "Notification",
  "ReceivingSession",
  "PurchaseOrderLine",
] as const;

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

  // E2-W1. Notification joins the exhaustive list because the erasure now
  // manages it. Leaving it outside would mean a new personal column here — and
  // this model's whole problem is that its columns are COPIES of other models'
  // personal data — could arrive without anyone answering for it.
  Notification: {
    id: { disposition: "STRUCTURAL" },
    businessId: { disposition: "STRUCTURAL" },
    dedupeKey: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "b<businessId>:<domain>:<category>:<entityType>:<entityId> — ids only, and the uniqueness the writer depends on",
      basis: "PRODUCT",
    },
    domain: { disposition: "STRUCTURAL" },
    semanticCategory: { disposition: "STRUCTURAL" },
    severity: { disposition: "STRUCTURAL" },
    entityType: { disposition: "STRUCTURAL" },
    entityId: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "points at a row in the same tenant that is itself anonymised; an id, not an identity",
      basis: "PRODUCT",
    },
    // An enum ARRAY is still a column, and the guard treats it as one — which is
    // how this entry came to be written at all.
    intendedChannels: { disposition: "STRUCTURAL" },
    title: { disposition: "ERASE" },
    summary: { disposition: "ERASE" },
    href: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "an internal route such as /inbox or /leads/<id>; names nobody",
      basis: "PRODUCT",
    },
    reason: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "a fixed policy string from notification-policy.ts explaining why the class of fact is surfaced at all",
      basis: "PRODUCT",
    },
    cooldownHours: { disposition: "STRUCTURAL" },
    firstSurfacedAt: { disposition: "STRUCTURAL" },
    lastSurfacedAt: { disposition: "STRUCTURAL" },
    lastNotifiedAt: { disposition: "STRUCTURAL" },
    readAt: { disposition: "STRUCTURAL" },
    dismissedAt: { disposition: "STRUCTURAL" },
    resolvedAt: { disposition: "STRUCTURAL" },
    createdAt: { disposition: "STRUCTURAL" },
    updatedAt: { disposition: "STRUCTURAL" },
  },

  // ── C12-E1 ────────────────────────────────────────────────────────────────
  //
  // Two models whose only personal surface is a note somebody typed. Receiving a
  // delivery and deciding what to do with an undelivered remainder are operational
  // facts about the business; the free text beside them is not, because nothing
  // constrains what goes in it.
  //
  // What is NOT erased here is the point of writing it all down. The provenance
  // pointers stay, on a declared and checked dependency. The product columns stay,
  // said out loud rather than inferred.

  ReceivingSession: {
    id: { disposition: "STRUCTURAL" },
    businessId: { disposition: "STRUCTURAL" },
    purchaseOrderId: { disposition: "STRUCTURAL" },
    status: { disposition: "STRUCTURAL" },
    receivedAt: { disposition: "STRUCTURAL" },
    postedAt: { disposition: "STRUCTURAL" },
    // The one free-text column, and the whole reason this model was ever a finding.
    note: { disposition: "ERASE" },
    createdByUserId: {
      disposition: "RETAIN_BY_DESIGN",
      purpose:
        "provenance: which user received the goods. An id into a User row whose email, " +
        "name and password the same erasure destroys — a pointer, not an identity",
      basis: "SECURITY/AUDIT",
      dependsOn: { model: "User", fields: ["email", "name", "password"] },
    },
    postedByUserId: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "provenance: which user posted the session to stock. Same pointer, same erasure",
      basis: "SECURITY/AUDIT",
      dependsOn: { model: "User", fields: ["email", "name", "password"] },
    },
    createdAt: { disposition: "STRUCTURAL" },
    updatedAt: { disposition: "STRUCTURAL" },
  },

  PurchaseOrderLine: {
    id: { disposition: "STRUCTURAL" },
    purchaseOrderId: { disposition: "STRUCTURAL" },
    itemId: { disposition: "STRUCTURAL" },
    // Product identity, ratified under S-7C. `rawName` is what a supplier's feed or a
    // CSV called the product — the connector maps it to `productName`, intake copies it
    // into `InventoryDraft.detectedName`, and the document service prints it as
    // "מוצר ללא שם" when it is missing. It sits beside sku and barcode in the line's own
    // identity check, and all three are written from the same normaliser in the same
    // call. Recorded rather than inferred, so the classification cannot rest on somebody
    // remembering why.
    rawName: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "the product's name as the supplier's feed or the owner's CSV gave it",
      basis: "PRODUCT",
    },
    sku: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "the product's stock-keeping unit, alongside rawName and barcode",
      basis: "PRODUCT",
    },
    barcode: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "the product's barcode, alongside rawName and sku",
      basis: "PRODUCT",
    },
    orderedQty: { disposition: "STRUCTURAL" },
    unitCost: { disposition: "STRUCTURAL" },
    unitType: { disposition: "STRUCTURAL" },
    status: { disposition: "STRUCTURAL" },
    remainingDecision: { disposition: "STRUCTURAL" },
    remainingDecisionQty: { disposition: "STRUCTURAL" },
    expectedAt: { disposition: "STRUCTURAL" },
    // Free text from the request body: whatever the owner wrote about the remainder.
    remainingDecisionNote: { disposition: "ERASE" },
    remainingDecidedAt: { disposition: "STRUCTURAL" },
    remainingDecidedByUserId: {
      disposition: "RETAIN_BY_DESIGN",
      purpose: "provenance: which user decided the remainder. Same pointer, same erasure",
      basis: "SECURITY/AUDIT",
      dependsOn: { model: "User", fields: ["email", "name", "password"] },
    },
    createdAt: { disposition: "STRUCTURAL" },
    updatedAt: { disposition: "STRUCTURAL" },
  },
};
