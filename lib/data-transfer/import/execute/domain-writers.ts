/**
 * The only place I-6 writes business data.
 *
 * Every writer calls the domain's CANONICAL create service and passes the batch
 * transaction through. Nothing here builds a Prisma `create` of its own, and
 * nothing here touches a column the service would not have touched.
 *
 * # Why `{ tx }` is the load-bearing detail
 *
 * The executor writes an `ImportRunRow` marker in the same transaction as the
 * business record. That is only possible because all four services accept an
 * external transaction — `createLead` actually REFUSES to run without one. So
 * for every row there are exactly two outcomes: record and marker both commit,
 * or neither does. A record with no marker (which a retry would duplicate) and a
 * marker with no record (which a retry would skip forever) are both unreachable.
 *
 * # Inventory, specifically
 *
 * `createItemWithInitialStock` writes the item AND an INITIAL_STOCK movement
 * when the quantity is above zero. Passing `tx` pulls the item, the movement and
 * the marker into ONE commit — which is exactly why row idempotency matters most
 * here: a replayed inventory row would duplicate a stock movement, and the
 * ledger is the truth about how much stock exists.
 *
 * # Leads, specifically
 *
 * `createLead` resolves-or-CREATES a Customer for the lead's phone. That side
 * effect is canonical and is deliberately left alone; what I-6 adds is that it
 * is COUNTED and shown before the owner confirms (see `projectLeadSideEffects`).
 */

import { customerService } from "@/lib/services/crm/customer.service";
import { supplierService } from "@/lib/services/inventory/supplier.service";
import { leadService } from "@/lib/services/crm/lead.service";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { parseInventoryUnitType } from "@/lib/services/inventory/inventory-core";
import { recordSensor } from "@/lib/sensors/record-sensor";
import type { TenantTx } from "@/lib/tenant/transaction";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import type { ValidatedRow } from "@/lib/data-transfer/import/validate/row-validate";

/** Canonical values keyed by the owner-facing Hebrew label. */
type Canonical = ValidatedRow["canonical"];

function text(row: Canonical, field: string): string | null {
  const v = row[field];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(row: Canonical, field: string): number | undefined {
  const v = row[field];
  return typeof v === "number" ? v : undefined;
}

/** Reverse the Hebrew unit label back to the enum the service expects. */
const UNIT_BY_LABEL: Record<string, string> = {
  יחידה: "UNIT",
  'מ"ל': "ML",
  גרם: "GRAM",
  "ק״ג": "KG",
  ליטר: "LITER",
  מארז: "BOX",
};

/**
 * M5.5 — optional run context for sensors. The executor holds `importRunId`; when it passes it, the
 * sensor payload carries it and the idempotency key is the run/row identity. When it does not, the
 * run id is omitted (never invented) and the record's own creation identity is used instead.
 */
export type DomainWriterMeta = { importRunId?: number | null };

export type DomainWriter = (
  tx: TenantTx,
  businessId: number,
  userId: number,
  row: ValidatedRow,
  meta?: DomainWriterMeta
) => Promise<void>;

/** The owner who started the run did this, through a file: OWNER_USER + IMPORT. */
function importActor(userId: number) {
  return { actor: { type: "OWNER_USER" as const, userId }, source: "IMPORT" as const };
}

/** Run/row provenance for a sensor payload — only what is actually known. */
function provenance(row: ValidatedRow, meta?: DomainWriterMeta) {
  return {
    ...(meta?.importRunId != null ? { importRunId: meta.importRunId } : {}),
    sourceRowNumber: row.rowNumber,
  };
}

function importKey(
  meta: DomainWriterMeta | undefined,
  row: ValidatedRow,
  kind: string,
  fallback: string
): string {
  return meta?.importRunId != null
    ? `import:${meta.importRunId}:${row.rowNumber}:${kind}`
    : fallback;
}

const writeCustomer: DomainWriter = async (tx, businessId, userId, row, meta) => {
  // CUSTOMER_CREATED is written by the canonical service inside this same tx.
  await customerService.createCustomer(
    {
      businessId,
      name: text(row.canonical, "שם") ?? "",
      phone: text(row.canonical, "טלפון"),
      email: text(row.canonical, "אימייל"),
      city: text(row.canonical, "עיר"),
      notes: text(row.canonical, "הערות"),
    },
    {
      tx,
      sensor: {
        ...importActor(userId),
        origin: "IMPORT",
        importRunId: meta?.importRunId ?? null,
        sourceRowNumber: row.rowNumber,
        // Without a run id, the service's own `customer:${id}:created` applies.
        idempotencyKey:
          meta?.importRunId != null
            ? `import:${meta.importRunId}:${row.rowNumber}:customer`
            : null,
      },
    }
  );
};

const writeSupplier: DomainWriter = async (tx, businessId, userId, row, meta) => {
  const c = row.canonical;
  const created = await supplierService.createSupplier(
    {
      businessId,
      name: text(c, "שם ספק") ?? "",
      legalName: text(c, "שם משפטי"),
      taxId: text(c, "מספר עוסק / ח.פ."),
      // The label round-trips through the same vocabulary the export uses; the
      // service parses it and refuses anything it does not recognise.
      taxIdType: taxIdTypeFromLabel(text(c, "סוג עוסק")),
      category: text(c, "תחום"),
      phone: text(c, "טלפון"),
      email: text(c, "אימייל"),
      website: text(c, "אתר"),
      contactName: text(c, "איש קשר"),
      contactRole: text(c, "תפקיד איש קשר"),
      contactPhone: text(c, "טלפון איש קשר"),
      contactEmail: text(c, "אימייל איש קשר"),
      addressStreet: text(c, "רחוב"),
      addressCity: text(c, "עיר"),
      addressPostalCode: text(c, "מיקוד"),
      paymentTermsDays: num(c, "ימי תשלום") ?? null,
      preferredPaymentMethod: paymentMethodFromLabel(
        text(c, "אמצעי תשלום מועדף")
      ),
      defaultLeadTimeDays: num(c, "ימי אספקה") ?? null,
      notes: text(c, "הערות"),
    },
    { tx }
  );
  await recordSensor(
    {
      businessId,
      sensor: "SUPPLIER_CREATED",
      entityId: created.id,
      ...importActor(userId),
      payload: {
        origin: "IMPORT",
        ...provenance(row, meta),
        hasTaxId: created.taxId != null,
      },
      idempotencyKey: importKey(meta, row, "supplier", `supplier:${created.id}:created`),
    },
    { tx }
  );
};

const writeLead: DomainWriter = async (tx, businessId, userId, row) => {
  // LEAD_CREATED (and CUSTOMER_CREATED origin LEAD, when the lead creates one) are written by the
  // canonical service inside this tx, stamped OWNER_USER + IMPORT.
  await leadService.createLead(
    {
      businessId,
      name: text(row.canonical, "שם") ?? "",
      phone: text(row.canonical, "טלפון"),
      email: text(row.canonical, "אימייל"),
      sourceChannel: text(row.canonical, "מקור הפנייה"),
      intentSnapshot: text(row.canonical, "מה ביקשו"),
      ...importActor(userId),
    },
    { tx }
  );
};

const writeInventoryItem: DomainWriter = async (tx, businessId, userId, row, meta) => {
  const c = row.canonical;
  const unitLabel = text(c, "יחידת מידה") ?? "";
  const created = await inventoryService.createItemWithInitialStock(
    {
      businessId,
      name: text(c, "שם פריט") ?? "",
      // Parsed through the canonical vocabulary, never cast.
      unitType: parseInventoryUnitType(UNIT_BY_LABEL[unitLabel] ?? unitLabel),
      sku: text(c, "מק״ט") ?? undefined,
      barcode: text(c, "ברקוד") ?? undefined,
      supplierName: text(c, "ספק") ?? undefined,
      // Drives the INITIAL_STOCK movement inside the service. Never written to
      // `currentQuantity` directly.
      initialQuantity: num(c, "כמות במלאי") ?? 0,
      minimumQuantity: num(c, "כמות מינימום") ?? 0,
      reorderPoint: num(c, "נקודת הזמנה"),
      costPerUnit: num(c, "עלות ליחידה"),
      sellPricePerUnit: num(c, "מחיר מכירה"),
      createdByUserId: userId,
    },
    { tx }
  );
  await recordSensor(
    {
      businessId,
      sensor: "INVENTORY_ITEM_CREATED",
      entityId: created.id,
      ...importActor(userId),
      payload: { origin: "IMPORT", ...provenance(row, meta) },
      idempotencyKey: importKey(meta, row, "inventory", `item:${created.id}:created`),
    },
    { tx }
  );
};

/* ------------------------------------------------------------ helpers --- */

import { CUSTOMER_TAX_ID_TYPE_LABELS } from "@/lib/billing/customer-tax-identity";
import { SUPPLIER_PAYMENT_METHOD_LABELS } from "@/lib/services/inventory/supplier-profile";

function keyByLabel(labels: Record<string, string>, label: string | null) {
  if (!label) return null;
  const hit = Object.entries(labels).find(([, value]) => value === label);
  return hit ? hit[0] : null;
}

function taxIdTypeFromLabel(label: string | null) {
  return keyByLabel(CUSTOMER_TAX_ID_TYPE_LABELS, label) as
    | "AUTHORIZED_DEALER"
    | "EXEMPT_DEALER"
    | "LTD_COMPANY"
    | "PRIVATE_ID"
    | "OTHER"
    | null;
}

function paymentMethodFromLabel(label: string | null) {
  return keyByLabel(SUPPLIER_PAYMENT_METHOD_LABELS, label) as
    | "BANK_TRANSFER"
    | "CREDIT_CARD"
    | "CHECK"
    | "CASH"
    | "BIT"
    | "PAYBOX"
    | "OTHER"
    | null;
}

const WRITERS: Record<string, DomainWriter> = {
  customers: writeCustomer,
  suppliers: writeSupplier,
  leads: writeLead,
  inventory: writeInventoryItem,
};

export function writerFor(domainId: DataTransferDomainId): DomainWriter {
  const writer = WRITERS[domainId];
  if (!writer) throw new Error(`No import writer for domain: ${domainId}`);
  return writer;
}
