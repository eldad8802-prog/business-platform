"use client";

import { reviewCard } from "./review-ui";

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
  return (
    <section style={reviewCard}>
      <div style={{ fontWeight: 950, color: "#0d1b3d", fontSize: 18, marginBottom: 14 }}>
        תצוגת מסמך
      </div>

      {showPreviewFallback ? (
        <div
          style={{
            border: "1px dashed #d8e2f2",
            borderRadius: 22,
            background: "#f8fbff",
            padding: 26,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 36, marginBottom: 8 }}>PDF</div>
          <div style={{ fontSize: 18, fontWeight: 950, color: "#0d1b3d" }}>
            {previewLoading ? "טוען תצוגת מסמך..." : "אין תצוגה מקדימה זמינה"}
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: 14,
              color: "#6b7899",
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
            borderRadius: 18,
            border: "1px solid #e1e8f4",
            background: "#ffffff",
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
            borderRadius: 18,
            border: "1px solid #e1e8f4",
            display: "block",
            background: "#ffffff",
          }}
        />
      )}
    </section>
  );
}
