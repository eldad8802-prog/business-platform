/**
 * Billing invoice HTML for Chromium PDF — mirrors billing-v1 pdfmake layout.
 * Pure string builder; no fs/network. Dynamic strings go through renderDynamicPdfText.
 */

import {
  renderDynamicPdfText,
  type PdfDynamicTextContext,
} from "@/lib/services/billing/pdf/billing-pdf-text-policy";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";

const ILS_SYMBOL = "\u20AA";
const BRAND_DARK = "#0f172a";
const BRAND_MUTED = "#475569";
const BORDER_SOFT = "#e5e7eb";
const BG_SOFT = "#f8fafc";
const BG_TOTAL = "#eef2ff";
const BG_PARTY_CARD = "#f8fafc";

const DOCUMENT_TYPE_LABELS_HE: Record<string, string> = {
  TAX_INVOICE: "חשבונית מס",
};

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
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy}`;
  }
}

function deriveCommonVatRateLabel(
  lines: BillingIssuedSnapshotV1["lines"]
): string | null {
  if (lines.length === 0) return null;
  const first = lines[0].vatRatePercent;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].vatRatePercent !== first) return null;
  }
  const rate = parseNumber(first);
  if (!Number.isFinite(rate)) return null;
  const trimmed = rate
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return `${trimmed}%`;
}

function getDocumentTypeLabel(type: string): string {
  return DOCUMENT_TYPE_LABELS_HE[type] ?? type;
}

function isDataImageUrl(value: string | null): boolean {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(trimmed);
}

function dyn(value: string, ctx: PdfDynamicTextContext): string {
  return renderDynamicPdfText(value, ctx);
}

export function buildBillingInvoiceHtml(
  snapshot: BillingIssuedSnapshotV1,
  fontDataUri: string
): string {
  const { document, issuer, customer, lines, totals, metadata } = snapshot;
  const currency = document.currency || snapshot.tax.currency || "ILS";
  const documentTypeLabel = getDocumentTypeLabel(document.type);
  const issuedAtFormatted = formatIssuedAt(
    snapshot.issuedAt,
    metadata.timezone || "Asia/Jerusalem"
  );
  const vatLabelSuffix = deriveCommonVatRateLabel(lines);
  const hasLogo = isDataImageUrl(issuer.logoUrl);
  const docNumber = document.numberFormatted;

  const vatRowLabelHtml = vatLabelSuffix
    ? `${dyn('מע"מ', "label")}<span dir="ltr" class="vat-suffix-inline">${dyn(
        ` (${vatLabelSuffix})`,
        "english"
      )}</span>`
    : dyn('מע"מ', "label");

  const issuerLines: Array<{ label: string; value: string; ctx: PdfDynamicTextContext }> =
    [];
  if (issuer.taxId) {
    issuerLines.push({
      label: "ע.מ./ח.פ.",
      value: issuer.taxId,
      ctx: "numeric",
    });
  }
  if (issuer.phone) {
    issuerLines.push({ label: "טלפון", value: issuer.phone, ctx: "phone" });
  }
  if (issuer.email) {
    issuerLines.push({ label: 'דוא"ל', value: issuer.email, ctx: "email" });
  }

  const customerLines: Array<{ label: string; value: string; ctx: PdfDynamicTextContext }> =
    [];
  if (customer.taxId) {
    customerLines.push({
      label: "ע.מ./ת.ז.",
      value: customer.taxId,
      ctx: "numeric",
    });
  }
  if (customer.city) {
    customerLines.push({
      label: "עיר",
      value: customer.city,
      ctx: "freeText",
    });
  }
  if (customer.phone) {
    customerLines.push({
      label: "טלפון",
      value: customer.phone,
      ctx: "phone",
    });
  }
  if (customer.email) {
    customerLines.push({
      label: 'דוא"ל',
      value: customer.email,
      ctx: "email",
    });
  }

  const tableRows = lines
    .map((line) => {
      return `
      <tr class="lines-row">
        <td class="cell-num">${dyn(formatMoney(line.lineTotal, currency), "mixed")}</td>
        <td class="cell-num">${dyn(formatMoney(line.vatAmount, currency), "mixed")}</td>
        <td class="cell-num">${dyn(formatMoney(line.unitPrice, currency), "mixed")}</td>
        <td class="cell-qty">${dyn(formatQuantity(line.quantity), "numeric")}</td>
        <td class="cell-desc">${dyn(line.description, "mixed")}</td>
        <td class="cell-idx">${dyn(String(line.lineIndex), "numeric")}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <style>
    @font-face {
      font-family: 'NotoSansHebrew';
      src: url('${fontDataUri}') format('truetype');
      font-weight: 400;
      font-style: normal;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      font-family: 'NotoSansHebrew', sans-serif;
      font-size: 11px;
      line-height: 1.45;
      color: ${BRAND_DARK};
      direction: rtl;
      text-align: right;
    }
    body { padding: 26px 44px 28px 44px; }
    .pdf-dyn { display: block; unicode-bidi: isolate; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
    .issuer-title .pdf-dyn,
    .doc-type .pdf-dyn,
    .party-name .pdf-dyn,
    .vat-label-cell .pdf-dyn { display: inline; }
    .pdf-dyn--ltr { direction: ltr; text-align: left; unicode-bidi: isolate; }
    .pdf-dyn--en { direction: ltr; text-align: left; unicode-bidi: isolate; }
    .pdf-dyn--label { direction: rtl; text-align: right; font-weight: 600; }
    .pdf-dyn--mixed { direction: rtl; text-align: right; }
    .pdf-dyn--he { direction: rtl; text-align: right; }

    .top {
      display: flex;
      flex-direction: row;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 18px;
    }
    .brand {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      text-align: left;
      direction: ltr;
    }
    .brand-logo {
      width: 48px;
      height: 48px;
      object-fit: contain;
      margin-bottom: 6px;
    }
    .issuer-title {
      font-size: 18px;
      font-weight: 700;
      color: ${BRAND_DARK};
      line-height: 1.15;
      direction: rtl;
      text-align: left;
      unicode-bidi: plaintext;
    }
    .doc-head {
      text-align: right;
    }
    .doc-type {
      font-size: 22px;
      font-weight: 700;
      color: ${BRAND_DARK};
      line-height: 1.1;
      margin: 0 0 10px;
    }
    .kv {
      display: flex;
      flex-direction: row;
      justify-content: flex-end;
      align-items: baseline;
      gap: 8px;
      margin-top: 6px;
    }
    .kv .k {
      color: ${BRAND_MUTED};
      font-size: 11px;
      flex: 0 0 auto;
    }
    .kv .v {
      flex: 1 1 auto;
      min-width: 0;
    }

    .party-grid {
      display: flex;
      flex-direction: row;
      gap: 14px;
      margin: 6px 0 20px;
    }
    .party-card {
      flex: 1;
      background: ${BG_PARTY_CARD};
      border-radius: 0;
      padding: 14px;
      border: 1px solid ${BORDER_SOFT};
    }
    .party-card--customer { text-align: left; }
    .party-card--issuer { text-align: right; }
    .party-cap {
      font-size: 10px;
      font-weight: 700;
      color: ${BRAND_MUTED};
      margin: 0 0 6px;
    }
    .party-name {
      font-size: 13px;
      font-weight: 700;
      color: ${BRAND_DARK};
      margin: 0 0 6px;
      line-height: 1.25;
    }
    .party-row {
      display: flex;
      flex-direction: row;
      justify-content: space-between;
      gap: 8px;
      margin: 0 0 2px;
      font-size: 10px;
      align-items: flex-start;
    }
    .party-row .pl {
      color: ${BRAND_MUTED};
      flex: 0 0 auto;
    }
    .party-row .pv {
      color: ${BRAND_DARK};
      flex: 1 1 auto;
      min-width: 0;
      unicode-bidi: isolate;
    }
    .party-row .pv .pdf-dyn--he,
    .party-row .pv .pdf-dyn--mixed,
    .party-row .pv .pdf-dyn--label {
      text-align: right;
      direction: rtl;
    }
    .party-row .pv .pdf-dyn--ltr,
    .party-row .pv .pdf-dyn--en {
      text-align: left;
      direction: ltr;
    }

    .section-title {
      font-size: 14px;
      font-weight: 700;
      color: ${BRAND_DARK};
      margin: 0 0 10px;
    }

    table.lines {
      width: 100%;
      border-collapse: collapse;
      direction: rtl;
      table-layout: fixed;
      margin: 0 0 16px;
    }
    table.lines th,
    table.lines td {
      border: 1px solid ${BORDER_SOFT};
      padding: 8px 8px;
      vertical-align: top;
      word-wrap: break-word;
    }
    table.lines thead th {
      background: ${BG_SOFT};
      color: ${BRAND_DARK};
      font-weight: 700;
      font-size: 11px;
    }
    table.lines tbody tr:nth-child(even) { background: #fbfdff; }
    .cell-num { text-align: left; }
    .cell-num .pdf-dyn { text-align: left; }
    .cell-qty { text-align: center; width: 72px; }
    .cell-idx { text-align: center; width: 28px; color: #6b7280; }
    .cell-desc { text-align: right; }

    .totals-wrap {
      display: flex;
      justify-content: flex-end;
      margin: 4px 0 0;
    }
    .totals {
      width: 280px;
      max-width: 100%;
      border-collapse: collapse;
    }
    .totals td {
      padding: 10px 12px;
      vertical-align: middle;
    }
    .totals .amt {
      text-align: left;
      color: ${BRAND_DARK};
    }
    .totals .lbl {
      text-align: right;
      color: ${BRAND_MUTED};
    }
    .totals tr.total-row td {
      background: ${BG_TOTAL};
      font-weight: 700;
      font-size: 14px;
    }
    .vat-suffix-inline .pdf-dyn { display: inline; }

    .footer-note {
      font-size: 8px;
      color: #555;
      text-align: right;
      margin: 24px 0 0;
      line-height: 1.35;
    }
  </style>
</head>
<body>
  <div class="top">
    <div class="brand">
      ${
        hasLogo
          ? `<img class="brand-logo" src="${issuer.logoUrl as string}" alt="" />`
          : ""
      }
      <div class="issuer-title">${dyn(issuer.name, "freeText")}</div>
    </div>
    <div class="doc-head">
      <div class="doc-type">${dyn(documentTypeLabel, "label")}</div>
      <div class="kv">
        <div class="k">${dyn("מס׳ מסמך", "label")}</div>
        <div class="v">${dyn(docNumber, "numeric")}</div>
      </div>
      <div class="kv">
        <div class="k">${dyn("תאריך הוצאה", "label")}</div>
        <div class="v">${dyn(issuedAtFormatted, "numeric")}</div>
      </div>
    </div>
  </div>

  <div class="party-grid">
    <div class="party-card party-card--customer">
      <div class="party-cap">${dyn("לקוח", "label")}</div>
      <div class="party-name">${dyn(customer.name, "freeText")}</div>
      ${customerLines
        .map(
          (row) => `
      <div class="party-row">
        <div class="pl">${dyn(row.label, "label")}</div>
        <div class="pv">${dyn(row.value, row.ctx)}</div>
      </div>`
        )
        .join("")}
    </div>
    <div class="party-card party-card--issuer">
      <div class="party-cap">${dyn("מוכר", "label")}</div>
      <div class="party-name">${dyn(issuer.name, "freeText")}</div>
      ${issuerLines
        .map(
          (row) => `
      <div class="party-row">
        <div class="pl">${dyn(row.label, "label")}</div>
        <div class="pv">${dyn(row.value, row.ctx)}</div>
      </div>`
        )
        .join("")}
    </div>
  </div>

  <div class="section-title">${dyn("פירוט פריטים", "label")}</div>

  <table class="lines" aria-label="פירוט פריטים">
    <thead>
      <tr>
        <th>${dyn('סה"כ', "label")}</th>
        <th>${dyn('מע"מ', "label")}</th>
        <th>${dyn("מחיר יחידה", "label")}</th>
        <th>${dyn("כמות", "label")}</th>
        <th>${dyn("תיאור", "label")}</th>
        <th>${dyn("מס׳", "label")}</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>

  <div class="totals-wrap">
    <table class="totals">
      <tr>
        <td class="amt">${dyn(formatMoney(totals.subtotal, currency), "mixed")}</td>
        <td class="lbl">${dyn('סה"כ לפני מע"מ', "label")}</td>
      </tr>
      <tr>
        <td class="amt">${dyn(formatMoney(totals.vat, currency), "mixed")}</td>
        <td class="lbl vat-label-cell">${vatRowLabelHtml}</td>
      </tr>
      <tr class="total-row">
        <td class="amt">${dyn(formatMoney(totals.total, currency), "mixed")}</td>
        <td class="lbl">${dyn('סה"כ לתשלום', "label")}</td>
      </tr>
    </table>
  </div>

  <div class="footer-note">
    ${dyn(
      "מסמך זה הופק אלקטרונית. נא לשמור לצרכי הנהלת חשבונות ודיווח.",
      "label"
    )}
  </div>
</body>
</html>`;
}
