import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import styles from "../settings-desk.module.css";
import { PaymentConnectionCard } from "@/components/settings/PaymentConnectionCard";
import { IntegrationStatusCards } from "@/components/settings/IntegrationStatusCards";
import { AuthorityConnectionCard } from "@/components/settings/AuthorityConnectionCard";

export default function SettingsConnectionsPage() {
  return (
    <>
      <SettingsSubPageHeader title="חיבורים" />
      <div className={styles.cardGrid}>
        <PaymentConnectionCard />
        <AuthorityConnectionCard />
        <IntegrationStatusCards />
      </div>
      <SettingsSection>
        <p className="text-sm leading-6 text-[var(--dz-text-muted)]">
          מוצג כאן מצב החיבורים הקיימים. ניהול החיבור עצמו מתבצע במסך הייעודי של כל
          אינטגרציה.
        </p>
      </SettingsSection>
    </>
  );
}
