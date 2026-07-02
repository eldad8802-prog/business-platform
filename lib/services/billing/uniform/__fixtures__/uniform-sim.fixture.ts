/**
 * WP4 — local simulator test fixture (NO DB / Prisma / env / network).
 *
 * A representative, arithmetically-consistent `UniformExportAssemblerInput`
 * covering the in-scope document types (חשבונית מס, קבלה, חשבונית מס/קבלה,
 * חשבונית מס זיכוי) with lines, payments (cash/check), and a customer with a
 * valid tax id. All עוסק/tax-id numbers carry a VALID Israeli check digit
 * (simulator risk #1 mitigation).
 *
 * This is TEST data for the simulator package only — not production data.
 */

import type {
  UniformDocumentInput,
  UniformExportAssemblerInput,
} from "@/lib/services/billing/uniform/uniform-export.types";

/** Israeli 9-digit check digit (same scheme as ת.ז. / עוסק מורשה). */
export function israeliCheckDigit(first8: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let p = Number(first8[i]) * (i % 2 === 0 ? 1 : 2);
    if (p > 9) p -= 9;
    sum += p;
  }
  return String((10 - (sum % 10)) % 10);
}
/** Build a check-digit-valid 9-digit id from an 8-digit prefix. */
export function validId9(first8: string): string {
  return first8 + israeliCheckDigit(first8);
}

const BUSINESS_VAT = validId9("51500012"); // 515000123 (valid)
const CUST_A = validId9("51400000"); // customer with valid tax id
const CUST_B = validId9("51300000");

function customer(id: number, name: string, taxId: string, city: string | null) {
  return { id, name, legalName: null, taxId, taxIdType: "LTD_COMPANY", city, phone: null, email: null };
}

function doc(over: Partial<UniformDocumentInput>): UniformDocumentInput {
  return {
    id: 0,
    documentType: "TAX_INVOICE",
    status: "ISSUED",
    documentNumber: 0,
    documentNumberFormatted: "00000000",
    issuedAt: "2026-06-15T10:00:00.000Z",
    lockedAt: "2026-06-15T10:00:00.000Z",
    currency: "ILS",
    subtotalAmount: "0.00",
    vatAmount: "0.00",
    totalAmount: "0.00",
    allocationNumber: null,
    allocationApprovedAt: null,
    isEmergencyAllocation: false,
    legalSnapshotHash: "hash",
    referenceDocumentId: null,
    customer: customer(1, "לקוח בדיקה", CUST_A, "תל אביב"),
    customerNameSnapshot: "לקוח בדיקה",
    lines: [],
    payments: [],
    issuedSnapshot: null,
    ...over,
  };
}

/** Deterministic build options for the test package (real runs use fresh values). */
export const SIM_BUILD_OPTS = {
  primaryId: "100000000000001",
  generatedAt: "2026-07-01T09:00:00.000Z",
} as const;

/**
 * Filler documents to satisfy the simulator's certification minimum
 * (">= 2000 records ... examples from every document type"). Simple, balanced
 * TAX_INVOICE docs (1 line each): C100.1219 == D110.1267 so each reconciles.
 * The 4 representative docs above already cover every in-scope type (305/320/
 * 400/330). Deterministic — no Date/random. Each filler = 1 C100 + 1 D110.
 */
function buildFillerDocs(count: number): UniformDocumentInput[] {
  const docs: UniformDocumentInput[] = [];
  for (let i = 0; i < count; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    const num = 2000 + i;
    docs.push(
      doc({
        id: 1000 + i,
        documentNumber: num,
        documentNumberFormatted: String(num).padStart(8, "0"),
        issuedAt: `2026-06-${day}T10:00:00.000Z`,
        lockedAt: `2026-06-${day}T10:00:00.000Z`,
        subtotalAmount: "100.00",
        vatAmount: "17.00",
        totalAmount: "117.00",
        lines: [
          { lineIndex: 0, description: "שירות", quantity: "1.0000", unitPrice: "100.00", vatRatePercent: "17.00", lineSubtotal: "100.00", vatAmount: "17.00", lineTotal: "117.00" },
        ],
      })
    );
  }
  return docs;
}

/** 1000 fillers → 2000 records (1 C100 + 1 D110 each); +9 representative +2 (A100/Z900). */
const FILLER_COUNT = 1000;

export const SIM_FIXTURE_INPUT: UniformExportAssemblerInput = {
  businessId: 1,
  period: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T23:59:59.999Z" },
  business: {
    businessId: 1,
    name: "דוביז",
    billingLegalName: "דוביז בע\"מ",
    billingBusinessKind: "LTD_COMPANY",
    billingTaxId: BUSINESS_VAT,
    billingVatNumber: BUSINESS_VAT,
    billingAddress: "רחוב הטכנולוגיה 5, תל אביב",
    billingPhone: null,
    billingEmail: null,
  },
  documents: [
    // חשבונית מס (305): 2×100 + 17% = 234.00
    doc({
      id: 1,
      documentNumber: 1001,
      documentNumberFormatted: "00001001",
      subtotalAmount: "200.00",
      vatAmount: "34.00",
      totalAmount: "234.00",
      lines: [
        { lineIndex: 0, description: "שירות ייעוץ", quantity: "2.0000", unitPrice: "100.00", vatRatePercent: "17.00", lineSubtotal: "200.00", vatAmount: "34.00", lineTotal: "234.00" },
      ],
    }),
    // קבלה (400) על 234.00 — מזומן
    doc({
      id: 2,
      documentType: "RECEIPT",
      documentNumber: 5001,
      documentNumberFormatted: "00005001",
      issuedAt: "2026-06-16T11:00:00.000Z",
      subtotalAmount: "234.00",
      vatAmount: "0.00",
      totalAmount: "234.00",
      payments: [
        { lineIndex: 0, method: "CASH", amount: "234.00", currency: "ILS", paymentDate: "2026-06-16T11:00:00.000Z", bankName: null, bankBranch: null, bankAccountNumber: null, checkNumber: null, checkDueDate: null, cardBrand: null, cardLast4: null, reference: null },
      ],
    }),
    // חשבונית מס/קבלה (320): 500 + 85 = 585.00 — המחאה
    doc({
      id: 3,
      documentType: "TAX_INVOICE_RECEIPT",
      documentNumber: 1002,
      documentNumberFormatted: "00001002",
      issuedAt: "2026-06-20T14:00:00.000Z",
      subtotalAmount: "500.00",
      vatAmount: "85.00",
      totalAmount: "585.00",
      customer: customer(2, "חברת דוגמה", CUST_B, "חיפה"),
      customerNameSnapshot: "חברת דוגמה",
      lines: [
        { lineIndex: 0, description: "אספקת מוצר", quantity: "1.0000", unitPrice: "500.00", vatRatePercent: "17.00", lineSubtotal: "500.00", vatAmount: "85.00", lineTotal: "585.00" },
      ],
      payments: [
        { lineIndex: 0, method: "CHECK", amount: "585.00", currency: "ILS", paymentDate: "2026-06-20T14:00:00.000Z", bankName: "12", bankBranch: "345", bankAccountNumber: "67890", checkNumber: "1111", checkDueDate: "2026-07-20T00:00:00.000Z", cardBrand: null, cardLast4: null, reference: null },
      ],
    }),
    // חשבונית מס זיכוי (330): מזכה חלק מ-1001; קוד 330 מקודד את המשמעות (סכומים חיוביים)
    doc({
      id: 4,
      documentType: "CREDIT_NOTE",
      documentNumber: 9001,
      documentNumberFormatted: "00009001",
      issuedAt: "2026-06-25T09:00:00.000Z",
      subtotalAmount: "100.00",
      vatAmount: "17.00",
      totalAmount: "117.00",
      referenceDocumentId: 1,
      lines: [
        { lineIndex: 0, description: "זיכוי חלקי", quantity: "1.0000", unitPrice: "100.00", vatRatePercent: "17.00", lineSubtotal: "100.00", vatAmount: "17.00", lineTotal: "117.00" },
      ],
    }),
    // Filler invoices to exceed the simulator's 2000-record certification minimum.
    ...buildFillerDocs(FILLER_COUNT),
  ],
};
