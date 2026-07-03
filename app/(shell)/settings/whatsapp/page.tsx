"use client";

import { useState } from "react";
import PageHeader from "@/components/ui/page-header";
import { TOKEN } from "@/lib/design/tokens";
import { useWhatsAppConnection } from "@/components/whatsapp/use-whatsapp-connection";
import { WhatsAppConnectInvitation } from "@/components/whatsapp/WhatsAppConnectInvitation";
import { WhatsAppConnectedCard } from "@/components/whatsapp/WhatsAppConnectedCard";

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

      <main
        style={{
          maxWidth: 560,
          margin: "0 auto",
          padding: "16px 16px 96px",
          boxSizing: "border-box",
        }}
      >
        {state.phase === "loading" ? (
          <div style={{ marginTop: 24, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>
            טוען…
          </div>
        ) : state.phase === "connected" ? (
          <WhatsAppConnectedCard connection={state.connection} onChanged={refresh} />
        ) : (
          <WhatsAppConnectInvitation onConnected={refresh} />
        )}
      </main>
    </div>
  );
}
