"use client";

import { TOKEN } from "@/lib/design/tokens";
import { useWhatsAppConnect } from "./use-whatsapp-connect";
import { useI18n } from "@/components/i18n/I18nProvider";
import { waConnectErrorText } from "./wa-copy";
import { IconLock } from "./wa-icons";
import { WaAvatar, WaBadge, WaConnecting, WaPrimaryButton } from "./wa-ui";

/**
 * Moment 1 — the single, shared "connect WhatsApp" experience.
 *
 * Used by BOTH the Inbox first-connect and the Settings first-connect so there
 * is exactly one invitation flow (no wizard, no divergence). It owns the three
 * transient states of a connect attempt:
 *   - idle / launching → the invitation (CTA opens Meta's official popup)
 *   - sending          → "מחברים…" spinner
 *   - error            → generic retry surface
 *
 * All connect logic is delegated to {@link useWhatsAppConnect}. `onConnected`
 * fires once the backend has persisted the connection so the host can refresh
 * (and also when the backend outcome is uncertain — a timeout or a dropped
 * network — so the host re-reads the true state instead of trusting the error).
 *
 * `notice` renders above the invitation — used by Settings to say truthfully
 * that a previous number exists but no longer receives messages.
 */
export function WhatsAppConnectInvitation({
  onConnected,
  notice,
}: {
  onConnected: () => void;
  notice?: React.ReactNode;
}) {
  const { t } = useI18n();
  const { status, detail, errorCode, start, reset, cancel } = useWhatsAppConnect(
    () => onConnected(),
    () => onConnected()
  );

  if (status === "error") {
    return (
      <ConnectSurface>
        <div style={{ ...heroStyle, gap: TOKEN.space.lg }}>
          <WaBadge tone="neutral" label={t("inbox.whatsapp.error.badge")} />
          <div style={stackStyle}>
            <h1 style={headingStyle}>{t("inbox.whatsapp.error.heading")}</h1>
            <p style={bodyStyle}>{waConnectErrorText(errorCode, t)}</p>
          </div>
        </div>
        <div style={footerStyle}>
          <WaPrimaryButton
            label={t("inbox.whatsapp.error.retry")}
            onClick={() => {
              reset();
              start();
            }}
            comingSoon
          />
        </div>
      </ConnectSurface>
    );
  }

  if (detail === "sending") {
    return (
      <ConnectSurface>
        <WaConnecting />
      </ConnectSurface>
    );
  }

  const launching = detail === "launching";

  return (
    <ConnectSurface>
      {notice}
      <div className="wa-connect-hero" style={heroStyle}>
        <WaAvatar size={70} />
        <div style={stackStyle}>
          <h1 style={headingStyle}>{t("inbox.whatsapp.invitation.heading")}</h1>
          <p style={bodyStyle}>{t("inbox.whatsapp.invitation.body")}</p>
        </div>
        <div style={trustCardStyle}>
          <span
            aria-hidden
            style={{ color: TOKEN.brand.mid, display: "inline-flex", flex: "0 0 auto", marginTop: 1 }}
          >
            <IconLock size={15} />
          </span>
          <p
            style={{
              margin: 0,
              fontSize: TOKEN.font.meta,
              color: TOKEN.ink.secondary,
              lineHeight: 1.55,
            }}
          >
            {t("inbox.whatsapp.invitation.trust")}
          </p>
        </div>
      </div>

      <div style={footerStyle}>
        {/* WhatsApp Business connection is not open yet: the button stays, inactive, marked "בקרוב". */}
        <WaPrimaryButton
          label={launching ? t("inbox.whatsapp.invitation.connecting") : t("inbox.whatsapp.invitation.cta")}
          onClick={start}
          disabled={launching}
          showGlyph={!launching}
          comingSoon
        />
        {launching ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <p style={helperStyle}>{t("inbox.whatsapp.invitation.popupHint")}</p>
            <button type="button" onClick={cancel} style={linkButtonStyle}>
              {t("inbox.whatsapp.invitation.cancelLaunch")}
            </button>
          </div>
        ) : (
          <p style={helperStyle}>{t("inbox.whatsapp.invitation.helper")}</p>
        )}
      </div>
    </ConnectSurface>
  );
}

/**
 * Full-height, centered surface with bottom clearance for the global nav.
 * On a phone the action sits at the bottom, under the thumb. From 1200 there
 * is no thumb and no bottom nav, so the hero stops stretching and the action
 * stays directly under the explanation it belongs to.
 */
const CONNECT_DESK_CSS = `
@media (min-width: 1200px) {
  .wa-connect-surface { justify-content: center; }
  .wa-connect-body { flex: 0 0 auto !important; }
  .wa-connect-hero { flex: 0 0 auto !important; }
}
`;

function ConnectSurface({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="wa-connect-surface"
      style={{
        minHeight: "100vh",
        background: TOKEN.surface.page,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: `${TOKEN.space.xl}px ${TOKEN.space.lg}px 96px`,
        boxSizing: "border-box",
      }}
    >
      <style>{CONNECT_DESK_CSS}</style>
      <div
        className="wa-connect-body"
        style={{
          width: "100%",
          maxWidth: 420,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}

const heroStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  gap: TOKEN.space["2xl"],
  padding: `${TOKEN.space.xl}px 0`,
};

const stackStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: TOKEN.space.sm,
};

const headingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: TOKEN.font.hero,
  fontWeight: TOKEN.weight.bold,
  letterSpacing: "-0.01em",
  color: TOKEN.ink.primary,
  lineHeight: 1.25,
};

const bodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.medium,
  color: TOKEN.ink.muted,
  lineHeight: 1.55,
};

const trustCardStyle: React.CSSProperties = {
  width: "100%",
  background: TOKEN.surface.card,
  borderRadius: TOKEN.radius.modal,
  boxShadow: TOKEN.shadow.floating,
  padding: TOKEN.space.lg,
  display: "flex",
  alignItems: "flex-start",
  gap: TOKEN.space.sm,
  textAlign: "start",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: TOKEN.space.md,
};

const helperStyle: React.CSSProperties = {
  margin: 0,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.medium,
  color: TOKEN.ink.muted,
  textAlign: "center",
  lineHeight: 1.5,
};

const linkButtonStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: "4px 8px",
  fontFamily: "inherit",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  color: TOKEN.ink.primary,
  textDecoration: "underline",
  cursor: "pointer",
};
