"use client";

import { useRouter } from "next/navigation";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import { TOKEN } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";
import { categoryLabel } from "@/lib/documents/category-label";
import ConfidenceDots from "./ConfidenceDots";

function sourceLabel(t: Translator, source: string): string {
  if (source === "email") return t("documents.common.sourceEmail");
  if (source === "whatsapp") return "WhatsApp";
  return t("documents.common.sourceUpload");
}

function docKindLabel(t: Translator, item: InboxListItem): string {
  if (item.preview.kind === "pdf") return "PDF";
  if (item.preview.kind === "image") return t("documents.common.kindImage");
  return t("documents.common.kindFile");
}

export default function DocumentCard({ item }: { item: InboxListItem }) {
  const router = useRouter();
  const { t, formatAmount, formatDate } = useI18n();
  const isPending = item.status === "needs_review";
  const vendor =
    item.financial?.vendorName ?? item.extracted?.vendorName ?? t("documents.common.notSpecified");
  const amountRaw = item.financial?.amount ?? item.extracted?.amount ?? null;
  const amountLabel = formatAmount(amountRaw, "ILS");
  const dateIso = item.financial?.date ?? item.extracted?.date ?? item.createdAt;
  const formattedDate = dateIso ? formatDate(dateIso, "date") : "";
  const categoryRaw = item.financial?.category ?? item.extracted?.category ?? null;
  const category = categoryRaw ? categoryLabel(t, categoryRaw) : t("documents.common.general");
  const meta = [formattedDate === "—" ? "" : formattedDate, category, sourceLabel(t, item.source), docKindLabel(t, item)]
    .filter(Boolean)
    .join(" · ");

  const goReview = () => router.push(`/documents/review/${item.documentId}`);

  return (
    <article
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
        <span style={statusPillStyle}>
          {isPending ? t("documents.inbox.statusPending") : t("documents.inbox.statusApproved")}
        </span>
        <span style={arrowStyle} aria-hidden>
          {t("documents.common.chevronForward")}
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
