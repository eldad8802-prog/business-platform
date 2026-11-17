"use client";

/**
 * Shows what is stored, what is missing and — when complete — the exact statement. The only action sends the
 * confirmation link to the account's address; nothing is declared on this screen. The details themselves are
 * edited in the business details form (the identity fields lock once a declaration exists).
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import type { IssuerDetailProblem } from "@/lib/billing/issuer-declaration/details";
import type { IssuerStatement } from "@/lib/billing/issuer-declaration/statement";

import { authHeaders, shellStyle, StatementTable } from "./shared";

type State = {
  problems: IssuerDetailProblem[];
  declared: boolean;
  precondition: "ALREADY_DECLARED" | "INCOMPLETE" | "NEEDS_DESIGNATION" | null;
  statement: IssuerStatement | null;
};

export default function DeclarationScreen() {
  const [state, setState] = useState<State | "loading" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/billing/issuer-declaration", { headers: authHeaders(), credentials: "same-origin", cache: "no-store" });
        const body = (await res.json()) as State;
        if (alive) setState(res.ok ? body : "error");
      } catch {
        if (alive) setState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const send = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/billing/issuer-declaration/request", { method: "POST", headers: authHeaders(), credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setNotice(body.message ?? "לא נשלח קישור. אפשר לנסות שוב.");
    } catch {
      setNotice("לא נשלח קישור. אפשר לנסות שוב.");
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading") return <main dir="rtl" style={shellStyle} aria-busy="true" />;
  if (state === "error") {
    return (
      <main dir="rtl" style={shellStyle}>
        <p role="alert">לא הצלחנו לטעון את פרטי המנפיק. אפשר לרענן את הדף.</p>
      </main>
    );
  }

  return (
    <main dir="rtl" style={shellStyle} data-testid="issuer-declaration-screen" data-precondition={state.precondition ?? "READY"}>
      <h1>הצהרת המנפיק</h1>
      {state.declared ? (
        <p>לעסק קיימת הצהרת מנפיק. פרטי הזהות של העסק נעולים לפיה.</p>
      ) : state.precondition === "INCOMPLETE" ? (
        <>
          <p>לפני אישור ההצהרה וההפקה הראשונה יש להשלים את הפרטים הבאים:</p>
          <ul data-testid="issuer-problems">
            {state.problems.map((p) => (
              <li key={`${p.field}-${p.code}`}>{p.message}</li>
            ))}
          </ul>
          <Link href="/billing">מעבר לפרטי העסק</Link>
        </>
      ) : state.precondition === "NEEDS_DESIGNATION" ? (
        <p>בעסק יש יותר ממשתמש אחד. את המורשה להצהיר ממנה מנהל הפלטפורמה.</p>
      ) : state.statement ? (
        <>
          <p>אלה הפרטים שיירשמו בהצהרה. האישור נעשה בקישור שנשלח לאימייל של החשבון, כשהחשבון מחובר.</p>
          <StatementTable s={state.statement} />
          <button type="button" onClick={send} disabled={busy} data-testid="issuer-request-link" style={{ marginTop: 16 }}>
            {busy ? "שולחים…" : "שליחת קישור לאישור"}
          </button>
        </>
      ) : null}
      {notice ? (
        <p role="status" data-testid="issuer-request-notice">
          {notice}
        </p>
      ) : null}
    </main>
  );
}
