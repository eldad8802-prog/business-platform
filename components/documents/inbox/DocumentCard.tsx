"use client";

import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import ConfidenceDots from "./ConfidenceDots";

const CARD: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 22,
  padding: 16,
  boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
  cursor: "pointer",
};

const TITLE_ROW: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  minWidth: 0,
};

const VENDOR: CSSProperties = {
  fontSize: 15,
  fontWeight: 950,
  color: "#111827",
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const AMOUNT: CSSProperties = {
  fontSize: 18,
  fontWeight: 950,
  color: "#111827",
  marginTop: 6,
};

const META: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#6b7280",
  marginTop: 4,
};

const FOOTER_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginTop: 10,
  gap: 10,
  flexWrap: "wrap",
};

const QUICK_BTN: CSSProperties = {
  padding: "10px 14px",
  borderRadius: 14,
  border: "1px solid #111827",
  background: "#111827",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 950,
  cursor: "default",
};

const OPEN_HINT: CSSProperties = {
  fontSize: 13,
  fontWeight: 900,
  color: "#0f766e",
};

function previewEmoji(item: InboxListItem): string {
  if (!item.preview.fileAvailable) return "📂";
  if (item.preview.kind === "pdf") return "📄";
  if (item.preview.kind === "image") return "🖼";
  return "📎";
}

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

export default function DocumentCard({ item }: { item: InboxListItem }) {
  const router = useRouter();
  const reviewPath = `/documents/review/${item.documentId}`;

  const vendor =
    item.financial?.vendorName ??
    item.extracted?.vendorName ??
    "לא צוין";

  const amountRaw =
    item.financial?.amount ?? item.extracted?.amount ?? null;
  const amountLabel =
    amountRaw != null && Number.isFinite(amountRaw) ? fmtMoney(amountRaw) : "—";

  const dateIso = item.financial?.date ?? item.extracted?.date ?? null;

  const goReview = () => {
    router.push(reviewPath);
  };

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
      style={CARD}
    >
      <div style={TITLE_ROW}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 14,
            background: "#f3f4f6",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 22,
            flexShrink: 0,
          }}
          aria-hidden
        >
          {previewEmoji(item)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={VENDOR} title={vendor}>
            {vendor}
          </div>
          <div style={META}>
            {item.source === "email" ? "מייל" : "העלאה"} ·{" "}
            {formatShortDate(item.createdAt)}
          </div>
        </div>
      </div>

      <div style={AMOUNT}>{amountLabel}</div>
      {dateIso ? (
        <div style={META}>תאריך מסמך: {formatShortDate(dateIso)}</div>
      ) : null}

      <ConfidenceDots dots={item.confidenceDots} />

      <div style={FOOTER_ROW}>
        {item.quickApproveEligible ? (
          <button
            type="button"
            style={QUICK_BTN}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            אישור מהיר
          </button>
        ) : (
          <span style={OPEN_HINT}>פתח לבדיקה</span>
        )}
        <span style={{ fontSize: 12, fontWeight: 800, color: "#9ca3af" }}>
          {item.status === "approved" ? "מאושר" : "ממתין"}
        </span>
      </div>
    </article>
  );
}
