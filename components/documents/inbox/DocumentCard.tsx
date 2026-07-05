"use client";

import { useRouter } from "next/navigation";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import { CATEGORY_MAP } from "@/lib/constants/categories";
import { TOKEN } from "@/lib/design/documents-theme";
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

function sourceLabel(source: string): string {
  if (source === "email") return "מייל";
  if (source === "whatsapp") return "WhatsApp";
  return "העלאה";
}

function docKindLabel(item: InboxListItem): string {
  if (item.preview.kind === "pdf") return "PDF";
  if (item.preview.kind === "image") return "תמונה";
  return "קובץ";
}

export default function DocumentCard({ item }: { item: InboxListItem }) {
  const router = useRouter();
  const isPending = item.status === "needs_review";
  const vendor =
    item.financial?.vendorName ?? item.extracted?.vendorName ?? "לא צוין";
  const amountRaw = item.financial?.amount ?? item.extracted?.amount ?? null;
  const amountLabel =
    amountRaw != null && Number.isFinite(amountRaw) ? fmtMoney(amountRaw) : "—";
  const dateIso = item.financial?.date ?? item.extracted?.date ?? item.createdAt;
  const categoryRaw = item.financial?.category ?? item.extracted?.category ?? null;
  const category = categoryRaw ? CATEGORY_MAP[categoryRaw] ?? categoryRaw : "כללי";
  const meta = [formatShortDate(dateIso), category, sourceLabel(item.source), docKindLabel(item)]
    .filter(Boolean)
    .join(" · ");

  const goReview = () => router.push(`/documents/review/${item.documentId}`);

  return (
    <article
      dir="rtl"
      role="button"
      tabIndex={0}
      onClick={goReview}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          goReview();
        }
      }}
      style={cardStyle}
    >
      <div style={thumbStyle} aria-hidden>
        {item.preview.kind === "pdf" ? (
          <FileTextIcon />
        ) : item.preview.kind === "image" ? (
          <ImageIcon />
        ) : (
          <PaperclipIcon />
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={rowTopStyle}>
          <span style={vendorStyle} title={vendor}>
            {vendor}
          </span>
          <span style={amountStyle}>{amountLabel}</span>
        </div>
        <div style={metaStyle}>{meta}</div>
        {isPending ? <ConfidenceDots dots={item.confidenceDots} /> : null}
      </div>

      <div style={statusWrapStyle}>
        <span style={statusPillStyle}>{isPending ? "ממתין" : "אושר"}</span>
        <span style={arrowStyle} aria-hidden>
          ‹
        </span>
      </div>
    </article>
  );
}

function FileTextIcon() {
  return (
    <svg width="25" height="25" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M14 3v5h5M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="25" height="25" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="5" width="16" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m7 16 3.5-3.5 2.5 2.5 2-2 2 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="9" r="1.2" fill="currentColor" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="25" height="25" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m8.5 12.5 5.7-5.7a3 3 0 0 1 4.2 4.2l-7.1 7.1a4.5 4.5 0 0 1-6.4-6.4l7-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const cardStyle = {
  minHeight: 82,
  background: TOKEN.surface.card,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  padding: "12px",
  boxShadow: TOKEN.shadow.elevated,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 12,
  WebkitTapHighlightColor: "transparent",
  userSelect: "none",
} as const;

const thumbStyle = {
  width: 48,
  height: 58,
  borderRadius: TOKEN.radius.input,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.inset,
  color: TOKEN.ink.secondary,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: TOKEN.font.caption,
  fontWeight: TOKEN.weight.bold,
  flexShrink: 0,
} as const;

const rowTopStyle = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
  minWidth: 0,
} as const;

const vendorStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const amountStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  flexShrink: 0,
} as const;

const metaStyle = {
  marginTop: 4,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const statusWrapStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexShrink: 0,
} as const;

const statusPillStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 26,
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.semantic.attention.bgSoft,
  border: `1px solid ${TOKEN.semantic.attention.border}`,
  color: TOKEN.semantic.attention.ink,
  padding: "0 9px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
} as const;

const arrowStyle = {
  color: TOKEN.ink.meta,
  fontSize: TOKEN.font.display,
  lineHeight: 1,
} as const;
