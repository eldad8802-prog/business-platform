"use client";

/**
 * Subscriptions & quotas (subscriptions stage C, decision 6.1): every business and its subscription state, the
 * businesses with unusual usage, the quota matrix (editable, with the impact shown before saving), the activation mode
 * per metric, and the open plan / quota requests. Every write asks for a reason and a fresh second factor; the server
 * re-checks the admin, writes through the database's definer functions and audits each change.
 */
import Link from "next/link";
import { useState } from "react";

import {
  PlatformAdminFetchError,
  fetchPlatformAdminQuotaMatrix,
  fetchPlatformAdminSubscriptionRequests,
  fetchPlatformAdminSubscriptions,
  platformAdminSubscriptionsWrite,
  previewPlatformAdminQuotaChange,
} from "@/lib/platform-admin/fetch-platform-admin";
import type { QuotaMatrixView, SubscriptionsOverviewRow } from "@/lib/services/platform-admin/subscriptions-admin.service";

import { ErrorBlock, LoadingBlock } from "./console-states";
import { useAdminLoad } from "./use-admin-load";
import styles from "./admin-console.module.css";

const TIERS = ["TRIAL", "BASIC", "ADVANCED", "PREMIUM", "FREE_LIMITED"] as const;
const TIER_HE: Record<string, string> = { TRIAL: "ניסיון", BASIC: "Basic", ADVANCED: "Advanced", PREMIUM: "Premium", FREE_LIMITED: "מוגבל" };
const STATUS_HE: Record<string, string> = { EXEMPT: "בודק", TRIALING: "בניסיון", ACTIVE: "פעיל", PAST_DUE: "בפיגור", FREE_LIMITED: "מוגבל" };
const MODE_HE: Record<string, string> = { OFF: "כבוי", SHADOW: "מדידה בלבד", ENFORCE: "אכיפה" };
const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "short" });

function fmtQuota(unit: string, v: number): string {
  if (unit === "byte") return `${(v / 1024 ** 3).toLocaleString("he-IL", { maximumFractionDigits: 2 })} GB`;
  return v.toLocaleString("he-IL");
}

function errText(e: unknown): string {
  if (e instanceof PlatformAdminFetchError) {
    if (e.status === 503) return "שינויי מנויים ומכסות כבויים כרגע (המתג SUBSCRIPTION_ADMIN_CHANGES_ENABLED).";
    if (e.code === "NO_CHANGE" || e.status === 409) return "אין שינוי.";
    if (e.code === "ADMIN_MFA_REQUIRED") return "נדרש אימות נוסף. לא נשמר.";
    return e.message || "הפעולה נכשלה";
  }
  return "הפעולה נכשלה";
}

type Tab = "overview" | "quotas" | "requests";

export function SubscriptionsSurface() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div>
      <div className={styles.list} role="tablist" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["overview", "quotas", "requests"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`${styles.btn} ${tab === t ? styles.btnPrimary : ""} ${styles.btnSmall}`} onClick={() => setTab(t)}>
            {t === "overview" ? "עסקים" : t === "quotas" ? "מכסות" : "בקשות"}
          </button>
        ))}
      </div>
      {tab === "overview" ? <OverviewTab /> : tab === "quotas" ? <QuotasTab /> : <RequestsTab />}
    </div>
  );
}

function OverviewTab() {
  const load = useAdminLoad("subscriptions:overview", () => fetchPlatformAdminSubscriptions<{ rows: SubscriptionsOverviewRow[]; unusual: SubscriptionsOverviewRow[] }>());
  if (load.loading && !load.previous) return <LoadingBlock />;
  if (load.error) return <ErrorBlock error={load.error} onRetry={load.reload} />;
  const data = load.data ?? load.previous;
  if (!data) return null;
  const row = (r: SubscriptionsOverviewRow) => (
    <tr key={r.businessId}>
      <td><Link href={`/admin/businesses/${r.businessId}/usage`} className={styles.linkBtn}>{r.name ?? `#${r.businessId}`}</Link></td>
      <td>{r.accountType === "CUSTOMER" ? STATUS_HE[r.status ?? ""] ?? r.status : r.accountType === "INTERNAL" ? "פנימי" : "בודק"}</td>
      <td>{r.plan ?? "—"}</td>
      <td>{r.trialEndsAt ? dateFmt.format(new Date(r.trialEndsAt)) : "—"}</td>
      <td>{r.maxPercent === null ? "—" : `${r.maxPercent}%`}</td>
      <td>{r.overShadowUnits || "—"}</td>
      <td>{r.openRequests || "—"}</td>
      <td>${r.estimatedCostUsdThisMonth.toFixed(2)}</td>
    </tr>
  );
  return (
    <div>
      <section className={styles.card}>
        <h2>שימוש חריג</h2>
        <p className={styles.muted}>עסקים מעל 80% ממכסה כלשהי, או עם יחידות שהיו נחסמות אילו האכיפה הייתה פעילה (30 הימים האחרונים).</p>
        {data.unusual.length === 0 ? <p className={styles.muted}>אין כרגע.</p> : (
          <table className={styles.table}><Head /><tbody>{data.unusual.map(row)}</tbody></table>
        )}
      </section>
      <section className={styles.card}>
        <h2>כל העסקים ({data.rows.length})</h2>
        <p className={styles.muted}>עלות משוערת: הערכה לפי מחירי ספקים (ראו עמודת עלות במכסות) — לא חשבונית.</p>
        <table className={styles.table}><Head /><tbody>{data.rows.map(row)}</tbody></table>
      </section>
    </div>
  );
}

function Head() {
  return (
    <thead>
      <tr><th>עסק</th><th>מצב</th><th>מסלול</th><th>סוף ניסיון</th><th>ניצול מרבי</th><th>מעבר בצל</th><th>בקשות</th><th>עלות משוערת</th></tr>
    </thead>
  );
}

function QuotasTab() {
  const load = useAdminLoad("subscriptions:quotas", () => fetchPlatformAdminQuotaMatrix<QuotaMatrixView>());
  const [edit, setEdit] = useState<{ metric: string; tier?: string; unit: string; value: string; mode?: string } | null>(null);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (load.loading && !load.previous) return <LoadingBlock />;
  if (load.error) return <ErrorBlock error={load.error} onRetry={load.reload} />;
  const m = load.data ?? load.previous;
  if (!m) return null;

  const toStored = (unit: string, v: string) => (unit === "byte" ? Math.round(Number(v) * 1024 ** 3) : Math.round(Number(v)));

  async function runPreview() {
    if (!edit?.tier) return;
    try {
      const r = await previewPlatformAdminQuotaChange<{ businessesAbove: number; businessesInTier: number; currentQuota: number | null }>({
        metric: edit.metric,
        tier: edit.tier,
        quota: toStored(edit.unit, edit.value),
      });
      setPreview(`${r.businessesAbove} מתוך ${r.businessesInTier} לקוחות במסלול הזה כבר מעל המכסה המוצעת בתקופה הנוכחית.`);
    } catch (e) {
      setPreview(errText(e));
    }
  }

  async function save() {
    if (!edit) return;
    setBusy(true);
    setMessage(null);
    try {
      if (edit.mode) {
        await platformAdminSubscriptionsWrite("/api/platform-admin/subscriptions/quotas", "PATCH", { metric: edit.metric, mode: edit.mode, reason });
      } else {
        await platformAdminSubscriptionsWrite("/api/platform-admin/subscriptions/quotas", "PATCH", { metric: edit.metric, tier: edit.tier, quota: toStored(edit.unit, edit.value), reason });
      }
      setEdit(null);
      setReason("");
      setPreview(null);
      setMessage("נשמר ונרשם ביומן הפעולות.");
      load.reload();
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <section className={styles.card}>
        <h2>מטריצת מכסות</h2>
        <p className={styles.muted}>
          חודשי לפי תקופת המנוי; ניסיון — לכל 30 הימים; אחסון מצטבר ולא מתאפס. תקרת השרת: {MODE_HE[m.ceiling]} — מצב מדד לא יכול לעבור אותה.
        </p>
        <table className={styles.table}>
          <thead>
            <tr><th>מדד</th>{TIERS.map((t) => <th key={t}>{TIER_HE[t]}</th>)}<th>מצב</th><th>עלות ליחידה</th></tr>
          </thead>
          <tbody>
            {m.metrics.map((x) => (
              <tr key={x.metric}>
                <td>{x.label}</td>
                {TIERS.map((t) => (
                  <td key={t}>
                    <button type="button" className={styles.linkBtn} onClick={() => { setEdit({ metric: x.metric, tier: t, unit: x.unit, value: String(x.unit === "byte" ? x.quotas[t].quota / 1024 ** 3 : x.quotas[t].quota) }); setPreview(null); }}>
                      {fmtQuota(x.unit, x.quotas[t].quota)}
                    </button>
                    {x.quotas[t].quota !== x.quotas[t].opening ? <span className={styles.muted}> (פתיחה {fmtQuota(x.unit, x.quotas[t].opening)})</span> : null}
                  </td>
                ))}
                <td>
                  <button type="button" className={styles.linkBtn} onClick={() => setEdit({ metric: x.metric, unit: x.unit, value: "", mode: x.mode })}>
                    {MODE_HE[x.mode]}{x.effectiveMode !== x.mode ? ` (בפועל: ${MODE_HE[x.effectiveMode]})` : ""}
                  </button>
                </td>
                <td>{x.unitCostUsd ? `$${x.unitCostUsd < 0.001 ? x.unitCostUsd.toExponential(1) : x.unitCostUsd}` : "לא ידוע"}{x.unitCostVerified ? "" : " · הערכה"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {edit ? (
        <section className={styles.card} aria-label="עריכה">
          <h2>{edit.mode ? "מצב הפעלה" : `מכסה — ${TIER_HE[edit.tier ?? ""]}`}</h2>
          {edit.mode ? (
            <div className={styles.field}>
              <label htmlFor="mode">מצב</label>
              <select id="mode" value={edit.mode} onChange={(e) => setEdit({ ...edit, mode: e.target.value })}>
                {(["OFF", "SHADOW", "ENFORCE"] as const).map((x) => <option key={x} value={x}>{MODE_HE[x]}</option>)}
              </select>
              <p className={styles.muted}>אכיפה חלה רק על לקוחות, רק עד תקרת השרת, ולעולם לא על בודקים או על צפייה, הורדה וייצוא.</p>
            </div>
          ) : (
            <div className={styles.field}>
              <label htmlFor="quota">מכסה{edit.unit === "byte" ? " (GB)" : ""}</label>
              <input id="quota" inputMode="decimal" value={edit.value} onChange={(e) => { setEdit({ ...edit, value: e.target.value }); setPreview(null); }} />
              <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={runPreview}>מה ההשפעה?</button>
              {preview ? <p className={styles.muted}>{preview}</p> : null}
            </div>
          )}
          <div className={styles.field}>
            <label htmlFor="reason">סיבה (10–500 תווים)</label>
            <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || reason.trim().length < 10} onClick={save}>שמירה</button>{" "}
          <button type="button" className={styles.btn} onClick={() => { setEdit(null); setPreview(null); }}>ביטול</button>
        </section>
      ) : null}
      {message ? <p className={styles.muted} role="status">{message}</p> : null}
    </div>
  );
}

type RequestRow = { id: string; businessId: number; businessName: string | null; kind: string; requestedPlan: string | null; metric: string | null; note: string | null; createdAt: string };

function RequestsTab() {
  const load = useAdminLoad("subscriptions:requests", () => fetchPlatformAdminSubscriptionRequests<{ requests: RequestRow[] }>("OPEN"));
  const [message, setMessage] = useState<string | null>(null);
  if (load.loading && !load.previous) return <LoadingBlock />;
  if (load.error) return <ErrorBlock error={load.error} onRetry={load.reload} />;
  const data = load.data ?? load.previous;
  if (!data) return null;

  async function resolve(id: string, status: "HANDLED" | "DISMISSED") {
    setMessage(null);
    try {
      await platformAdminSubscriptionsWrite(`/api/platform-admin/subscriptions/requests/${id}`, "POST", { status });
      load.reload();
    } catch (e) {
      setMessage(errText(e));
    }
  }

  return (
    <section className={styles.card}>
      <h2>בקשות פתוחות ({data.requests.length})</h2>
      <p className={styles.muted}>שיוך המסלול עצמו נעשה בדף השימוש של העסק; כאן סוגרים את הבקשה.</p>
      {data.requests.length === 0 ? <p className={styles.muted}>אין בקשות פתוחות.</p> : (
        <div className={styles.list}>
          {data.requests.map((r) => (
            <div key={r.id} className={styles.row}>
              <div>
                <span className={styles.rowTitle}>{r.kind === "PLAN" ? `מעוניין במסלול ${r.requestedPlan}` : `מבקש הגדלת מכסה: ${r.metric}`}</span>
                <span className={styles.rowSub}>{[r.businessName ?? `עסק #${r.businessId}`, dateFmt.format(new Date(r.createdAt)), r.note].filter(Boolean).join(" · ")}</span>
              </div>
              <span>
                <Link href={`/admin/businesses/${r.businessId}/usage`} className={styles.linkBtn}>לעסק</Link>{" "}
                <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => resolve(r.id, "HANDLED")}>טופל</button>{" "}
                <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => resolve(r.id, "DISMISSED")}>דחייה</button>
              </span>
            </div>
          ))}
        </div>
      )}
      {message ? <p className={styles.muted} role="status">{message}</p> : null}
    </section>
  );
}
