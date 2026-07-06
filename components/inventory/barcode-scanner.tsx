"use client";

import { useCallback, useRef, useState, type ComponentProps } from "react";
import { Scanner } from "@yudiel/react-qr-scanner";
import { useModalDismiss } from "@/components/inventory/use-modal-dismiss";

/**
 * Shared inventory barcode scanner.
 *
 * One reusable overlay for every inventory flow that needs to read a barcode
 * (new product, general search, stock count) — so scanning logic is never
 * copied per screen. It wraps `@yudiel/react-qr-scanner` with retail-barcode
 * formats (EAN/UPC/Code-128…), a manual-entry fallback for when the camera is
 * unsupported or permission is denied, and Hebrew/RTL copy.
 *
 * Behaviour is driven by `mode`:
 *  - "single"     — stop after the first read; the parent closes the overlay
 *                   (used by product create + general search).
 *  - "continuous" — keep scanning; the same code re-fires after a short
 *                   cooldown so the same product can be counted repeatedly
 *                   without a single sighting double-counting (stock count).
 *
 * The component never touches inventory state itself — it only reports codes
 * via `onDetected`; each flow decides what a code means.
 */

// Retail barcode symbologies + qr_code as a convenience. Cast to the Scanner's
// own prop type so we don't take a direct import on the transitive
// `barcode-detector` package.
const BARCODE_FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "code_93",
  "codabar",
  "itf",
  "qr_code",
] as const;

type ScannerFormats = ComponentProps<typeof Scanner>["formats"];

/** Same code within this window (continuous mode) is treated as one sighting. */
const RESCAN_COOLDOWN_MS = 1400;

export type BarcodeScannerStatus = {
  text: string;
  tone?: "success" | "error" | "info";
};

type Props = {
  open: boolean;
  onClose: () => void;
  onDetected: (code: string) => void;
  mode?: "single" | "continuous";
  title?: string;
  hint?: string;
  /** Live feedback line rendered by the parent (mainly for continuous mode). */
  status?: BarcodeScannerStatus | null;
};

export default function BarcodeScanner(props: Props) {
  // Mount the body fresh each time the overlay opens so every session starts
  // with clean state — no reset-in-effect needed.
  if (!props.open) return null;
  return <BarcodeScannerBody {...props} />;
}

function BarcodeScannerBody({
  onClose,
  onDetected,
  mode = "single",
  title = "סריקת ברקוד",
  hint,
  status,
}: Props) {
  const [manualMode, setManualMode] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [cameraSupported] = useState(
    () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia
  );
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Single-mode lock so one read fires onDetected exactly once.
  const lockedRef = useRef(false);
  // Continuous-mode cooldown bookkeeping.
  const lastCodeRef = useRef<string | null>(null);
  const lastTimeRef = useRef(0);

  useModalDismiss({ isOpen: true, onClose });

  const accept = useCallback(
    (raw: string, { fromManual = false }: { fromManual?: boolean } = {}) => {
      const code = (raw || "").trim();
      if (!code) return;

      if (mode === "single") {
        if (lockedRef.current) return;
        lockedRef.current = true;
        onDetected(code);
        return;
      }

      // continuous
      const now = Date.now();
      if (
        !fromManual &&
        lastCodeRef.current === code &&
        now - lastTimeRef.current < RESCAN_COOLDOWN_MS
      ) {
        return; // same sighting — ignore the repeat
      }
      lastCodeRef.current = code;
      lastTimeRef.current = now;
      onDetected(code);
    },
    [mode, onDetected]
  );

  const handleManualSubmit = useCallback(() => {
    const code = manualValue.trim();
    if (!code) return;
    accept(code, { fromManual: true });
    setManualValue(""); // continuous mode keeps the overlay open for the next entry
  }, [accept, manualValue]);

  const showCamera = cameraSupported && !cameraError && !manualMode;

  const statusTone = status?.tone ?? "info";
  const statusColors: Record<string, { bg: string; ink: string; border: string }> = {
    success: { bg: "var(--inv-success-bg)", ink: "var(--inv-success)", border: "var(--inv-success-border)" },
    error: { bg: "var(--inv-danger-bg)", ink: "var(--inv-danger)", border: "var(--inv-danger-border)" },
    info: { bg: "var(--inv-info-bg)", ink: "var(--inv-info-ink)", border: "var(--inv-info-border)" },
  };
  const sc = statusColors[statusTone];

  return (
    <div
      dir="rtl"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--inv-backdrop)",
        zIndex: 300,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 440,
          borderRadius: 22,
          background: "var(--inv-card-bg)",
          boxShadow: "var(--inv-shadow-overlay)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 18px 12px",
            borderBottom: "1px solid var(--inv-surface-2)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, color: "var(--inv-text)" }}>{title}</div>
            {hint ? (
              <div style={{ marginTop: 4, fontSize: 13, color: "var(--inv-text-muted)" }}>{hint}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="סגירת חלון"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              border: "1px solid var(--inv-border)",
              background: "var(--inv-surface-2)",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Camera or manual body */}
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {showCamera ? (
            <div
              style={{
                width: "100%",
                minHeight: 300,
                borderRadius: 16,
                overflow: "hidden",
                background: "#000",
              }}
            >
              <Scanner
                formats={BARCODE_FORMATS as unknown as ScannerFormats}
                allowMultiple={mode === "continuous"}
                scanDelay={mode === "continuous" ? 300 : 400}
                sound={mode === "continuous"}
                constraints={{ facingMode: { ideal: "environment" } }}
                styles={{
                  container: { width: "100%", height: 300 },
                  video: { width: "100%", height: 300, objectFit: "cover", display: "block" },
                }}
                onScan={(codes) => {
                  const raw = codes?.[0]?.rawValue || "";
                  if (raw) accept(raw);
                }}
                onError={(err) => {
                  console.error("Barcode scanner error:", err);
                  setCameraError(
                    "לא הצלחנו להפעיל את המצלמה. אפשר לאשר הרשאת מצלמה או להזין ברקוד ידנית."
                  );
                }}
              />
            </div>
          ) : (
            <div
              style={{
                width: "100%",
                borderRadius: 16,
                border: "1px dashed var(--inv-border-hover)",
                background: "var(--inv-surface)",
                padding: "18px 16px",
                textAlign: "center",
                color: "var(--inv-text-muted)",
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              {cameraError
                ? cameraError
                : !cameraSupported
                ? "הדפדפן לא תומך בפתיחת מצלמה. אפשר להזין ברקוד ידנית."
                : "הזנת ברקוד ידנית"}
            </div>
          )}

          {/* Live status feedback (continuous counting) */}
          {status?.text ? (
            <div
              role="status"
              aria-live="polite"
              style={{
                background: sc.bg,
                border: `1px solid ${sc.border}`,
                color: sc.ink,
                borderRadius: 12,
                padding: "10px 12px",
                fontSize: 13,
                fontWeight: 600,
                textAlign: "center",
              }}
            >
              {status.text}
            </div>
          ) : null}

          {/* Manual entry — always available as a fallback */}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              inputMode="numeric"
              value={manualValue}
              onChange={(e) => setManualValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleManualSubmit();
                }
              }}
              placeholder="הזנת ברקוד ידנית"
              aria-label="הזנת ברקוד ידנית"
              style={{
                flex: 1,
                minHeight: 46,
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid var(--inv-border-hover)",
                fontSize: 14,
                background: "var(--inv-card-bg)",
                boxSizing: "border-box",
              }}
            />
            <button
              type="button"
              onClick={handleManualSubmit}
              disabled={!manualValue.trim()}
              style={{
                minHeight: 46,
                padding: "10px 16px",
                borderRadius: 12,
                border: "none",
                background: "var(--inv-primary)",
                color: "var(--inv-on-accent)",
                fontSize: 14,
                fontWeight: 600,
                cursor: manualValue.trim() ? "pointer" : "not-allowed",
                opacity: manualValue.trim() ? 1 : 0.6,
                flexShrink: 0,
              }}
            >
              אישור
            </button>
          </div>

          {/* Toggle back to camera when supported */}
          {cameraSupported && !cameraError && manualMode ? (
            <button
              type="button"
              onClick={() => setManualMode(false)}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--inv-accent)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                padding: 4,
              }}
            >
              ← חזרה לסריקה במצלמה
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
