"use client";

/**
 * The emailed link's page (#1081). On load it only CHECKS the link and loads the statement (no change). The
 * declaration is recorded only on the button, by the signed-in account, in one transaction with the link's spend.
 * The token is read from the fragment and removed from the address bar so it does not linger in history.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import type { IssuerStatement } from "@/lib/billing/issuer-declaration/statement";

import { authHeaders, shellStyle, StatementTable } from "../shared";

type View =
  | { kind: "loading" }
  | { kind: "blocked"; message: string; status: string }
  | { kind: "ready"; statement: IssuerStatement }
  | { kind: "done"; message: string; outcome: string };

const PRECONDITION_MESSAGE: Record<string, string> = {
  ALREADY_DECLARED: "לעסק כבר קיימת הצהרת מנפיק.",
  NEEDS_DESIGNATION: "בעסק יש יותר ממשתמש אחד. את המורשה להצהיר ממנה מנהל הפלטפורמה.",
  INCOMPLETE: "פרטי המנפיק אינם שלמים. יש להשלים אותם ולבקש קישור חדש.",
};

export default function ConfirmScreen() {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const hash = window.location.hash;
    const t = hash.startsWith("#t=") ? decodeURIComponent(hash.slice(3)) : null;
    // The secret stays in this page's memory only: out of the address bar and the history.
    if (hash) window.history.replaceState(null, "", window.location.pathname);
    (async () => {
      if (!t) {
        if (alive) setView({ kind: "blocked", status: "INVALID", message: "הקישור אינו תקין. יש לפתוח את הקישור מההודעה האחרונה שנשלחה." });
        return;
      }
      try {
        const headers = { ...authHeaders(), "content-type": "application/json" };
        const res = await fetch("/api/billing/issuer-declaration/check", {
          method: "POST",
          headers,
          credentials: "same-origin",
          body: JSON.stringify({ token: t }),
        });
        const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string | null };
        if (!alive) return;
        if (body.status !== "VALID") {
          setView({ kind: "blocked", status: body.status ?? "INVALID", message: body.message ?? "הקישור אינו תקין." });
          return;
        }
        const st = await fetch("/api/billing/issuer-declaration", { headers: authHeaders(), credentials: "same-origin", cache: "no-store" });
        const sb = (await st.json().catch(() => ({}))) as { statement?: IssuerStatement | null; precondition?: string | null };
        if (!alive) return;
        if (!st.ok || !sb.statement || sb.precondition) {
          const status = sb.precondition ?? "INCOMPLETE";
          setView({ kind: "blocked", status, message: PRECONDITION_MESSAGE[status] ?? PRECONDITION_MESSAGE.INCOMPLETE });
          return;
        }
        setToken(t);
        setView({ kind: "ready", statement: sb.statement });
      } catch {
        if (alive) setView({ kind: "blocked", status: "ERROR", message: "לא הצלחנו לבדוק את הקישור. אפשר לרענן את הדף." });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const confirm = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const headers = { ...authHeaders(), "content-type": "application/json" };
      const res = await fetch("/api/billing/issuer-declaration/confirm", {
        method: "POST",
        headers,
        credentials: "same-origin",
        body: JSON.stringify({ token }),
      });
      const body = (await res.json().catch(() => ({}))) as { outcome?: string; message?: string };
      setView({ kind: "done", outcome: body.outcome ?? "ERROR", message: body.message ?? "ההצהרה לא נשמרה. אפשר לנסות שוב." });
    } catch {
      setView({ kind: "done", outcome: "ERROR", message: "ההצהרה לא נשמרה. אפשר לנסות שוב." });
    } finally {
      setBusy(false);
    }
  };

  if (view.kind === "loading") return <main dir="rtl" style={shellStyle} aria-busy="true" />;
  if (view.kind === "blocked" || view.kind === "done") {
    const status = view.kind === "blocked" ? view.status : view.outcome;
    return (
      <main dir="rtl" style={shellStyle} data-testid="issuer-confirm-result" data-status={status}>
        <h1>{status === "CONFIRMED" ? "ההצהרה אושרה" : "ההצהרה לא נשמרה"}</h1>
        <p role={status === "CONFIRMED" ? "status" : "alert"}>{view.message}</p>
        <Link href="/billing/issuer-declaration">למסך הצהרת המנפיק</Link>
      </main>
    );
  }
  return (
    <main dir="rtl" style={shellStyle} data-testid="issuer-confirm-ready">
      <h1>אישור הצהרת המנפיק</h1>
      <p>אני מצהיר/ה שהפרטים הבאים נכונים ושאני מוסמך/ת להצהיר בשם העסק. לאחר האישור פרטי הזהות של העסק יינעלו לפי ההצהרה.</p>
      <StatementTable s={view.statement} />
      <button type="button" onClick={confirm} disabled={busy} data-testid="issuer-confirm-submit" style={{ marginTop: 16 }}>
        {busy ? "מאשרים…" : "אני מאשר/ת את ההצהרה"}
      </button>
    </main>
  );
}
