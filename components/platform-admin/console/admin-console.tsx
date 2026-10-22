"use client";

/**
 * Admin Control Center shell (A1): one frame for every admin screen.
 *
 *   desktop / tablet  graphite sidebar (the privileged-area cue) + top bar with
 *                     global search, the deployment badge and the MFA state;
 *   phone (≤ 760px)   compact top bar + a fixed bottom tab bar, 44px+ targets.
 *
 * The shell owns no data. Identity comes from PlatformAdminGate (session probe,
 * identity-only); every privileged read the page makes goes through the shared
 * request core, which answers a missing elevation with the step-up dialog.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { PlatformAdminSessionResponse } from "@/lib/services/platform-admin/types";
import { getAdminElevationExpiresAt } from "@/lib/platform-admin/admin-elevation";
import { PlatformAdminGate } from "../platform-admin-gate";
import { ConsoleIcon, type ConsoleIconName } from "./console-icons";
import styles from "./admin-console.module.css";

type NavEntry = { href: string; label: string; icon: ConsoleIconName };

const NAV: NavEntry[] = [
  { href: "/admin", label: "סקירה", icon: "home" },
  { href: "/admin/businesses", label: "עסקים", icon: "businesses" },
  { href: "/admin/audit", label: "יומן פעולות", icon: "audit" },
  { href: "/admin/security", label: "אבטחה", icon: "shield" },
];

const TOOLS: NavEntry[] = [{ href: "/admin/diagnostics", label: "בדיקות מערכת", icon: "tools" }];

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Minutes left on the in-memory elevation, refreshed every 15 seconds. */
function useElevationMinutes(): number | null {
  const [minutes, setMinutes] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => {
      const at = getAdminElevationExpiresAt();
      setMinutes(at ? Math.max(1, Math.ceil((at - Date.now()) / 60_000)) : null);
    };
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, []);
  return minutes;
}

function DeploymentBadge({ deployment }: { deployment: PlatformAdminSessionResponse["deployment"] }) {
  const label = deployment === "production" ? "PRODUCTION" : deployment === "preview" ? "PREVIEW" : "LOCAL";
  return (
    <span
      className={`${styles.envBadge} ${deployment === "production" ? styles.envProd : styles.envOther}`}
      title="הסביבה שעונה לבקשות"
    >
      {label}
    </span>
  );
}

function ElevationChip({ session }: { session: PlatformAdminSessionResponse }) {
  const minutes = useElevationMinutes();
  if (!session.mfa.required) {
    return <span className={styles.elevChip}>אימות נוסף כבוי בסביבה הזו</span>;
  }
  if (minutes) {
    return (
      <Link href="/admin/security" className={`${styles.elevChip} ${styles.elevOn}`}>
        <ConsoleIcon name="shield" size={14} />
        מאומת · עוד {minutes} דק׳
      </Link>
    );
  }
  return (
    <Link href="/admin/security" className={styles.elevChip}>
      <ConsoleIcon name="shield" size={14} />
      לא מאומת
    </Link>
  );
}

function GlobalSearch({ id }: { id: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <form
      role="search"
      className={styles.search}
      onSubmit={(e) => {
        e.preventDefault();
        const text = q.trim();
        router.push(text ? `/admin/businesses?q=${encodeURIComponent(text)}` : "/admin/businesses");
      }}
    >
      <ConsoleIcon name="search" size={16} />
      <input
        id={id}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="חיפוש עסק לפי שם, מזהה או מייל"
        aria-label="חיפוש עסק לפי שם, מזהה או מייל"
        maxLength={120}
        enterKeyHint="search"
      />
    </form>
  );
}

/** A banner when MFA is enforced but this admin has no factor yet. */
function MfaSetupBanner({ session, pathname }: { session: PlatformAdminSessionResponse; pathname: string | null }) {
  const noFactor = session.mfa.required && !session.mfa.enrolled && session.mfa.passkeys.count === 0;
  if (!noFactor || pathname === "/admin/security") return null;
  return (
    <div className={`${styles.card} ${styles.cardAttention}`} role="status">
      <div className={styles.cardHead}>
        <h2>יש להגדיר אימות דו-שלבי</h2>
        <Link href="/admin/security" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`}>
          להגדרה
        </Link>
      </div>
      <p className={styles.note}>כל הנתונים באזור הניהול מוגנים באימות נוסף. בלי אמצעי אימות לא תוכל לצפות בהם.</p>
    </div>
  );
}

type AdminConsoleProps = {
  /** Shown in the phone top bar. */
  title: string;
  /** Phone top bar back target (second-level screens). */
  backHref?: string;
  children: (session: PlatformAdminSessionResponse) => ReactNode;
};

export function AdminConsole({ title, backHref, children }: AdminConsoleProps) {
  const pathname = usePathname();

  return (
    <PlatformAdminGate>
      {(session) => (
        <div className={styles.shell}>
          <aside className={styles.side} aria-label="ניווט ראשי של אזור הניהול">
            <div className={styles.brand}>
              <span className={styles.mark} aria-hidden="true">
                D
              </span>
              <div>
                Dubiz Admin
                <small>מרכז שליטה</small>
              </div>
            </div>
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={styles.navItem}
                aria-current={isActive(pathname, item.href) ? "page" : undefined}
              >
                <ConsoleIcon name={item.icon} />
                {item.label}
              </Link>
            ))}
            <div className={styles.navGroup}>כלים</div>
            {TOOLS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={styles.navItem}
                aria-current={isActive(pathname, item.href) ? "page" : undefined}
              >
                <ConsoleIcon name={item.icon} />
                {item.label}
              </Link>
            ))}
            <div className={styles.sideFoot}>
              <span>{session.admin.email}</span>
              <Link href="/app" className={styles.navItem} style={{ padding: "6px 0", minHeight: 32 }}>
                חזרה ל־Dubiz
              </Link>
            </div>
          </aside>

          <div className={styles.main}>
            <header className={styles.topbar}>
              <GlobalSearch id="admin-global-search" />
              <span className={styles.spacer} />
              <DeploymentBadge deployment={session.deployment} />
              <ElevationChip session={session} />
            </header>

            <header className={styles.mobileTop}>
              {backHref ? (
                <Link href={backHref} className={styles.iconBtn} aria-label="חזרה">
                  <ConsoleIcon name="back" size={20} />
                </Link>
              ) : (
                <span className={styles.mark} aria-hidden="true">
                  D
                </span>
              )}
              <span className={styles.mobileTitle}>{title}</span>
              <DeploymentBadge deployment={session.deployment} />
              <Link href="/admin/businesses" className={styles.iconBtn} aria-label="חיפוש עסק">
                <ConsoleIcon name="search" size={20} />
              </Link>
            </header>

            <main className={styles.content}>
              <MfaSetupBanner session={session} pathname={pathname} />
              {children(session)}
            </main>
          </div>

          <nav className={styles.tabbar} aria-label="ניווט ראשי">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={styles.tab}
                aria-current={isActive(pathname, item.href) ? "page" : undefined}
              >
                <ConsoleIcon name={item.icon} />
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </PlatformAdminGate>
  );
}

export { styles as consoleStyles };
