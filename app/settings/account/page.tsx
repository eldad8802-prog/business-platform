import BackButton from "@/components/ui/back-button";
import { DeleteAccountSection } from "@/components/settings/DeleteAccountSection";
import styles from "../settings-desk.module.css";

export default function AccountPrivacySettingsPage() {
  return (
    <div className={styles.focused}>
      <header className="mb-5 rounded-3xl dz-mist px-4 py-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <BackButton />
          <div className="min-w-0 flex-1 text-center">
            <h1 className="text-base font-bold text-[var(--dz-text-primary)]">חשבון ופרטיות</h1>
          </div>
          <div className="h-11 min-w-[44px]" aria-hidden />
        </div>
      </header>
      <DeleteAccountSection />
    </div>
  );
}
