"use client";

import { reviewCard } from "./review-ui";
import { TOKEN } from "@/lib/design/documents-theme";
import { glassActionStyle } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";

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
  const { t } = useI18n();

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
          {t("documents.review.preview.title")}
        </div>
        {canOpenFull ? (
          <a
            href={fileBlobUrl as string}
            target="_blank"
            rel="noopener noreferrer"
            style={openFullButtonStyle}
          >
            <ExternalIcon />
            {t("documents.review.preview.openFull")}
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
            {previewLoading
              ? t("documents.review.preview.loading")
              : t("documents.review.preview.unavailable")}
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
              ? t("documents.review.preview.downloading")
              : t("documents.review.preview.extractedStillAvailable")}
          </div>
        </div>
      ) : previewKind === "pdf" ? (
        <iframe
          src={fileBlobUrl as string}
          title={t("documents.review.preview.title")}
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
          alt={t("documents.review.preview.title")}
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
