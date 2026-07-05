"use client";

/**
 * Lightweight inventory toast — no external library.
 *
 * Success feedback after save/update actions (per the inventory UX rule:
 * success → toast, validation errors → inline next to the field). Dispatch from
 * anywhere with `inventoryToast.success("…")`; a single <InventoryToastHost />
 * mounted in the inventory layout renders + auto-dismisses them. Because the host
 * lives in the layout it survives route changes, so a toast fired right before
 * router.push still shows on the next screen.
 */

import { useEffect, useState } from "react";

type ToastType = "success" | "error" | "info";
type ToastItem = { id: number; type: ToastType; message: string };

const TOAST_EVENT = "inventory-toast";
const TOAST_TTL_MS = 3200;
let toastCounter = 0;

export function inventoryToast(message: string, type: ToastType = "success") {
  if (typeof window === "undefined" || !message) return;
  window.dispatchEvent(
    new CustomEvent(TOAST_EVENT, { detail: { type, message } })
  );
}
inventoryToast.success = (message: string) => inventoryToast(message, "success");
inventoryToast.error = (message: string) => inventoryToast(message, "error");
inventoryToast.info = (message: string) => inventoryToast(message, "info");

const TONE: Record<ToastType, { bg: string; border: string; ink: string; icon: string }> = {
  success: { bg: "var(--inv-success-bg)", border: "var(--inv-success-border)", ink: "var(--inv-success)", icon: "✓" },
  error: { bg: "var(--inv-danger-bg)", border: "var(--inv-danger-border)", ink: "var(--inv-danger)", icon: "!" },
  info: { bg: "var(--inv-info-bg)", border: "var(--inv-info-border)", ink: "var(--inv-info-ink)", icon: "i" },
};

export function InventoryToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    function onToast(event: Event) {
      const detail = (event as CustomEvent).detail as
        | { type?: ToastType; message?: string }
        | undefined;
      if (!detail?.message) return;
      toastCounter += 1;
      const id = toastCounter;
      const type: ToastType = detail.type ?? "success";
      setToasts((current) => [...current, { id, type, message: detail.message as string }]);
      window.setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== id));
      }, TOAST_TTL_MS);
    }
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      dir="rtl"
      aria-live="polite"
      style={{
        position: "fixed",
        top: "calc(14px + env(safe-area-inset-top, 0px))",
        left: 0,
        right: 0,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: "0 16px",
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => {
        const tone = TONE[toast.type];
        return (
          <div
            key={toast.id}
            role="status"
            style={{
              pointerEvents: "auto",
              maxWidth: 420,
              width: "fit-content",
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: tone.bg,
              border: `1px solid ${tone.border}`,
              color: tone.ink,
              borderRadius: 14,
              padding: "11px 15px",
              fontSize: 14,
              fontWeight: 600,
              boxShadow: "var(--inv-shadow)",
            }}
          >
            <span
              aria-hidden
              style={{
                flexShrink: 0,
                width: 20,
                height: 20,
                borderRadius: 999,
                background: tone.ink,
                color: tone.bg,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {tone.icon}
            </span>
            <span>{toast.message}</span>
          </div>
        );
      })}
    </div>
  );
}
