import { SettingsNav } from "@/components/settings/SettingsNav";
import { SettingsOverview } from "@/components/settings/SettingsOverview";
import BackButton from "@/components/ui/back-button";
import styles from "./settings-desk.module.css";

export default function SettingsHubPage() {
  return (
    <>
      <header className="mb-5 rounded-3xl dz-mist px-4 py-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          {/* /settings is a main-nav root: back only to a verified origin. */}
          <div className="h-11 min-w-[44px]">
            <BackButton hideWithoutOrigin />
          </div>

          <div className="min-w-0 flex-1 text-center">
            <h1 className="text-base font-bold text-[var(--dz-text-primary)]">הגדרות</h1>
          </div>

          <div className="h-11 min-w-[44px]" aria-hidden />
        </div>
      </header>

      {/* Below 1200 the hub is the category list. From 1200 the rail carries
          the categories and the hub shows what is set up. */}
      <div className={styles.hubList}>
        <SettingsNav />
      </div>
      <SettingsOverview />
    </>
  );
}
