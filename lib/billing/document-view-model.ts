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

export function newEmptyLocalLine(): LocalLine {
  return {
    key: generateLocalLineKey(),
    description: "",
    quantity: "1",
    unitPrice: "0",
    vatRatePercent: "17",
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

export function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: currency || "ILS",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("he-IL", {
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

export function formatQuantity(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat("he-IL", {
    maximumFractionDigits: 4,
  }).format(n);
}

export function formatPercent(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value}%`;
  const formatted = new Intl.NumberFormat("he-IL", {
    maximumFractionDigits: 2,
  }).format(n);
  return `${formatted}%`;
}

export function getDocumentTypeLabel(type: string): string {
  return DOCUMENT_TYPE_LABEL[type] ?? type;
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
