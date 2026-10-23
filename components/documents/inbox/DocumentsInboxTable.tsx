"use client";

import { useRouter } from "next/navigation";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table/data-table";
import { MoneyCell } from "@/components/ui/money-cell";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";
import { categoryLabel } from "@/lib/documents/category-label";

/**
 * Documents / Incoming — desktop review table (Artifact C). PRESENTATION only:
 * receives the SAME already-fetched, already-grouped `InboxListItem[]` the mobile
 * cards use, and renders the four approved columns (ספק · תאריך · קטגוריה · סכום).
 * Derivation mirrors DocumentCard verbatim. It never fetches, paginates, regroups,
 * or derives new business state. Opening navigates to the SAME review route.
 */

function vendorOf(t: Translator, item: InboxListItem): string {
  return item.financial?.vendorName ?? item.extracted?.vendorName ?? t("documents.common.notSpecified");
}

function amountOf(item: InboxListItem): number | null {
  const raw = item.financial?.amount ?? item.extracted?.amount ?? null;
  return raw != null && Number.isFinite(raw) ? raw : null;
}

function dateOf(item: InboxListItem): string {
  return item.financial?.date ?? item.extracted?.date ?? item.createdAt;
}

function categoryOf(t: Translator, item: InboxListItem): string {
  const raw = item.financial?.category ?? item.extracted?.category ?? null;
  return raw ? categoryLabel(t, raw) : t("documents.common.general");
}

export default function DocumentsInboxTable({
  items,
  ariaLabel,
  onRowActivate,
  selectedId,
}: {
  items: InboxListItem[];
  ariaLabel?: string;
  /** Desktop queue: select in place. When omitted, the row opens review. */
  onRowActivate?: (item: InboxListItem) => void;
  selectedId?: number | null;
}) {
  const router = useRouter();
  const { t, formatDate } = useI18n();
  const columns: DataTableColumn<InboxListItem>[] = [
    { key: "vendor", header: t("documents.review.fields.vendor"), width: "40%", render: (i) => vendorOf(t, i) },
    {
      key: "date",
      header: t("documents.review.fields.date"),
      width: "20%",
      render: (i) => {
        const iso = dateOf(i);
        const text = iso ? formatDate(iso, "date") : "";
        return text === "—" ? "" : text;
      },
    },
    { key: "category", header: t("documents.review.fields.category"), width: "20%", render: (i) => categoryOf(t, i) },
    {
      key: "amount",
      header: t("documents.review.fields.amount"),
      width: "20%",
      align: "end",
      render: (i) => <MoneyCell amount={amountOf(i)} />,
    },
  ];
  return (
    <DataTable<InboxListItem>
      columns={columns}
      rows={items}
      getRowId={(i) => String(i.documentId)}
      selectedRowId={selectedId != null ? String(selectedId) : undefined}
      onRowOpen={(i) =>
        onRowActivate ? onRowActivate(i) : router.push(`/documents/review/${i.documentId}`)
      }
      ariaLabel={ariaLabel}
    />
  );
}
