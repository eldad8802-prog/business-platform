import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { SubscriptionScreen } from "@/components/settings/subscription/subscription-screen";
import { getServerI18n } from "@/lib/i18n/server";
import styles from "../settings-desk.module.css";

export const dynamic = "force-dynamic";

/** "המנוי שלי" (subscriptions stage C) — clean: the plan as facts, messages only when attention is needed, the plan terms. */
export default async function SettingsSubscriptionPage() {
  const { t } = await getServerI18n();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader
        title={t("account.settings.subscriptionPage.title")}
        subtitle={t("account.settings.subscriptionPage.subtitle")}
      />
      <SubscriptionScreen />
    </div>
  );
}
