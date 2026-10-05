"use client";

import { useState } from "react";
import PageHeader from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { TOKEN } from "@/lib/design/tokens";
import { useWhatsAppConnection } from "@/components/whatsapp/use-whatsapp-connection";
import { WhatsAppConnectInvitation } from "@/components/whatsapp/WhatsAppConnectInvitation";
import { WhatsAppConnectedCard } from "@/components/whatsapp/WhatsAppConnectedCard";
import { WhatsAppMetaDataPrivacySection } from "@/components/whatsapp/WhatsAppMetaDataPrivacySection";
import { WA_COPY } from "@/components/whatsapp/wa-copy";
import { WaBadge, WaPrimaryButton } from "@/components/whatsapp/wa-ui";
import { settingsViewFor } from "@/components/whatsapp/connection-view";
import desk from "./wa-desk.module.css";

/**
 * Dedicated WhatsApp settings screen.
 *
 * Pure routing over the SERVER's connection state — the actual UI is the same
 * shared components used by the Inbox. Every state is shown truthfully:
 *   - status read failed            → load error + retry (never "connect")
 *   - no row                        → the shared invitation (moment 1)
 *   - CONNECTED                     → the status card + owner actions
 *   - REVOKED_BY_META / ERROR       → the card with "needs attention" (the
 *                                     number still receives messages)
 *   - DISCONNECTED / REVOKED        → the invitation, headed by the previous
 *                                     number and why it no longer receives
 *
 * `reloadKey` re-fetches the status after a (re)connect or disconnect so the
 * view reflects the new state.
 */
export default function WhatsAppSettingsPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const state = useWhatsAppConnection(reloadKey);
  const view = settingsViewFor(state);
  const refresh = () => setReloadKey((k) => k + 1);

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <PageHeader title="WhatsApp Business" backHref="/settings/connections" showBack />

      {/* Pilot: focused intent (Spec v1 §6) — the connection is a focused
          setting, and that decision lives in the DS, not a literal. From 1200
          the page widens (wa-desk.module.css) so the connection and what Dubiz
          stores from Meta sit side by side instead of stacked. */}
      <PageContainer intent="focused" className={desk.page} style={{ paddingBlock: "16px 96px" }}>
        <div className={desk.desk}>
          <div>
            {view.kind === "loading" ? (
              <div style={{ marginTop: 24, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>
                טוען…
              </div>
            ) : view.kind === "load_error" ? (
              <ConnectionLoadError onRetry={refresh} />
            ) : view.kind === "connected" || view.kind === "attention" ? (
              <WhatsAppConnectedCard connection={view.connection} onChanged={refresh} />
            ) : view.kind === "disconnected" ? (
              <WhatsAppConnectInvitation
                onConnected={refresh}
                notice={
                  <PreviousConnectionNotice
                    status={view.connection.status}
                    displayPhoneNumber={view.connection.displayPhoneNumber}
                  />
                }
              />
            ) : (
              <WhatsAppConnectInvitation onConnected={refresh} />
            )}
          </div>
          <WhatsAppMetaDataPrivacySection onChanged={refresh} />
        </div>
      </PageContainer>
    </div>
  );
}

/** The status read failed: say so, and let the owner retry. Never "connect". */
function ConnectionLoadError({ onRetry }: { onRetry: () => void }) {
  const c = WA_COPY.loadError;
  return (
    <div
      role="alert"
      style={{
        marginTop: 16,
        background: TOKEN.surface.card,
        borderRadius: TOKEN.radius.modal,
        boxShadow: TOKEN.shadow.floating,
        padding: 22,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <WaBadge tone="neutral" label={c.badge} />
      <div style={{ fontSize: TOKEN.font.title, fontWeight: TOKEN.weight.semibold, color: TOKEN.ink.primary }}>
        {c.heading}
      </div>
      <div style={{ fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, lineHeight: 1.5 }}>{c.body}</div>
      <WaPrimaryButton label={c.retry} onClick={onRetry} showGlyph={false} />
    </div>
  );
}

/** A row exists but no longer receives messages: show which number and why. */
function PreviousConnectionNotice({
  status,
  displayPhoneNumber,
}: {
  status: string;
  displayPhoneNumber: string;
}) {
  const c = WA_COPY.disconnectedNotice;
  const reason = c[status] ?? c.DISCONNECTED;
  return (
    <div
      role="status"
      style={{
        background: TOKEN.semantic.info.bgSoft,
        border: `1px solid ${TOKEN.semantic.info.border}`,
        borderRadius: TOKEN.radius.input,
        padding: "10px 12px",
        fontSize: TOKEN.font.meta,
        color: TOKEN.semantic.info.ink,
        lineHeight: 1.5,
        marginBottom: 12,
      }}
    >
      {displayPhoneNumber ? (
        <div>
          {c.numberLabel}: <span dir="ltr">{displayPhoneNumber}</span>
        </div>
      ) : null}
      <div>{reason}</div>
    </div>
  );
}
