import type { ReactNode } from "react";

import { DubizLogo } from "@/components/ui/dubiz-logo";

import styles from "./auth-card.module.css";

/** The frame every account-link screen shares with login: logo, title, one line, then the body. */
export function AuthCard({ title, lede, children }: { title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.head}>
          <div className={styles.logo}>
            <DubizLogo height={34} priority />
          </div>
          <h1 className={styles.title}>{title}</h1>
          {lede ? <p className={styles.lede}>{lede}</p> : null}
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </main>
  );
}

export { styles as authCardStyles };
