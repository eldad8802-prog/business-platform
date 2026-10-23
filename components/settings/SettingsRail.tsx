"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import { SETTINGS_CATEGORIES, SETTINGS_GROUP_ORDER, SETTINGS_GROUP_TITLE_KEYS } from "./settings-categories";
import styles from "../../app/settings/settings-desk.module.css";

/**
 * Desktop settings navigation for the sub-pages. The same areas, in the same
 * groups, as the hub (each category names its group), so switching area never
 * passes through the hub and the two can never disagree. Hidden below 1200.
 */

export function SettingsRail() {
  const path = usePathname() || "";
  const { t } = useI18n();
  const hubOn = path === "/settings";
  return (
    <nav aria-label={t("account.settings.rail.ariaLabel")} className={styles.rail}>
      <Link
        href="/settings"
        className={hubOn ? styles.railOn : styles.railLink}
        aria-current={hubOn ? "page" : undefined}
      >
        <span className={styles.railIcon} aria-hidden>⚙️</span>
        <span>{t("account.settings.rail.overview")}</span>
      </Link>
      {SETTINGS_GROUP_ORDER.map((group) => (
        <div key={group} className={styles.railGroup}>
          <p className={styles.railHeading}>{t(SETTINGS_GROUP_TITLE_KEYS[group])}</p>
          {SETTINGS_CATEGORIES.filter((item) => item.group === group).map((item) => {
            const on = path === item.href || path.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.key}
                href={item.href}
                className={on ? styles.railOn : styles.railLink}
                aria-current={on ? "page" : undefined}
              >
                <span className={styles.railIcon} aria-hidden>{item.icon}</span>
                <span>{t(item.titleKey)}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
