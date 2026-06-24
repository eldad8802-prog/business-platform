import {
  PartyClaimConfidence,
  PartyClaimStatus,
  PartyResolutionMethod,
  Prisma,
} from "@prisma/client";

/**
 * Supplier Domain Phase 2 — Identity Learning.
 *
 * Two additive, transaction-scoped writes invoked from `approveSupplierPurchase`
 * AFTER each draft line is resolved to an InventoryItem:
 *   - `ensureSupplierProductTx`        — lazy Reported-Reality reference.
 *   - `learnRepresentationMappingTx`   — corrigible Identity binding-belief.
 *
 * Guard rails (Constitution v1.2 / Phase 2 plan):
 *   - Identity ONLY — no Catalog, no Measure / unit conversion, no price.
 *   - SupplierProduct is "how the supplier names a product", NEVER a Product
 *     Master and NEVER authoritative over InventoryItem (we never write items).
 *   - Mappings are HUMAN_CONFIRMED (KNOWN) only; append-only — superseded rows
 *     become RETRACTED, never deleted; single ACTIVE per SupplierProduct.
 *   - Precondition-guarded: absence of supplier / identity → no write (degrade).
 *     Learning must never block approval, so callers skip on `null` rather than
 *     throwing.
 */

/** Lowercase, NFKC-normalize, trim, and collapse internal whitespace. */
export function normalizeSupplierText(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  const normalized = raw.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

/**
 * Bridge a free-text `supplierName` to a `supplierId` via find-or-create of a
 * Supplier ROW (case-insensitive by name). This is a row lookup, NOT Party
 * identity merge — strong-signal Party convergence is out of Phase 2 scope and
 * is intentionally not invoked here. Returns null when no usable name exists.
 */
export async function resolveSupplierIdByNameTx(
  tx: Prisma.TransactionClient,
  input: { businessId: number; supplierName: string | null | undefined }
): Promise<number | null> {
  const display = (input.supplierName ?? "").trim();
  if (!display) return null;

  const existing = await tx.supplier.findFirst({
    where: {
      businessId: input.businessId,
      name: { equals: display, mode: "insensitive" },
    },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await tx.supplier.create({
    data: { businessId: input.businessId, name: display },
    select: { id: true },
  });
  return created.id;
}

export type SupplierProductIdentityInput = {
  businessId: number;
  supplierId: number;
  externalSku?: string | null;
  barcode?: string | null;
  rawName?: string | null;
  /** Provenance of first observation, e.g. "draft:{id}:line:{lineId}". */
  source: string;
};

export type EnsuredSupplierProduct = {
  id: number;
  /** Which signal keyed the dedup lookup (Establishing > Supporting). */
  identitySignal: "sku" | "barcode" | "name";
};

/**
 * Lazily materialize (or look up) the SupplierProduct for a supplier-reported
 * line, deduped by the strongest available identity signal:
 *   externalSku (Establishing) → barcode (Establishing) → normalizedName
 *   (Supporting). No identity signal at all → returns null (no reference).
 * Reported attributes (name / active) are refreshed in place; identity is never
 * mutated and InventoryItem is never touched.
 */
export async function ensureSupplierProductTx(
  tx: Prisma.TransactionClient,
  input: SupplierProductIdentityInput
): Promise<EnsuredSupplierProduct | null> {
  const externalSku = (input.externalSku ?? "").trim() || null;
  const barcode = (input.barcode ?? "").trim() || null;
  const rawName = (input.rawName ?? "").trim() || null;
  const normalizedName = normalizeSupplierText(rawName);

  let identitySignal: EnsuredSupplierProduct["identitySignal"];
  let lookup: Prisma.SupplierProductWhereInput;

  if (externalSku) {
    identitySignal = "sku";
    lookup = {
      businessId: input.businessId,
      supplierId: input.supplierId,
      externalSku,
    };
  } else if (barcode) {
    identitySignal = "barcode";
    lookup = {
      businessId: input.businessId,
      supplierId: input.supplierId,
      barcode,
    };
  } else if (normalizedName) {
    identitySignal = "name";
    lookup = {
      businessId: input.businessId,
      supplierId: input.supplierId,
      normalizedName,
    };
  } else {
    // Degrade: no stable supplier-product identity on this line.
    return null;
  }

  const existing = await tx.supplierProduct.findFirst({
    where: lookup,
    orderBy: { createdAt: "asc" },
    select: { id: true, rawName: true, isActive: true },
  });

  if (existing) {
    const needsNameRefresh = rawName !== null && existing.rawName !== rawName;
    if (needsNameRefresh || !existing.isActive) {
      await tx.supplierProduct.update({
        where: { id: existing.id },
        data: {
          ...(needsNameRefresh ? { rawName, normalizedName } : {}),
          isActive: true,
        },
      });
    }
    return { id: existing.id, identitySignal };
  }

  const created = await tx.supplierProduct.create({
    data: {
      businessId: input.businessId,
      supplierId: input.supplierId,
      externalSku,
      barcode,
      rawName,
      normalizedName,
      isActive: true,
      source: input.source,
    },
    select: { id: true },
  });
  return { id: created.id, identitySignal };
}

export type LearnRepresentationMappingInput = {
  businessId: number;
  supplierProductId: number;
  inventoryItemId: number;
  identitySignal?: string | null;
  source: string;
  resolvedByUserId?: number | null;
};

/**
 * Record the human-confirmed Identity mapping SupplierProduct → InventoryItem.
 * Mirrors PartyResolutionClaim: append-only, KNOWN + HUMAN_CONFIRMED. Idempotent
 * when an ACTIVE mapping to the same item already exists; a mapping to a
 * different item RETRACTs the prior ACTIVE row(s) and inserts a new ACTIVE one
 * (revision), keeping exactly one ACTIVE row per SupplierProduct.
 */
export async function learnRepresentationMappingTx(
  tx: Prisma.TransactionClient,
  input: LearnRepresentationMappingInput
): Promise<void> {
  const activeMappings = await tx.representationMapping.findMany({
    where: {
      businessId: input.businessId,
      supplierProductId: input.supplierProductId,
      status: PartyClaimStatus.ACTIVE,
    },
    select: { id: true, inventoryItemId: true },
  });

  if (activeMappings.some((m) => m.inventoryItemId === input.inventoryItemId)) {
    return;
  }

  if (activeMappings.length > 0) {
    await tx.representationMapping.updateMany({
      where: { id: { in: activeMappings.map((m) => m.id) } },
      data: { status: PartyClaimStatus.RETRACTED },
    });
  }

  await tx.representationMapping.create({
    data: {
      businessId: input.businessId,
      supplierProductId: input.supplierProductId,
      inventoryItemId: input.inventoryItemId,
      identityConfidence: PartyClaimConfidence.KNOWN,
      method: PartyResolutionMethod.HUMAN_CONFIRMED,
      identitySignal: input.identitySignal ?? null,
      source: input.source,
      resolvedByUserId: input.resolvedByUserId ?? null,
      status: PartyClaimStatus.ACTIVE,
    },
  });
}

// ── Phase 3 — Measure (Representation Conversion) ────────────────────────────
// Identity-only Phase 2 said "which product"; Measure says "how many stock-units
// a supplier unit represents". The factor lives on the ACTIVE mapping row; per-
// order snapshots on PO/Receiving preserve the factor used at order time.

export type SetRepresentationMeasureInput = {
  businessId: number;
  supplierProductId: number;
  purchaseUnitName?: string | null;
  /** stock-units per 1 purchase-unit. null clears (→ 1:1); positive sets. */
  factor: number | null;
  measureSource: string;
  measureConfidence?: PartyClaimConfidence | null;
  resolvedByUserId?: number | null;
};

function normalizeFactor(factor: number | null | undefined): number | null {
  if (factor == null) return null;
  const f = Number(factor);
  return Number.isFinite(f) && f > 0 ? f : null;
}

/**
 * Attach / update the Measure on the ACTIVE mapping of a SupplierProduct. The
 * factor is the owner's belief (Human-Entered ⇒ default BELIEVED, never KNOWN —
 * it can be wrong and may rot). Updated in place on the mapping row; the
 * canonical per-order record is the PO/Receiving snapshot, so historic orders
 * are never rewritten by a later factor change.
 */
export async function setRepresentationMeasureTx(
  tx: Prisma.TransactionClient,
  input: SetRepresentationMeasureInput
): Promise<void> {
  const active = await tx.representationMapping.findFirst({
    where: {
      businessId: input.businessId,
      supplierProductId: input.supplierProductId,
      status: PartyClaimStatus.ACTIVE,
    },
    select: { id: true },
  });
  if (!active) {
    throw new Error("No active mapping to attach a measure to");
  }

  await tx.representationMapping.update({
    where: { id: active.id },
    data: {
      purchaseUnitName: (input.purchaseUnitName ?? "").trim() || null,
      factor: normalizeFactor(input.factor),
      measureSource: input.measureSource,
      measureConfidence: input.measureConfidence ?? PartyClaimConfidence.BELIEVED,
      measureResolvedByUserId: input.resolvedByUserId ?? null,
    },
  });
}

export type EffectiveMeasure = {
  supplierProductId: number;
  factor: number | null;
  purchaseUnitName: string | null;
};

/**
 * Read-only lookup of the Measure to apply for a supplier-reported line: find
 * the existing SupplierProduct (same dedup precedence as ensure) and read its
 * ACTIVE mapping's factor. No product / no mapping ⇒ null ⇒ caller uses 1:1.
 * Never writes; never creates.
 */
export async function lookupEffectiveMeasureTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    supplierId: number;
    externalSku?: string | null;
    barcode?: string | null;
    rawName?: string | null;
  }
): Promise<EffectiveMeasure | null> {
  const externalSku = (input.externalSku ?? "").trim() || null;
  const barcode = (input.barcode ?? "").trim() || null;
  const normalizedName = normalizeSupplierText(input.rawName);

  let lookup: Prisma.SupplierProductWhereInput;
  if (externalSku) {
    lookup = { businessId: input.businessId, supplierId: input.supplierId, externalSku };
  } else if (barcode) {
    lookup = { businessId: input.businessId, supplierId: input.supplierId, barcode };
  } else if (normalizedName) {
    lookup = { businessId: input.businessId, supplierId: input.supplierId, normalizedName };
  } else {
    return null;
  }

  const product = await tx.supplierProduct.findFirst({
    where: lookup,
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!product) return null;

  const mapping = await tx.representationMapping.findFirst({
    where: {
      businessId: input.businessId,
      supplierProductId: product.id,
      status: PartyClaimStatus.ACTIVE,
    },
    orderBy: { id: "desc" },
    select: { factor: true, purchaseUnitName: true },
  });

  return {
    supplierProductId: product.id,
    factor: mapping?.factor ?? null,
    purchaseUnitName: mapping?.purchaseUnitName ?? null,
  };
}
