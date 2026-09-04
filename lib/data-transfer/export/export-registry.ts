/**
 * The exportable domains, in canonical presentation order.
 *
 * I-3 ships the four TABULAR domains. Documents (`files`) and issued documents
 * (`fiscal`) are in the ratified six-domain scope but are NOT here: they do not
 * move as spreadsheet rows, and their export is a later increment. That is a
 * fact about the artifacts, not an omission — which is why the verifier asserts
 * this registry equals exactly the `tabular` subset of the domain registry,
 * rather than just counting four.
 */

import {
  DATA_TRANSFER_DOMAINS,
  type DataTransferDomainId,
} from "@/lib/data-transfer/domains";
import type { ExportDomainDescriptor } from "@/lib/data-transfer/export/export-domain.types";
import { customersExportDescriptor } from "./domains/customers.export";
import { suppliersExportDescriptor } from "./domains/suppliers.export";
import { leadsExportDescriptor } from "./domains/leads.export";
import { inventoryExportDescriptor } from "./domains/inventory.export";

export const EXPORT_DESCRIPTORS: readonly ExportDomainDescriptor[] = [
  customersExportDescriptor,
  suppliersExportDescriptor,
  leadsExportDescriptor,
  inventoryExportDescriptor,
] as const;

export const EXPORTABLE_DOMAIN_IDS: readonly DataTransferDomainId[] =
  EXPORT_DESCRIPTORS.map((d) => d.id);

export function isExportableDomainId(
  value: unknown
): value is DataTransferDomainId {
  return (
    typeof value === "string" &&
    (EXPORTABLE_DOMAIN_IDS as readonly string[]).includes(value)
  );
}

export function getExportDescriptor(
  id: DataTransferDomainId
): ExportDomainDescriptor {
  const found = EXPORT_DESCRIPTORS.find((d) => d.id === id);
  if (!found) throw new Error(`Domain is not exportable: ${id}`);
  return found;
}

/** Owner-facing title for a domain, from the single six-domain registry. */
export function exportDomainTitle(id: DataTransferDomainId): string {
  return DATA_TRANSFER_DOMAINS.find((d) => d.id === id)?.title ?? id;
}
