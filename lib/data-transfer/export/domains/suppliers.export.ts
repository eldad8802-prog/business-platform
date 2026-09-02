/**
 * Suppliers export descriptor.
 *
 * The supplier profile is almost entirely owner-entered business data, so
 * almost all of it ships. Excluded: `id`, `businessId`, `updatedAt` — internal
 * keys and a technical timestamp.
 *
 * `paymentTermsDays` is exported as a NUMBER of days rather than a phrase like
 * "שוטף+30". The number is what the field actually means, it is what the owner
 * chose, and it is the only form that stays correct for every value (0, 45,
 * 120) without inventing a phrase for each. There is no existing Hebrew
 * payment-terms label helper in the tree to reuse.
 */

import { CUSTOMER_TAX_ID_TYPE_LABELS } from "@/lib/billing/customer-tax-identity";
import { SUPPLIER_PAYMENT_METHOD_LABELS } from "@/lib/services/inventory/supplier-profile";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import type { TenantTx } from "@/lib/tenant/transaction";
import type {
  ExportDomainDescriptor,
  ExportPage,
} from "@/lib/data-transfer/export/export-domain.types";
import {
  date,
  label,
  num,
  text,
  yesNo,
} from "@/lib/data-transfer/export/export-values";

const COLUMNS = [
  { header: "שם ספק", type: "text", width: 28 },
  { header: "שם משפטי", type: "text", width: 28 },
  { header: "סוג עוסק", type: "text", width: 16 },
  { header: "מספר עוסק / ח.פ.", type: "text", width: 20 },
  { header: "תחום", type: "text", width: 18 },
  { header: "טלפון", type: "text", width: 18 },
  { header: "אימייל", type: "text", width: 28 },
  { header: "אתר", type: "text", width: 26 },
  { header: "איש קשר", type: "text", width: 20 },
  { header: "תפקיד איש קשר", type: "text", width: 18 },
  { header: "טלפון איש קשר", type: "text", width: 18 },
  { header: "אימייל איש קשר", type: "text", width: 28 },
  { header: "רחוב", type: "text", width: 24 },
  { header: "עיר", type: "text", width: 16 },
  { header: "מיקוד", type: "text", width: 12 },
  { header: "ימי תשלום", type: "integer", width: 12 },
  { header: "אמצעי תשלום מועדף", type: "text", width: 20 },
  { header: "ימי אספקה", type: "integer", width: 12 },
  { header: "הערות", type: "text", width: 40 },
  { header: "פעיל", type: "text", width: 10 },
  { header: "נוצר בתאריך", type: "date", width: 14 },
] as const;

export const suppliersExportDescriptor: ExportDomainDescriptor = {
  id: "suppliers",
  sheetName: "ספקים",
  fileSlug: "suppliers",
  columns: COLUMNS,

  async readPage(
    tx: TenantTx,
    businessId: number,
    afterId: number,
    take: number
  ): Promise<ExportPage> {
    const rows = await tx.supplier.findMany({
      where: { businessId, id: { gt: afterId } },
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        name: true,
        legalName: true,
        taxIdType: true,
        taxId: true,
        category: true,
        phone: true,
        email: true,
        website: true,
        contactName: true,
        contactRole: true,
        contactPhone: true,
        contactEmail: true,
        addressStreet: true,
        addressCity: true,
        addressPostalCode: true,
        paymentTermsDays: true,
        preferredPaymentMethod: true,
        defaultLeadTimeDays: true,
        notes: true,
        isActive: true,
        createdAt: true,
      },
    });

    return {
      cells: rows.map((r) => [
        text(r.name),
        text(r.legalName),
        label(r.taxIdType, CUSTOMER_TAX_ID_TYPE_LABELS),
        text(r.taxId),
        text(r.category),
        text(formatPhoneForDisplay(r.phone)),
        text(r.email),
        text(r.website),
        text(r.contactName),
        text(r.contactRole),
        text(formatPhoneForDisplay(r.contactPhone)),
        text(r.contactEmail),
        text(r.addressStreet),
        text(r.addressCity),
        text(r.addressPostalCode),
        num(r.paymentTermsDays),
        label(r.preferredPaymentMethod, SUPPLIER_PAYMENT_METHOD_LABELS),
        num(r.defaultLeadTimeDays),
        text(r.notes),
        yesNo(r.isActive),
        date(r.createdAt),
      ]),
      lastId: rows.length > 0 ? rows[rows.length - 1].id : null,
    };
  },
};
