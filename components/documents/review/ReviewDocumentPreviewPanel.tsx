"use client";

import type { PreviewView } from "@/lib/documents/review/preview-visibility";
import ReviewPreviewFallback from "./ReviewPreviewFallback";
import { TOKEN } from "@/lib/design/documents-theme";
import styles from "./review-adaptive.module.css";

export type ReviewDocumentPreviewPanelProps = {
  previewView: PreviewView;
  fileBlobUrl: string | null;
  onPreviewFailed: () => void;
  vendorDisplay: string;
  amountDisplay: string;
  dateDisplay: string;
  categoryDisplay: string;
  directionDisplay: string;
};

/**
 * The live source-file preview surface for the Review screen.
 *
 * Extracted verbatim from ReviewDecisionPanel (same soft-panel + inner card
 * frame, same pdf/image/loading/fallback branches) so it can be placed either
 * inline in the single-column decision card or in the desktop two-pane
 * workspace, without duplicating the fetch/blob lifecycle (that stays in the
 * page). Sizing is CSS-driven: 330px inline on mobile, taller on tablet, and
 * fills the pinned pane on desktop — no zoom/rotate/page controls are added.
 *
 * The palette/radii/shadows come from --rvw-* custom properties set on the
 * decision card ancestor, so no design literals live in the CSS module.
 */
export default function ReviewDocumentPreviewPanel({
  previewView,
  fileBlobUrl,
  onPreviewFailed,
  vendorDisplay,
  amountDisplay,
  dateDisplay,
  categoryDisplay,
  directionDisplay,
}: ReviewDocumentPreviewPanelProps) {
  return (
    <div className={styles.previewOuter} role="region" aria-label="תצוגת מסמך המקור">
      <div className={styles.previewInner}>
        {previewView === "pdf" ? (
          <iframe
            src={fileBlobUrl as string}
            title="תצוגת מסמך"
            onError={onPreviewFailed}
            className={styles.previewMedia}
          />
        ) : previewView === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- Secure object URL preview, not a static/image-optimization asset.
          <img
            src={fileBlobUrl as string}
            alt="תצוגת מסמך"
            onError={onPreviewFailed}
            className={styles.previewImg}
          />
        ) : previewView === "loading" ? (
          <div className={styles.previewLoading}>
            <div style={{ fontSize: 30 }} aria-hidden>
              ⏳
            </div>
            <div style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary }}>
              טוען תצוגת מסמך…
            </div>
            <div style={{ fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.muted }}>
              מורידים את קובץ המקור בצורה מאובטחת.
            </div>
          </div>
        ) : (
          <ReviewPreviewFallback
            vendorDisplay={vendorDisplay}
            amountDisplay={amountDisplay}
            dateDisplay={dateDisplay}
            categoryDisplay={categoryDisplay}
            directionDisplay={directionDisplay}
          />
        )}
      </div>
    </div>
  );
}
