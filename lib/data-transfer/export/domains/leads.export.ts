/**
 * Leads export descriptor.
 *
 * # Six columns are deliberately NOT exported, and this is why
 *
 * `Lead` carries `temperature`, `currentStage`, `valueEstimate`, `quotedPrice`,
 * `finalPrice` and `currency` from an earlier design. NO code path in the Leads
 * domain writes any of them — `lead.service.ts` creates rows with
 * customerName / phone / email / intentSnapshot / sourceChannel / customerId /
 * status / lastActivityAt, and its updates touch status, closedAt, lostReason,
 * nextFollowUpAt, followUpNote and lastActivityAt. The money lives on `Deal`.
 * (The `currentStage` / `temperatureScore` that ARE written belong to
 * `Conversation`, a different table.)
 *
 * Exporting them would hand the owner six permanently empty columns and imply
 * Dubiz holds a pipeline value it does not have. `temperature` is additionally
 * a derived score, which the approved scope excludes outright.
 *
 * Also excluded: `id`, `businessId`, `customerId` (internal keys) and
 * `updatedAt` (technical timestamp).
 *
 * Follow-up state is exported as the STORED timestamp, not as the derived
 * "overdue / due today" label. The label is computed at read time against the
 * current clock, so freezing it into a file would make it wrong tomorrow.
 */

import { LEAD_STATUS_LABELS } from "@/lib/services/crm/lead-core";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import type { TenantTx } from "@/lib/tenant/transaction";
import type {
  ExportDomainDescriptor,
  ExportPage,
} from "@/lib/data-transfer/export/export-domain.types";
import { date, label, text } from "@/lib/data-transfer/export/export-values";

/**
 * `Lead` columns that EXIST in the schema but have no active writer today.
 *
 * The column list below is not a permanent architectural claim — it is "the
 * business fields that are live right now". These six are named here so the
 * exclusion is checkable rather than assumed: `leads-dormant-fields` in
 * `lib/data-transfer/export/export.verify.test.ts` re-derives the evidence on
 * every CI run and FAILS the build if a future product flow starts writing one
 * of them. That failure is the signal to re-evaluate whether the field belongs
 * in the export — not a reason to silence the check.
 *
 * They are intentionally NOT filled from `Deal`, and `Conversation.currentStage`
 * / `Conversation.temperatureScore` are NOT copied onto a lead: those are a
 * different table's facts, and borrowing them would fabricate lead history.
 */
export const LEAD_DORMANT_FIELDS = [
  "temperature",
  "currentStage",
  "valueEstimate",
  "quotedPrice",
  "finalPrice",
  "currency",
] as const;

/**
 * IMPORT CONTRACT — evidence.
 *
 * `leadService.createLead` (lib/services/crm/lead.service.ts) accepts exactly:
 * `name`, `phone`, `email`, `intentSnapshot`, `sourceChannel`.
 * `normalizeLeadName` throws `ValidationError("name is required")` on a blank
 * name, so NAME is the one required field. `sourceChannel` falls back to
 * LEAD_SOURCE_MANUAL when absent, so it is optional.
 *
 * Status and the follow-up fields are LIFECYCLE ACTIONS, not create inputs: a
 * lead is created as NEW and moved by an explicit transition that stamps
 * closedAt / lostReason. Letting a spreadsheet set them would let an import
 * fabricate a history no transition ever happened.
 *
 * Order is the SHIPPED export order and must not be rearranged — the cell
 * projection in readPage is positional.
 */
const COLUMNS = [
  { header: "שם", type: "text", width: 24, exportable: true, importable: true, required: true,
    help: "שם הפונה. שדה חובה.", example: "דנה כהן" },
  { header: "טלפון", type: "text", width: 18, exportable: true, importable: true,
    help: "מספר ישראלי בכל צורה מקובלת. ליד פתוח נוסף עם אותו טלפון ייחסם ככפילות.",
    example: "052-987-6543" },
  { header: "אימייל", type: "text", width: 28, exportable: true, importable: true,
    help: "כתובת דוא״ל אחת.", example: "dana@example.co.il" },
  { header: "סטטוס", type: "text", width: 16, exportable: true, importable: false },
  { header: "מקור הפנייה", type: "text", width: 18, exportable: true, importable: true,
    help: "מאיפה הגיעה הפנייה. אם יישאר ריק — ייקלט כפנייה ידנית.",
    example: "פייסבוק" },
  { header: "מה ביקשו", type: "text", width: 44, exportable: true, importable: true,
    help: "מה הפונה ביקש, במילים שלכם או שלו.",
    example: "בקשה להצעת מחיר לאירוע ביוני" },
  { header: "מעקב הבא", type: "date", width: 14, exportable: true, importable: false },
  { header: "נושא המעקב", type: "text", width: 32, exportable: true, importable: false },
  { header: "פעילות אחרונה", type: "date", width: 14, exportable: true, importable: false },
  { header: "נסגר בתאריך", type: "date", width: 14, exportable: true, importable: false },
  { header: "סיבת אי-סגירה", type: "text", width: 32, exportable: true, importable: false },
  { header: "נוצר בתאריך", type: "date", width: 14, exportable: true, importable: false },
] as const;

export const leadsExportDescriptor: ExportDomainDescriptor = {
  id: "leads",
  sheetName: "לידים",
  fileSlug: "leads",
  columns: COLUMNS,

  async readPage(
    tx: TenantTx,
    businessId: number,
    afterId: number,
    take: number
  ): Promise<ExportPage> {
    const rows = await tx.lead.findMany({
      where: { businessId, id: { gt: afterId } },
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        customerName: true,
        phone: true,
        email: true,
        status: true,
        sourceChannel: true,
        intentSnapshot: true,
        nextFollowUpAt: true,
        followUpNote: true,
        lastActivityAt: true,
        closedAt: true,
        lostReason: true,
        createdAt: true,
      },
    });

    return {
      cells: rows.map((r) => [
        text(r.customerName),
        text(formatPhoneForDisplay(r.phone)),
        text(r.email),
        label(r.status, LEAD_STATUS_LABELS),
        text(r.sourceChannel),
        text(r.intentSnapshot),
        date(r.nextFollowUpAt),
        text(r.followUpNote),
        date(r.lastActivityAt),
        date(r.closedAt),
        text(r.lostReason),
        date(r.createdAt),
      ]),
      lastId: rows.length > 0 ? rows[rows.length - 1].id : null,
    };
  },
};
