"use client";

/**
 * Accountant package monitoring (G5 milestone 1): what is wrong now, what recovered this week, the latest runs of
 * the sweep and of the monitor, and the switches. Operational facts only — codes, months, delivery numbers, times
 * and counts; never an address, a link, a document or an amount (the tables cannot hold one).
 */
import Link from "next/link";
import type { AccountantOpsAlertView, AccountantOpsResponse, AccountantOpsRunView } from "@/lib/services/platform-admin/accountant-ops.service";
import { fetchPlatformAdminAccountantOps } from "@/lib/platform-admin/fetch-platform-admin";
import { ErrorBlock, LoadingBlock } from "./console-states";
import { useAdminLoad } from "./use-admin-load";
import styles from "./admin-console.module.css";

const timeFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short" });
const fmt = (iso: string | null) => (iso ? timeFmt.format(new Date(iso)) : "—");

const SEVERITY_HE: Record<string, string> = { CRITICAL: "קריטי", HIGH: "גבוה", MEDIUM: "בינוני" };
const OUTCOME_HE: Record<string, string> = { OK: "תקין", FAILED: "נכשל", RUNNING: "לא הסתיים" };
const SOURCE_HE: Record<string, string> = { VERCEL_CRON: "Vercel Cron", GITHUB_ACTIONS: "GitHub Actions" };

function stripeClass(severity: string): string {
  if (severity === "CRITICAL") return `${styles.stripe} ${styles.stripeCritical}`;
  if (severity === "HIGH") return `${styles.stripe} ${styles.stripeHigh}`;
  return `${styles.stripe} ${styles.stripeMedium}`;
}

function scopeOf(a: AccountantOpsAlertView): string {
  if (a.scope === "platform") return a.subject ? `פלטפורמה · ${a.subject}` : "פלטפורמה";
  const biz = a.businessName ? `${a.businessName} (#${a.businessId})` : `עסק #${a.businessId}`;
  return a.subject ? `${biz} · ${a.subject}` : biz;
}

function AlertList({ alerts, resolved }: { alerts: AccountantOpsAlertView[]; resolved?: boolean }) {
  return (
    <div className={styles.list}>
      {alerts.map((a) => (
        <div key={`${a.scope}:${a.id}`} className={styles.row}>
          <i className={resolved ? `${styles.stripe} ${styles.stripeOk}` : stripeClass(a.severity)} aria-hidden="true" />
          <div>
            <span className={styles.rowTitle}>{a.title}</span>
            <span className={styles.rowSub}>
              {[
                scopeOf(a),
                resolved ? `נפתר ${fmt(a.resolvedAt)}` : `${SEVERITY_HE[a.severity] ?? a.severity} · מאז ${fmt(a.openedAt)}`,
                !resolved && a.detail.unchecked === true ? "לא ניתן לבדוק כרגע (המתג כבוי) — נשאר פתוח, בלי תזכורות" : "",
                a.notifyCount > 0 ? `נשלחו ${a.notifyCount} הודעות (אחרונה ${fmt(a.lastNotifiedAt)})` : "טרם נשלחה הודעה",
              ].filter(Boolean).join(" · ")}
            </span>
          </div>
          {a.businessId ? (
            <Link href={`/admin/businesses/${a.businessId}`} className={styles.linkBtn}>
              לעסק
            </Link>
          ) : (
            <span />
          )}
        </div>
      ))}
    </div>
  );
}

function RunsTable({ title, runs }: { title: string; runs: AccountantOpsRunView[] }) {
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <h2>{title}</h2>
      </div>
      {runs.length === 0 ? (
        <p className={styles.note}>עוד לא נרשמה ריצה.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>התחלה</th>
                <th>מקור</th>
                <th>תוצאה</th>
                <th>משך</th>
                <th>פירוט</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{fmt(r.startedAt)}</td>
                  <td>{SOURCE_HE[r.source] ?? r.source}</td>
                  <td>
                    <span className={`${styles.pill} ${r.outcome === "OK" ? styles.pillOk : r.outcome === "FAILED" ? styles.pillBad : styles.pillWarn}`}>
                      {OUTCOME_HE[r.outcome] ?? r.outcome}
                    </span>
                  </td>
                  <td>{r.durationMs === null ? "—" : `${(r.durationMs / 1000).toFixed(1)} שנ׳`}</td>
                  <td className={styles.muted}>{summarize(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function summarize(r: AccountantOpsRunView): string {
  const c = r.counts as Record<string, unknown>;
  const n = (k: string) => (typeof c[k] === "number" ? (c[k] as number) : 0);
  if (r.kind === "SWEEP") {
    return `עסקים פעילים ${n("eligible")} · הוכנו ${n("prepared")} · נבנו ${n("built")} · נכשלו ${n("buildFailed")} · שליחות ${n("deliveriesProcessed")} · שגיאות ${n("businessErrors")}`;
  }
  return `נבדקו ${n("evaluated")}/${n("eligible")} · ממצאים ${n("findings")} · נפתחו ${n("opened")} · נסגרו ${n("resolved")} · הודעות ${n("claimed")}${r.errorCode ? ` · ${r.errorCode}` : ""}`;
}

/**
 * The monitor's own health and an honest account of how alerts travel. No delivery time is promised: Vercel Cron is
 * hourly, but GitHub's schedule — the channel that works when Vercel's does not — is irregular.
 */
function Health({ data }: { data: Extract<AccountantOpsResponse, { available: true }> }) {
  const h = data.health;
  const problems = [
    h.cronStale ? `תזמון הניטור ב־Vercel לא רץ מאז ${fmt(h.lastRunBySource.VERCEL_CRON)}` : "",
    h.watchdogStale ? `בודק הניטור העצמאי ב־GitHub לא רץ מאז ${fmt(h.lastRunBySource.GITHUB_ACTIONS)}` : "",
    h.lastRun && h.lastRun.outcome !== "OK"
      ? h.lastRun.errorCode?.startsWith("notify_")
        ? "הריצה האחרונה לא הצליחה לשלוח את ההתראה — הפריטים נשמרו וישלחו בריצה הבאה"
        : "הריצה האחרונה של הניטור נכשלה"
      : "",
  ].filter(Boolean);
  return (
    <section className={`${styles.card} ${problems.length ? styles.cardAttention : ""}`} aria-labelledby="ops-health">
      <div className={styles.cardHead}>
        <h2 id="ops-health">מצב הניטור עצמו</h2>
        <span className={`${styles.pill} ${problems.length ? styles.pillBad : styles.pillOk}`}>{problems.length ? "דורש בדיקה" : "תקין"}</span>
      </div>
      {problems.length ? (
        <ul className={styles.note}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      ) : null}
      <p className={styles.note}>
        ריצה אחרונה דרך Vercel Cron: {fmt(h.lastRunBySource.VERCEL_CRON)} · דרך GitHub: {fmt(h.lastRunBySource.GITHUB_ACTIONS)}
        {h.lastNotifyFailureAt ? ` · כשל שליחת התראה אחרון: ${fmt(h.lastNotifyFailureAt)}` : ""}
      </p>
      <p className={styles.note}>
        אין התחייבות לזמן הגעת התראה. כשתזמון Vercel פועל הבדיקה רצה פעם בשעה; אם הוא נעצר, הבדיקה ממשיכה דרך GitHub, שהתזמון
        שלו אינו סדיר ועלול להתעכב כמה שעות. כשערוץ ההתראות אינו זמין, ההתראות אינן אובדות: הן נשמרות ונשלחות בריצה הבאה,
        הריצה מסומנת כנכשלת כאן, והבדיקה ב־GitHub מסומנת באדום (ההודעה על כך תלויה בהגדרות ההתראות של GitHub).
      </p>
    </section>
  );
}

function Switches({ data }: { data: AccountantOpsResponse }) {
  const c = data.config;
  const item = (label: string, on: boolean, onText = "פעיל", offText = "כבוי") => (
    <div className={styles.kpi}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={styles.kpiValue}>
        <span className={`${styles.pill} ${on ? styles.pillOk : styles.pillNeutral}`}>{on ? onText : offText}</span>
      </span>
    </div>
  );
  return (
    <div className={styles.kpis}>
      {item("ניטור", c.monitorEnabled)}
      {item("ערוץ התראות", c.alertChannelConfigured, "מוגדר", "לא מוגדר")}
      {item("סריקה חודשית", c.sweepEnabled)}
      {item("שליחה לרואי חשבון", c.deliveryEnabled)}
      {item("Webhook מסירה", c.webhookConfigured, "מוגדר", "לא מוגדר")}
    </div>
  );
}

export function AccountantOpsSurface() {
  const load = useAdminLoad<AccountantOpsResponse>("accountant-ops", () => fetchPlatformAdminAccountantOps());
  const data = load.data ?? (load.loading ? load.previous : null);

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>ניטור חבילת רואה החשבון</h1>
          <p>תקלות פתוחות, ריצות אחרונות ומצב המתגים. מידע תפעולי בלבד — בלי כתובות, קישורים או מסמכים.</p>
        </div>
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={load.reload} disabled={load.loading}>
          רענון
        </button>
      </div>
      {!data && load.loading ? <LoadingBlock height={140} label="טוען את מצב הניטור" /> : null}
      {load.error ? <ErrorBlock error={load.error} onRetry={load.reload} /> : null}
      {data ? (
        <>
          <Switches data={data} />
          {!data.available ? (
            <section className={`${styles.card} ${styles.cardAttention}`}>
              <div className={styles.cardHead}>
                <h2>אין עדיין הרשאת קריאה לטבלאות הניטור</h2>
              </div>
              <p className={styles.note}>
                הניטור וההתראות עובדים גם בלי המסך הזה. כדי שהמסך יציג אותם צריך להחיל את הרשאת הקריאה של הפאנל
                (migration 20261107092000_accountant_ops_admin_read), באישור נפרד.
              </p>
            </section>
          ) : (
            <>
              <Health data={data} />
              <section className={`${styles.card} ${data.openAlerts.length ? styles.cardAttention : ""}`} aria-labelledby="ops-open">
                <div className={styles.cardHead}>
                  <h2 id="ops-open">תקלות פתוחות</h2>
                  {data.openAlerts.length ? <span className={`${styles.pill} ${styles.pillBad}`}>{data.openAlerts.length}</span> : null}
                </div>
                {data.openAlerts.length === 0 ? <p className={styles.note}>אין כרגע תקלה פתוחה.</p> : <AlertList alerts={data.openAlerts} />}
              </section>
              <section className={styles.card} aria-labelledby="ops-resolved">
                <div className={styles.cardHead}>
                  <h2 id="ops-resolved">נפתרו בשבוע האחרון</h2>
                </div>
                {data.recentlyResolved.length === 0 ? (
                  <p className={styles.note}>לא נסגרה תקלה בשבוע האחרון.</p>
                ) : (
                  <AlertList alerts={data.recentlyResolved} resolved />
                )}
              </section>
              <RunsTable title="ריצות אחרונות — סריקה חודשית" runs={data.sweepRuns} />
              <RunsTable title="ריצות אחרונות — ניטור" runs={data.monitorRuns} />
            </>
          )}
        </>
      ) : null}
    </>
  );
}
