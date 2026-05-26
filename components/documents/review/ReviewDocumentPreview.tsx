"use client";

import { card } from "@/app/(shell)/documents/ui";

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
    <section style={card}>
      <div style={{ fontWeight: 950, color: "#111827", fontSize: 16, marginBottom: 12 }}>
        תצוגת מסמך
      </div>

      {showPreviewFallback ? (
        <div
          style={{
            border: "1px dashed #d1d5db",
            borderRadius: 22,
            background: "#f9fafb",
            padding: 22,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 34, marginBottom: 8 }}>📄</div>
          <div style={{ fontSize: 18, fontWeight: 950, color: "#111827" }}>
            {previewLoading ? "טוען תצוגת מסמך..." : "אין תצוגה מקדימה זמינה"}
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: 14,
              color: "#6b7280",
              lineHeight: 1.6,
            }}
          >
            {previewLoading
              ? "מורידים את קובץ המקור."
              : "אין קובץ מקור זמין למסמך הזה. הנתונים שחולצו עדיין שמורים, אבל לא נשמר עותק להצגה."}
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
            border: "1px solid #e5e7eb",
            background: "#ffffff",
          }}
        />
      ) : (
        <img
          src={fileBlobUrl as string}
          alt="תצוגת מסמך"
          onError={onPreviewFailed}
          style={{
            width: "100%",
            maxHeight: 620,
            objectFit: "contain",
            borderRadius: 18,
            border: "1px solid #e5e7eb",
            display: "block",
            background: "#ffffff",
          }}
        />
      )}
    </section>
  );
}
