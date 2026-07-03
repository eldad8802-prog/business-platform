"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InboxListItem } from "@/lib/documents/inbox-types";
import { TOKEN } from "@/lib/design/tokens";

function sourceLabel(source: string): string {
  if (source === "email") return "מייל";
  if (source === "whatsapp") return "WhatsApp";
  return "העלאה";
}

function kindLabel(item: InboxListItem): string {
  if (item.preview.kind === "pdf") return "PDF";
  if (item.preview.kind === "image") return "תמונה";
  return "קובץ";
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Inbox card for the intermediate upload states (status "processing" / "failed").
 * Lets the user see a document the moment Phase 1 persists it — before OCR /
 * extraction finish — and retry a failed one without re-uploading.
 */
export default function ProcessingCard({
  item,
  authToken,
  onRetried,
}: {
  item: InboxListItem;
  authToken: string | null;
  onRetried: () => void;
}) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");

  const isFailed = item.status === "failed";
  const meta = [sourceLabel(item.source), kindLabel(item), formatTime(item.createdAt)]
    .filter(Boolean)
    .join(" · ");

  async function retry() {
    if (!authToken || retrying) return;
    setRetrying(true);
    setRetryError("");
    try {
      const res = await fetch(`/api/documents/${item.documentId}/process`, {
        method: "POST",
        headers: { authorization: authToken },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "נסה שוב מאוחר יותר");
      }
      onRetried();
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : "נסה שוב מאוחר יותר");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <article dir="rtl" style={cardStyle}>
      <div
        style={{
          ...thumbStyle,
          color: isFailed ? TOKEN.semantic.urgent.ink : TOKEN.brand.mid,
        }}
        aria-hidden
      >
        {isFailed ? <AlertIcon /> : <span style={spinnerStyle} />}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={titleStyle}>
          {isFailed ? "העלאה נכשלה" : "מעבד מסמך…"}
        </div>
        <div style={metaStyle}>{meta}</div>
        {retryError ? <div style={retryErrorStyle}>{retryError}</div> : null}
      </div>

      <div style={statusWrapStyle}>
        {isFailed ? (
          <button
            type="button"
            onClick={retry}
            disabled={retrying}
            style={{ ...retryButtonStyle, opacity: retrying ? 0.6 : 1 }}
          >
            {retrying ? "מנסה…" : "נסה שוב"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => router.push(`/documents/review/${item.documentId}`)}
            style={statusPillStyle}
          >
            בעיבוד
          </button>
        )}
      </div>
    </article>
  );
}

function AlertIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
  display: "flex",
  alignItems: "center",
  gap: 12,
} as const;

const thumbStyle = {
  width: 48,
  height: 58,
  borderRadius: TOKEN.radius.input,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.inset,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
} as const;

const spinnerStyle = {
  width: 22,
  height: 22,
  borderRadius: TOKEN.radius.pill,
  border: `3px solid ${TOKEN.brand.softBorder}`,
  borderTopColor: TOKEN.brand.mid,
  display: "inline-block",
  animation: "documents-processing-spin 0.8s linear infinite",
} as const;

const titleStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
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

const retryErrorStyle = {
  marginTop: 4,
  color: TOKEN.semantic.urgent.ink,
  fontSize: TOKEN.font.caption,
  fontWeight: TOKEN.weight.semibold,
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
  minHeight: 30,
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.surface.inset,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  color: TOKEN.ink.secondary,
  padding: "0 12px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
} as const;

const retryButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 34,
  borderRadius: TOKEN.radius.button,
  background: TOKEN.brand.gradient,
  border: "none",
  color: TOKEN.ink.inverse,
  padding: "0 14px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
} as const;
