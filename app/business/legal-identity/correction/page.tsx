"use client";

/**
 * Correction request for the LOCKED legal identity (owner decision 2026-11-13). The owner never edits the business
 * kind, legal name or dealer number / ח״פ directly: they ask, with a reason, after re-verifying; an authorized party
 * decides. Draft and OFF (LEGAL_IDENTITY_CORRECTION_ENABLED): when the API answers 404 this page says the feature is
 * not available, and no screen links here yet.
 *
 * Hebrew only, RTL, mobile first; the existing settings page's tokens. Values are the owner's own data.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import PageHeader from "@/components/ui/page-header";

type Identity = { businessKind: string; legalName: string; taxId: string };
type RequestRow = {
  id: number;
  kind: "TYPO_CORRECTION" | "BUSINESS_KIND_CHANGE";
  status: "PENDING" | "APPLIED" | "REJECTED" | "CANCELLED" | "STALE";
  current: { businessKind: string; legalName: string | null; taxId: string | null };
  requested: { businessKind: string; legalName: string | null; taxId: string | null };
  reason: string | null;
  decisionNote: string | null;
  createdAt: string;
};
type State = { identity: Identity | null; verification: "PASSWORD" | "RECENT_SIGN_IN"; requests: RequestRow[] };

const KIND_LABEL: Record<string, string> = { EXEMPT_DEALER: "עוסק פטור", AUTHORIZED_DEALER: "עוסק מורשה", LTD_COMPANY: "חברה בע״מ" };
const STATUS_LABEL: Record<RequestRow["status"], string> = {
  PENDING: "ממתינה להחלטה",
  APPLIED: "אושרה ובוצעה",
  REJECTED: "נדחתה",
  CANCELLED: "בוטלה",
  STALE: "לא בוצעה — הפרטים השתנו בינתיים",
};
const REQUEST_KIND_LABEL: Record<RequestRow["kind"], string> = { TYPO_CORRECTION: "תיקון טעות", BUSINESS_KIND_CHANGE: "שינוי סוג עסק" };

function token(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || "";
}
const card: React.CSSProperties = {
  background: "var(--dz-surface)", border: "1px solid var(--dz-border)", borderRadius: 14, padding: 16,
};
const input: React.CSSProperties = {
  height: 46, width: "100%", boxSizing: "border-box", borderRadius: 12, border: "1px solid var(--dz-border-strong)",
  padding: "0 12px", font: "inherit", fontSize: 16, background: "var(--dz-surface-raised-flat)", color: "var(--dz-text-primary)",
};
const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 14, fontWeight: 500 };
const errorText: React.CSSProperties = { margin: 0, color: "var(--dz-danger)", fontSize: 13 };

export default function LegalIdentityCorrectionPage() {
  const [state, setState] = useState<State | null>(null);
  const [view, setView] = useState<"loading" | "off" | "ready" | "error">("loading");
  const [kind, setKind] = useState("");
  const [legalName, setLegalName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [reason, setReason] = useState("");
  const [sameEntity, setSameEntity] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<{ field?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/business/legal-identity/corrections", { headers: { Authorization: `Bearer ${token()}` }, cache: "no-store" });
      if (res.status === 404) return setView("off");
      if (!res.ok) return setView("error");
      const s = (await res.json()) as State;
      setState(s);
      if (s.identity) {
        setKind((k) => k || s.identity!.businessKind);
        setLegalName((v) => v || s.identity!.legalName);
        setTaxId((v) => v || s.identity!.taxId);
      }
      setView("ready");
    } catch {
      setView("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFieldError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/business/legal-identity/corrections", {
        method: "POST",
        headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          requestedBusinessKind: kind, requestedLegalName: legalName, requestedTaxId: taxId, reason,
          sameLegalEntity: sameEntity, password: state?.verification === "PASSWORD" ? password : undefined,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; field?: string };
      if (!res.ok) {
        setFieldError({ field: j.field, message: j.error || "הבקשה לא נשלחה. אפשר לנסות שוב." });
        return;
      }
      setPassword("");
      setReason("");
      setSameEntity(false);
      setNotice("הבקשה נשלחה וממתינה להחלטה. הפרטים הקיימים נשארים בתוקף עד שהבקשה תאושר.");
      await load();
    } catch {
      setFieldError({ message: "הבקשה לא נשלחה. אפשר לנסות שוב." });
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: number) {
    setBusy(true);
    try {
      await fetch(`/api/business/legal-identity/corrections/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token()}` } });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const errFor = (f: string) => (fieldError?.field === f ? <p role="alert" style={errorText}>{fieldError.message}</p> : null);
  const pending = state?.requests.find((r) => r.status === "PENDING") ?? null;

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: "var(--dz-surface-muted)" }}>
      <PageHeader title="בקשת תיקון פרטים חוקיים" showBack />
      <main style={{ maxWidth: 640, margin: "0 auto", padding: "16px", display: "grid", gap: 16 }}>
        {view === "loading" ? <p aria-busy="true" style={{ color: "var(--dz-text-muted)" }}>טוען…</p> : null}
        {view === "off" ? (
          <section style={card} data-testid="correction-off">
            <p style={{ margin: 0 }}>הגשת בקשות תיקון לפרטים החוקיים עדיין אינה זמינה.</p>
            <p style={{ margin: "8px 0 0" }}><Link href="/business">חזרה לפרטי העסק</Link></p>
          </section>
        ) : null}
        {view === "error" ? <p role="alert" style={errorText}>לא ניתן לטעון את הנתונים כרגע.</p> : null}

        {view === "ready" && state && !state.identity ? (
          <section style={card}>
            <p style={{ margin: 0 }}>פרטי העסק עדיין לא אושרו ולכן אינם נעולים. אפשר לעדכן אותם ישירות ב<Link href="/business">פרטי העסק</Link>.</p>
          </section>
        ) : null}

        {view === "ready" && state?.identity ? (
          <>
            <section style={card} aria-labelledby="cur-h">
              <h2 id="cur-h" style={{ margin: "0 0 10px", fontSize: 16 }}>הפרטים הנעולים כעת</h2>
              <dl style={{ margin: 0, display: "grid", gap: 8 }}>
                <div><dt style={{ fontSize: 13, color: "var(--dz-text-muted)" }}>סוג העסק</dt><dd style={{ margin: 0, fontWeight: 600 }}>{KIND_LABEL[state.identity.businessKind] ?? state.identity.businessKind}</dd></div>
                <div><dt style={{ fontSize: 13, color: "var(--dz-text-muted)" }}>שם משפטי</dt><dd style={{ margin: 0, fontWeight: 600 }}>{state.identity.legalName}</dd></div>
                <div><dt style={{ fontSize: 13, color: "var(--dz-text-muted)" }}>מספר עוסק / ח״פ</dt><dd style={{ margin: 0, fontWeight: 600 }}><span dir="ltr">{state.identity.taxId}</span></dd></div>
              </dl>
              <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--dz-text-muted)", lineHeight: 1.5 }}>
                תיקון טעות שומר על אותה ישות משפטית. מעבר בין עוסק לבין חברה בע״מ הוא ישות אחרת ואינו מתבצע כאן.
                בקשה מאושרת אינה משנה מסמכים שכבר הופקו.
              </p>
            </section>

            {notice ? <p role="status" style={{ ...card, margin: 0, color: "var(--dz-text-primary)" }}>{notice}</p> : null}

            {pending ? (
              <section style={card} data-testid="correction-pending">
                <p style={{ margin: 0 }}>יש בקשה פתוחה ({REQUEST_KIND_LABEL[pending.kind]}) שממתינה להחלטה. אפשר לבטל אותה כדי להגיש בקשה אחרת.</p>
                <button type="button" onClick={() => cancel(pending.id)} disabled={busy} style={{ ...input, width: "auto", marginTop: 10, cursor: "pointer", fontWeight: 600 }}>
                  ביטול הבקשה
                </button>
              </section>
            ) : (
              <form onSubmit={submit} noValidate style={{ ...card, display: "grid", gap: 14 }} data-testid="correction-form">
                <h2 style={{ margin: 0, fontSize: 16 }}>מה צריך לתקן</h2>
                <label style={label}>
                  סוג העסק
                  <select value={kind} onChange={(e) => setKind(e.target.value)} style={input}>
                    {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  {errFor("requestedBusinessKind")}
                </label>
                <label style={label}>
                  שם משפטי
                  <input value={legalName} onChange={(e) => setLegalName(e.target.value)} style={input} autoComplete="off" />
                  {errFor("requestedLegalName")}
                </label>
                <label style={label}>
                  מספר עוסק / ח״פ
                  <input value={taxId} onChange={(e) => setTaxId(e.target.value)} style={input} dir="ltr" inputMode="numeric" autoComplete="off" />
                  {errFor("requestedTaxId")}
                </label>
                <label style={label}>
                  סיבת הבקשה
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} style={{ ...input, height: "auto", padding: 12 }} />
                  {errFor("reason")}
                </label>
                <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14 }}>
                  <input type="checkbox" checked={sameEntity} onChange={(e) => setSameEntity(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>אני מאשר/ת שהבקשה נוגעת לאותה ישות משפטית ושהפרטים המבוקשים נכונים.</span>
                </label>
                {errFor("sameLegalEntity")}
                {state.verification === "PASSWORD" ? (
                  <label style={label}>
                    סיסמת החשבון (לאימות)
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={input} dir="ltr" autoComplete="current-password" />
                  </label>
                ) : (
                  <p style={{ margin: 0, fontSize: 13, color: "var(--dz-text-muted)" }}>החשבון נפתח עם Google: לאימות יש להתחבר מחדש ולהגיש בתוך 10 דקות.</p>
                )}
                {fieldError && !fieldError.field ? <p role="alert" style={errorText}>{fieldError.message}</p> : null}
                {fieldError?.field === "noChange" ? <p role="alert" style={errorText}>{fieldError.message}</p> : null}
                <button type="submit" disabled={busy} style={{ height: 50, borderRadius: 14, border: 0, background: "var(--dz-brand-gradient)", color: "var(--dz-text-on-brand)", font: "inherit", fontWeight: 600, cursor: "pointer" }}>
                  {busy ? "שולחים…" : "שליחת בקשת תיקון"}
                </button>
              </form>
            )}

            {state.requests.length > 0 ? (
              <section style={card} aria-labelledby="hist-h" data-testid="correction-history">
                <h2 id="hist-h" style={{ margin: "0 0 10px", fontSize: 16 }}>היסטוריית בקשות</h2>
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
                  {state.requests.map((r) => (
                    <li key={r.id} style={{ borderTop: "1px solid var(--dz-border)", paddingTop: 10 }}>
                      <div style={{ fontWeight: 600 }}>{REQUEST_KIND_LABEL[r.kind]} · {STATUS_LABEL[r.status]}</div>
                      <div style={{ fontSize: 13, color: "var(--dz-text-muted)" }}>{new Date(r.createdAt).toLocaleDateString("he-IL")}</div>
                      {r.decisionNote ? <div style={{ fontSize: 13 }}>הערת ההחלטה: {r.decisionNote}</div> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
