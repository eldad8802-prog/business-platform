"use client";

import { reviewCard } from "./review-ui";
import { TOKEN } from "@/lib/design/documents-theme";
import { glassActionStyle } from "@/lib/design/documents-theme";

const toolbarStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 14,
} as const;

const openFullButtonStyle = {
  ...glassActionStyle({ height: 36 }),
  padding: "8px 12px",
  fontSize: TOKEN.font.meta,
  textDecoration: "none",
} as const;

function ExternalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M14 4h6v6M20 4l-8 8M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export type ReviewDocumentPreviewProps = {
  showPreviewFallback: boolean;
  previewLoading: boolean;
  previewKind: "pdf" | "image" | "unsupported";
  fileBlobUrl: string | null;
  onPreviewFailed: () => void;
};

export default function ReviewDocumentPreview({
  showPreviewFallback,
  previewLoading,
  previewKind,
  fileBlobUrl,
  onPreviewFailed,
}: ReviewDocumentPreviewProps) {
  const canOpenFull = !showPreviewFallback && !!fileBlobUrl;

  return (
    <section style={reviewCard}>
      <div style={toolbarStyle}>
        <div
          style={{
            fontWeight: TOKEN.weight.bold,
            color: TOKEN.ink.primary,
            fontSize: TOKEN.font.title,
          }}
        >
          תצוגת מסמך
        </div>
        {canOpenFull ? (
          <a
            href={fileBlobUrl as string}
            target="_blank"
            rel="noopener noreferrer"
            style={openFullButtonStyle}
          >
            <ExternalIcon />
            פתח במסך מלא
          </a>
        ) : null}
      </div>

      {showPreviewFallback ? (
        <div
          style={{
            border: `1px dashed ${TOKEN.border.DEFAULT}`,
            borderRadius: TOKEN.radius.card,
            background: TOKEN.surface.inset,
            padding: 26,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 36, marginBottom: 8 }}>PDF</div>
          <div
            style={{
              fontSize: TOKEN.font.title,
              fontWeight: TOKEN.weight.bold,
              color: TOKEN.ink.primary,
            }}
          >
            {previewLoading ? "טוען תצוגת מסמך..." : "אין תצוגה מקדימה זמינה"}
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: TOKEN.font.body,
              color: TOKEN.ink.muted,
              lineHeight: 1.6,
            }}
          >
            {previewLoading
              ? "מורידים את קובץ המקור בצורה מאובטחת."
              : "הנתונים שחולצו עדיין זמינים, גם אם קובץ המקור לא מוצג כרגע."}
          </div>
        </div>
      ) : previewKind === "pdf" ? (
        <iframe
          src={fileBlobUrl as string}
          title="תצוגת מסמך"
          onError={onPreviewFailed}
          style={{
            width: "100%",
            height: 520,
            borderRadius: TOKEN.radius.card,
            border: `1px solid ${TOKEN.border.DEFAULT}`,
            background: TOKEN.surface.card,
          }}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- Secure object URL preview, not a static/image-optimization asset.
        <img
          src={fileBlobUrl as string}
          alt="תצוגת מסמך"
          onError={onPreviewFailed}
          style={{
            width: "100%",
            maxHeight: 620,
            objectFit: "contain",
            borderRadius: TOKEN.radius.card,
            border: `1px solid ${TOKEN.border.DEFAULT}`,
            display: "block",
            background: TOKEN.surface.card,
          }}
        />
      )}
    </section>
  );
}
