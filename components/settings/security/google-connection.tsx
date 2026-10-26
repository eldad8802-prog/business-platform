"use client";

/**
 * Settings → Security → Google. Whether the account is connected to Google, and the way to disconnect it.
 *
 * Disconnecting asks for the account's password again (the server checks it under the login attempt limits)
 * and is offered only to an account that HAS a password — without one, nothing would be left to sign in
 * with. Rendered only while "Continue with Google" is on. Hebrew only (owner decision, 22.10.2026).
 */

import { useEffect, useState } from "react";

import { buildClientAuthHeaders, redirectToLogin } from "@/lib/client-session";

type Status = { linked: boolean; emailAtLink: string | null; linkedAt: string | null; lastUsedAt: string | null; hasPassword: boolean };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ready"; status: Status };

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });
}

/** The caller's own status; redirects to login when the session is gone. */
async function fetchStatus(): Promise<Load> {
  try {
    const res = await fetch("/api/security/google", { headers: buildClientAuthHeaders(), cache: "no-store" });
    if (res.status === 401) {
      redirectToLogin();
      return { kind: "loading" };
    }
    if (!res.ok) return { kind: "error" };
    return { kind: "ready", status: (await res.json()) as Status };
  } catch {
    return { kind: "error" };
  }
}

export function GoogleConnection() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchStatus().then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  const disconnect = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!password) {
      setMessage({ tone: "error", text: "יש להזין את הסיסמה של החשבון." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/security/google", {
        method: "POST",
        headers: { ...buildClientAuthHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setConfirming(false);
        setPassword("");
        setMessage({ tone: "ok", text: "Google נותק מהחשבון. שלחנו הודעה על כך לאימייל של החשבון." });
        setState(await fetchStatus());
        return;
      }
      setMessage({ tone: "error", text: body.error ?? "הניתוק לא הושלם. אפשר לנסות שוב." });
    } catch {
      setMessage({ tone: "error", text: "הניתוק לא הושלם. אפשר לנסות שוב." });
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === "loading") return null;
  if (state.kind === "error") {
    return <p className="px-1 text-sm text-[var(--dz-text-secondary)]">לא ניתן להציג כרגע את מצב החיבור ל־Google.</p>;
  }
  const s = state.status;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="google-connection-title" data-testid="google-connection">
      <h2 id="google-connection-title" className="px-1 text-base font-bold text-[var(--dz-text-primary)]">התחברות עם Google</h2>
      <div className="rounded-3xl dz-mist px-4 py-4 shadow-sm">
        {s.linked ? (
          <div className="flex flex-col gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-[var(--dz-text-primary)]" data-testid="google-connection-state">מחובר ל־Google</p>
              {s.emailAtLink ? <p className="mt-1 break-all text-xs text-[var(--dz-text-secondary)]" dir="ltr" style={{ textAlign: "right" }}>{s.emailAtLink}</p> : null}
              {s.linkedAt ? <p className="mt-1 text-xs text-[var(--dz-text-secondary)]">חובר ב־{shortDate(s.linkedAt)}</p> : null}
            </div>
            {!s.hasPassword ? (
              <p className="text-xs text-[var(--dz-text-secondary)]" data-testid="google-connection-needs-password">
                כדי לנתק את Google צריך קודם לבחור סיסמה לחשבון (דרך ״שכחתי סיסמה״ במסך ההתחברות). בלי סיסמה לא תהיה דרך אחרת להתחבר.
              </p>
            ) : confirming ? (
              <form onSubmit={disconnect} className="flex flex-col gap-2" data-testid="google-connection-confirm">
                <label htmlFor="google-unlink-password" className="text-xs text-[var(--dz-text-secondary)]">לאישור, יש להזין את הסיסמה של החשבון:</label>
                <input
                  id="google-unlink-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="min-h-11 rounded-2xl border border-[var(--dz-border-subtle)] bg-white px-3 text-sm"
                />
                <div className="flex flex-wrap gap-2">
                  <button type="submit" disabled={busy} className="min-h-11 rounded-2xl bg-[var(--dz-danger,#9c3232)] px-4 text-sm font-bold text-white disabled:opacity-70" data-testid="google-unlink-submit">
                    {busy ? "מנתקים…" : "ניתוק Google"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => { setConfirming(false); setPassword(""); setMessage(null); }} className="min-h-11 rounded-2xl px-4 text-sm font-bold text-[var(--dz-text-secondary)]">
                    ביטול
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className="min-h-11 self-start rounded-2xl border border-[var(--dz-border-subtle)] px-4 text-sm font-bold text-[var(--dz-text-primary)]" data-testid="google-unlink-open">
                ניתוק
              </button>
            )}
          </div>
        ) : (
          <div>
            <p className="text-sm font-bold text-[var(--dz-text-primary)]" data-testid="google-connection-state">לא מחובר ל־Google</p>
            <p className="mt-1 text-xs text-[var(--dz-text-secondary)]">אפשר לחבר את Google בכניסה הבאה: במסך ההתחברות לוחצים על ״המשך עם Google״ ומאשרים שהחשבון שלך.</p>
          </div>
        )}
        {message ? (
          <p role={message.tone === "error" ? "alert" : "status"} className={`mt-3 text-sm ${message.tone === "error" ? "text-[var(--dz-danger,#9c3232)]" : "text-[var(--dz-app-chrome)]"}`} data-testid="google-connection-message">
            {message.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
