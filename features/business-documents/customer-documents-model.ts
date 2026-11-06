/**
 * ר3 — a customer's documents as a read-only timeline. Pure: no fetch, no clock.
 *
 * The rows come, unchanged, from the EXISTING GET /api/billing/documents?customerId=…
 * (server-side auth + tenant transaction). Nothing here computes balances or any
 * figure of its own: every value shown is a field the billing service already
 * returned. Grouping is by the document's own date in Israel time.
 */

export type BillingListRow = {
  id: number;
  documentType: string;
  status: string;
  documentNumberFormatted: string | null;
  customerNameSnapshot: string | null;
  totalAmount: string | number;
  currency: string;
  issuedAt: string | null;
  createdAt: string;
};

export type TimelineItem = {
  id: number;
  href: string;
  title: string;
  statusLabel: string;
  statusTone: "ok" | "warn" | "neutral";
  dateLabel: string;
  amountLabel: string;
};

export type TimelineGroup = { key: string; label: string; items: TimelineItem[] };

const TYPE_LABEL: Record<string, string> = {
  TAX_INVOICE: "חשבונית מס",
  TAX_INVOICE_RECEIPT: "חשבונית מס/קבלה",
  RECEIPT: "קבלה",
  CREDIT_NOTE: "חשבונית זיכוי",
  QUOTE: "הצעת מחיר",
};

const STATUS: Record<string, { label: string; tone: TimelineItem["statusTone"] }> = {
  DRAFT: { label: "טיוטה", tone: "neutral" },
  PENDING_REVIEW: { label: "ממתין לבדיקה", tone: "warn" },
  ISSUED: { label: "הופק", tone: "ok" },
};

const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

/** The date a document is placed by: its issue date when issued, otherwise its creation date. */
export function documentDate(row: Pick<BillingListRow, "issuedAt" | "createdAt">): string {
  return row.issuedAt ?? row.createdAt;
}

/** Year / month / day of an ISO instant in Asia/Jerusalem. */
export function jerusalemParts(iso: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

export function formatAmount(value: string | number, currency: string): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  try {
    return new Intl.NumberFormat("he-IL", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export function toTimelineItem(row: BillingListRow): TimelineItem {
  const typeLabel = TYPE_LABEL[row.documentType] ?? "מסמך";
  const status = STATUS[row.status] ?? { label: row.status, tone: "neutral" as const };
  const { y, m, d } = jerusalemParts(documentDate(row));
  return {
    id: row.id,
    href: `/billing/${row.id}`,
    title: row.documentNumberFormatted ? `${typeLabel} ${row.documentNumberFormatted}` : typeLabel,
    statusLabel: status.label,
    statusTone: status.tone,
    dateLabel: `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`,
    amountLabel: formatAmount(row.totalAmount, row.currency),
  };
}

/** Newest first, grouped by month. Input order does not matter; ties break by id (newest first). */
export function buildTimeline(rows: BillingListRow[]): TimelineGroup[] {
  const sorted = [...rows].sort((a, b) => {
    const t = Date.parse(documentDate(b)) - Date.parse(documentDate(a));
    return t !== 0 ? t : b.id - a.id;
  });
  const groups: TimelineGroup[] = [];
  for (const row of sorted) {
    const { y, m } = jerusalemParts(documentDate(row));
    const key = `${y}-${String(m).padStart(2, "0")}`;
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, label: `${MONTHS[m - 1]} ${y}`, items: [] };
      groups.push(g);
    }
    g.items.push(toTimelineItem(row));
  }
  return groups;
}

/** Merge a further page into what is shown, dropping any row already present (a retried page). */
export function mergePages(current: BillingListRow[], next: BillingListRow[]): BillingListRow[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...next.filter((r) => !seen.has(r.id))];
}

export function errorText(status: number | null): string {
  if (status === 401) return "צריך להתחבר מחדש.";
  if (status === 403) return "אין הרשאה לצפות במסמכים האלה.";
  if (status === 404) return "הלקוח לא נמצא.";
  return "לא הצלחנו לטעון את המסמכים. אפשר לנסות שוב.";
}
