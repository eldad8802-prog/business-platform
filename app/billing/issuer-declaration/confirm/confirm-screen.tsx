"use client";

/**
 * The emailed link's page (#1081), in the approved design (owner, 2026-11-17, screens 4 and 5). On load it only
 * CHECKS the link and loads the statement (no change). The declaration is recorded only on the button, by the
 * signed-in account, in one transaction with the link's spend.
 *
 * Security is unchanged: the token is read from the fragment and removed from the address bar before anything else
 * runs, so it does not linger in history; it is held in this page's memory only and never stored. A page that was
 * opened while signed out explains why and how to continue — it does not keep the token across a sign-in.
 */

import { useEffect, useState } from "react";

import { SUPPORT_EMAIL } from "@/components/settings/settings-hub";
import { confirmViewFor, type ConfirmAction } from "@/lib/billing/issuer-declaration/screen-model";
import type { IssuerStatement } from "@/lib/billing/issuer-declaration/statement";
import { TOKEN } from "@/lib/design/billing-theme";

import { authHeaders, Card, CardTitle, LinkButton, LockIcon, Page, PageHead, PrimaryButton, SecondaryButton, StatementTable } from "../shared";

type View =
  | { kind: "loading" }
  | { kind: "result"; status: string }
  | { kind: "ready"; statement: IssuerStatement };

function Actions({ actions, onRetry, busy }: { actions: ConfirmAction[]; onRetry: () => void; busy: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {actions.map((a, i) => {
        const primary = i === 0;
        switch (a) {
          case "SIGN_IN":
            return <LinkButton key={a} href="/login" primary={primary} testId="issuer-confirm-sign-in">התחברות</LinkButton>;
          case "NEW_LINK":
            return <LinkButton key={a} href="/billing/issuer-declaration" primary={primary} testId="issuer-confirm-new-link">שליחת קישור חדש</LinkButton>;
          case "REVIEW_DETAILS":
            return <LinkButton key={a} href="/billing/issuer-declaration" primary={primary}>לבדיקת הפרטים</LinkButton>;
          case "STATUS":
            return <LinkButton key={a} href="/billing/issuer-declaration" primary={primary} testId="issuer-confirm-status">למצב ההצהרה</LinkButton>;
          case "BILLING":
            return <LinkButton key={a} href="/billing" primary={primary}>לאזור החשבוניות</LinkButton>;
          case "CONTACT":
            return <LinkButton key={a} href={`mailto:${SUPPORT_EMAIL}`} primary={primary}>פנייה לצוות דוביז</LinkButton>;
          case "RETRY":
            return primary ? (
              <PrimaryButton key={a} onClick={onRetry} disabled={busy} testId="issuer-confirm-retry">{busy ? "מאשרים…" : "ניסיון חוזר"}</PrimaryButton>
            ) : (
              <SecondaryButton key={a} onClick={onRetry} disabled={busy}>ניסיון חוזר</SecondaryButton>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

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
        if (alive) setView({ kind: "result", status: "INVALID" });
        return;
      }
      try {
        const res = await fetch("/api/billing/issuer-declaration/check", {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ token: t }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          status?: string;
          statement?: IssuerStatement | null;
          precondition?: string | null;
        };
        if (!alive) return;
        if (res.status === 401) {
          setView({ kind: "result", status: "SIGN_IN_REQUIRED" });
          return;
        }
        if (body.status !== "VALID") {
          setView({ kind: "result", status: body.status ?? "INVALID" });
          return;
        }
        if (!res.ok || !body.statement || body.precondition) {
          setView({ kind: "result", status: body.precondition ?? "INCOMPLETE" });
          return;
        }
        setToken(t);
        setView({ kind: "ready", statement: body.statement });
      } catch {
        if (alive) setView({ kind: "result", status: "ERROR" });
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
      const res = await fetch("/api/billing/issuer-declaration/confirm", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token }),
      });
      const body = (await res.json().catch(() => ({}))) as { outcome?: string };
      const status = res.status === 401 ? "SIGN_IN_REQUIRED" : body.outcome ?? "ERROR";
      // A spent or refused link is never offered again; only a transient failure keeps the token for a retry.
      if (!confirmViewFor(status).retryable) setToken(null);
      setView({ kind: "result", status });
    } catch {
      setView({ kind: "result", status: "ERROR" });
    } finally {
      setBusy(false);
    }
  };

  if (view.kind === "loading") return <Page><div aria-busy="true" style={{ minHeight: 200 }} /></Page>;

  if (view.kind === "result") {
    const v = confirmViewFor(view.status);
    const canRetry = v.retryable && token !== null;
    return (
      <Page testId="issuer-confirm-result" status={view.status}>
        <PageHead title={view.status === "CONFIRMED" ? "הצהרת המנפיק" : "אישור הצהרת המנפיק"} />
        <Card tone={v.tone} label={v.title} role={v.tone === "success" ? "status" : "alert"}>
          <CardTitle tone={v.tone}>{v.title}</CardTitle>
          <p style={{ margin: 0, fontSize: 14 }}>{v.body}</p>
          <Actions actions={canRetry ? v.actions : v.actions.filter((a) => a !== "RETRY").concat(v.retryable ? ["NEW_LINK"] : [])} onRetry={confirm} busy={busy} />
        </Card>
      </Page>
    );
  }

  return (
    <Page testId="issuer-confirm-ready">
      <PageHead step="נפתח מהקישור שנשלח למייל" title="אישור הצהרת המנפיק" />
      <Card label="הצהרה">
        <p style={{ margin: 0, fontSize: 15, fontWeight: TOKEN.weight.medium, lineHeight: 1.7 }}>
          אני מצהיר/ה שהפרטים הבאים נכונים, שאני מוסמך/ת להצהיר בשם העסק, ושהם יופיעו על המסמכים שאפיק בדוביז.
        </p>
        <div style={{ borderTop: `1px solid ${TOKEN.border.DEFAULT}`, paddingTop: 12 }}>
          <StatementTable s={view.statement} />
        </div>
      </Card>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          background: TOKEN.semantic.attention.bg,
          border: `1px solid ${TOKEN.semantic.attention.border}`,
          borderRadius: TOKEN.radius.input,
          padding: 12,
        }}
      >
        <LockIcon color={TOKEN.semantic.attention.ink} />
        <p style={{ margin: 0, fontSize: 13, color: TOKEN.semantic.attention.ink }}>
          לאחר האישור, סוג העסק, השם הרשמי, מספר הזהות ומספר העוסק המורשה ננעלים. שינוי שלהם — רק בבקשת תיקון מבוקרת.
        </p>
      </div>
      <PrimaryButton onClick={confirm} disabled={busy} testId="issuer-confirm-submit">
        {busy ? "מאשרים…" : "אני מאשר/ת את ההצהרה"}
      </PrimaryButton>
      <a href="/billing/issuer-declaration" style={{ textAlign: "center", fontSize: 14, color: TOKEN.brand.mid }}>
        משהו לא נכון? חזרה לפרטים
      </a>
    </Page>
  );
}
