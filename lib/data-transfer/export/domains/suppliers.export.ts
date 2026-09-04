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

/**
 * IMPORT CONTRACT — evidence.
 *
 * `supplierService.createSupplier` accepts `name`, `phone`, `email`, `notes`,
 * `defaultLeadTimeDays` PLUS the whole `SupplierProfileInput` (legalName,
 * taxId, taxIdType, category, website, contact*, address*, paymentTermsDays,
 * preferredPaymentMethod). `normalizeName` throws
 * InventoryValidationError("Supplier name is required") on a blank name, so
 * NAME is the one required field and every other accepted field is optional —
 * the service is explicitly built so a supplier stays creatable in seconds.
 *
 * `isActive` and `createdAt` are system-owned and are exportable only.
 *
 * Order below is the SHIPPED export order and must not be rearranged — the
 * cell projection in readPage is positional.
 */
const COLUMNS = [
  {"header":"שם ספק","type":"text","width":28,"exportable":true,"importable":true,"required":true,"help":"שם הספק כפי שתזהו אותו. שדה חובה.","example":"תנובה בע״מ"},
  {"header":"שם משפטי","type":"text","width":28,"exportable":true,"importable":true,"help":"השם הרשום, אם שונה משם התצוגה.","example":"תנובה מרכז שיתופי בע״מ"},
  {"header":"סוג עוסק","type":"text","width":16,"exportable":true,"importable":true,"allowedValues":["עוסק מורשה","עוסק פטור","חברה בע\"מ","ת.ז.","אחר"],"help":"אחד מהערכים המותרים בלבד.","example":"חברה בע\"מ"},
  {"header":"מספר עוסק / ח.פ.","type":"text","width":20,"exportable":true,"importable":true,"help":"מספר הזיהוי העסקי, ספרות בלבד.","example":"512345678"},
  {"header":"תחום","type":"text","width":18,"exportable":true,"importable":true,"help":"תחום הספק, טקסט חופשי.","example":"מוצרי חלב"},
  {"header":"טלפון","type":"text","width":18,"exportable":true,"importable":true,"help":"מספר ישראלי בכל צורה מקובלת.","example":"03-123-4567"},
  {"header":"אימייל","type":"text","width":28,"exportable":true,"importable":true,"help":"כתובת דוא״ל אחת.","example":"orders@example.co.il"},
  {"header":"אתר","type":"text","width":26,"exportable":true,"importable":true,"help":"כתובת אתר.","example":"https://example.co.il"},
  {"header":"איש קשר","type":"text","width":20,"exportable":true,"importable":true,"help":"שם איש הקשר אצל הספק.","example":"רונית לוי"},
  {"header":"תפקיד איש קשר","type":"text","width":18,"exportable":true,"importable":true,"help":"התפקיד שלו.","example":"מנהלת מכירות"},
  {"header":"טלפון איש קשר","type":"text","width":18,"exportable":true,"importable":true,"help":"טלפון ישיר.","example":"054-111-2222"},
  {"header":"אימייל איש קשר","type":"text","width":28,"exportable":true,"importable":true,"help":"דוא״ל ישיר.","example":"ronit@example.co.il"},
  {"header":"רחוב","type":"text","width":24,"exportable":true,"importable":true,"help":"רחוב ומספר.","example":"הרצל 10"},
  {"header":"עיר","type":"text","width":16,"exportable":true,"importable":true,"help":"עיר או יישוב.","example":"רחובות"},
  {"header":"מיקוד","type":"text","width":12,"exportable":true,"importable":true,"help":"מיקוד.","example":"7630000"},
  {"header":"ימי תשלום","type":"integer","width":12,"exportable":true,"importable":true,"help":"תנאי תשלום במספר ימים. 0 = מיידי, 30 = שוטף+30.","example":"30"},
  {"header":"אמצעי תשלום מועדף","type":"text","width":20,"exportable":true,"importable":true,"allowedValues":["העברה בנקאית","כרטיס אשראי","צ׳ק","מזומן","ביט","פייבוקס","אחר"],"help":"אחד מהערכים המותרים בלבד.","example":"העברה בנקאית"},
  {"header":"ימי אספקה","type":"integer","width":12,"exportable":true,"importable":true,"help":"כמה ימים בדרך כלל לוקח לספק לספק.","example":"3"},
  {"header":"הערות","type":"text","width":40,"exportable":true,"importable":true,"help":"טקסט חופשי.","example":"מינימום הזמנה 500 ₪"},
  {"header":"פעיל","type":"text","width":10,"exportable":true,"importable":false},
  {"header":"נוצר בתאריך","type":"date","width":14,"exportable":true,"importable":false},
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
