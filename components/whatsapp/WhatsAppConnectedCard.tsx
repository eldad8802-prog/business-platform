"use client";

import { useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useWhatsAppConnect } from "./use-whatsapp-connect";
import type { WhatsAppPublicConnection } from "./use-whatsapp-connection";
import { WA_COPY, waConnectErrorText } from "./wa-copy";
import { IconChevronStart, IconPower, IconRefresh, IconSwap } from "./wa-icons";
import { WaAvatar, WaBadge, WaConnecting } from "./wa-ui";
import { WhatsAppDisconnectDialog } from "./WhatsAppDisconnectDialog";

/**
 * Settings — CONNECTED status card + owner actions.
 *
 * Renders only what the approved UX shows: the WhatsApp avatar, a "מחובר"
 * badge, the connected number, and three actions. No "אומת לאחרונה", no
 * "מזהה WABA", no token wording — nothing systemic.
 *
 * Reconnect / switch relaunch the official signup via {@link useWhatsAppConnect}
 * (the same flow as the invitation). Disconnect opens the confirmation sheet,
 * which calls the existing disconnect endpoint. Only the session bearer token
 * leaves the client.
 *
 * Also used for a row that still RECEIVES messages but is not healthy
 * (REVOKED_BY_META / ERROR): the card then shows the number with an
 * "needs attention" badge and the reason, instead of pretending no connection
 * exists. Inbound semantics are the server's (M2) — this is display only.
 */
export function WhatsAppConnectedCard({
  connection,
  onChanged,
}: {
  connection: WhatsAppPublicConnection;
  onChanged: () => void;
}) {
  const { status, detail, errorCode, start, reset, cancel } = useWhatsAppConnect(
    () => onChanged(),
    () => onChanged()
  );
  const attentionText =
    connection.status !== "CONNECTED" ? WA_COPY.attention[connection.status] ?? null : null;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const connecting = status === "connecting";
  const busy = connecting || disconnecting;

  function beginConnect() {
    if (status === "error") reset();
    start();
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setDisconnectError(null);
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    try {
      const res = await fetch(
        "/api/integrations/whatsapp/connection/disconnect",
        {
          method: "POST",
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        }
      );
      if (!res.ok) {
        setDisconnectError(WA_COPY.disconnect.error);
        setDisconnecting(false);
        return;
      }
      setDisconnecting(false);
      setConfirmOpen(false);
      onChanged();
    } catch {
      setDisconnectError(WA_COPY.disconnect.error);
      setDisconnecting(false);
    }
  }

  // Backend exchange in flight (after Meta popup closed).
  if (detail === "sending") return <WaConnecting />;

  const a = WA_COPY.settingsCard.actions;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section
        style={{
          background: TOKEN.surface.card,
          borderRadius: TOKEN.radius.modal,
          boxShadow: TOKEN.shadow.floating,
          padding: 22,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 18,
          }}
        >
          <WaAvatar size={52} radius={TOKEN.radius.card} />
          {attentionText ? (
            <WaBadge tone="neutral" label={WA_COPY.attention.badge} />
          ) : (
            <WaBadge tone="success" label={WA_COPY.settingsCard.badge} />
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span
            style={{
              fontSize: TOKEN.font.meta,
              color: TOKEN.ink.muted,
              fontWeight: TOKEN.weight.semibold,
            }}
          >
            {WA_COPY.settingsCard.numberLabel}
          </span>
          <span
            dir="ltr"
            style={{
              fontSize: TOKEN.font.hero,
              fontWeight: TOKEN.weight.bold,
              color: TOKEN.ink.primary,
              textAlign: "right",
            }}
          >
            {connection.displayPhoneNumber}
          </span>
        </div>
      </section>

      {attentionText && (
        <div role="status" style={noticeStyle}>
          {attentionText}
        </div>
      )}

      {status === "error" && (
        <div
          role="alert"
          style={{
            background: TOKEN.semantic.info.bgSoft,
            border: `1px solid ${TOKEN.semantic.info.border}`,
            borderRadius: TOKEN.radius.input,
            padding: "10px 12px",
            fontSize: TOKEN.font.meta,
            color: TOKEN.semantic.info.ink,
            lineHeight: 1.5,
          }}
        >
          {WA_COPY.error.heading} — {waConnectErrorText(errorCode)}
        </div>
      )}

      <div
        style={{
          background: TOKEN.surface.card,
          borderRadius: TOKEN.radius.modal,
          boxShadow: TOKEN.shadow.floating,
          padding: "6px 18px",
        }}
      >
        <ActionRow
          icon={<IconRefresh size={20} />}
          title={a.reconnect.title}
          subtitle={a.reconnect.subtitle}
          onClick={beginConnect}
          disabled={busy}
          divider={false}
        />
        <ActionRow
          icon={<IconSwap size={20} />}
          title={a.switch.title}
          subtitle={a.switch.subtitle}
          onClick={beginConnect}
          disabled={busy}
          divider
        />
        <ActionRow
          icon={<IconPower size={20} />}
          title={a.disconnect.title}
          subtitle={a.disconnect.subtitle}
          onClick={() => setConfirmOpen(true)}
          disabled={busy}
          danger
          divider
        />
      </div>

      {connecting && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <p
            style={{
              margin: 0,
              fontSize: TOKEN.font.meta,
              color: TOKEN.ink.muted,
              textAlign: "center",
            }}
          >
            {WA_COPY.invitation.connecting}
          </p>
          <p style={{ margin: 0, fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, textAlign: "center", lineHeight: 1.5 }}>
            {WA_COPY.invitation.popupHint}
          </p>
          <button
            type="button"
            onClick={cancel}
            style={{
              border: "none",
              background: "transparent",
              padding: "4px 8px",
              fontFamily: "inherit",
              fontSize: TOKEN.font.meta,
              fontWeight: TOKEN.weight.semibold,
              color: TOKEN.ink.primary,
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            {WA_COPY.invitation.cancelLaunch}
          </button>
        </div>
      )}

      {confirmOpen && (
        <WhatsAppDisconnectDialog
          busy={disconnecting}
          error={disconnectError}
          onConfirm={handleDisconnect}
          onCancel={() => {
            if (disconnecting) return;
            setConfirmOpen(false);
            setDisconnectError(null);
          }}
        />
      )}
    </div>
  );
}

const noticeStyle: React.CSSProperties = {
  background: TOKEN.semantic.info.bgSoft,
  border: `1px solid ${TOKEN.semantic.info.border}`,
  borderRadius: TOKEN.radius.input,
  padding: "10px 12px",
  fontSize: TOKEN.font.meta,
  color: TOKEN.semantic.info.ink,
  lineHeight: 1.5,
};

function ActionRow({
  icon,
  title,
  subtitle,
  onClick,
  disabled,
  danger,
  divider,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
  divider: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: TOKEN.space.md,
        width: "100%",
        border: "none",
        background: "transparent",
        fontFamily: "inherit",
        textAlign: "right",
        padding: "15px 2px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        borderTop: divider ? `1px solid ${TOKEN.border.DEFAULT}` : "none",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 42,
          height: 42,
          flex: "0 0 42px",
          borderRadius: TOKEN.radius.card,
          background: danger ? TOKEN.semantic.urgent.bg : TOKEN.surface.inset,
          color: danger ? TOKEN.semantic.urgent.accent : TOKEN.ink.primary,
          display: "grid",
          placeItems: "center",
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: TOKEN.font.title,
            fontWeight: TOKEN.weight.semibold,
            color: danger ? TOKEN.semantic.urgent.ink : TOKEN.ink.primary,
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: "block",
            fontSize: TOKEN.font.meta,
            fontWeight: TOKEN.weight.medium,
            color: TOKEN.ink.muted,
            marginTop: 2,
          }}
        >
          {subtitle}
        </span>
      </span>
      <span aria-hidden style={{ color: TOKEN.ink.meta, display: "inline-flex" }}>
        <IconChevronStart size={18} />
      </span>
    </button>
  );
}
