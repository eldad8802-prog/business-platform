/**
 * Duplicate DETECTION. Not duplicate policy.
 *
 * I-5 finds candidates and explains them. It never decides "skip" or "update" —
 * that decision belongs to the owner, in I-6, with this evidence in front of
 * them. Nothing here writes.
 *
 * # Two scopes, because they are different problems
 *
 *   IN_FILE   two rows of the upload collide with each other. The owner has to
 *             fix their spreadsheet; Dubiz cannot choose which one is real.
 *   EXISTING  a row looks like something already in THIS business. Read-only,
 *             tenant-scoped, server-derived businessId.
 *
 * # Strength is about the product, not about our confidence
 *
 * STRONG means the platform itself treats the value as an identity:
 *
 *   Customers  `@@unique([businessId, phone])` — a second row with that phone
 *              genuinely cannot be created.
 *   Leads      `Lead_open_phone_key` — at most one OPEN lead per phone. A
 *              CLOSED lead with the same phone does NOT block, so it is
 *              reported WEAK: real context, not an obstacle.
 *
 * WEAK means "worth a look": suppliers and inventory have NO uniqueness at all,
 * so even an exact tax-id or SKU match is a candidate, never a certainty.
 * Claiming otherwise would invent a guarantee the product does not make.
 *
 * # What leaves this module
 *
 * A human-readable label for the existing record and the field that matched.
 * No internal ids, no tenant identifiers, no row shapes — the preview explains
 * the match; it does not hand out database handles.
 */

import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import type { ValidatedRow } from "@/lib/data-transfer/import/validate/row-validate";

export type DuplicateScope = "IN_FILE" | "EXISTING";
export type DuplicateStrength = "STRONG" | "WEAK";

export type DuplicateEvidence = {
  scope: DuplicateScope;
  /** Owner-facing field label that matched. */
  field: string;
  strength: DuplicateStrength;
  /** The matched value, as the owner would recognize it. */
  value: string;
  /** For IN_FILE: the other row numbers carrying the same value. */
  otherRows?: number[];
  /** For EXISTING: a safe display label. Never an internal id. */
  existingLabel?: string;
  /** For EXISTING: extra context the owner needs to judge (e.g. lead status). */
  existingNote?: string;
};

export type RowDuplicates = Map<number, DuplicateEvidence[]>;

/** Case- and space-insensitive key for a weak name comparison. */
function nameKey(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().toLowerCase()
    : "";
}

function textOf(row: ValidatedRow, field: string): string {
  const raw = row.canonical[field];
  return raw == null ? "" : String(raw);
}

/** Which fields identify a record, per domain, and how strongly. */
const IN_FILE_KEYS: Record<
  string,
  ReadonlyArray<{ field: string; strength: DuplicateStrength; fold?: boolean }>
> = {
  customers: [{ field: "טלפון", strength: "STRONG" }],
  leads: [{ field: "טלפון", strength: "STRONG" }],
  suppliers: [
    { field: "מספר עוסק / ח.פ.", strength: "WEAK" },
    { field: "שם ספק", strength: "WEAK", fold: true },
  ],
  inventory: [
    { field: "מק״ט", strength: "WEAK" },
    { field: "ברקוד", strength: "WEAK" },
  ],
};

/** Collisions between rows of the same upload. Pure — no DB. */
export function detectInFileDuplicates(
  domainId: DataTransferDomainId,
  rows: readonly ValidatedRow[]
): RowDuplicates {
  const result: RowDuplicates = new Map();
  const keys = IN_FILE_KEYS[domainId] ?? [];

  for (const key of keys) {
    const buckets = new Map<string, number[]>();
    for (const row of rows) {
      const raw = textOf(row, key.field);
      if (raw === "") continue;
      const bucketKey = key.fold ? nameKey(raw) : raw;
      buckets.set(bucketKey, [...(buckets.get(bucketKey) ?? []), row.rowNumber]);
    }
    for (const [value, rowNumbers] of buckets) {
      if (rowNumbers.length < 2) continue;
      for (const rowNumber of rowNumbers) {
        const evidence: DuplicateEvidence = {
          scope: "IN_FILE",
          field: key.field,
          strength: key.strength,
          value,
          otherRows: rowNumbers.filter((n) => n !== rowNumber),
        };
        result.set(rowNumber, [...(result.get(rowNumber) ?? []), evidence]);
      }
    }
  }

  return result;
}

/** Unique, non-empty values of one field across the rows. */
function collect(rows: readonly ValidatedRow[], field: string): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const value = textOf(row, field);
    if (value !== "") set.add(value);
  }
  return [...set];
}

function push(map: RowDuplicates, rowNumber: number, e: DuplicateEvidence) {
  map.set(rowNumber, [...(map.get(rowNumber) ?? []), e]);
}

/**
 * Look for existing records that match. READ-ONLY, inside the tenant substrate:
 * server-derived businessId -> ALS -> tenant transaction -> RLS.
 *
 * Lookups are batched with `IN (...)` over the distinct values, so a 10,000-row
 * file costs a handful of queries rather than 10,000.
 */
export async function detectExistingMatches(
  businessId: number,
  domainId: DataTransferDomainId,
  rows: readonly ValidatedRow[]
): Promise<RowDuplicates> {
  const result: RowDuplicates = new Map();
  if (rows.length === 0) return result;

  await runWithTenantContext({ businessId }, () =>
    withTenantTransaction(async (tx) => {
      if (domainId === "customers") {
        const phones = collect(rows, "טלפון");
        if (phones.length === 0) return;
        const existing = await tx.customer.findMany({
          where: { businessId, phone: { in: phones } },
          select: { name: true, phone: true },
        });
        const byPhone = new Map(existing.map((c) => [c.phone ?? "", c.name]));
        for (const row of rows) {
          const phone = textOf(row, "טלפון");
          const label = phone === "" ? undefined : byPhone.get(phone);
          if (!label) continue;
          push(result, row.rowNumber, {
            scope: "EXISTING",
            field: "טלפון",
            strength: "STRONG",
            value: phone,
            existingLabel: label,
            existingNote: "לקוח עם אותו טלפון כבר קיים",
          });
        }
        return;
      }

      if (domainId === "leads") {
        const phones = collect(rows, "טלפון");
        if (phones.length === 0) return;
        const existing = await tx.lead.findMany({
          where: { businessId, phone: { in: phones } },
          select: { customerName: true, phone: true, status: true },
        });
        const CLOSED = new Set(["WON", "LOST", "DROPPED"]);
        // An OPEN lead blocks; a CLOSED one is context. Keep the open match if
        // both exist for a phone.
        const byPhone = new Map<string, { name: string | null; open: boolean }>();
        for (const lead of existing) {
          const key = lead.phone ?? "";
          const open = !CLOSED.has(lead.status);
          const prior = byPhone.get(key);
          if (!prior || (open && !prior.open)) {
            byPhone.set(key, { name: lead.customerName, open });
          }
        }
        for (const row of rows) {
          const phone = textOf(row, "טלפון");
          const hit = phone === "" ? undefined : byPhone.get(phone);
          if (!hit) continue;
          push(result, row.rowNumber, {
            scope: "EXISTING",
            field: "טלפון",
            strength: hit.open ? "STRONG" : "WEAK",
            value: phone,
            existingLabel: hit.name ?? "(ללא שם)",
            existingNote: hit.open
              ? "כבר קיים ליד פתוח עם אותו טלפון"
              : "קיים ליד סגור עם אותו טלפון (אינו חוסם)",
          });
        }
        return;
      }

      if (domainId === "suppliers") {
        const taxIds = collect(rows, "מספר עוסק / ח.פ.");
        const names = collect(rows, "שם ספק");
        const existing = await tx.supplier.findMany({
          where: {
            businessId,
            OR: [
              ...(taxIds.length ? [{ taxId: { in: taxIds } }] : []),
              ...(names.length ? [{ name: { in: names } }] : []),
            ],
          },
          select: { name: true, taxId: true },
        });
        if (existing.length === 0) return;
        const byTaxId = new Map(
          existing.filter((s) => s.taxId).map((s) => [s.taxId as string, s.name])
        );
        const byName = new Map(existing.map((s) => [nameKey(s.name), s.name]));
        for (const row of rows) {
          const taxId = textOf(row, "מספר עוסק / ח.פ.");
          const label = taxId === "" ? undefined : byTaxId.get(taxId);
          if (label) {
            push(result, row.rowNumber, {
              scope: "EXISTING",
              field: "מספר עוסק / ח.פ.",
              strength: "WEAK",
              value: taxId,
              existingLabel: label,
              existingNote: "ספק עם אותו מספר עוסק כבר קיים",
            });
            continue;
          }
          const key = nameKey(textOf(row, "שם ספק"));
          const nameHit = key === "" ? undefined : byName.get(key);
          if (nameHit) {
            push(result, row.rowNumber, {
              scope: "EXISTING",
              field: "שם ספק",
              strength: "WEAK",
              value: nameHit,
              existingLabel: nameHit,
              existingNote: "ספק בשם דומה כבר קיים",
            });
          }
        }
        return;
      }

      // inventory
      const skus = collect(rows, "מק״ט");
      const barcodes = collect(rows, "ברקוד");
      if (skus.length === 0 && barcodes.length === 0) return;
      const existing = await tx.inventoryItem.findMany({
        where: {
          businessId,
          OR: [
            ...(skus.length ? [{ sku: { in: skus } }] : []),
            ...(barcodes.length ? [{ barcode: { in: barcodes } }] : []),
          ],
        },
        select: { name: true, sku: true, barcode: true },
      });
      if (existing.length === 0) return;
      const bySku = new Map(
        existing.filter((i) => i.sku).map((i) => [i.sku as string, i.name])
      );
      const byBarcode = new Map(
        existing.filter((i) => i.barcode).map((i) => [i.barcode as string, i.name])
      );
      for (const row of rows) {
        const sku = textOf(row, "מק״ט");
        const skuHit = sku === "" ? undefined : bySku.get(sku);
        if (skuHit) {
          push(result, row.rowNumber, {
            scope: "EXISTING",
            field: "מק״ט",
            strength: "WEAK",
            value: sku,
            existingLabel: skuHit,
            existingNote: "פריט עם אותו מק״ט כבר קיים",
          });
          continue;
        }
        const barcode = textOf(row, "ברקוד");
        const barcodeHit = barcode === "" ? undefined : byBarcode.get(barcode);
        if (barcodeHit) {
          push(result, row.rowNumber, {
            scope: "EXISTING",
            field: "ברקוד",
            strength: "WEAK",
            value: barcode,
            existingLabel: barcodeHit,
            existingNote: "פריט עם אותו ברקוד כבר קיים",
          });
        }
      }
    })
  );

  return result;
}

/** Merge both scopes into one per-row list. */
export function mergeDuplicates(
  ...sources: RowDuplicates[]
): RowDuplicates {
  const merged: RowDuplicates = new Map();
  for (const source of sources) {
    for (const [rowNumber, list] of source) {
      merged.set(rowNumber, [...(merged.get(rowNumber) ?? []), ...list]);
    }
  }
  return merged;
}
