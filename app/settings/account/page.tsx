import BackButton from "@/components/ui/back-button";
import { DeleteAccountSection } from "@/components/settings/DeleteAccountSection";
import { SettingsRow } from "@/components/settings/SettingsRow";
import { SettingsSection } from "@/components/settings/SettingsSection";
import {
  IMPORT_EXPORT_RELEASED,
  IMPORT_EXPORT_ROUTE,
} from "@/components/settings/import-export/import-export-release";
import { getServerI18n } from "@/lib/i18n/server";
import styles from "../settings-desk.module.css";

/**
 * הגדרות → פרטיות: the owner's two real privacy controls — taking a copy of
 * the business's data, and deleting the account. The public data-deletion page
 * quotes this path; keep the two in step. There is no retention control, so
 * none is offered.
 */
export default async function AccountPrivacySettingsPage() {
  const { t } = await getServerI18n();
  return (
    <div className={styles.focused}>
      <header className="mb-5 rounded-3xl dz-mist px-4 py-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <BackButton />
          <div className="min-w-0 flex-1 text-center">
            <h1 className="text-base font-bold text-[var(--dz-text-primary)]">{t("account.settings.categories.accountPrivacy.title")}</h1>
          </div>
          <div className="h-11 min-w-[44px]" aria-hidden />
        </div>
      </header>
      {IMPORT_EXPORT_RELEASED ? (
        <div className="mb-4">
          <SettingsSection title={t("account.settings.privacy.exportSection")}>
            <SettingsRow
              href={`${IMPORT_EXPORT_ROUTE}/export`}
              icon="⬇️"
              title={t("account.settings.privacy.exportTitle")}
              description={t("account.settings.privacy.exportDescription")}
            />
          </SettingsSection>
        </div>
      ) : null}
      <DeleteAccountSection />
    </div>
  );
}
