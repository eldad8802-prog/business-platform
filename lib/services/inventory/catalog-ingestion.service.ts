import { CatalogSourceType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ensureSupplierProductTx } from "./supplier-identity-learning.service";
import { createCatalogSourceTx } from "./catalog-source.service";
import { recordCatalogClaimTx, type CatalogValueInput } from "./catalog-claim.service";

/**
 * Supplier Domain Catalog — Ingestion layer (v1: manual / structured import ONLY).
 *
 * This is INGESTION, not Connection: no supplier APIs, no sync engine, no
 * credentials, no marketplace. It takes already-collected rows (typed by a manual
 * form or a parsed structured file) and turns them into provenance + claims:
 *   normalizeCatalogImport → createCatalogSource → ensureSupplierProduct (REUSE of
 *   Phase 2 identity, never a new mechanism) → recordCatalogClaim.
 *
 * Guard rails: never writes InventoryItem, stock, cost-of-record, Measure, or
 * Mapping; never creates POs. Catalog only stores claims; the offer is derived.
 */

/** One supplier-reported product row (product-level catalog attributes). */
export type CatalogImportRow = {
  externalSku?: string | null;
  barcode?: string | null;
  name?: string | null;
  askingPrice?: number | null;
  currency?: string | null;
  /** Free supplier-reported availability text, e.g. "IN_STOCK" / "2 weeks". */
  availability?: string | null;
  packageDescription?: string | null;
  /** When the supplier asserted these values; defaults to ingestion time. */
  observedAt?: Date | null;
};

/** Supplier-level commercial terms (subjectType = SUPPLIER). */
export type SupplierTermsInput = {
  minimumOrderAmount?: number | null;
  currency?: string | null;
  leadTimeDays?: number | null;
  observedAt?: Date | null;
};

export type NormalizedCatalogRow = {
  externalSku: string | null;
  barcode: string | null;
  name: string | null;
  askingPrice: number | null;
  currency: string | null;
  availability: string | null;
  packageDescription: string | null;
  observedAt: Date | null;
};

export type CatalogNormalizationResult = {
  rows: NormalizedCatalogRow[];
  /** Rows dropped before ingestion (no identity signal at all). */
  skipped: { index: number; reason: string }[];
};

const DEFAULT_CURRENCY = "ILS";

function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalize raw import rows: trim text, validate numbers, and drop rows with no
 * usable identity signal (sku / barcode / name) — those cannot anchor a
 * SupplierProduct. Pure; no DB access.
 */
export function normalizeCatalogImport(
  rows: CatalogImportRow[]
): CatalogNormalizationResult {
  const out: NormalizedCatalogRow[] = [];
  const skipped: { index: number; reason: string }[] = [];

  rows.forEach((row, index) => {
    const externalSku = clean(row.externalSku);
    const barcode = clean(row.barcode);
    const name = clean(row.name);

    if (!externalSku && !barcode && !name) {
      skipped.push({ index, reason: "no identity signal (sku/barcode/name)" });
      return;
    }

    out.push({
      externalSku,
      barcode,
      name,
      askingPrice: cleanNumber(row.askingPrice),
      currency: clean(row.currency) ?? DEFAULT_CURRENCY,
      availability: clean(row.availability),
      packageDescription: clean(row.packageDescription),
      observedAt: row.observedAt ?? null,
    });
  });

  return { rows: out, skipped };
}

/**
 * Identity bridge — REUSE of Phase 2 `ensureSupplierProductTx`. Catalog never
 * invents identities; it resolves a supplier-reported row to a SupplierProduct via
 * the existing dedup (sku → barcode → name). Returns null when unresolved.
 */
export function ensureSupplierProductFromCatalogTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    supplierId: number;
    externalSku?: string | null;
    barcode?: string | null;
    name?: string | null;
    sourceId: number;
  }
) {
  return ensureSupplierProductTx(tx, {
    businessId: input.businessId,
    supplierId: input.supplierId,
    externalSku: input.externalSku,
    barcode: input.barcode,
    rawName: input.name,
    source: `catalog:source:${input.sourceId}`,
  });
}

export type IngestCatalogInput = {
  businessId: number;
  supplierId: number;
  sourceType: CatalogSourceType;
  actorUserId?: number | null;
  rows: CatalogImportRow[];
  supplierTerms?: SupplierTermsInput;
  metadata?: Prisma.InputJsonValue | null;
};

export type IngestCatalogResult = {
  sourceId: number;
  productsResolved: number;
  claimsRecorded: number;
  unresolved: { row: NormalizedCatalogRow }[];
  skipped: { index: number; reason: string }[];
};

/**
 * Transaction-scoped ingestion: create the provenance anchor, resolve each row to
 * a SupplierProduct (reusing Phase 2 identity), and record one append-only claim
 * per present attribute. Unresolved rows are reported, never forced. Optional
 * supplier-level terms are recorded against the supplier subject.
 */
export async function ingestCatalogTx(
  tx: Prisma.TransactionClient,
  input: IngestCatalogInput
): Promise<IngestCatalogResult> {
  const { rows, skipped } = normalizeCatalogImport(input.rows);

  const source = await createCatalogSourceTx(tx, {
    businessId: input.businessId,
    supplierId: input.supplierId,
    sourceType: input.sourceType,
    actorUserId: input.actorUserId ?? null,
    metadata: input.metadata ?? undefined,
  });

  let productsResolved = 0;
  let claimsRecorded = 0;
  const unresolved: { row: NormalizedCatalogRow }[] = [];

  for (const row of rows) {
    const ensured = await ensureSupplierProductFromCatalogTx(tx, {
      businessId: input.businessId,
      supplierId: input.supplierId,
      externalSku: row.externalSku,
      barcode: row.barcode,
      name: row.name,
      sourceId: source.id,
    });

    if (!ensured) {
      unresolved.push({ row });
      continue;
    }
    productsResolved += 1;

    const attributeValues: { attribute: Parameters<typeof recordCatalogClaimTx>[1]["attribute"]; value: CatalogValueInput }[] = [];

    if (row.askingPrice != null) {
      attributeValues.push({
        attribute: "ASKING_PRICE",
        value: { valueType: "MONEY", valueNumber: row.askingPrice, currency: row.currency ?? DEFAULT_CURRENCY },
      });
    }
    if (row.availability != null) {
      attributeValues.push({
        attribute: "AVAILABILITY",
        value: { valueType: "TEXT", valueText: row.availability },
      });
    }
    if (row.packageDescription != null) {
      attributeValues.push({
        attribute: "PACKAGE_DESCRIPTION",
        value: { valueType: "TEXT", valueText: row.packageDescription },
      });
    }

    for (const { attribute, value } of attributeValues) {
      await recordCatalogClaimTx(tx, {
        businessId: input.businessId,
        subjectType: "SUPPLIER_PRODUCT",
        subjectId: ensured.id,
        attribute,
        value,
        sourceId: source.id,
        observedAt: row.observedAt,
      });
      claimsRecorded += 1;
    }
  }

  const terms = input.supplierTerms;
  if (terms) {
    if (terms.minimumOrderAmount != null) {
      await recordCatalogClaimTx(tx, {
        businessId: input.businessId,
        subjectType: "SUPPLIER",
        subjectId: input.supplierId,
        attribute: "MINIMUM_ORDER_AMOUNT",
        value: { valueType: "MONEY", valueNumber: terms.minimumOrderAmount, currency: terms.currency ?? DEFAULT_CURRENCY },
        sourceId: source.id,
        observedAt: terms.observedAt,
      });
      claimsRecorded += 1;
    }
    if (terms.leadTimeDays != null) {
      await recordCatalogClaimTx(tx, {
        businessId: input.businessId,
        subjectType: "SUPPLIER",
        subjectId: input.supplierId,
        attribute: "LEAD_TIME_DAYS",
        value: { valueType: "NUMBER", valueNumber: terms.leadTimeDays },
        sourceId: source.id,
        observedAt: terms.observedAt,
      });
      claimsRecorded += 1;
    }
  }

  return { sourceId: source.id, productsResolved, claimsRecorded, unresolved, skipped };
}

/** Public entry: ingest a catalog batch in its own transaction. */
export function ingestCatalog(input: IngestCatalogInput): Promise<IngestCatalogResult> {
  return prisma.$transaction((tx) => ingestCatalogTx(tx, input));
}
