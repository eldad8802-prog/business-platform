"use client";

import { useState } from "react";
import PageHeader from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { TOKEN } from "@/lib/design/tokens";
import { useWhatsAppConnection } from "@/components/whatsapp/use-whatsapp-connection";
import { WhatsAppConnectInvitation } from "@/components/whatsapp/WhatsAppConnectInvitation";
import { WhatsAppConnectedCard } from "@/components/whatsapp/WhatsAppConnectedCard";
import { WhatsAppMetaDataPrivacySection } from "@/components/whatsapp/WhatsAppMetaDataPrivacySection";

/**
 * Dedicated WhatsApp settings screen.
 *
 * Pure routing over the connection status — the actual UI is the same shared
 * components used by the Inbox, so both entry points give one identical
 * experience:
 *   - not connected → the shared invitation (moment 1)
 *   - connected     → the status card + owner actions
 *
 * `reloadKey` re-fetches the status after a (re)connect or disconnect so the
 * view reflects the new state.
 */
export default function WhatsAppSettingsPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const state = useWhatsAppConnection(reloadKey);
  const refresh = () => setReloadKey((k) => k + 1);

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <PageHeader title="WhatsApp Business" backHref="/tools" backLabel="חזרה" showBack />

      {/* Pilot: focused intent (Spec v1 §6) — settings stay deliberately
          narrow, and that decision now lives in the DS, not a literal. */}
      <PageContainer intent="focused" style={{ paddingBlock: "16px 96px" }}>
        {state.phase === "loading" ? (
          <div style={{ marginTop: 24, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>
            טוען…
          </div>
        ) : state.phase === "connected" ? (
          <WhatsAppConnectedCard connection={state.connection} onChanged={refresh} />
        ) : (
          <WhatsAppConnectInvitation onConnected={refresh} />
        )}

        <div style={{ marginTop: 16 }}>
          <WhatsAppMetaDataPrivacySection onChanged={refresh} />
        </div>
      </PageContainer>
    </div>
  );
}
