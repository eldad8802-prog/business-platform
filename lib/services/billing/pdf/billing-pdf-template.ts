import {
  parseBillingPdfTemplateStyle,
  type BillingPdfTemplateStyle,
} from "@/lib/billing/billing-pdf-template-style";

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
const BRAND_DARK = "#0f172a";
const BRAND_MUTED = "#475569";
const BORDER_SOFT = "#e5e7eb";
const BG_SOFT = "#f8fafc";
const BG_TOTAL = "#eef2ff";
const BG_PARTY_CARD = "#f8fafc";

// ---------------------------------------------------------------------------
// Text helpers (RTL/LTR without BiDi control chars)
// ---------------------------------------------------------------------------
//
// pdfmake/pdfkit + the current Hebrew font can sometimes render Unicode BiDi
// control characters (RLI/LRI/PDI/LRM/RLM) as visible squares. We therefore
// DO NOT use any directionality control chars at all.
//
// Instead, we:
// - Keep labels and values in separate cells/columns (no "label: value" string).
// - Use NBSP in fixed multi-word Hebrew labels to prevent space collapse.
// - Strip any BiDi control chars defensively from any incoming strings.
//
// pdfmake lays out `columns` left → right. For RTL Hebrew rows we put **value
// first** (left/wider) and **label second** (right/auto) so reading RTL meets
// the label on the inner edge first — without reversing string contents.
const NBSP = "\u00A0";

function stripBidiControls(value: string): string {
  return value.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
}

function safeText(value: string): string {
  const raw = typeof value === "string" ? value : String(value);
  return stripBidiControls(raw);
}

function rtlText(value: string, opts?: { nbspWords?: boolean }): string {
  const raw = safeText(value);
  return opts?.nbspWords ? raw.replace(/ +/g, NBSP) : raw;
}

function ltrText(value: string): string {
  // Keep plain string; direction is controlled by layout (alignment/columns).
  return safeText(value);
}

function rtlLabel(value: string): string {
  return rtlText(value, { nbspWords: true });
}

const DOCUMENT_TYPE_LABELS_HE: Record<string, string> = {
  TAX_INVOICE: "חשבונית מס",
  QUOTE: "הצעת מחיר",
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
  /** Present from snapshot migration onward; older snapshots omit → CLASSIC in renderers. */
  pdfTemplateStyle?: BillingPdfTemplateStyle | string;
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

function getBillingFooterLegalNote(snapshot: BillingIssuedSnapshotV1): string {
  if (snapshot.document.type === "QUOTE") {
    const ext = snapshot.extensions;
    let profileNote = "";
    if (
      ext &&
      typeof ext === "object" &&
      "billingFooterNote" in ext &&
      typeof (ext as { billingFooterNote?: unknown }).billingFooterNote ===
        "string"
    ) {
      profileNote = (
        (ext as { billingFooterNote: string }).billingFooterNote ?? ""
      ).trim();
    }
    const base =
      "מסמך זה אינו חשבונית מס. ההצעה ללא התחייבות עד להפקת חשבונית מס רשמית במערכת.";
    return profileNote.length > 0 ? `${base}\n${profileNote}` : base;
  }
  const ext = snapshot.extensions;
  if (
    ext &&
    typeof ext === "object" &&
    "billingFooterNote" in ext &&
    typeof (ext as { billingFooterNote?: unknown }).billingFooterNote ===
      "string"
  ) {
    const n = (
      (ext as { billingFooterNote: string }).billingFooterNote ?? ""
    ).trim();
    if (n.length > 0) return n;
  }
  return "מסמך זה הופק אלקטרונית. נא לשמור לצרכי הנהלת חשבונות ודיווח.";
}

function buildPaymentDetailsBlock(paymentNote: string): AnyNode {
  const t = paymentNote.trim();
  return {
    margin: [0, 18, 0, 0],
    stack: [
      {
        text: rtlLabel("פרטי תשלום"),
        fontSize: 12,
        bold: true,
        color: BRAND_DARK,
        alignment: "right",
        margin: [0, 0, 0, 8],
      },
      {
        text: rtlText(t),
        fontSize: 10,
        color: BRAND_MUTED,
        alignment: "right",
        lineHeight: 1.35,
      },
    ],
  };
}

function isDataImageUrl(value: string | null): boolean {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  // pdfmake supports `image` as a data URL / base64 string. We intentionally
  // do NOT fetch remote URLs in the template layer.
  return /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(trimmed);
}

// ---------------------------------------------------------------------------
// Layout helpers (pdfmake nodes)
// ---------------------------------------------------------------------------

type AnyNode = Record<string, unknown>;

function buildPartyCard(args: {
  title: "מוכר" | "לקוח";
  name: string;
  lines: Array<{ label: string; value: string; valueDir: "rtl" | "ltr" }>;
  align: "right" | "left";
}): AnyNode {
  const { title, name, lines, align } = args;
  const secondary = lines.filter(
    (l) => typeof l?.value === "string" && l.value.trim().length > 0
  );

  return {
    width: "*",
    table: {
      widths: ["*"],
      body: [
        [
          {
            stack: [
              {
                text: rtlLabel(title),
                fontSize: 10,
                bold: true,
                color: BRAND_MUTED,
                alignment: align,
                margin: [0, 0, 0, 6],
                lineHeight: 1.1,
              },
              {
                // Free-form names must NOT be reversed. We isolate RTL to keep
                // visual order stable without changing characters.
                text: rtlText(name),
                fontSize: 13,
                bold: true,
                color: BRAND_DARK,
                alignment: align,
                margin: [0, 0, 0, secondary.length > 0 ? 6 : 0],
                lineHeight: 1.2,
              },
              ...(secondary.length > 0
                ? secondary.map((row) => ({
                    columns: [
                      {
                        text:
                          row.valueDir === "ltr"
                            ? ltrText(row.value)
                            : rtlText(row.value),
                        alignment:
                          row.valueDir === "ltr" ? "left" : "right",
                        color: BRAND_DARK,
                        fontSize: 10,
                        width: "*",
                      },
                      {
                        text: rtlLabel(row.label),
                        alignment: "right",
                        color: BRAND_MUTED,
                        fontSize: 10,
                        width: "auto",
                      },
                    ],
                    columnGap: 8,
                    margin: [0, 0, 0, 2],
                  }))
                : []),
            ],
            fillColor: BG_PARTY_CARD,
            margin: [0, 0, 0, 0],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 14,
      paddingRight: () => 14,
      paddingTop: () => 12,
      paddingBottom: () => 12,
    },
  };
}

function buildIssuerStack(
  issuer: BillingIssuedSnapshotV1Issuer
): AnyNode {
  const lines: Array<{ label: string; value: string; valueDir: "rtl" | "ltr" }> =
    [];
  if (issuer.taxId) {
    lines.push({ label: 'ע.מ./ח.פ.', value: issuer.taxId, valueDir: "ltr" });
  }
  if (issuer.vatRegistration) {
    lines.push({
      label: "עוסק מורשה",
      value: issuer.vatRegistration,
      valueDir: "ltr",
    });
  }
  if (issuer.phone) {
    lines.push({ label: "טלפון", value: issuer.phone, valueDir: "ltr" });
  }
  if (issuer.email) {
    lines.push({ label: 'דוא"ל', value: issuer.email, valueDir: "ltr" });
  }
  if (issuer.address && typeof issuer.address === "string") {
    const flat = issuer.address
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" · ");
    if (flat.length > 0) {
      lines.push({ label: "כתובת", value: flat, valueDir: "rtl" });
    }
  }
  return buildPartyCard({
    title: "מוכר",
    name: issuer.name,
    lines,
    align: "right",
  });
}

function buildCustomerStack(
  customer: BillingIssuedSnapshotV1Customer
): AnyNode {
  const lines: Array<{ label: string; value: string; valueDir: "rtl" | "ltr" }> =
    [];
  if (customer.taxId) {
    lines.push({ label: "ע.מ./ת.ז.", value: customer.taxId, valueDir: "ltr" });
  }
  if (customer.city) {
    lines.push({ label: "עיר", value: customer.city, valueDir: "rtl" });
  }
  if (customer.phone) {
    lines.push({ label: "טלפון", value: customer.phone, valueDir: "ltr" });
  }
  if (customer.email) {
    lines.push({ label: 'דוא"ל', value: customer.email, valueDir: "ltr" });
  }
  return buildPartyCard({
    title: "לקוח",
    name: customer.name,
    lines,
    align: "right",
  });
}

function buildLineRow(
  line: BillingIssuedSnapshotV1Line,
  currency: string
): AnyNode[] {
  // Table columns are drawn left → right. Order is outer (סה״כ) … inner (מס׳).
  // Hebrew description: alignment right + rtlText (logical order unchanged).
  return [
    {
      text: ltrText(formatMoney(line.lineTotal, currency)),
      alignment: "left",
      bold: true,
      color: BRAND_DARK,
    },
    { text: ltrText(formatMoney(line.vatAmount, currency)), alignment: "left" },
    { text: ltrText(formatMoney(line.unitPrice, currency)), alignment: "left" },
    { text: ltrText(formatQuantity(line.quantity)), alignment: "center" },
    {
      text: rtlText(line.description),
      alignment: "right",
    },
    {
      text: ltrText(String(line.lineIndex)),
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
    fillColor: BG_SOFT,
    color: BRAND_DARK,
  };
  const tableHeader: AnyNode[] = [
    { text: rtlLabel('סה"כ'), alignment: "center", ...headerCellStyle },
    { text: rtlLabel('מע"מ'), alignment: "center", ...headerCellStyle },
    { text: rtlLabel("מחיר יחידה"), alignment: "center", ...headerCellStyle },
    { text: rtlLabel("כמות"), alignment: "center", ...headerCellStyle },
    { text: rtlLabel("תיאור"), alignment: "right", ...headerCellStyle },
    { text: rtlLabel("מס׳"), alignment: "center", ...headerCellStyle },
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
        rowIndex === 0 ? BG_SOFT : rowIndex % 2 === 0 ? "#fbfdff" : null,
      hLineColor: () => BORDER_SOFT,
      vLineColor: () => BORDER_SOFT,
      hLineWidth: (i: number, node: { table?: { body?: unknown[] } }) => {
        const rows = Array.isArray(node?.table?.body) ? node.table?.body.length : 0;
        // Top + bottom borders slightly stronger; inner separators hairline.
        if (i === 0 || i === rows) return 0.8;
        return 0.4;
      },
      vLineWidth: () => 0,
      paddingLeft: (colIndex: number) => (colIndex === 0 ? 6 : 8),
      paddingRight: () => 8,
      paddingTop: (rowIndex: number) => (rowIndex === 0 ? 9 : 8),
      paddingBottom: (rowIndex: number) => (rowIndex === 0 ? 9 : 8),
    },
    margin: [0, 0, 0, 16],
  };
}

function buildTotalsBlock(
  totals: BillingIssuedSnapshotV1["totals"],
  vatLabelSuffix: string | null,
  currency: string
): AnyNode {
  const vatLabelNode: AnyNode = vatLabelSuffix
    ? {
        text: [
          { text: rtlText('מע"מ') },
          { text: ltrText(` (${vatLabelSuffix})`) },
        ],
      }
    : { text: rtlText('מע"מ') };
  const totalsBody: AnyNode[][] = [
    [
      {
        text: ltrText(formatMoney(totals.subtotal, currency)),
        alignment: "left",
        color: BRAND_DARK,
      },
      { text: rtlLabel('סה"כ לפני מע"מ'), alignment: "right", color: BRAND_MUTED },
    ],
    [
      {
        text: ltrText(formatMoney(totals.vat, currency)),
        alignment: "left",
        color: BRAND_DARK,
      },
      { ...vatLabelNode, alignment: "right", color: BRAND_MUTED },
    ],
    [
      {
        text: ltrText(formatMoney(totals.total, currency)),
        alignment: "left",
        bold: true,
        fontSize: 14,
        fillColor: BG_TOTAL,
        color: BRAND_DARK,
      },
      {
        text: rtlLabel('סה"כ לתשלום'),
        alignment: "right",
        bold: true,
        fontSize: 14,
        fillColor: BG_TOTAL,
        color: BRAND_DARK,
      },
    ],
  ];
  return {
    margin: [0, 4, 0, 0],
    columns: [
      { text: "", width: "*" },
      {
        width: 280,
        table: {
          widths: ["*"],
          body: [
            [
              {
                fillColor: "#f1f5f9",
                table: { widths: ["auto", "*"], body: totalsBody },
                layout: {
                  hLineWidth: () => 0,
                  vLineWidth: () => 0,
                  paddingLeft: () => 12,
                  paddingRight: () => 12,
                  paddingTop: () => 10,
                  paddingBottom: () => 10,
                },
              },
            ],
          ],
        },
        layout: {
          hLineWidth: () => 0,
          vLineWidth: () => 0,
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Public: build pdfmake docDefinition from a v1 snapshot
// ---------------------------------------------------------------------------

function resolvePdfmakeTemplateStyle(
  snapshot: BillingIssuedSnapshotV1
): BillingPdfTemplateStyle {
  return parseBillingPdfTemplateStyle(
    typeof snapshot.pdfTemplateStyle === "string"
      ? snapshot.pdfTemplateStyle
      : undefined
  );
}

function pdfmakeMetricsForStyle(style: BillingPdfTemplateStyle): {
  pageMargins: [number, number, number, number];
  baseFont: number;
  docTitle: number;
  issuerHeader: number;
} {
  switch (style) {
    case "MODERN":
      return {
        pageMargins: [40, 112, 40, 62],
        baseFont: 11,
        docTitle: 24,
        issuerHeader: 19,
      };
    case "COMPACT":
      return {
        pageMargins: [40, 102, 40, 56],
        baseFont: 10,
        docTitle: 20,
        issuerHeader: 17,
      };
    default:
      return {
        pageMargins: [44, 110, 44, 64],
        baseFont: 11,
        docTitle: 22,
        issuerHeader: 18,
      };
  }
}

export function buildDocDefinition(
  snapshot: BillingIssuedSnapshotV1
): BillingPdfDocDefinition {
  const pm = pdfmakeMetricsForStyle(resolvePdfmakeTemplateStyle(snapshot));
  const { document, issuer, customer, lines, totals, metadata } = snapshot;
  const currency = document.currency || snapshot.tax.currency || "ILS";
  const documentTypeLabel = getDocumentTypeLabel(document.type);
  const tz = metadata.timezone || "Asia/Jerusalem";
  const issuedAtFormatted = formatIssuedAt(snapshot.issuedAt, tz);
  let quoteValidUntilFormatted = "";
  if (
    document.type === "QUOTE" &&
    snapshot.extensions &&
    typeof snapshot.extensions === "object" &&
    "quoteValidUntil" in snapshot.extensions &&
    typeof (snapshot.extensions as { quoteValidUntil?: unknown })
      .quoteValidUntil === "string"
  ) {
    const raw = (
      snapshot.extensions as { quoteValidUntil: string }
    ).quoteValidUntil.trim();
    if (raw.length > 0) {
      quoteValidUntilFormatted = formatIssuedAt(raw, tz);
    }
  }
  const dateRowLabel =
    document.type === "QUOTE" ? "תאריך" : "תאריך הוצאה";
  const vatLabelSuffix = deriveCommonVatRateLabel(lines);
  const hasLogo = isDataImageUrl(issuer.logoUrl);
  const docNumber = document.numberFormatted;

  return {
    pageSize: "A4",
    pageMargins: pm.pageMargins,
    defaultStyle: {
      font: HEBREW_FONT_NAME,
      fontSize: pm.baseFont,
      alignment: "right",
    },
    info: {
      title: `${documentTypeLabel} ${docNumber}`,
      author: issuer.name,
      subject: documentTypeLabel,
      creator: `billing-platform/${BILLING_PDF_TEMPLATE_VERSION}`,
      producer: `billing-platform/${BILLING_PDF_TEMPLATE_VERSION}`,
    },
    header: () => ({
      columns: [
        {
          stack: [
            ...(hasLogo
              ? [
                  {
                    image: issuer.logoUrl as string,
                    width: 48,
                    height: 48,
                    alignment: "left",
                    margin: [0, 0, 0, 6],
                  },
                ]
              : []),
            {
              text: rtlText(issuer.name),
              alignment: "right",
              color: BRAND_DARK,
              fontSize: pm.issuerHeader,
              bold: true,
              lineHeight: 1.15,
            },
          ],
          alignment: "left",
          margin: [44, 26, 0, 0],
        },
        {
          stack: [
            {
              text: rtlLabel(documentTypeLabel),
              alignment: "right",
              fontSize: pm.docTitle,
              bold: true,
              color: BRAND_DARK,
              lineHeight: 1.05,
            },
            {
              columns: [
                {
                  text: ltrText(docNumber),
                  alignment: "left",
                  fontSize: 11,
                  color: BRAND_DARK,
                  width: "*",
                },
                {
                  text: rtlLabel("מס׳ מסמך"),
                  alignment: "right",
                  fontSize: 11,
                  color: BRAND_MUTED,
                  width: "auto",
                },
              ],
              columnGap: 8,
              margin: [0, 10, 0, 0],
            },
            {
              columns: [
                {
                  text: ltrText(issuedAtFormatted),
                  alignment: "left",
                  fontSize: 11,
                  color: BRAND_DARK,
                  width: "*",
                },
                {
                  text: rtlLabel(dateRowLabel),
                  alignment: "right",
                  fontSize: 11,
                  color: BRAND_MUTED,
                  width: "auto",
                },
              ],
              columnGap: 8,
              margin: [0, 6, 0, 0],
            },
            ...(quoteValidUntilFormatted.length > 0
              ? [
                  {
                    columns: [
                      {
                        text: ltrText(quoteValidUntilFormatted),
                        alignment: "left",
                        fontSize: 11,
                        color: BRAND_DARK,
                        width: "*",
                      },
                      {
                        text: rtlLabel("בתוקף עד"),
                        alignment: "right",
                        fontSize: 11,
                        color: BRAND_MUTED,
                        width: "auto",
                      },
                    ],
                    columnGap: 8,
                    margin: [0, 6, 0, 0],
                  },
                ]
              : []),
          ],
          alignment: "right",
          margin: [0, 26, 44, 0],
        },
      ],
    }),
    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        {
          text: rtlText(issuer.name),
          alignment: "right",
          margin: [44, 20, 0, 0],
          fontSize: 8,
          color: "#64748b",
        },
        {
          text: rtlText(`עמוד ${currentPage} מתוך ${pageCount}`),
          alignment: "right",
          margin: [0, 20, 44, 0],
          fontSize: 8,
          color: "#64748b",
        },
      ],
    }),
    content: [
      {
        columns: [buildCustomerStack(customer), buildIssuerStack(issuer)],
        columnGap: 14,
        margin: [0, 6, 0, 20],
      },
      {
        text: rtlLabel("פירוט פריטים"),
        fontSize: 14,
        bold: true,
        color: BRAND_DARK,
        margin: [0, 0, 0, 10],
      },
      buildLinesTable(lines, currency),
      buildTotalsBlock(totals, vatLabelSuffix, currency),
      ...(typeof issuer.bankDetails === "string" &&
      issuer.bankDetails.trim().length > 0
        ? [buildPaymentDetailsBlock(issuer.bankDetails)]
        : []),
      {
        text: rtlText(getBillingFooterLegalNote(snapshot)),
        fontSize: 8,
        color: "#555",
        alignment: "right",
        margin: [0, 24, 0, 0],
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
