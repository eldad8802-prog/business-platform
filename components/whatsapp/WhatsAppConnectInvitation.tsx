"use client";

import { TOKEN } from "@/lib/design/tokens";
import { useWhatsAppConnect } from "./use-whatsapp-connect";
import { WA_COPY } from "./wa-copy";
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
 * fires once the backend has persisted the connection so the host can refresh.
 */
export function WhatsAppConnectInvitation({
  onConnected,
}: {
  onConnected: () => void;
}) {
  const { status, detail, start, reset } = useWhatsAppConnect(() => onConnected());

  if (status === "error") {
    return (
      <ConnectSurface>
        <div style={{ ...heroStyle, gap: TOKEN.space.lg }}>
          <WaBadge tone="neutral" label={WA_COPY.error.badge} />
          <div style={stackStyle}>
            <h1 style={headingStyle}>{WA_COPY.error.heading}</h1>
            <p style={bodyStyle}>{WA_COPY.error.body}</p>
          </div>
        </div>
        <div style={footerStyle}>
          <WaPrimaryButton
            label={WA_COPY.error.retry}
            onClick={() => {
              reset();
              start();
            }}
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
  const c = WA_COPY.invitation;

  return (
    <ConnectSurface>
      <div style={heroStyle}>
        <WaAvatar size={70} />
        <div style={stackStyle}>
          <h1 style={headingStyle}>{c.heading}</h1>
          <p style={bodyStyle}>{c.body}</p>
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
            {c.trust}
          </p>
        </div>
      </div>

      <div style={footerStyle}>
        <WaPrimaryButton
          label={launching ? c.connecting : c.cta}
          onClick={start}
          disabled={launching}
          showGlyph={!launching}
        />
        <p style={helperStyle}>{c.helper}</p>
      </div>
    </ConnectSurface>
  );
}

/** Full-height, centered surface with bottom clearance for the global nav. */
function ConnectSurface({ children }: { children: React.ReactNode }) {
  return (
    <div
      dir="rtl"
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
      <div
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
  textAlign: "right",
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
