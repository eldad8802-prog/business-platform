import BackButton from "@/components/ui/back-button";
import { DeleteAccountSection } from "@/components/settings/DeleteAccountSection";
import { SettingsRow } from "@/components/settings/SettingsRow";
import { SettingsSection } from "@/components/settings/SettingsSection";
import {
  IMPORT_EXPORT_RELEASED,
  IMPORT_EXPORT_ROUTE,
} from "@/components/settings/import-export/import-export-release";
import styles from "../settings-desk.module.css";

/**
 * הגדרות → פרטיות: the owner's two real privacy controls — taking a copy of
 * the business's data, and deleting the account. The public data-deletion page
 * quotes this path; keep the two in step. There is no retention control, so
 * none is offered.
 */
export default function AccountPrivacySettingsPage() {
  return (
    <div className={styles.focused}>
      <header className="mb-5 rounded-3xl dz-mist px-4 py-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <BackButton href="/settings" label="חזרה להגדרות" />
          <div className="min-w-0 flex-1 text-center">
            <h1 className="text-base font-bold text-[var(--dz-text-primary)]">פרטיות</h1>
          </div>
          <div className="h-11 min-w-[44px]" aria-hidden />
        </div>
      </header>
      {IMPORT_EXPORT_RELEASED ? (
        <div className="mb-4">
          <SettingsSection title="ייצוא המידע">
            <SettingsRow
              href={`${IMPORT_EXPORT_ROUTE}/export`}
              icon="⬇️"
              title="הורדת עותק של המידע"
              description="הורד עותק של הנתונים והמסמכים שלך"
            />
          </SettingsSection>
        </div>
      ) : null}
      <DeleteAccountSection />
    </div>
  );
}
