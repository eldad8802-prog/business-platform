"use client";

import { useRouter } from "next/navigation";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import ConfidenceDots from "./ConfidenceDots";

function fmtMoney(n: number) {
  return `₪${n.toLocaleString("he-IL", { maximumFractionDigits: 2 })}`;
}

function formatShortDate(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function previewEmoji(item: InboxListItem): string {
  if (!item.preview.fileAvailable) return "📂";
  if (item.preview.kind === "pdf") return "📄";
  if (item.preview.kind === "image") return "🖼";
  return "📎";
}

export default function DocumentCard({ item }: { item: InboxListItem }) {
  const router = useRouter();
  const isPending = item.status === "needs_review";

  const vendor =
    item.financial?.vendorName ?? item.extracted?.vendorName ?? "לא צוין";
  const amountRaw =
    item.financial?.amount ?? item.extracted?.amount ?? null;
  const amountLabel =
    amountRaw != null && Number.isFinite(amountRaw) ? fmtMoney(amountRaw) : "—";
  const dateIso = item.financial?.date ?? item.extracted?.date ?? null;

  const goReview = () => router.push(`/documents/review/${item.documentId}`);

  return (
    <article
      dir="rtl"
      role="button"
      tabIndex={0}
      onClick={goReview}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          goReview();
        }
      }}
      style={{
        background: "#ffffff",
        border: "1px solid #dfe7f3",
        borderRadius: 14,
        padding: "14px 16px",
        boxShadow: "0 6px 18px rgba(15, 23, 42, 0.04)",
        cursor: "pointer",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        WebkitTapHighlightColor: "transparent",
        userSelect: "none",
      }}
    >
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 12,
          background: isPending
            ? "#fff7ed"
            : "#f0fdf4",
          border: isPending
            ? "1px solid #fed7aa"
            : "1px solid #bbf7d0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 21,
          flexShrink: 0,
        }}
        aria-hidden
      >
        {previewEmoji(item)}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 3,
          }}
        >
          <span
            style={{
              fontWeight: 800,
              color: "#0f172a",
              fontSize: 15,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
            title={vendor}
          >
            {vendor}
          </span>
          <span
            style={{
              fontWeight: 900,
              color: "#0f172a",
              fontSize: 16,
              flexShrink: 0,
            }}
          >
            {amountLabel}
          </span>
        </div>

        <div
          style={{
            fontSize: 12,
            color: "#6b7280",
            fontWeight: 600,
            marginBottom: 9,
          }}
        >
          {formatShortDate(dateIso || item.createdAt)} ·{" "}
          {item.source === "email" ? "מייל" : "העלאה"}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "4px 10px",
              borderRadius: 999,
              background: isPending ? "#fef3c7" : "#dcfce7",
              border: isPending ? "1px solid #fde68a" : "1px solid #bbf7d0",
              color: isPending ? "#92400e" : "#166534",
              fontSize: 12,
              fontWeight: 850,
            }}
          >
            <span aria-hidden>{isPending ? "⏳" : "✓"}</span>
            {isPending ? "ממתין לבדיקה" : "מאושר"}
          </span>
          <span
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              background: "#eff6ff",
              border: "1px solid #dbeafe",
              color: "#002b6b",
              fontSize: 12,
              fontWeight: 900,
            }}
          >
            פתח ←
          </span>
        </div>

        {isPending ? <ConfidenceDots dots={item.confidenceDots} /> : null}
      </div>
    </article>
  );
}
