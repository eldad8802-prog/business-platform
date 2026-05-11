/**
 * Billing invoice HTML for Chromium PDF — mirrors billing-v1 pdfmake layout.
 * Pure string builder; no fs/network. Dynamic strings go through renderDynamicPdfText.
 */

import {
  renderDynamicPdfText,
  type PdfDynamicTextContext,
} from "@/lib/services/billing/pdf/billing-pdf-text-policy";
import { parseBillingPdfTemplateStyle } from "@/lib/billing/billing-pdf-template-style";
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
  QUOTE: "הצעת מחיר",
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
  const pdfStyle = parseBillingPdfTemplateStyle(
    typeof snapshot.pdfTemplateStyle === "string"
      ? snapshot.pdfTemplateStyle
      : undefined
  );
  const pdfStyleClass =
    pdfStyle === "MODERN"
      ? "billing-pdf--modern"
      : pdfStyle === "COMPACT"
        ? "billing-pdf--compact"
        : "billing-pdf--classic";

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

  // Hebrew + LTR rate: plaintext span for the word, isolated LTR for the % suffix.
  const vatRowLabelHtml = vatLabelSuffix
    ? `<div class="pdf-dyn pdf-dyn--label vat-label-row"><span dir="rtl" class="pdf-bidi-plain pdf-bidi-plain--label">מע&quot;מ</span><span dir="ltr" class="vat-suffix-inline"> (${vatLabelSuffix})</span></div>`
    : `<div class="pdf-dyn pdf-dyn--label"><span dir="rtl" class="pdf-bidi-plain pdf-bidi-plain--label">מע&quot;מ</span></div>`;

  const issuerLines: Array<{ label: string; value: string; ctx: PdfDynamicTextContext }> =
    [];
  if (issuer.taxId) {
    issuerLines.push({
      label: "ע.מ./ח.פ.",
      value: issuer.taxId,
      ctx: "numeric",
    });
  }
  if (issuer.vatRegistration) {
    issuerLines.push({
      label: "עוסק מורשה",
      value: issuer.vatRegistration,
      ctx: "numeric",
    });
  }
  if (issuer.phone) {
    issuerLines.push({ label: "טלפון", value: issuer.phone, ctx: "phone" });
  }
  if (issuer.email) {
    issuerLines.push({ label: 'דוא"ל', value: issuer.email, ctx: "email" });
  }
  if (issuer.address && typeof issuer.address === "string") {
    const flat = issuer.address
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" · ");
    if (flat.length > 0) {
      issuerLines.push({
        label: "כתובת",
        value: flat,
        ctx: "freeText",
      });
    }
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
      /* Column order: RTL visual = מס׳ → תיאור → … → סה״כ (first <td> = rightmost col) */
      return `
      <tr class="lines-row">
        <td class="cell-idx">${dyn(String(line.lineIndex), "numeric")}</td>
        <td class="cell-desc">${dyn(line.description, "freeText")}</td>
        <td class="cell-qty">${dyn(formatQuantity(line.quantity), "numeric")}</td>
        <td class="cell-num">${dyn(formatMoney(line.unitPrice, currency), "numeric")}</td>
        <td class="cell-num">${dyn(formatMoney(line.vatAmount, currency), "numeric")}</td>
        <td class="cell-num">${dyn(formatMoney(line.lineTotal, currency), "numeric")}</td>
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
    html {
      direction: rtl;
    }
    html, body {
      margin: 0;
      padding: 0;
      font-family: 'NotoSansHebrew', 'Segoe UI', 'Arial Hebrew', sans-serif;
      font-size: 11px;
      line-height: 1.45;
      color: ${BRAND_DARK};
      direction: rtl;
      text-align: right;
    }
    body { padding: 26px 44px 28px 44px; }
    /* Outer wrapper only; real BiDi is on .pdf-bidi-plain (plaintext) */
    .pdf-dyn {
      display: block;
      width: 100%;
    }
    /* Hebrew logical order — plaintext avoids reversed words in Chromium PDF */
    .pdf-bidi-plain {
      unicode-bidi: plaintext;
      direction: rtl;
      text-align: right;
      display: block;
      width: 100%;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: normal;
    }
    .pdf-bidi-plain--label { font-weight: 600; }
    .pdf-bidi-plain--mixed { font-weight: 400; }
    .pdf-bidi-plain--body { font-weight: 400; }
    .pdf-bidi-plain-auto {
      unicode-bidi: plaintext;
      direction: auto;
      text-align: right;
      display: block;
      width: 100%;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: normal;
    }
    .pdf-bidi-free-text-isolate {
      unicode-bidi: isolate;
      direction: rtl;
      text-align: right;
      display: block;
      width: 100%;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: normal;
    }
    .pdf-bidi-free-text-auto {
      unicode-bidi: isolate;
      direction: auto;
      text-align: right;
      display: block;
      width: 100%;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: normal;
    }
    /* Titles / names: plaintext + wrap long strings */
    .issuer-title .pdf-bidi-plain,
    .doc-type .pdf-bidi-plain,
    .party-name .pdf-bidi-plain {
      display: inline-block;
      max-width: 100%;
      white-space: normal;
      unicode-bidi: plaintext;
      vertical-align: top;
    }
    .issuer-title .pdf-dyn,
    .doc-type .pdf-dyn,
    .party-name .pdf-dyn {
      display: block;
      width: 100%;
      text-align: right;
      direction: rtl;
    }
    /* LTR inline values */
    .pdf-dyn--ltr { direction: ltr; text-align: left; unicode-bidi: isolate; }
    .pdf-dyn--en { direction: ltr; text-align: left; unicode-bidi: isolate; }
    .pdf-dyn--label,
    .pdf-dyn--mixed,
    .pdf-dyn--he {
      direction: rtl;
      text-align: right;
    }
    /* Numeric cells */
    .cell-num .pdf-dyn { text-align: left; }
    .amt .pdf-dyn { text-align: left; }
    .vat-label-row {
      display: flex;
      flex-direction: row;
      align-items: baseline;
      justify-content: flex-end;
      gap: 4px;
      flex-wrap: wrap;
      direction: rtl;
    }
    .vat-label-row .pdf-bidi-plain {
      display: inline;
      white-space: normal;
      width: auto;
    }
    .vat-suffix-inline {
      unicode-bidi: isolate;
      direction: ltr;
    }

    .top {
      display: flex;
      flex-direction: row;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 18px;
      direction: rtl;
    }
    /* Logo + issuer: visual LEFT — second flex item in RTL row */
    .brand {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      text-align: right;
      direction: rtl;
      flex: 1;
      min-width: 0;
    }
    .brand-logo {
      width: 72px;
      height: 72px;
      object-fit: contain;
      margin-bottom: 6px;
      align-self: flex-end;
    }
    .issuer-title {
      font-size: 18px;
      font-weight: 700;
      color: ${BRAND_DARK};
      line-height: 1.25;
      direction: rtl;
      text-align: right;
      width: 100%;
    }
    /* Title block: visual RIGHT — first flex item in RTL row */
    .doc-head {
      text-align: right;
      direction: rtl;
      flex: 1;
      min-width: 0;
    }
    .doc-type {
      font-size: 22px;
      font-weight: 700;
      color: ${BRAND_DARK};
      line-height: 1.1;
      margin: 0 0 10px;
      direction: rtl;
      text-align: right;
    }
    .kv {
      display: flex;
      flex-direction: row;
      justify-content: flex-start;
      align-items: baseline;
      gap: 8px;
      margin-top: 6px;
      direction: rtl;
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
    .kv--taxid { margin-bottom: 6px; }
    .kv--taxid .k { font-weight: 700; color: ${BRAND_DARK}; }
    .kv--taxid .v { font-weight: 700; color: ${BRAND_DARK}; }

    .party-grid {
      display: flex;
      flex-direction: row;
      gap: 14px;
      margin: 6px 0 20px;
      direction: rtl;
    }
    .party-card {
      flex: 1;
      background: ${BG_PARTY_CARD};
      border-radius: 0;
      padding: 14px;
      border: 1px solid ${BORDER_SOFT};
      direction: rtl;
      text-align: right;
    }
    .party-card--customer,
    .party-card--issuer {
      text-align: right;
    }
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
      line-height: 1.35;
      direction: rtl;
      text-align: right;
    }
    /* RTL grid: column 1 = visual right = label; column 2 = value (remaining) */
    .party-row {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 8px 10px;
      margin: 0 0 4px;
      font-size: 10px;
      align-items: start;
      direction: rtl;
    }
    .party-row .pl {
      color: ${BRAND_MUTED};
      text-align: right;
      grid-column: 1;
    }
    .party-row .pv {
      color: ${BRAND_DARK};
      min-width: 0;
      text-align: right;
      grid-column: 2;
    }
    .party-row .pv .pdf-dyn {
      text-align: right;
    }
    .party-row .pv .pdf-bidi-plain {
      text-align: right;
    }
    .party-row .pv .pdf-dyn--ltr,
    .party-row .pv .pdf-dyn--en {
      display: inline-block;
      text-align: left;
      direction: ltr;
    }

    .section-title {
      font-size: 14px;
      font-weight: 700;
      color: ${BRAND_DARK};
      margin: 0 0 10px;
      direction: rtl;
      text-align: right;
    }

    table.lines {
      width: 100%;
      border-collapse: collapse;
      direction: rtl;
      table-layout: fixed;
      margin: 0 0 16px;
      text-align: right;
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
      text-align: right;
      direction: rtl;
    }
    table.lines tbody tr:nth-child(even) { background: #fbfdff; }
    .cell-num {
      text-align: left;
      direction: rtl;
    }
    .cell-num .pdf-dyn,
    .cell-num .pdf-dyn--ltr {
      display: inline-block;
      text-align: left;
      direction: ltr;
      unicode-bidi: isolate;
    }
    .cell-qty {
      text-align: center;
      width: 72px;
      direction: rtl;
    }
    .cell-idx {
      text-align: center;
      width: 36px;
      color: #6b7280;
      direction: rtl;
    }
    .cell-desc {
      text-align: right;
      direction: rtl;
    }
    .cell-desc .pdf-bidi-plain--body {
      white-space: normal;
    }

    .totals-wrap {
      display: flex;
      justify-content: flex-end;
      margin: 4px 0 0;
      direction: rtl;
    }
    .totals {
      width: 280px;
      max-width: 100%;
      border-collapse: collapse;
      direction: rtl;
    }
    .totals td {
      padding: 10px 12px;
      vertical-align: middle;
    }
    /* RTL row: label column on the right, amounts on the left */
    .totals .lbl {
      text-align: right;
      color: ${BRAND_MUTED};
      direction: rtl;
      width: 58%;
    }
    .totals .amt {
      text-align: left;
      color: ${BRAND_DARK};
      direction: ltr;
      unicode-bidi: isolate;
      width: 42%;
    }
    .totals .amt .pdf-dyn,
    .totals .amt .pdf-dyn--ltr {
      display: inline-block;
      text-align: left;
      direction: ltr;
    }
    .totals tr.total-row td {
      background: ${BG_TOTAL};
      font-weight: 700;
      font-size: 14px;
    }
    .footer-note {
      font-size: 10px;
      color: #555;
      text-align: right;
      margin: 24px 0 0;
      line-height: 1.45;
      direction: rtl;
    }
    .footer-note .pdf-bidi-plain {
      white-space: pre-wrap;
    }

    /* ----- billingPdfTemplateStyle presets (frozen in issued snapshot) ----- */
    body.billing-pdf-root.billing-pdf--modern .top {
      margin-bottom: 22px;
      padding-bottom: 14px;
      border-bottom: 2px solid #e2e8f0;
    }
    body.billing-pdf-root.billing-pdf--modern .doc-type {
      font-size: 24px;
      letter-spacing: -0.02em;
    }
    body.billing-pdf-root.billing-pdf--modern .issuer-title {
      font-size: 19px;
    }
    body.billing-pdf-root.billing-pdf--modern .party-card {
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
    }

    body.billing-pdf-root.billing-pdf--compact {
      font-size: 10px;
      line-height: 1.38;
      padding: 20px 36px 22px 36px;
    }
    body.billing-pdf-root.billing-pdf--compact .top {
      margin-bottom: 12px;
      gap: 10px;
    }
    body.billing-pdf-root.billing-pdf--compact .doc-type {
      font-size: 20px;
      margin-bottom: 8px;
    }
    body.billing-pdf-root.billing-pdf--compact .issuer-title {
      font-size: 16px;
    }
    body.billing-pdf-root.billing-pdf--compact .party-grid {
      gap: 10px;
      margin: 4px 0 12px;
    }
    body.billing-pdf-root.billing-pdf--compact .party-card {
      padding: 10px 12px;
    }
    body.billing-pdf-root.billing-pdf--compact .section-title {
      font-size: 12px;
      margin: 0 0 6px;
    }
    body.billing-pdf-root.billing-pdf--compact table.lines th,
    body.billing-pdf-root.billing-pdf--compact table.lines td {
      padding: 5px 6px;
    }
    body.billing-pdf-root.billing-pdf--compact table.lines thead th {
      padding-top: 7px;
      padding-bottom: 7px;
      font-size: 10px;
    }
    body.billing-pdf-root.billing-pdf--compact .totals td {
      padding: 8px 10px;
    }
    body.billing-pdf-root.billing-pdf--compact .footer-note {
      margin-top: 16px;
      font-size: 9px;
    }
  </style>
</head>
<body class="billing-pdf-root ${pdfStyleClass}">
  <div class="top">
    <div class="doc-head">
      <div class="doc-type">${dyn(documentTypeLabel, "label")}</div>
      ${issuer.taxId ? `<div class="kv kv--taxid">
        <div class="k">${dyn("ע.מ./ח.פ.", "label")}</div>
        <div class="v">${dyn(issuer.taxId, "numeric")}</div>
      </div>` : ""}
      <div class="kv">
        <div class="k">${dyn("מס׳ מסמך", "label")}</div>
        <div class="v">${dyn(docNumber, "numeric")}</div>
      </div>
      <div class="kv">
        <div class="k">${dyn(dateRowLabel, "label")}</div>
        <div class="v">${dyn(issuedAtFormatted, "numeric")}</div>
      </div>
      ${
        quoteValidUntilFormatted.length > 0
          ? `<div class="kv">
        <div class="k">${dyn("בתוקף עד", "label")}</div>
        <div class="v">${dyn(quoteValidUntilFormatted, "numeric")}</div>
      </div>`
          : ""
      }
    </div>
    <div class="brand">
      ${
        hasLogo
          ? `<img class="brand-logo" src="${issuer.logoUrl as string}" alt="" />`
          : ""
      }
      <div class="issuer-title">${dyn(issuer.name, "freeText")}</div>
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
        <th>${dyn("מס׳", "label")}</th>
        <th>${dyn("תיאור", "label")}</th>
        <th>${dyn("כמות", "label")}</th>
        <th>${dyn("מחיר יחידה", "label")}</th>
        <th>${dyn('מע"מ', "label")}</th>
        <th>${dyn('סה"כ', "label")}</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>

  <div class="totals-wrap">
    <table class="totals">
      <tr>
        <td class="lbl">${dyn('סה"כ לפני מע"מ', "label")}</td>
        <td class="amt">${dyn(formatMoney(totals.subtotal, currency), "numeric")}</td>
      </tr>
      <tr>
        <td class="lbl vat-label-cell">${vatRowLabelHtml}</td>
        <td class="amt">${dyn(formatMoney(totals.vat, currency), "numeric")}</td>
      </tr>
      <tr class="total-row">
        <td class="lbl">${dyn('סה"כ לתשלום', "label")}</td>
        <td class="amt">${dyn(formatMoney(totals.total, currency), "numeric")}</td>
      </tr>
    </table>
  </div>

  <div class="payment-block" style="margin-top:18px;text-align:right;direction:rtl;">
    <div style="font-size:12px;font-weight:700;color:${BRAND_DARK};margin-bottom:8px;">${dyn("פרטי תשלום", "label")}</div>
    <div style="font-size:10px;color:${BRAND_MUTED};line-height:1.35;">
      ${typeof issuer.bankDetails === "string" && issuer.bankDetails.trim().length > 0
        ? dyn(issuer.bankDetails.trim(), "freeText")
        : `<span style="font-style:italic;color:#94a3b8;">לא הוגדרו פרטי תשלום</span>`}
    </div>
  </div>

  <div class="footer-note">
    ${dyn(getBillingFooterLegalNote(snapshot), "freeText")}
  </div>
</body>
</html>`;
}
