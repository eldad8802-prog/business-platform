"use client";

import { useRouter } from "next/navigation";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import { CATEGORY_MAP } from "@/lib/constants/categories";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table/data-table";
import { MoneyCell } from "@/components/ui/money-cell";

/**
 * Documents / Incoming — desktop review table (Artifact C). PRESENTATION only:
 * receives the SAME already-fetched, already-grouped `InboxListItem[]` the mobile
 * cards use, and renders the four approved columns (ספק · תאריך · קטגוריה · סכום).
 * Derivation mirrors DocumentCard verbatim. It never fetches, paginates, regroups,
 * or derives new business state. Opening navigates to the SAME review route.
 */

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function vendorOf(item: InboxListItem): string {
  return item.financial?.vendorName ?? item.extracted?.vendorName ?? "לא צוין";
}

function amountOf(item: InboxListItem): number | null {
  const raw = item.financial?.amount ?? item.extracted?.amount ?? null;
  return raw != null && Number.isFinite(raw) ? raw : null;
}

function dateOf(item: InboxListItem): string {
  return item.financial?.date ?? item.extracted?.date ?? item.createdAt;
}

function categoryOf(item: InboxListItem): string {
  const raw = item.financial?.category ?? item.extracted?.category ?? null;
  return raw ? CATEGORY_MAP[raw] ?? raw : "כללי";
}

const COLUMNS: DataTableColumn<InboxListItem>[] = [
  { key: "vendor", header: "ספק", width: "40%", render: (i) => vendorOf(i) },
  { key: "date", header: "תאריך", width: "20%", render: (i) => formatShortDate(dateOf(i)) },
  { key: "category", header: "קטגוריה", width: "20%", render: (i) => categoryOf(i) },
  { key: "amount", header: "סכום", width: "20%", align: "end", render: (i) => <MoneyCell amount={amountOf(i)} /> },
];

export default function DocumentsInboxTable({
  items,
  ariaLabel,
}: {
  items: InboxListItem[];
  ariaLabel?: string;
}) {
  const router = useRouter();
  return (
    <DataTable<InboxListItem>
      columns={COLUMNS}
      rows={items}
      getRowId={(i) => String(i.documentId)}
      onRowOpen={(i) => router.push(`/documents/review/${i.documentId}`)}
      ariaLabel={ariaLabel}
    />
  );
}
