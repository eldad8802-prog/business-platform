/**
 * S8 — EXTERNAL OBJECT SURFACES. The debt dimension the model-level registry cannot hold.
 *
 * WHY THIS FILE EXISTS
 *
 * `erasure-model-coverage.ts` answers one question per MODEL: does the erasure touch
 * it? That question has no room for a second, independent answer about the bytes the
 * row points at. `CrmAttachment` proved the cost: the model is ERASURE_MANAGED, the
 * erasure deletes the row — and the object in storage was left behind, with the only
 * `storageKey` in the schema deleted along with the row. No finding could describe it,
 * because there was nowhere to write it down.
 *
 * `InventoryItem` proved the other half: clearing `supplierName` flips the model to
 * ERASURE_MANAGED, which resolves `C12-UNMANAGED-PERSONAL-DATA::InventoryItem` — and
 * the unerased image object would vanish from the ledger with it.
 *
 * So this is a SECOND, ORTHOGONAL dimension, keyed by SURFACE rather than by model:
 *
 *     ERASURE_MANAGED(model)  says nothing about  OBJECT(model.field)
 *
 * A model may be fully managed and still carry an OPEN object surface, and the
 * verifier reports both. C12 is neither weakened nor replaced.
 *
 * WHAT COUNTS AS A SURFACE HERE
 *
 * Only objects DUBIZ OWNS: bytes this application wrote into its own storage
 * (`lib/storage`, any provider) and can therefore delete. A URL somebody typed into a
 * field, a payment page hosted by a provider, or a base64 data URL inlined in a column
 * is not an owned object — those are declared in NOT_OWNED, with the reason, so that
 * "every pointer-shaped column is accounted for" stays machine-checkable rather than
 * a matter of who remembered to look.
 */

/**
 * What the erasure does with the OBJECT (not with the column).
 *
 *   ERASED     the object is deleted by the erasure, BEFORE the row/pointer goes.
 *              Requires `erasedBy`, and the verifier checks the adapter really calls it.
 *   OPEN       the object survives an account deletion. This is debt, and it is a
 *              finding every run.
 *   OPEN_INERT the same, except nothing in the product can create such an object yet.
 *              Still a finding — a narrower one — and the inertness is proven: any
 *              writer of the field falsifies it.
 *   RETAINED   the object is kept on purpose, for the same reason the row is kept.
 *              Requires a basis.
 */
export type ObjectSurfaceState = "ERASED" | "OPEN" | "OPEN_INERT" | "RETAINED";

export type ObjectPointerKind =
  /** The column holds a storage key this application can hand straight to `deleteObject`. */
  | "STORAGE_KEY"
  /** The column holds a public URL. Deleting needs a URL→key inverse, which may not exist. */
  | "PUBLIC_URL";

export type ObjectSurface = {
  model: string;
  field: string;
  kind: ObjectPointerKind;
  /** The `lib/storage` domain the object lives in, where one is known. */
  domain?: string;
  state: ObjectSurfaceState;
  /** Always required: why this state is the right answer. */
  reason: string;
  /** Required for RETAINED. */
  basis?: "LEGAL/FISCAL" | "SECURITY/AUDIT" | "PRODUCT";
  /**
   * Required for ERASED. `fn` is the function the erasure adapter must call to remove
   * the object; `beforeDelegate` is the Prisma delegate whose row write/delete must
   * come AFTER it. The verifier reads the adapter and fails if the call is missing or
   * in the wrong order — a classification flip alone cannot resolve an object surface.
   */
  erasedBy?: { fn: string; beforeDelegate: string };
  /** Required for OPEN / OPEN_INERT: the increment that is expected to close it. */
  target?: string;
};

/**
 * Pointer-shaped columns that are NOT objects this application owns. Declared so the
 * completeness check can insist that every candidate column has an answer.
 */
export type NotOwnedPointer = { model: string; field: string; reason: string };

export const OBJECT_SURFACES: readonly ObjectSurface[] = [
  // ── The one this increment corrects ──────────────────────────────────────
  {
    model: "CrmAttachment",
    field: "storageKey",
    kind: "STORAGE_KEY",
    domain: "crm",
    state: "ERASED",
    reason:
      "a private CRM attachment: the row is the only place its key exists, so the object is deleted first and the row second",
    erasedBy: { fn: "deleteAttachmentObject", beforeDelegate: "crmAttachment" },
  },

  // ── Kept because the row is kept ─────────────────────────────────────────
  {
    model: "Document",
    field: "fileUrl",
    kind: "STORAGE_KEY",
    domain: "documents",
    state: "RETAINED",
    reason: "the artifact IS the bookkeeping evidence; the row is retained and so is the object",
    basis: "LEGAL/FISCAL",
  },
  {
    model: "FinancialDocument",
    field: "fileUrl",
    kind: "STORAGE_KEY",
    domain: "documents",
    state: "RETAINED",
    reason: "bookkeeping evidence, retained with its row",
    basis: "LEGAL/FISCAL",
  },
  {
    model: "BillingDocument",
    field: "pdfStorageKey",
    kind: "STORAGE_KEY",
    domain: "billing",
    state: "RETAINED",
    reason: "the rendered issued document; retained for the same reason the document is",
    basis: "LEGAL/FISCAL",
  },
  {
    model: "BillingDocument",
    field: "signedPdfStorageKey",
    kind: "STORAGE_KEY",
    domain: "billing",
    state: "RETAINED",
    reason: "the signed rendering of an issued document",
    basis: "LEGAL/FISCAL",
  },

  // ── Open debt: the object survives an account deletion ───────────────────
  {
    model: "InventoryItem",
    field: "imageUrl",
    kind: "PUBLIC_URL",
    domain: "inventory",
    state: "OPEN",
    reason:
      "a product photo written to public storage; the column holds the public URL and no URL→key inverse or public-asset delete exists, so a database erasure cannot reach the bytes",
    target: "S8-IMAGES",
  },
  {
    model: "InventoryDraft",
    field: "imageUrl",
    kind: "PUBLIC_URL",
    domain: "inventory",
    state: "OPEN",
    reason:
      "same public-URL shape as InventoryItem, and the draft route additionally accepts a client-supplied URL that may point outside this bucket",
    target: "S8-IMAGES",
  },
  {
    model: "Offer",
    field: "imageUrl",
    kind: "PUBLIC_URL",
    domain: "offers",
    state: "OPEN",
    reason: "an offer image in public storage; the model itself is still NEEDS_OWNER_DECISION",
    target: "C13-OFFER",
  },
  {
    model: "ContentRender",
    field: "outputUrl",
    kind: "PUBLIC_URL",
    domain: "content",
    state: "OPEN",
    reason:
      "a rendered marketing asset; the model is NEEDS_OWNER_DECISION and the URL may be the render provider's rather than this bucket's",
    target: "C13-CONTENT",
  },
  {
    model: "ContentRender",
    field: "thumbnailUrl",
    kind: "PUBLIC_URL",
    domain: "content",
    state: "OPEN",
    reason: "the thumbnail beside the render, same provenance question",
    target: "C13-CONTENT",
  },

  // ── Schema-capable, but nothing can create the object yet ────────────────
  {
    model: "InboundEmailMessage",
    field: "rawObjectKey",
    kind: "STORAGE_KEY",
    state: "OPEN_INERT",
    reason:
      "the raw MIME object an ingestion path would write. No ingestion path exists and nothing writes this column, so no object can exist today — but the surface is declared now so the first writer cannot arrive unnoticed",
    target: "S5-INBOUND",
  },
];

export const NOT_OWNED_POINTERS: readonly NotOwnedPointer[] = [
  {
    model: "BusinessProfile",
    field: "billingLogoDataUrl",
    reason: "a base64 data URL stored inline in the column; there is no object anywhere",
  },
  {
    model: "BusinessProfile",
    field: "billingSignatureDataUrl",
    reason: "inline data URL, same as the logo",
  },
  {
    model: "BusinessBotSettings",
    field: "productLinkUrl",
    reason: "a link the owner types to their own site; this application never wrote an object for it",
  },
  {
    model: "BusinessBot",
    field: "avatar",
    reason:
      "the bot's avatar as chosen in the UI; no upload path writes an object for it (the model's own text stays NEEDS_OWNER_DECISION)",
  },
  {
    model: "PaymentRequest",
    field: "paymentUrl",
    reason: "a checkout page hosted by the payment provider; not this application's object",
  },
];

/**
 * Column-name shapes that MIGHT be an owned object pointer. Anything matching this in
 * the schema must appear in OBJECT_SURFACES or NOT_OWNED_POINTERS — that is what makes
 * a new pointer column a finding instead of a silent addition.
 */
export const POINTER_NAME_PATTERN = /(storagekey|objectkey|imageurl|fileurl|avatar|url|path)$/i;
