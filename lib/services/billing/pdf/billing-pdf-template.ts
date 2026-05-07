// Billing PDF template — pure, deterministic.
//
// Owns:
//   • The billing-v1 visual layout (Hebrew RTL tax invoice).
//   • The structural type of the v1 issued snapshot consumed by the renderer.
//   • The current template version constant.
//
// Pure rules (do NOT break):
//   • No imports from Prisma, fs, http, or pdfmake runtime modules.
//   • No side effects at module scope.
//   • Inputs in -> docDefinition out. Same input -> same output.

export const BILLING_PDF_TEMPLATE_VERSION = "billing-v1";
export const BILLING_PDF_SCHEMA_VERSION_SUPPORTED = 1;

const HEBREW_FONT_NAME = "NotoSansHebrew";
const ILS_SYMBOL = "\u20AA"; // ₪

const DOCUMENT_TYPE_LABELS_HE: Record<string, string> = {
  TAX_INVOICE: "חשבונית מס",
};

// Structural type that mirrors the v1 issuedSnapshot produced by
// lib/services/billing/billing-issue.service.ts. Defined locally on purpose
// so the renderer/template never imports from the issue service (avoids
// circular coupling between issue-time logic and PDF rendering).

export type BillingIssuedSnapshotV1Issuer = {
  id: number;
  name: string;
  legalName: string | null;
  taxId: string | null;
  vatRegistration: string | null;
  address: unknown | null;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
  bankDetails: unknown | null;
};

export type BillingIssuedSnapshotV1Customer = {
  id: number | null;
  name: string;
  legalName: string | null;
  taxId: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: unknown | null;
};

export type BillingIssuedSnapshotV1Line = {
  lineIndex: number;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRatePercent: string;
  lineSubtotal: string;
  vatAmount: string;
  lineTotal: string;
};

export type BillingIssuedSnapshotV1 = {
  schemaVersion: number;
  issuedAt: string;
  document: {
    id: number;
    type: string;
    status: string;
    number: number;
    numberFormatted: string;
    currency: string;
    allocationNumber: string | null;
    referenceDocumentId: number | null;
  };
  issuer: BillingIssuedSnapshotV1Issuer;
  customer: BillingIssuedSnapshotV1Customer;
  lines: BillingIssuedSnapshotV1Line[];
  totals: {
    subtotal: string;
    vat: string;
    total: string;
  };
  tax: {
    currency: string;
    defaultVatRate: string | null;
    vatMode: string;
  };
  metadata: {
    locale: string;
    timezone: string;
    actorUserId: number;
    source: string;
  };
  extensions: Record<string, unknown>;
};

// pdfmake's TDocumentDefinitions has many overloads; we treat the doc def
// as `unknown` at the public boundary to keep the template free of pdfmake
// type imports. The renderer casts it back to pdfmake's expected shape.

export type BillingPdfDocDefinition = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function parseNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(amount: string, currency: string): string {
  const n = parseNumber(amount);
  const formatted = n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (currency === "ILS") return `${formatted} ${ILS_SYMBOL}`;
  return `${formatted} ${currency}`;
}

function formatQuantity(qty: string): string {
  const n = parseNumber(qty);
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatIssuedAt(isoString: string, timeZone: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("he-IL", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    // Fallback if ICU/timezone is unavailable in the runtime.
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy}`;
  }
}

// Returns a "17%" string if every line shares the same vat rate, otherwise null.
// Used so the totals row can show "מע״מ (17%):" when meaningful, or just
// "מע״מ:" when lines have heterogeneous rates.
function deriveCommonVatRateLabel(
  lines: BillingIssuedSnapshotV1Line[]
): string | null {
  if (lines.length === 0) return null;
  const first = lines[0].vatRatePercent;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].vatRatePercent !== first) return null;
  }
  const rate = parseNumber(first);
  if (!Number.isFinite(rate)) return null;
  // Drop trailing zeros: "17.00" -> "17", "8.50" -> "8.5".
  const trimmed = rate
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return `${trimmed}%`;
}

function getDocumentTypeLabel(type: string): string {
  return DOCUMENT_TYPE_LABELS_HE[type] ?? type;
}

// ---------------------------------------------------------------------------
// Layout helpers (pdfmake nodes)
// ---------------------------------------------------------------------------

type AnyNode = Record<string, unknown>;

function buildIssuerStack(
  issuer: BillingIssuedSnapshotV1Issuer
): AnyNode {
  const stack: AnyNode[] = [
    {
      text: "פרטי המוכר",
      bold: true,
      fontSize: 11,
      margin: [0, 0, 0, 4],
      color: "#1f2937",
      alignment: "right",
    },
    { text: issuer.name, alignment: "right", bold: true },
  ];
  if (issuer.taxId) {
    stack.push({ text: `ע.מ./ח.פ.: ${issuer.taxId}`, alignment: "right" });
  }
  if (issuer.phone) {
    stack.push({ text: `טלפון: ${issuer.phone}`, alignment: "right" });
  }
  if (issuer.email) {
    stack.push({ text: issuer.email, alignment: "right", fontSize: 9 });
  }
  return { width: "*", stack };
}

function buildCustomerStack(
  customer: BillingIssuedSnapshotV1Customer
): AnyNode {
  const stack: AnyNode[] = [
    {
      text: "פרטי הלקוח",
      bold: true,
      fontSize: 11,
      margin: [0, 0, 0, 4],
      color: "#1f2937",
      alignment: "left",
    },
    { text: customer.name, alignment: "left" },
  ];
  if (customer.taxId) {
    stack.push({ text: `ע.מ./ת.ז.: ${customer.taxId}`, alignment: "left" });
  }
  if (customer.city) {
    stack.push({ text: customer.city, alignment: "left" });
  }
  if (customer.phone) {
    stack.push({ text: `טלפון: ${customer.phone}`, alignment: "left" });
  }
  if (customer.email) {
    stack.push({ text: customer.email, alignment: "left", fontSize: 9 });
  }
  return { width: "*", stack };
}

function buildLineRow(
  line: BillingIssuedSnapshotV1Line,
  currency: string
): AnyNode[] {
  // Visual order is right-to-left (RTL): index | description | qty | unit | vat | total.
  // pdfmake renders left-to-right, so we lay out the columns in their
  // visual right-to-left order which produces the correct Hebrew layout.
  return [
    { text: formatMoney(line.lineTotal, currency), alignment: "left" },
    { text: formatMoney(line.vatAmount, currency), alignment: "left" },
    { text: formatMoney(line.unitPrice, currency), alignment: "left" },
    { text: formatQuantity(line.quantity), alignment: "center" },
    { text: line.description, alignment: "right" },
    {
      text: String(line.lineIndex),
      alignment: "center",
      color: "#6b7280",
    },
  ];
}

function buildLinesTable(
  lines: BillingIssuedSnapshotV1Line[],
  currency: string
): AnyNode {
  const headerCellStyle = {
    bold: true,
    fillColor: "#f3f4f6",
  };
  const tableHeader: AnyNode[] = [
    { text: 'סה"כ', alignment: "center", ...headerCellStyle },
    { text: 'מע"מ', alignment: "center", ...headerCellStyle },
    { text: "מחיר יחידה", alignment: "center", ...headerCellStyle },
    { text: "כמות", alignment: "center", ...headerCellStyle },
    { text: "תיאור", alignment: "right", ...headerCellStyle },
    { text: "מס'", alignment: "center", ...headerCellStyle },
  ];
  const tableBody: AnyNode[][] = [tableHeader];
  for (const line of lines) {
    tableBody.push(buildLineRow(line, currency));
  }

  return {
    table: {
      headerRows: 1,
      widths: ["auto", "auto", "auto", "auto", "*", 24],
      body: tableBody,
    },
    layout: {
      fillColor: (rowIndex: number) =>
        rowIndex === 0 ? "#f3f4f6" : rowIndex % 2 === 0 ? "#fafafa" : null,
      hLineColor: () => "#d1d5db",
      vLineColor: () => "#d1d5db",
    },
    margin: [0, 0, 0, 14],
  };
}

function buildTotalsBlock(
  totals: BillingIssuedSnapshotV1["totals"],
  vatLabelSuffix: string | null,
  currency: string
): AnyNode {
  const vatLabel = vatLabelSuffix
    ? `מע"מ (${vatLabelSuffix}):`
    : 'מע"מ:';
  const totalsBody: AnyNode[][] = [
    [
      { text: formatMoney(totals.subtotal, currency), alignment: "left" },
      { text: 'סה"כ לפני מע"מ:', alignment: "right" },
    ],
    [
      { text: formatMoney(totals.vat, currency), alignment: "left" },
      { text: vatLabel, alignment: "right" },
    ],
    [
      {
        text: formatMoney(totals.total, currency),
        alignment: "left",
        bold: true,
        fontSize: 13,
        fillColor: "#eef2ff",
      },
      {
        text: 'סה"כ לתשלום:',
        alignment: "right",
        bold: true,
        fontSize: 13,
        fillColor: "#eef2ff",
      },
    ],
  ];
  return {
    columns: [
      { text: "", width: "*" },
      {
        width: "auto",
        table: { widths: ["auto", "auto"], body: totalsBody },
        layout: "noBorders",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Public: build pdfmake docDefinition from a v1 snapshot
// ---------------------------------------------------------------------------

export function buildDocDefinition(
  snapshot: BillingIssuedSnapshotV1
): BillingPdfDocDefinition {
  const { document, issuer, customer, lines, totals, metadata } = snapshot;
  const currency = document.currency || snapshot.tax.currency || "ILS";
  const documentTypeLabel = getDocumentTypeLabel(document.type);
  const issuedAtFormatted = formatIssuedAt(
    snapshot.issuedAt,
    metadata.timezone || "Asia/Jerusalem"
  );
  const vatLabelSuffix = deriveCommonVatRateLabel(lines);

  return {
    pageSize: "A4",
    pageMargins: [40, 90, 40, 60],
    defaultStyle: {
      font: HEBREW_FONT_NAME,
      fontSize: 10,
      alignment: "right",
    },
    info: {
      title: `${documentTypeLabel} ${document.numberFormatted}`,
      author: issuer.name,
      subject: documentTypeLabel,
      creator: `billing-platform/${BILLING_PDF_TEMPLATE_VERSION}`,
      producer: `billing-platform/${BILLING_PDF_TEMPLATE_VERSION}`,
    },
    header: () => ({
      columns: [
        {
          text: issuer.name,
          alignment: "left",
          margin: [40, 30, 0, 0],
          color: "#444",
          fontSize: 9,
        },
        {
          text: documentTypeLabel,
          alignment: "right",
          margin: [0, 25, 40, 0],
          fontSize: 18,
          bold: true,
        },
      ],
    }),
    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        {
          text: document.numberFormatted,
          alignment: "left",
          margin: [40, 20, 0, 0],
          fontSize: 8,
          color: "#777",
        },
        {
          text: `עמוד ${currentPage} מתוך ${pageCount}`,
          alignment: "right",
          margin: [0, 20, 40, 0],
          fontSize: 9,
        },
      ],
    }),
    content: [
      {
        columns: [
          {
            text: `תאריך הוצאה: ${issuedAtFormatted}`,
            alignment: "left",
            fontSize: 10,
          },
          {
            text: `מס' מסמך: ${document.numberFormatted}`,
            alignment: "right",
            fontSize: 10,
            bold: true,
          },
        ],
        margin: [0, 0, 0, 14],
      },
      {
        columns: [buildCustomerStack(customer), buildIssuerStack(issuer)],
        columnGap: 24,
        margin: [0, 0, 0, 18],
      },
      buildLinesTable(lines, currency),
      buildTotalsBlock(totals, vatLabelSuffix, currency),
      {
        text: "מסמך זה הופק אלקטרונית. נא לשמור לצרכי הנהלת חשבונות ודיווח.",
        fontSize: 8,
        color: "#555",
        alignment: "right",
        margin: [0, 26, 0, 0],
      },
      {
        text: `Template: ${BILLING_PDF_TEMPLATE_VERSION}`,
        fontSize: 7,
        color: "#9ca3af",
        alignment: "left",
        margin: [0, 6, 0, 0],
      },
    ],
  };
}

// Runtime guard used by the orchestrator to validate the JSON snapshot
// before handing it to the renderer. Defensive, not a full schema validator.
export function assertSnapshotV1(
  raw: unknown
): asserts raw is BillingIssuedSnapshotV1 {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid issued snapshot: not an object");
  }
  const s = raw as Partial<BillingIssuedSnapshotV1>;
  if (s.schemaVersion !== BILLING_PDF_SCHEMA_VERSION_SUPPORTED) {
    throw new Error(
      `Unsupported issuedSnapshot.schemaVersion (expected ${BILLING_PDF_SCHEMA_VERSION_SUPPORTED})`
    );
  }
  if (!s.document || typeof s.document.numberFormatted !== "string") {
    throw new Error("Invalid issued snapshot: document.numberFormatted missing");
  }
  if (!s.issuer || typeof s.issuer.name !== "string") {
    throw new Error("Invalid issued snapshot: issuer.name missing");
  }
  if (!s.customer || typeof s.customer.name !== "string") {
    throw new Error("Invalid issued snapshot: customer.name missing");
  }
  if (!Array.isArray(s.lines) || s.lines.length === 0) {
    throw new Error("Invalid issued snapshot: lines must be a non-empty array");
  }
  if (
    !s.totals ||
    typeof s.totals.subtotal !== "string" ||
    typeof s.totals.vat !== "string" ||
    typeof s.totals.total !== "string"
  ) {
    throw new Error("Invalid issued snapshot: totals incomplete");
  }
}
