"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { SettingsRail } from "./SettingsRail";
import { SettingsSystemFooter } from "./SettingsSystemFooter";
import styles from "../../app/settings/settings-desk.module.css";

/**
 * The hub (/settings) is a full-width warm screen with its own account card,
 * groups and version line. Every Settings sub-page keeps the established frame:
 * the focused column, the desktop rail from 1200, and the system footer.
 */
export function SettingsFrame({ children, versionLabel }: { children: ReactNode; versionLabel: string }) {
  const pathname = usePathname() || "";

  if (pathname === "/settings") return <>{children}</>;

  return (
    <div className="min-h-screen bg-[var(--dz-background)] text-[var(--dz-text-primary)]" dir="rtl">
      <div className={`mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-8 pt-4 sm:max-w-2xl sm:px-6 lg:max-w-4xl ${styles.container}`}>
        <div className={styles.frame}>
          <aside className={styles.aside}>
            <SettingsRail />
          </aside>
          <div className="min-w-0 flex-1">
            {children}
            <SettingsSystemFooter appVersion={versionLabel} />
          </div>
        </div>
      </div>
    </div>
  );
}
