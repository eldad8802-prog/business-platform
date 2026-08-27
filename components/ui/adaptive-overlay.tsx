"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LAYOUT } from "@/lib/design/tokens";
import { useAccessibleDialog } from "@/components/ui/use-accessible-dialog";

/**
 * AdaptiveOverlay — the canonical modal/sheet primitive
 * (Adaptive + Native Architecture Specification v1, §11; owner-approved).
 *
 * One component, one behavior contract:
 *  - < 640px viewport → bottom sheet (top radius, max-height 86dvh, bottom
 *    safe-area padding, slides over the shell bottom bar).
 *  - ≥ 640px → centered dialog, width by variant:
 *      confirm 400 · form 560 · wide min(900px, 92vw) · fullscreen inset 0.
 *  - Portals to #dz-overlay-root (outside .shell-content), so it never fights
 *    the shell's stacking context; z comes from LAYOUT.z.overlay.
 *  - Focus trap / Escape / scroll lock via the shared accessible-dialog hook.
 *  - RTL-safe (logical properties only).
 *
 * 640 is an overlay-internal sub-token (sheet↔dialog), deliberately NOT part
 * of the page form-factor scale — screens never use it.
 */

export type AdaptiveOverlayVariant = "confirm" | "form" | "wide" | "fullscreen";

const SHEET_MAX = 640;

const VARIANT_WIDTH: Record<AdaptiveOverlayVariant, string> = {
  confirm: "400px",
  form: "560px",
  wide: "min(900px, 92vw)",
  fullscreen: "100%",
};

export function AdaptiveOverlay({
  open,
  onClose,
  variant = "form",
  labelledBy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  variant?: AdaptiveOverlayVariant;
  /** id of the element that titles the dialog (aria-labelledby). */
  labelledBy?: string;
  children: ReactNode;
}) {
  const dialogRef = useAccessibleDialog<HTMLDivElement>({ isOpen: open, onClose });
  const [mounted, setMounted] = useState(false);
  const [isSheet, setIsSheet] = useState(false);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia(`(max-width: ${SHEET_MAX - 1}px)`);
    const sync = () => setIsSheet(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  if (!open || !mounted) return null;

  const target =
    document.getElementById("dz-overlay-root") ?? document.body;

  const fullscreen = variant === "fullscreen";
  const sheet = isSheet && !fullscreen;

  const backdrop: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: LAYOUT.z.overlay,
    background: "rgba(23, 20, 16, 0.45)",
    display: "flex",
    alignItems: sheet ? "flex-end" : "center",
    justifyContent: "center",
    padding: fullscreen ? 0 : sheet ? 0 : 24,
  };

  const panel: CSSProperties = fullscreen
    ? {
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "auto",
        overscrollBehavior: "contain",
        background: "#FEF8F2",
        paddingTop: "var(--dz-safe-top)",
        paddingBottom: "var(--dz-safe-bottom)",
      }
    : sheet
      ? {
          position: "relative",
          width: "100%",
          maxHeight: "86dvh",
          overflow: "auto",
          overscrollBehavior: "contain",
          background: "#FEF8F2",
          borderRadius: "22px 22px 0 0",
          padding: `18px 18px calc(18px + var(--dz-safe-bottom))`,
          boxSizing: "border-box",
        }
      : {
          position: "relative",
          width: "100%",
          maxWidth: VARIANT_WIDTH[variant],
          maxHeight: "min(82dvh, 900px)",
          overflow: "auto",
          overscrollBehavior: "contain",
          background: "#FEF8F2",
          borderRadius: 22,
          padding: 22,
          boxSizing: "border-box",
          boxShadow: "0 18px 60px rgba(23, 20, 16, 0.28)",
        };

  return createPortal(
    <div style={backdrop} onClick={onClose} data-component="dz-adaptive-overlay">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        style={panel}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    target
  );
}
