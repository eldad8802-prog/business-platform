"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccessibleDialog } from "@/components/ui/accessibility";
import {
  buildDocumentDownloadName,
  fetchDocumentFileBlob,
} from "@/lib/documents/file-access";
import { getPreviewKind } from "@/lib/documents/review/preview";
import { TOKEN } from "@/lib/design/documents-theme";
import { glassActionStyle, primaryActionStyle } from "@/lib/design/documents-theme";

type Status = "loading" | "ready" | "error";

export type DocumentFilePreviewOverlayProps = {
  documentId: number;
  mimeType: string | null;
  title: string;
  vendorName?: string | null;
  onClose: () => void;
};

/**
 * Opens the original document file over the current screen. Fetches the
 * auth-protected file as a Blob, renders a PDF in an <iframe> or an image in
 * an <img>, and offers a direct download of the same fetched blob. Closing
 * returns to exactly the same screen (it is a portal overlay, no navigation).
 */
export default function DocumentFilePreviewOverlay({
  documentId,
  mimeType,
  title,
  vendorName,
  onClose,
}: DocumentFilePreviewOverlayProps) {
  const [status, setStatus] = useState<Status>("loading");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;

    void (async () => {
      try {
        const blob = await fetchDocumentFileBlob(documentId, { signal: ctrl.signal });
        if (!active) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobUrl(url);
        setStatus("ready");
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (active) setStatus("error");
      }
    })();

    return () => {
      active = false;
      ctrl.abort();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [documentId]);

  // WP1 A-11 via the shared A-18 primitive: role/aria-modal, focus trap + restore,
  // Escape, background inert, scroll lock — all inherited, no hand-rolling.
  const { dialogProps, backdropProps } = useAccessibleDialog({
    open: true,
    onClose,
    ariaLabel: "תצוגת מסמך מקור",
  });

  const kind = getPreviewKind("", mimeType);

  const handleDownload = () => {
    if (!blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = buildDocumentDownloadName({ documentId, vendorName, mimeType });
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      dir="rtl"
      className="documents-file-overlay"
      style={overlayStyle}
      {...backdropProps}
    >
      <section {...dialogProps} style={dialogStyle}>
        <header style={headerStyle}>
          <div style={titleStyle} title={title}>
            {title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <button
              type="button"
              onClick={handleDownload}
              disabled={status !== "ready"}
              style={downloadButtonStyle(status !== "ready")}
            >
              הורד מסמך
            </button>
            <button
              type="button"
              aria-label="סגור"
              onClick={onClose}
              style={closeButtonStyle}
            >
              ×
            </button>
          </div>
        </header>

        <div style={bodyStyle}>
          {status === "loading" ? (
            <div style={centerNoteStyle}>טוען מסמך…</div>
          ) : status === "error" ? (
            <div style={centerNoteStyle}>
              לא ניתן להציג את קובץ המקור כרגע.
            </div>
          ) : kind === "pdf" ? (
            <iframe src={blobUrl as string} title={title} style={frameStyle} />
          ) : kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- Secure object URL preview, not a static/image-optimization asset.
            <img src={blobUrl as string} alt={title} style={imageStyle} />
          ) : (
            <div style={centerNoteStyle}>
              סוג הקובץ אינו נתמך לתצוגה. אפשר להוריד אותו דרך הכפתור למעלה.
            </div>
          )}
        </div>
      </section>

      <style jsx global>{`
        @media (max-width: 640px) {
          .documents-file-overlay {
            padding: 0 !important;
            align-items: stretch !important;
          }
          .documents-file-overlay section {
            width: 100% !important;
            max-width: none !important;
            height: 100% !important;
            max-height: none !important;
            border-radius: 0 !important;
          }
        }
      `}</style>
    </div>,
    document.body
  );
}

const overlayStyle = {
  position: "fixed" as const,
  inset: 0,
  zIndex: 2147483600,
  background: "rgba(35, 48, 43, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
};

const dialogStyle = {
  width: "min(900px, 96vw)",
  height: "min(86vh, 900px)",
  display: "flex",
  flexDirection: "column" as const,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.modal,
  background: TOKEN.surface.overlay,
  boxShadow: TOKEN.shadow.floating,
  overflow: "hidden",
};

const headerStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "12px 14px",
  borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
};

const titleStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  minWidth: 0,
};

const downloadButtonStyle = (disabled: boolean) =>
  ({
    ...primaryActionStyle({ disabled, height: 40 }),
    minHeight: 40,
    padding: "0 16px",
    fontSize: TOKEN.font.body,
    whiteSpace: "nowrap" as const,
  }) as const;

const closeButtonStyle = {
  ...glassActionStyle({ height: 40 }),
  width: 40,
  height: 40,
  fontSize: 24,
  lineHeight: 1,
  padding: 0,
} as const;

const bodyStyle = {
  flex: 1,
  minHeight: 0,
  background: TOKEN.surface.inset,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 12,
};

const frameStyle = {
  width: "100%",
  height: "100%",
  border: "none",
  borderRadius: TOKEN.radius.input,
  background: TOKEN.surface.card,
} as const;

const imageStyle = {
  maxWidth: "100%",
  maxHeight: "100%",
  objectFit: "contain" as const,
  borderRadius: TOKEN.radius.input,
  background: TOKEN.surface.card,
};

const centerNoteStyle = {
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  textAlign: "center" as const,
  padding: 24,
  lineHeight: 1.6,
};
