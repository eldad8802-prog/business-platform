"use client";

import { TOKEN } from "@/lib/design/tokens";
import { useWhatsAppConnect } from "@/components/whatsapp/use-whatsapp-connect";
import { useI18n } from "@/components/i18n/I18nProvider";
import { IconAlertTriangle } from "@/components/whatsapp/wa-icons";
import { WhatsAppConnectInvitation } from "@/components/whatsapp/WhatsAppConnectInvitation";
import { ComingSoonPill } from "@/components/ui/coming-soon/ComingSoonPill";

/**
 * Inbox-facing composition of the WhatsApp connection surfaces.
 *
 * The connect experience itself lives in the shared
 * {@link WhatsAppConnectInvitation} (also used by Settings) — this file only
 * adapts it and the inbox-only pieces (reconnect banner, status loader) for the
 * "שיחות עם לקוחות" screen. All copy comes from the i18n dictionary (`inbox.whatsapp.*`).
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
  const { status, detail, cancel } = useWhatsAppConnect(
    () => onConnected(),
    () => onConnected()
  );
  const connecting = status === "connecting";
  const failed = status === "error";
  const { t } = useI18n();

  return (
    <div>
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
            {failed ? t("inbox.whatsapp.banner.failedTitle") : t("inbox.whatsapp.banner.title")}
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
            {failed ? t("inbox.whatsapp.banner.failedSubtitle") : t("inbox.whatsapp.banner.subtitle")}
          </div>
        </div>
        {/* WhatsApp Business connection is not open yet: the reconnect button stays, inactive, marked "בקרוב". */}
        <button
          type="button"
          disabled
          style={{
            flex: "0 0 auto",
            display: "inline-flex",
            alignItems: "center",
            gap: TOKEN.space.xs,
            opacity: 0.6,
            border: "none",
            borderRadius: TOKEN.radius.input,
            padding: `${TOKEN.space.sm}px ${TOKEN.space.md}px`,
            background: TOKEN.semantic.attention.ink,
            color: TOKEN.ink.inverse,
            fontSize: TOKEN.font.meta,
            fontWeight: TOKEN.weight.bold,
            fontFamily: "inherit",
            cursor: "not-allowed",
          }}
        >
          {connecting ? t("inbox.whatsapp.banner.connecting") : failed ? t("inbox.whatsapp.banner.retry") : t("inbox.whatsapp.banner.button")}
          <ComingSoonPill />
        </button>
      </div>
      {detail === "launching" && (
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 6 }}>
          <button
            type="button"
            onClick={cancel}
            style={{
              border: "none",
              background: "transparent",
              fontFamily: "inherit",
              fontSize: TOKEN.font.meta,
              color: TOKEN.ink.muted,
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            {t("inbox.whatsapp.invitation.cancelLaunch")}
          </button>
        </div>
      )}
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
        {t("inbox.whatsapp.banner.footnote")}
      </div>
    </div>
  );
}

/** Shown while the connection status is still resolving. */
export function InboxConnectionLoader() {
  const { t } = useI18n();
  return (
    <div
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
      {t("inbox.whatsapp.loader")}
    </div>
  );
}
