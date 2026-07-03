"use client";

import { TOKEN } from "@/lib/design/tokens";
import { useWhatsAppConnect } from "@/components/whatsapp/use-whatsapp-connect";
import { WA_COPY } from "@/components/whatsapp/wa-copy";
import { IconAlertTriangle } from "@/components/whatsapp/wa-icons";
import { WhatsAppConnectInvitation } from "@/components/whatsapp/WhatsAppConnectInvitation";

/**
 * Inbox-facing composition of the WhatsApp connection surfaces.
 *
 * The connect experience itself lives in the shared
 * {@link WhatsAppConnectInvitation} (also used by Settings) — this file only
 * adapts it and the inbox-only pieces (reconnect banner, status loader) for the
 * "שיחות עם לקוחות" screen. All copy comes from {@link WA_COPY}.
 */

/** Never-connected → the single shared invitation (moment 1). */
export function WhatsAppInboxOnboarding({
  onConnected,
}: {
  onConnected: () => void;
}) {
  return <WhatsAppConnectInvitation onConnected={onConnected} />;
}

/** Broken/expired connection → slim banner above the conversation list. */
export function WhatsAppReconnectBanner({
  onConnected,
}: {
  onConnected: () => void;
}) {
  const { status, start, reset } = useWhatsAppConnect(() => onConnected());
  const connecting = status === "connecting";
  const failed = status === "error";
  const c = WA_COPY.banner;

  return (
    <div dir="rtl">
      <div
        role="status"
        style={{
          display: "flex",
          alignItems: "center",
          gap: TOKEN.space.md,
          margin: TOKEN.space.md,
          padding: TOKEN.space.md,
          borderRadius: TOKEN.radius.modal,
          background: TOKEN.semantic.attention.bg,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 38,
            height: 38,
            flex: "0 0 38px",
            borderRadius: TOKEN.radius.card,
            background: TOKEN.semantic.attention.border,
            color: TOKEN.semantic.attention.ink,
            display: "grid",
            placeItems: "center",
          }}
        >
          <IconAlertTriangle size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: TOKEN.font.body,
              fontWeight: TOKEN.weight.bold,
              color: TOKEN.semantic.attention.ink,
              lineHeight: 1.3,
            }}
          >
            {failed ? c.failedTitle : c.title}
          </div>
          <div
            style={{
              fontSize: TOKEN.font.caption,
              fontWeight: TOKEN.weight.medium,
              color: TOKEN.semantic.attention.ink,
              marginTop: 1,
              opacity: 0.85,
            }}
          >
            {failed ? c.failedSubtitle : c.subtitle}
          </div>
        </div>
        <button
          type="button"
          onClick={
            failed
              ? () => {
                  reset();
                  start();
                }
              : start
          }
          disabled={connecting}
          style={{
            flex: "0 0 auto",
            border: "none",
            borderRadius: TOKEN.radius.input,
            padding: `${TOKEN.space.sm}px ${TOKEN.space.md}px`,
            background: TOKEN.semantic.attention.ink,
            color: TOKEN.ink.inverse,
            fontSize: TOKEN.font.meta,
            fontWeight: TOKEN.weight.bold,
            fontFamily: "inherit",
            cursor: connecting ? "wait" : "pointer",
          }}
        >
          {connecting ? c.connecting : failed ? c.retry : c.button}
        </button>
      </div>
      <div
        style={{
          fontSize: TOKEN.font.caption,
          fontWeight: TOKEN.weight.medium,
          color: TOKEN.ink.meta,
          textAlign: "center",
          padding: `0 ${TOKEN.space.lg}px ${TOKEN.space.sm}px`,
          lineHeight: 1.5,
        }}
      >
        {c.footnote}
      </div>
    </div>
  );
}

/** Shown while the connection status is still resolving. */
export function InboxConnectionLoader() {
  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100vh",
        background: TOKEN.surface.page,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        color: TOKEN.ink.muted,
        fontSize: TOKEN.font.body,
        fontWeight: TOKEN.weight.medium,
      }}
    >
      {WA_COPY.loader}
    </div>
  );
}
