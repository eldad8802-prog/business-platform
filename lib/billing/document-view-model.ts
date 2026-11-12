/**
 * Billing document view model — the types, labels and formatters the document
 * workspace renders from.
 *
 * Extracted verbatim from `app/billing/[id]/page.tsx` (B1, mechanical
 * decomposition): same declarations, same behavior, different file boundary.
 *
 * Nothing here computes money. `formatMoney` formats a server-provided string
 * for display; subtotals, VAT and totals are derived server-side and must stay
 * that way — see docs/billing-adaptive-design-report-v1.md §8.
 */
import { TOKEN } from "@/lib/design/billing-theme";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";
import type { AuthorityDocumentStateView } from "@/lib/billing/authority-document-state-display";

export type BillingStatus = "DRAFT" | "PENDING_REVIEW" | "ISSUED";

export type BillingDocumentLine = {
  id: number;
  lineIndex: number;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRatePercent: string;
  lineSubtotal: string;
  vatAmount: string;
  lineTotal: string;
};

export type BillingDocumentDetail = {
  id: number;
  documentType: string;
  status: BillingStatus;
  documentNumber: number | null;
  documentNumberFormatted: string | null;
  customerId: number | null;
  customerNameSnapshot: string | null;
  validUntil: string | null;
  convertedToInvoiceId: number | null;
  subtotalAmount: string;
  vatAmount: string;
  totalAmount: string;
  currency: string;
  issuedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: BillingDocumentLine[];
  /**
   * The stored allocation state of an issued document (document API only; null
   * for a draft). Absent on responses that do not carry it — callers then keep
   * today's behaviour.
   */
  authorityState?: AuthorityDocumentStateView | null;
};

export type LocalLine = {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRatePercent: string;
};

export type PatchSaveStatus = "idle" | "saving" | "saved" | "error";

export type LifecycleAction = "submit" | "revert" | "issue";

export type StageKey =
  | "draft_missing"
  | "draft_ready"
  | "quote_ready"
  | "quote_converted"
  | "pending_review"
  | "issued";

export function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Opens a fetched PDF in a new tab without async window.open popup blocking. */
export function openPdfBlobInNewTab(blob: Blob): void {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

export type StickyPrimaryAction =
  | { kind: "none" }
  | { kind: "open-issue-dialog" }
  | { kind: "convert-quote" }
  | { kind: "scroll"; targetId: string; label: string };

export function mapServerLinesToLocal(lines: BillingDocumentLine[]): LocalLine[] {
  return lines.map((l) => ({
    key: `s-${l.id}`,
    description: l.description,
    quantity: String(l.quantity),
    unitPrice: String(l.unitPrice),
    vatRatePercent: String(l.vatRatePercent),
  }));
}

export function generateLocalLineKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `n-${crypto.randomUUID()}`;
  }
  return `n-local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Israel's standard VAT rate by date (חוק מע"מ, סעיף 2 and the rate orders): 17% until 31.12.2024, 18% from 1.1.2025.
 * Newest first; a date before every entry falls back to the oldest rate listed.
 */
const STANDARD_VAT_RATES: readonly { from: string; percent: string }[] = [
  { from: "2025-01-01", percent: "18" },
  { from: "2015-10-01", percent: "17" },
];

/** The standard rate in force on `date` (Israel time), as the percent string a line carries. */
export function standardVatRatePercent(date: Date = new Date()): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return (STANDARD_VAT_RATES.find((r) => day >= r.from) ?? STANDARD_VAT_RATES[STANDARD_VAT_RATES.length - 1]).percent;
}

/**
 * A new draft line. Its VAT default is the standard rate in force today — never a hard-coded rate — and 0 for an
 * exempt dealer, who charges no VAT (s.31(3)). The server still validates every line; this is only the default.
 */
export function newEmptyLocalLine(options: { businessKind?: string | null; today?: Date } = {}): LocalLine {
  return {
    key: generateLocalLineKey(),
    description: "",
    quantity: "1",
    unitPrice: "0",
    vatRatePercent: options.businessKind === "EXEMPT_DEALER" ? "0" : standardVatRatePercent(options.today),
  };
}

export function normalizeNumericForCompare(value: string): string {
  const t = value.trim();
  if (t === "") return "";
  const parsed = Number(t);
  if (!Number.isFinite(parsed)) return t;
  // Normalize numerically equivalent inputs (e.g. "1" === "1.00", "17" === "17.0")
  return String(parsed);
}

export function linesAreDirty(
  draft: LocalLine[],
  serverLines: BillingDocumentLine[]
): boolean {
  const a = draft.map((l) => ({
    description: l.description.trim(),
    quantity: normalizeNumericForCompare(l.quantity),
    unitPrice: normalizeNumericForCompare(l.unitPrice),
    vatRatePercent: normalizeNumericForCompare(l.vatRatePercent),
  }));
  const b = serverLines.map((l) => ({
    description: l.description.trim(),
    quantity: normalizeNumericForCompare(String(l.quantity)),
    unitPrice: normalizeNumericForCompare(String(l.unitPrice)),
    vatRatePercent: normalizeNumericForCompare(String(l.vatRatePercent)),
  }));
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function looksLikeDecimalInput(value: string): boolean {
  const t = value.trim();
  if (t === "") return false;
  return /^-?\d+(\.\d+)?$/.test(t);
}

export const STATUS_LABEL: Record<BillingStatus, string> = {
  DRAFT: "טיוטה",
  PENDING_REVIEW: "ממתין לאישור",
  ISSUED: "הופק",
};

export const STATUS_STYLE: Record<
  BillingStatus,
  { bg: string; fg: string; border: string }
> = {
  DRAFT: { bg: TOKEN.surface.inset, fg: TOKEN.ink.secondary, border: TOKEN.border.DEFAULT },
  PENDING_REVIEW: { bg: TOKEN.semantic.attention.bg, fg: TOKEN.semantic.attention.ink, border: TOKEN.semantic.attention.border },
  ISSUED: { bg: TOKEN.semantic.success.bg, fg: TOKEN.semantic.success.ink, border: TOKEN.semantic.success.border },
};

export const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  TAX_INVOICE: "חשבונית מס",
  QUOTE: "הצעת מחיר",
};

/**
 * Formatters take the interface language (default Hebrew — byte-identical to the legacy output).
 * The language only picks the Intl locale; currency always comes from the document, and the time
 * zone stays Asia/Jerusalem.
 */
export function formatMoney(amount: string, currency: string, locale: Locale = "he"): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(intlTag(locale), {
      style: "currency",
      currency: currency || "ILS",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export function formatDate(iso: string | null, locale: Locale = "he"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(intlTag(locale), {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}

export function formatDateTime(iso: string | null, locale: Locale = "he"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(intlTag(locale), {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return iso;
  }
}

export function formatQuantity(value: string, locale: Locale = "he"): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat(intlTag(locale), {
    maximumFractionDigits: 4,
  }).format(n);
}

export function formatPercent(value: string, locale: Locale = "he"): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value}%`;
  const formatted = new Intl.NumberFormat(intlTag(locale), {
    maximumFractionDigits: 2,
  }).format(n);
  return `${formatted}%`;
}

/**
 * App-UI label for a document type. With a translator it follows the interface language; without
 * one it is the Hebrew label (unchanged). Never used for the issued document / PDF itself.
 */
export function getDocumentTypeLabel(type: string, t?: Translator): string {
  if (type === "TAX_INVOICE" || type === "QUOTE") {
    return t ? t(`billing.docType.${type}`) : DOCUMENT_TYPE_LABEL[type];
  }
  return DOCUMENT_TYPE_LABEL[type] ?? type;
}

/** App-UI label for a lifecycle status (Hebrew without a translator, as before). */
export function getStatusLabel(status: string, t?: Translator): string {
  if (status === "DRAFT" || status === "PENDING_REVIEW" || status === "ISSUED") {
    return t ? t(`billing.status.${status}`) : STATUS_LABEL[status];
  }
  return status;
}

export function resolveServerLineForDraft(
  line: LocalLine,
  docLines: BillingDocumentLine[]
): BillingDocumentLine | undefined {
  if (line.key.startsWith("s-")) {
    const lid = Number(line.key.slice(2));
    if (!Number.isFinite(lid)) return undefined;
    return docLines.find((l) => l.id === lid);
  }
  return undefined;
}
