/**
 * Customers export descriptor.
 *
 * # What is exported, and what is not
 *
 * Everything the owner typed about a customer, plus when the record started.
 * Deliberately NOT exported:
 *
 *  - `id`, `businessId` — internal keys. `businessId` is the tenant boundary
 *    and must never appear in a file the owner can hand to anyone.
 *  - `updatedAt` — a technical timestamp. It records when a row was touched,
 *    which answers a developer's question, not a business one.
 *
 * `phone` is stored canonically (`972501234567`) because that canonical form is
 * what the `(businessId, phone)` unique index is built on. The export shows the
 * READABLE form (`050-123-4567`) through the existing display formatter — the
 * same value the owner sees everywhere else in Dubiz. The stored value is
 * untouched; this is presentation only.
 */

import { CUSTOMER_TAX_ID_TYPE_LABELS } from "@/lib/billing/customer-tax-identity";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import type { TenantTx } from "@/lib/tenant/transaction";
import type {
  ExportDomainDescriptor,
  ExportPage,
} from "@/lib/data-transfer/export/export-domain.types";
import { date, label, text, yesNo } from "@/lib/data-transfer/export/export-values";

const COLUMNS = [
  { header: "שם", type: "text", width: 28 },
  { header: "טלפון", type: "text", width: 18 },
  { header: "אימייל", type: "text", width: 28 },
  { header: "עיר", type: "text", width: 16 },
  { header: "שם משפטי", type: "text", width: 28 },
  { header: "סוג עוסק", type: "text", width: 16 },
  { header: "מספר עוסק / ח.פ.", type: "text", width: 20 },
  { header: "הערות", type: "text", width: 40 },
  { header: "פעיל", type: "text", width: 10 },
  { header: "נוצר בתאריך", type: "date", width: 14 },
] as const;

export const customersExportDescriptor: ExportDomainDescriptor = {
  id: "customers",
  sheetName: "לקוחות",
  fileSlug: "customers",
  columns: COLUMNS,

  async readPage(
    tx: TenantTx,
    businessId: number,
    afterId: number,
    take: number
  ): Promise<ExportPage> {
    const rows = await tx.customer.findMany({
      where: { businessId, id: { gt: afterId } },
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        city: true,
        legalName: true,
        taxId: true,
        taxIdType: true,
        notes: true,
        isActive: true,
        createdAt: true,
      },
    });

    return {
      cells: rows.map((r) => [
        text(r.name),
        text(formatPhoneForDisplay(r.phone)),
        text(r.email),
        text(r.city),
        text(r.legalName),
        label(r.taxIdType, CUSTOMER_TAX_ID_TYPE_LABELS),
        text(r.taxId),
        text(r.notes),
        yesNo(r.isActive),
        date(r.createdAt),
      ]),
      lastId: rows.length > 0 ? rows[rows.length - 1].id : null,
    };
  },
};
