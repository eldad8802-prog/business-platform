"use client";

import { TOKEN } from "@/lib/design/tokens";
import { useI18n } from "@/components/i18n/I18nProvider";
import { WhatsAppGlyph } from "./wa-icons";
import { ComingSoonPill } from "@/components/ui/coming-soon/ComingSoonPill";

/**
 * Small, presentational building blocks shared across the WhatsApp connection
 * surfaces (Inbox onboarding, Inbox empty state, Settings card). No logic, no
 * copy — colors/radii/shadows come only from the Dubiz design tokens.
 */

/** WhatsApp green rounded-square avatar with the glyph. */
export function WaAvatar({ size, radius }: { size: number; radius?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        borderRadius: radius ?? TOKEN.radius.modal,
        background: TOKEN.brand.whatsapp.gradient,
        boxShadow: TOKEN.brand.whatsapp.shadow,
        display: "grid",
        placeItems: "center",
      }}
    >
      <WhatsAppGlyph
        size={Math.round(size * 0.5)}
        circle={TOKEN.brand.whatsapp.ink}
        handset={TOKEN.brand.whatsapp.green}
      />
    </span>
  );
}

/** Full-width WhatsApp-green primary action. */
export function WaPrimaryButton({
  label,
  onClick,
  disabled = false,
  showGlyph = true,
  comingSoon = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  showGlyph?: boolean;
  /** Not open yet: inactive, with the "בקרוב" pill beside the label. */
  comingSoon?: boolean;
}) {
  const inactive = disabled || comingSoon;
  return (
    <button
      type="button"
      onClick={comingSoon ? undefined : onClick}
      disabled={inactive}
      style={{
        height: 52,
        width: "100%",
        border: "none",
        borderRadius: TOKEN.radius.card,
        background: inactive ? TOKEN.ink.disabled : TOKEN.brand.whatsapp.gradient,
        color: TOKEN.brand.whatsapp.ink,
        boxShadow: inactive ? TOKEN.shadow.none : TOKEN.brand.whatsapp.shadow,
        fontSize: TOKEN.font.title,
        fontWeight: TOKEN.weight.bold,
        fontFamily: "inherit",
        cursor: comingSoon ? "not-allowed" : disabled ? "wait" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: TOKEN.space.sm,
      }}
    >
      {showGlyph && (
        <WhatsAppGlyph
          size={22}
          circle={TOKEN.brand.whatsapp.ink}
          handset={TOKEN.brand.whatsapp.green}
        />
      )}
      {label}
      {comingSoon ? <ComingSoonPill /> : null}
    </button>
  );
}

/** Pill badge — success (מחובר) or neutral (לא הושלם). */
export function WaBadge({
  tone,
  label,
}: {
  tone: "success" | "neutral";
  label: string;
}) {
  const ok = tone === "success";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 12px",
        borderRadius: TOKEN.radius.pill,
        background: ok ? TOKEN.semantic.success.bg : TOKEN.surface.inset,
        color: ok ? TOKEN.semantic.success.ink : TOKEN.ink.muted,
        fontSize: TOKEN.font.meta,
        fontWeight: TOKEN.weight.bold,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: TOKEN.radius.pill,
          background: ok ? TOKEN.semantic.success.accent : TOKEN.ink.meta,
        }}
      />
      {label}
    </span>
  );
}

/** "מחברים…" centered spinner state (backend exchange in flight). */
export function WaConnecting() {
  const { t } = useI18n();
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: TOKEN.space.xl,
        padding: `${TOKEN.space["4xl"]}px 0`,
      }}
    >
      <style>{`@keyframes waSpin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.wa-spin{animation:none}}`}</style>
      <div
        className="wa-spin"
        aria-hidden
        style={{
          width: 52,
          height: 52,
          borderRadius: TOKEN.radius.pill,
          border: `4px solid ${TOKEN.surface.inset}`,
          borderTopColor: TOKEN.brand.whatsapp.green,
          animation: "waSpin .9s linear infinite",
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: TOKEN.space.sm }}>
        <h2
          style={{
            margin: 0,
            fontSize: TOKEN.font.display,
            fontWeight: TOKEN.weight.bold,
            color: TOKEN.ink.primary,
          }}
        >
          {t("inbox.whatsapp.connecting.title")}
        </h2>
        <p
          style={{
            margin: 0,
            fontSize: TOKEN.font.body,
            fontWeight: TOKEN.weight.medium,
            color: TOKEN.ink.muted,
            lineHeight: 1.5,
          }}
        >
          {t("inbox.whatsapp.connecting.body")}
        </p>
      </div>
    </div>
  );
}
