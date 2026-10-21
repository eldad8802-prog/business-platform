"use client";

import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import { TOKEN } from "@/lib/design/tokens";
import { useWhatsAppConnection } from "./use-whatsapp-connection";

/**
 * Inbox / Conversations entry prompt.
 *
 * Shows ONLY when WhatsApp is not connected. The CTA navigates to the
 * dedicated WhatsApp screen — it does not start any connection itself
 * (no Meta, no Embedded Signup). Renders nothing while loading, on error,
 * or once connected, so it is safe to mount anywhere in the inbox.
 */
export function WhatsAppConnectCard() {
  const { t } = useI18n();
  const router = useRouter();
  const state = useWhatsAppConnection();

  if (state.phase !== "disconnected") {
    return null;
  }

  return (
    <div
      style={{
        margin: TOKEN.space.lg,
        background: TOKEN.surface.card,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: TOKEN.radius.card,
        boxShadow: TOKEN.shadow.elevated,
        padding: TOKEN.space.lg,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: TOKEN.space.md,
        }}
      >
        <div
          aria-hidden
          style={{
            flexShrink: 0,
            width: 44,
            height: 44,
            borderRadius: TOKEN.radius.input,
            background: TOKEN.semantic.success.bgSoft,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 22,
            lineHeight: 1,
          }}
        >
          💬
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: TOKEN.font.title,
              fontWeight: TOKEN.weight.bold,
              color: TOKEN.ink.primary,
              lineHeight: 1.3,
            }}
          >
            {t("inbox.whatsapp.connectCard.title")}
          </div>
          <p
            style={{
              margin: `${TOKEN.space.sm}px 0 0`,
              fontSize: TOKEN.font.body,
              color: TOKEN.ink.secondary,
              lineHeight: 1.5,
            }}
          >
            {t("inbox.whatsapp.connectCard.body")}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => router.push("/settings/whatsapp")}
        style={{
          marginTop: TOKEN.space.lg,
          width: "100%",
          minHeight: 48,
          border: "none",
          borderRadius: TOKEN.radius.input,
          background: TOKEN.action.primary.background,
          color: TOKEN.ink.inverse,
          fontSize: TOKEN.font.title,
          fontWeight: TOKEN.weight.bold,
          fontFamily: "inherit",
          cursor: "pointer",
        }}
      >
        {t("inbox.whatsapp.connectCard.cta")}
      </button>
    </div>
  );
}
