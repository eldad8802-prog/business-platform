"use client";

/**
 * Admin Control Center home (A1). Order is the order of attention:
 *   1. what needs handling now   (attention feed)
 *   2. four core figures          (businesses, active, seen today, revenue)
 *   3. how new businesses progress (30-day funnel) and the signup trend
 *   4. who joined, and what admins did
 *   5. feature usage (the existing usage insights, unchanged)
 *
 * Every block loads and fails on its own. A figure without a trustworthy
 * source says so ("אין נתון") instead of showing a zero.
 */
import Link from "next/link";
import type {
  PlatformAdminAttentionResponse,
  PlatformAdminHomeResponse,
  PlatformAttentionItem,
} from "@/lib/services/platform-admin/types";
import type { PlatformUsageOverviewResponse } from "@/lib/services/platform-admin/platform-usage-overview.service";
import { formatAuditActionLabel } from "@/lib/services/platform-admin/platform-audit-format";
import {
  fetchPlatformAdminAttention,
  fetchPlatformAdminHome,
  fetchPlatformAdminUsageOverview,
} from "@/lib/platform-admin/fetch-platform-admin";
import { PlatformUsageInsightsSection } from "../platform-usage-insights-section";
import { formatRelativeTime } from "../platform-usage-labels";
import { ConsoleIcon } from "./console-icons";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "./console-states";
import { useAdminLoad, type AdminLoad } from "./use-admin-load";
import styles from "./admin-console.module.css";

const nf = new Intl.NumberFormat("he-IL");

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 30;
  const max = Math.max(1, ...values);
  const step = w / (values.length - 1);
  const y = (v: number) => h - 3 - (v / max) * (h - 8);
  const d = values.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className={styles.spark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d} L${w} ${h} L0 ${h}Z`} fill="var(--dz-brand)" opacity="0.12" />
      <path d={d} fill="none" stroke="var(--dz-brand)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      <circle cx={w} cy={y(values[values.length - 1])} r="2.6" fill="var(--dz-brand)" />
    </svg>
  );
}

function stripeClass(severity: PlatformAttentionItem["severity"]): string {
  if (severity === "critical") return `${styles.stripe} ${styles.stripeCritical}`;
  if (severity === "high") return `${styles.stripe} ${styles.stripeHigh}`;
  if (severity === "medium") return `${styles.stripe} ${styles.stripeMedium}`;
  return styles.stripe;
}

function AttentionCard({ load }: { load: AdminLoad<PlatformAdminAttentionResponse> }) {
  if (load.loading) return <LoadingBlock height={110} label="טוען פריטים לטיפול" />;
  if (load.error) return <ErrorBlock error={load.error} onRetry={load.reload} />;
  const items = load.data?.items ?? [];
  return (
    <section className={`${styles.card} ${items.length ? styles.cardAttention : ""}`} aria-labelledby="attention-title">
      <div className={styles.cardHead}>
        <h2 id="attention-title">דורש טיפול עכשיו</h2>
        {items.length ? <span className={`${styles.pill} ${styles.pillBad}`}>{items.length}</span> : null}
      </div>
      {items.length === 0 ? (
        <p className={styles.note}>אין כרגע דבר שדורש טיפול.</p>
      ) : (
        <div className={styles.list}>
          {items.slice(0, 6).map((item) => (
            <div key={item.id} className={styles.row}>
              <i className={stripeClass(item.severity)} aria-hidden="true" />
              <div>
                <span className={styles.rowTitle}>{item.title}</span>
                <span className={styles.rowSub}>
                  {[item.businessName, item.detail].filter(Boolean).join(" · ")}
                </span>
              </div>
              {item.businessId ? (
                <Link href={`/admin/businesses/${item.businessId}`} className={styles.linkBtn}>
                  לעסק
                </Link>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Kpis({ home }: { home: PlatformAdminHomeResponse }) {
  const daily = home.signups.daily30.map((d) => d.count);
  const activeShare = home.businesses.total
    ? Math.round((home.businesses.active7d / home.businesses.total) * 100)
    : null;
  return (
    <div className={styles.kpis}>
      <Link href="/admin/businesses" className={styles.kpi}>
        <span className={styles.kpiLabel}>עסקים</span>
        <span className={styles.kpiValue}>{nf.format(home.businesses.total)}</span>
        <span className={styles.kpiSub}>
          היום {nf.format(home.signups.today)} · השבוע {nf.format(home.signups.week)} · החודש {nf.format(home.signups.month)}
        </span>
        <Sparkline values={daily} />
      </Link>
      <div className={styles.kpi}>
        <span className={styles.kpiLabel}>עסקים פעילים · 7 ימים</span>
        <span className={styles.kpiValue}>{nf.format(home.businesses.active7d)}</span>
        <span className={styles.kpiSub}>
          {activeShare === null ? "—" : `${activeShare}% מהעסקים`} · 30 ימים: {nf.format(home.businesses.active30d)}
        </span>
        <Link href="/admin/businesses?filter=inactive" className={styles.linkBtn}>
          לעסקים שלא נכנסו 14 ימים
        </Link>
      </div>
      <div className={styles.kpi}>
        <span className={styles.kpiLabel}>משתמשים שנראו · 24 שעות</span>
        <span className={styles.kpiValue}>{nf.format(home.users.seen24h)}</span>
        <span className={styles.kpiSub}>מתוך {nf.format(home.users.total)} משתמשים</span>
      </div>
      <div className={styles.kpi}>
        <span className={styles.kpiLabel}>הכנסות Dubiz</span>
        <span className={`${styles.kpiValue} ${styles.kpiNone}`}>אין נתון</span>
        <span className={styles.kpiSub}>אין עדיין מערכת מנויים</span>
      </div>
    </div>
  );
}

function FunnelRow({ label, value, of }: { label: string; value: number | null; of: number }) {
  const pct = value === null || of === 0 ? 0 : Math.round((value / of) * 100);
  return (
    <div className={styles.funnelRow}>
      <span>{label}</span>
      <span className={styles.funnelBar} aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
      <b className={styles.num}>{value === null ? "—" : nf.format(value)}</b>
    </div>
  );
}

function FunnelCard({ home }: { home: PlatformAdminHomeResponse }) {
  const f = home.funnel30d;
  return (
    <section className={styles.card} aria-labelledby="funnel-title">
      <div className={styles.cardHead}>
        <h2 id="funnel-title">הצטרפות · 30 ימים</h2>
        <Link href="/admin/businesses?filter=new" className={styles.linkBtn}>
          עסקים חדשים
        </Link>
      </div>
      {f.registered === 0 ? (
        <p className={styles.note}>לא נרשמו עסקים ב־30 הימים האחרונים.</p>
      ) : (
        <div className={styles.funnel}>
          <FunnelRow label="השלימו הרשמה" value={f.registered} of={f.registered} />
          <FunnelRow label="אימתו מייל" value={f.emailVerified} of={f.registered} />
          <FunnelRow label="חזרו להתחבר" value={f.returnedToLogin} of={f.registered} />
          <FunnelRow label="השלימו אונבורדינג" value={f.onboarded} of={f.registered} />
          <FunnelRow label="התחילו לעבוד" value={f.activated} of={f.registered} />
        </div>
      )}
      <p className={styles.note} style={{ marginTop: 10 }}>
        {f.emailVerified === null ? "אימות מייל כבוי בסביבה הזו, לכן מוצג —. " : ""}
        &quot;התחילו לעבוד&quot; = העלו מסמך או הפיקו חשבונית.
      </p>
    </section>
  );
}

function OnboardingCard({ home }: { home: PlatformAdminHomeResponse }) {
  const o = home.onboarding;
  const pct = o.cohort ? Math.round((o.completed / o.cohort) * 100) : null;
  return (
    <section className={styles.card} aria-labelledby="onboarding-title">
      <div className={styles.cardHead}>
        <h2 id="onboarding-title">אונבורדינג</h2>
        <Link href="/admin/businesses?filter=no_onboarding" className={styles.linkBtn}>
          מי לא השלים
        </Link>
      </div>
      <div className={styles.kpiValue}>{pct === null ? "—" : `${pct}%`}</div>
      <p className={styles.kpiSub}>
        {nf.format(o.completed)} מתוך {nf.format(o.cohort)} עסקים השלימו
      </p>
      <p className={styles.note} style={{ marginTop: 8 }}>
        נמדד רק לעסקים שהצטרפו אחרי {new Date(o.reliableSince).toLocaleDateString("he-IL")}. לפני כן הערך מולא אוטומטית במיגרציה, ולכן אינו מעיד על השלמה.
      </p>
    </section>
  );
}

function RecentBusinesses({ home }: { home: PlatformAdminHomeResponse }) {
  return (
    <section className={styles.card} aria-labelledby="recent-biz-title">
      <div className={styles.cardHead}>
        <h2 id="recent-biz-title">הצטרפו לאחרונה</h2>
        <Link href="/admin/businesses" className={styles.linkBtn}>
          כל העסקים
        </Link>
      </div>
      {home.recentBusinesses.length === 0 ? (
        <p className={styles.note}>עדיין אין עסקים.</p>
      ) : (
        <div className={styles.list}>
          {home.recentBusinesses.map((b) => (
            <Link key={b.id} href={`/admin/businesses/${b.id}`} className={`${styles.row} ${styles.rowLink}`}>
              <span className={styles.avatar} aria-hidden="true">
                {b.name.trim().charAt(0) || "?"}
              </span>
              <span>
                <span className={styles.rowTitle}>{b.name}</span>
                <span className={styles.rowSub}>
                  #{b.id}
                  {b.ownerEmail ? ` · ${b.ownerEmail}` : ""}
                </span>
              </span>
              <span className={styles.muted}>{formatRelativeTime(b.createdAt)}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentActions({ home }: { home: PlatformAdminHomeResponse }) {
  return (
    <section className={styles.card} aria-labelledby="recent-actions-title">
      <div className={styles.cardHead}>
        <h2 id="recent-actions-title">פעולות ניהול אחרונות</h2>
        <Link href="/admin/audit" className={styles.linkBtn}>
          יומן מלא
        </Link>
      </div>
      {home.recentAdminActions.length === 0 ? (
        <p className={styles.note}>עדיין לא בוצעו פעולות ניהול.</p>
      ) : (
        <div className={styles.list}>
          {home.recentAdminActions.map((a) => (
            <div key={a.id} className={styles.row}>
              <i className={styles.stripe} aria-hidden="true" />
              <span>
                <span className={styles.rowTitle}>{formatAuditActionLabel(a.action)}</span>
                <span className={styles.rowSub}>
                  {a.targetType === "BUSINESS" && a.targetId
                    ? `עסק #${a.targetId}`
                    : a.targetType === "USER"
                      ? "חשבון מנהל"
                      : a.targetType === "SYSTEM"
                        ? "מערכת"
                        : a.targetType ?? ""}
                </span>
              </span>
              <span className={styles.muted}>{formatRelativeTime(a.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function HomeSurface() {
  const home = useAdminLoad("home", fetchPlatformAdminHome);
  const attention = useAdminLoad("attention", fetchPlatformAdminAttention);
  const usage = useAdminLoad<PlatformUsageOverviewResponse>("usage", fetchPlatformAdminUsageOverview);

  const refreshAll = () => {
    home.reload();
    attention.reload();
    usage.reload();
  };

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>סקירה</h1>
          <p>
            {home.data
              ? `עודכן ${new Date(home.data.generatedAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })} · ימים לפי שעון ישראל`
              : "טוען…"}
          </p>
        </div>
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={refreshAll}>
          <ConsoleIcon name="refresh" size={16} />
          רענון
        </button>
      </div>

      <AttentionCard load={attention} />

      {home.loading ? (
        <div className={styles.kpis}>
          {[0, 1, 2, 3].map((i) => (
            <LoadingBlock key={i} height={104} />
          ))}
        </div>
      ) : home.error ? (
        <ErrorBlock error={home.error} onRetry={home.reload} />
      ) : home.data ? (
        <>
          <Kpis home={home.data} />
          <div className={styles.grid2}>
            <FunnelCard home={home.data} />
            <OnboardingCard home={home.data} />
          </div>
          <div className={styles.grid2}>
            <RecentBusinesses home={home.data} />
            <RecentActions home={home.data} />
          </div>
        </>
      ) : (
        <EmptyBlock title="אין נתונים" />
      )}

      <PlatformUsageInsightsSection
        usage={usage.data}
        error={usage.error ? "לא ניתן לטעון את נתוני השימוש" : null}
        loading={usage.loading}
        onRetry={usage.reload}
      />
    </>
  );
}
