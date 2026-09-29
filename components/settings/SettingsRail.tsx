"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SETTINGS_CATEGORIES } from "./settings-categories";
import styles from "../../app/settings/settings-desk.module.css";

/**
 * Desktop settings navigation. The same categories as the hub list, grouped by
 * what the owner is looking for, so switching area never passes through the
 * hub. Hidden below 1200 by the layout.
 */
const GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: "זהות", keys: ["team", "business"] },
  { title: "חיבורים", keys: ["connections"] },
  { title: "העדפות ואבטחה", keys: ["workspace", "security", "account-privacy", "import-export"] },
];
const GROUPED = new Set(GROUPS.flatMap((group) => group.keys));

export function SettingsRail() {
  const path = usePathname() || "";
  const hubOn = path === "/settings";
  return (
    <nav aria-label="אזורי ההגדרות" className={styles.rail}>
      <Link
        href="/settings"
        className={hubOn ? styles.railOn : styles.railLink}
        aria-current={hubOn ? "page" : undefined}
      >
        <span className={styles.railIcon} aria-hidden>⚙️</span>
        <span>סקירה</span>
      </Link>
      {GROUPS.map((group, index) => (
        <div key={group.title} className={styles.railGroup}>
          <p className={styles.railHeading}>{group.title}</p>
          {SETTINGS_CATEGORIES.filter((item) =>
            // A category no group names lands in the last group, never nowhere.
            group.keys.includes(item.key) ||
            (index === GROUPS.length - 1 && !GROUPED.has(item.key)),
          ).map((item) => {
            const on = path === item.href || path.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.key}
                href={item.href}
                className={on ? styles.railOn : styles.railLink}
                aria-current={on ? "page" : undefined}
              >
                <span className={styles.railIcon} aria-hidden>{item.icon}</span>
                <span>{item.title}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
