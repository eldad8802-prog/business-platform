"use client";

import { useAccessibleDialog } from "@/components/ui/use-accessible-dialog";
import { TOKEN } from "@/lib/design/tokens";
import { WA_COPY } from "./wa-copy";
import { IconPower } from "./wa-icons";

/**
 * Disconnect confirmation — a bottom sheet over the dimmed settings card.
 *
 * Framed entirely around what happens inside Dubiz (stops receiving messages;
 * existing chats kept; can reconnect). No Meta-side instructions — see the
 * approved UX. The confirm calls back to the host, which POSTs to the existing
 * disconnect endpoint. Presentational only; no network here.
 */
export function WhatsAppDisconnectDialog({
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const c = WA_COPY.disconnect;
  const dialogRef = useAccessibleDialog<HTMLDivElement>({
    isOpen: true,
    onClose: () => {
      if (!busy) onCancel();
    },
  });

  return (
    <div
      dir="rtl"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(52, 60, 50, 0.42)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={c.title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 480,
          background: TOKEN.surface.overlay,
          borderRadius: `${TOKEN.radius.modal}px ${TOKEN.radius.modal}px 0 0`,
          boxShadow: TOKEN.shadow.floating,
          // Bottom clearance keeps the actions above the global app nav.
          padding: "14px 24px 88px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 40,
            height: 4,
            borderRadius: TOKEN.radius.pill,
            background: TOKEN.border.hover,
            margin: "0 auto 16px",
          }}
        />
        <div
          aria-hidden
          style={{
            width: 58,
            height: 58,
            borderRadius: TOKEN.radius.modal,
            background: TOKEN.semantic.urgent.bg,
            color: TOKEN.semantic.urgent.accent,
            display: "grid",
            placeItems: "center",
            margin: "0 auto 14px",
          }}
        >
          <IconPower size={26} />
        </div>

        <h2
          style={{
            margin: 0,
            fontSize: TOKEN.font.display,
            fontWeight: TOKEN.weight.bold,
            color: TOKEN.ink.primary,
            textAlign: "center",
            lineHeight: 1.3,
          }}
        >
          {c.title}
        </h2>
        <p
          style={{
            margin: "8px 0 0",
            fontSize: TOKEN.font.body,
            fontWeight: TOKEN.weight.medium,
            color: TOKEN.ink.muted,
            textAlign: "center",
            lineHeight: 1.55,
          }}
        >
          {c.body}
        </p>

        {error && (
          <p
            role="alert"
            style={{
              margin: "12px 0 0",
              fontSize: TOKEN.font.meta,
              color: TOKEN.semantic.urgent.ink,
              lineHeight: 1.5,
              textAlign: "center",
            }}
          >
            {error}
          </p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{
              height: 52,
              width: "100%",
              border: "none",
              borderRadius: TOKEN.radius.card,
              background: TOKEN.semantic.urgent.bg,
              color: TOKEN.semantic.urgent.ink,
              fontSize: TOKEN.font.title,
              fontWeight: TOKEN.weight.bold,
              fontFamily: "inherit",
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? c.confirmBusy : c.confirm}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              height: 52,
              width: "100%",
              border: "none",
              borderRadius: TOKEN.radius.card,
              background: TOKEN.surface.inset,
              color: TOKEN.ink.secondary,
              fontSize: TOKEN.font.title,
              fontWeight: TOKEN.weight.semibold,
              fontFamily: "inherit",
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {c.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
