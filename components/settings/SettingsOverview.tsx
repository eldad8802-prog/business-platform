"use client";

import Link from "next/link";
import { useMediaQuery } from "@/lib/ui/use-breakpoint";
import { AccountSummaryCard } from "./AccountSummaryCard";
import { BusinessSummaryCard } from "./BusinessSummaryCard";
import { IntegrationStatusCards } from "./IntegrationStatusCards";
import styles from "../../app/settings/settings-desk.module.css";

/**
 * Desktop settings hub: what is set up right now, read from the same cards the
 * sub-pages use. The rail beside it carries navigation, so the hub does not
 * repeat the category list. Mounted only from 1200, so the phone hub does not
 * fetch account and connection status it never shows.
 */
export function SettingsOverview() {
  const desktop = useMediaQuery("(min-width: 1200px)");
  if (!desktop) return null;
  return (
    <div className={styles.overview}>
      <div className={styles.overviewHead}>
        <h2>מה מוגדר עכשיו</h2>
        <p>החשבון, העסק והחיבורים כפי שדוביז רואה אותם. משנים כל אזור מהתפריט שבצד.</p>
      </div>
      <AccountSummaryCard />
      <BusinessSummaryCard />
      <div className={styles.connections}>
        <IntegrationStatusCards />
        <div className={styles.connectionsMore}>
          <span>סליקה וחיבור לרשות המסים מנוהלים במסך החיבורים.</span>
          <Link href="/settings/connections">לכל החיבורים</Link>
        </div>
      </div>
    </div>
  );
}
