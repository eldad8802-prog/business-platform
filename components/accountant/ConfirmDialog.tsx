"use client";

import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import { TOKEN, glassActionStyle, primaryActionStyle, dangerActionStyle } from "@/lib/design/documents-theme";

/**
 * Styled replacement for `window.confirm` (owner-approved 2026-11-02) with the
 * SAME contract: the exact question text, "אישור" runs the action, and every
 * other way out — "ביטול", the backdrop, Escape — does nothing. Initial focus
 * lands on "אישור" (first focusable), as in the browser dialog, so Enter still
 * confirms. Bottom sheet under 640px, centered dialog above (AdaptiveOverlay).
 */
export function ConfirmDialog({
  message,
  danger = false,
  onConfirm,
  onCancel,
}: {
  message: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AdaptiveOverlay open onClose={onCancel} variant="confirm" labelledBy="dz-confirm-text" scope="documents">
      <div dir="rtl" style={{ color: TOKEN.ink.primary }}>
        <p id="dz-confirm-text" style={{ margin: "4px 2px 18px", fontSize: 17, fontWeight: 600, lineHeight: 1.55 }}>
          {message}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <button
            type="button"
            style={danger ? dangerActionStyle({ fullWidth: true, height: 50 }) : primaryActionStyle({ fullWidth: true, height: 50 })}
            onClick={onConfirm}
          >
            אישור
          </button>
          <button type="button" style={glassActionStyle({ fullWidth: true, height: 50 })} onClick={onCancel}>
            ביטול
          </button>
        </div>
      </div>
    </AdaptiveOverlay>
  );
}
