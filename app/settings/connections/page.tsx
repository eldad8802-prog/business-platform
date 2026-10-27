import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import styles from "../settings-desk.module.css";
import { getServerI18n } from "@/lib/i18n/server";
import { PaymentConnectionCard } from "@/components/settings/PaymentConnectionCard";
import { AuthorityConnectionCard } from "@/components/settings/AuthorityConnectionCard";
import { LeadSourcesPanel } from "@/components/settings/LeadSourcesPanel";
import { StoresAndCallsPanel } from "@/components/settings/StoresAndCallsPanel";
import {
  ConnectionCategorySection,
  ConnectionsCenterProvider,
  ConnectionsOverview,
} from "@/components/settings/ConnectionsCenter";
import { CONNECTIONS_ANCHOR } from "@/lib/services/connections/connections-center.model";

/**
 * Settings → חיבורים — one connections center (S1-B · M1).
 *
 * The overview (GET /api/settings/connections-center) sits on top; below it every category shows
 * its status rows and then the EXISTING management component, unchanged: payments →
 * PaymentConnectionCard, leads → LeadSourcesPanel, stores and calls → StoresAndCallsPanel,
 * authorities → AuthorityConnectionCard. Gmail, the inbound address and WhatsApp are status rows
 * linking to the screens that own them.
 *
 * OAuth returns land here unchanged (/settings/connections, ?store=woocommerce, the tax
 * authority's ?authority=… result that AuthorityConnectionCard reads and cleans).
 */
export default async function SettingsConnectionsPage() {
  const { t } = await getServerI18n();
  return (
    <>
      <SettingsSubPageHeader title={t("account.settings.categories.connections.title")} />
      <ConnectionsCenterProvider>
        <ConnectionsOverview />
        <div className={styles.cardGrid}>
          <ConnectionCategorySection category="invoices" />
          <ConnectionCategorySection category="pos" />
          <ConnectionCategorySection category="payments" anchorId={CONNECTIONS_ANCHOR.payments}>
            <PaymentConnectionCard />
          </ConnectionCategorySection>
          <ConnectionCategorySection category="messaging" />
          <ConnectionCategorySection category="leads" wide anchorId={CONNECTIONS_ANCHOR.leads}>
            <LeadSourcesPanel />
          </ConnectionCategorySection>
          <ConnectionCategorySection category="stores_calls" wide anchorId={CONNECTIONS_ANCHOR.stores}>
            <StoresAndCallsPanel />
          </ConnectionCategorySection>
          <ConnectionCategorySection category="authority" anchorId={CONNECTIONS_ANCHOR.authority}>
            <AuthorityConnectionCard />
          </ConnectionCategorySection>
        </div>
      </ConnectionsCenterProvider>
      <SettingsSection>
        <p className="text-sm leading-6 text-[var(--dz-text-muted)]">
          {t("account.settings.connections.page.footnote")}
        </p>
      </SettingsSection>
    </>
  );
}
