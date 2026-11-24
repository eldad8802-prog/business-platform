"use client";

/**
 * One business's subscription and usage (subscriptions stage C, decision 6.1): its record, the quota and usage of every
 * metric this period, the measured provider usage and estimated cost, the adjustments (add / special quota / revoke),
 * the usage history and the latest counted units (identifiers and amounts only, never document content), and the
 * admin's lifecycle actions: assign a plan, grant or extend a trial, move to the limited mode, mark tester.
 * Every write asks for a reason and a fresh second factor; the server re-checks and audits it.
 */
import { useState } from "react";

import {
  PlatformAdminFetchError,
  fetchPlatformAdminBusinessUsage,
  platformAdminSubscriptionsWrite,
} from "@/lib/platform-admin/fetch-platform-admin";
import type { BusinessUsageAdminView } from "@/lib/services/platform-admin/subscriptions-admin.service";

import { ErrorBlock, LoadingBlock } from "./console-states";
import { useAdminLoad } from "./use-admin-load";
import styles from "./admin-console.module.css";

const STATUS_HE: Record<string, string> = { EXEMPT: "בודק", TRIALING: "בניסיון", ACTIVE: "פעיל", PAST_DUE: "בפיגור", FREE_LIMITED: "מוגבל" };
const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short" });
const QUOTA_METRICS = ["business_documents", "document_uploads", "ocr_pages", "storage_customer_bytes", "accountant_packages", "accountant_emails", "ai_owner_actions", "video_renders"];

function amountText(metric: string, v: number | null): string {
  if (v === null) return "ללא מכסה";
  if (metric.endsWith("_bytes")) return `${(v / 1024 ** 3).toLocaleString("he-IL", { maximumFractionDigits: 3 })} GB`;
  return v.toLocaleString("he-IL");
}

function errText(e: unknown): string {
  if (e instanceof PlatformAdminFetchError) {
    if (e.status === 503) return "שינויי מנויים ומכסות כבויים כרגע (המתג SUBSCRIPTION_ADMIN_CHANGES_ENABLED).";
    if (e.code === "ADMIN_MFA_REQUIRED") return "נדרש אימות נוסף. לא נשמר.";
    if (e.code === "PREMIUM_NOT_OPEN") return "Premium עדיין לא פתוח.";
    if (e.status === 409) return "אין שינוי.";
    return e.message || "הפעולה נכשלה";
  }
  return "הפעולה נכשלה";
}

export function BusinessUsageSurface({ businessId }: { businessId: number }) {
  const load = useAdminLoad(`usage:${businessId}`, () => fetchPlatformAdminBusinessUsage<BusinessUsageAdminView>(businessId), Number.isInteger(businessId) && businessId > 0);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [adj, setAdj] = useState({ metric: "ocr_pages", kind: "ADD", amount: "", endsAt: "" });
  const [life, setLife] = useState({ action: "PLAN", plan: "BASIC", trialDays: "30" });
  const [busy, setBusy] = useState(false);

  if (load.loading && !load.previous) return <LoadingBlock />;
  if (load.error) return <ErrorBlock error={load.error} onRetry={load.reload} />;
  const v = load.data ?? load.previous;
  if (!v) return null;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setReason("");
      setMessage("נשמר ונרשם ביומן הפעולות.");
      load.reload();
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const lifecycleBody = (): Record<string, unknown> => {
    if (life.action === "TESTER") return { accountType: "TESTER", plan: null, reason };
    if (life.action === "TRIAL") return { accountType: "CUSTOMER", status: "TRIALING", plan: null, trialDays: Number(life.trialDays), reason };
    if (life.action === "LIMITED") return { accountType: "CUSTOMER", status: "FREE_LIMITED", plan: null, reason };
    return { accountType: "CUSTOMER", status: "ACTIVE", plan: life.plan, reason };
  };

  const toStored = (metric: string, a: string) => (metric.endsWith("_bytes") ? Math.round(Number(a) * 1024 ** 3) : Math.round(Number(a)));
  const s = v.subscription;

  return (
    <div>
      <section className={styles.card}>
        <h2>מנוי</h2>
        <p>
          {s ? `${s.accountType === "CUSTOMER" ? STATUS_HE[s.status ?? ""] ?? s.status : s.accountType === "INTERNAL" ? "פנימי" : "בודק"}${s.plan ? ` · ${s.plan}` : ""}${s.trialEndsAt ? ` · הניסיון מסתיים ${dateFmt.format(new Date(s.trialEndsAt))}` : ""}` : "אין רשומת מנוי — מחושב כבודק"}
        </p>
        <p className={styles.muted}>עלות משוערת בתקופה הנוכחית: ${v.estimatedCostUsdThisPeriod.toFixed(3)} (הערכה, לא חשבונית).</p>
      </section>

      <section className={styles.card}>
        <h2>שימוש בתקופה הנוכחית</h2>
        <table className={styles.table}>
          <thead><tr><th>מדד</th><th>סוג</th><th>מכסה</th><th>נוצל</th><th>%</th><th>מתחדש</th></tr></thead>
          <tbody>
            {v.metrics.map((m) => (
              <tr key={m.metric}>
                <td>{m.label}</td>
                <td>{m.kind === "quota" ? "מכסה" : "מדידה"}</td>
                <td>{m.kind === "quota" ? amountText(m.metric, m.quota) : "—"}</td>
                <td>{amountText(m.metric, m.used)}</td>
                <td>{m.percent === null ? "—" : `${m.percent}%`}</td>
                <td>{m.periodKey === "ALL" ? "מצטבר" : m.periodEnd ? dateFmt.format(new Date(m.periodEnd)) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={styles.card}>
        <h2>פעולות</h2>
        <div className={styles.field}>
          <label htmlFor="reason">סיבה (חובה, 10–500 תווים)</label>
          <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>

        <h3>מנוי</h3>
        <div className={styles.field}>
          <select aria-label="פעולה" value={life.action} onChange={(e) => setLife({ ...life, action: e.target.value })}>
            <option value="PLAN">שיוך מסלול</option>
            <option value="TRIAL">מתן או הארכת ניסיון</option>
            <option value="LIMITED">מעבר למצב מוגבל</option>
            <option value="TESTER">סימון כבודק</option>
          </select>
          {life.action === "PLAN" ? (
            <select aria-label="מסלול" value={life.plan} onChange={(e) => setLife({ ...life, plan: e.target.value })}>
              <option value="BASIC">Basic</option>
              <option value="ADVANCED">Advanced</option>
            </select>
          ) : null}
          {life.action === "TRIAL" ? <input aria-label="ימי ניסיון" inputMode="numeric" value={life.trialDays} onChange={(e) => setLife({ ...life, trialDays: e.target.value })} /> : null}
          <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={busy || reason.trim().length < 10}
            onClick={() => run(() => platformAdminSubscriptionsWrite(`/api/platform-admin/businesses/${businessId}/subscription`, "PATCH", lifecycleBody()))}>
            ביצוע
          </button>
        </div>

        <h3>תוספת או מכסה מיוחדת</h3>
        <div className={styles.field}>
          <select aria-label="מדד" value={adj.metric} onChange={(e) => setAdj({ ...adj, metric: e.target.value })}>
            {QUOTA_METRICS.map((m) => <option key={m} value={m}>{v.metrics.find((x) => x.metric === m)?.label ?? m}</option>)}
          </select>
          <select aria-label="סוג" value={adj.kind} onChange={(e) => setAdj({ ...adj, kind: e.target.value })}>
            <option value="ADD">תוספת על המסלול</option>
            <option value="OVERRIDE">מכסה מיוחדת במקום המסלול</option>
          </select>
          <input aria-label={adj.metric.endsWith("_bytes") ? "כמות (GB)" : "כמות"} inputMode="decimal" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} />
          <input aria-label="עד תאריך (לא חובה)" type="date" value={adj.endsAt} onChange={(e) => setAdj({ ...adj, endsAt: e.target.value })} />
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || reason.trim().length < 10 || adj.amount === ""}
            onClick={() => run(() => platformAdminSubscriptionsWrite(`/api/platform-admin/businesses/${businessId}/usage/adjustments`, "POST", {
              metric: adj.metric, kind: adj.kind, amount: toStored(adj.metric, adj.amount), endsAt: adj.endsAt ? new Date(`${adj.endsAt}T23:59:59Z`).toISOString() : null, reason,
            }))}>
            הוספה
          </button>
        </div>
        {v.adjustments.length > 0 ? (
          <div className={styles.list}>
            {v.adjustments.map((a) => (
              <div key={a.id} className={styles.row}>
                <div>
                  <span className={styles.rowTitle}>{`${a.metric} · ${a.kind === "ADD" ? "תוספת" : "מכסה מיוחדת"} ${amountText(a.metric, a.amount)}`}</span>
                  <span className={styles.rowSub}>{[a.reason, a.endsAt ? `עד ${dateFmt.format(new Date(a.endsAt))}` : "ללא תאריך סיום", a.revokedAt ? `בוטל ${dateFmt.format(new Date(a.revokedAt))}` : ""].filter(Boolean).join(" · ")}</span>
                </div>
                {a.revokedAt ? <span /> : (
                  <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || reason.trim().length < 10}
                    onClick={() => run(() => platformAdminSubscriptionsWrite(`/api/platform-admin/businesses/${businessId}/usage/adjustments/${a.id}`, "POST", { reason }))}>
                    ביטול
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : null}
        {message ? <p className={styles.muted} role="status">{message}</p> : null}
      </section>

      <section className={styles.card}>
        <h2>היסטוריית שימוש</h2>
        <table className={styles.table}>
          <thead><tr><th>תקופה</th><th>מדד</th><th>נוצל</th></tr></thead>
          <tbody>{v.history.map((h) => <tr key={`${h.periodKey}:${h.metric}`}><td>{h.periodKey}</td><td>{h.metric}</td><td>{amountText(h.metric, h.used)}</td></tr>)}</tbody>
        </table>
      </section>

      <section className={styles.card}>
        <h2>יחידות אחרונות</h2>
        <table className={styles.table}>
          <thead><tr><th>זמן</th><th>מדד</th><th>כמות</th><th>מצב</th><th>תוצאה</th><th>מקור</th></tr></thead>
          <tbody>
            {v.recentUnits.map((u, i) => (
              <tr key={i}><td>{dateFmt.format(new Date(u.createdAt))}</td><td>{u.metric}</td><td>{amountText(u.metric, u.amount)}</td><td>{u.state}</td><td>{u.verdict === "OVER_SHADOW" ? "מעבר למכסה (צל)" : u.verdict}</td><td>{u.source}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
