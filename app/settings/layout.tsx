import type { ReactNode } from "react";
import type { Metadata } from "next";
import packageJson from "../../package.json";
import { SettingsSystemFooter } from "@/components/settings/SettingsSystemFooter";
import { SettingsRail } from "@/components/settings/SettingsRail";
import { ShellChrome } from "@/components/navigation/shell-chrome";
import styles from "./settings-desk.module.css";

export const metadata: Metadata = { title: "הגדרות" };

// Settings is a primary navigation destination (the bottom bar's "עוד"/"פרופיל"
// tab points here), so it inherits the one shared bottom bar via ShellChrome.
// The existing system-info footer stays inside the scroll content, above the bar.
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <ShellChrome>
      <div className="min-h-screen bg-[var(--dz-background)] text-[var(--dz-text-primary)]" dir="rtl">
        <div className={`mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-8 pt-4 sm:max-w-2xl sm:px-6 lg:max-w-4xl ${styles.container}`}>
          <div className={styles.frame}>
            <aside className={styles.aside}>
              <SettingsRail />
            </aside>
            <div className="min-w-0 flex-1">
              {children}
              <SettingsSystemFooter appVersion={packageJson.version} />
            </div>
          </div>
        </div>
      </div>
    </ShellChrome>
  );
}
