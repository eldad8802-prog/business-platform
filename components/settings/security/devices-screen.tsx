"use client";

/**
 * Settings → Security → your devices.
 *
 * Written for a business owner, not an engineer. Nothing on this screen is a
 * uuid, a hash, a token, a generation or the word "session" in its database
 * sense. A person should be able to look at it and answer one question: is
 * anything signed in that should not be?
 *
 * Times are formatted in the BROWSER. The server stores instants and this project
 * does not store a per-user timezone, so the device the owner is holding is the
 * only thing that knows what "yesterday" means to them.
 */

import { useCallback, useEffect, useState } from "react";

import { buildClientAuthHeaders, redirectToLogin } from "@/lib/client-session";

type SessionStatus = "active" | "revoked" | "expired";

type SessionView = {
  id: string;
  current: boolean;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  status: SessionStatus;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; sessions: SessionView[]; currentIdentified: boolean };

/** Human, relative, and honest about precision. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דקות`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "לפני שעה" : `לפני ${hours} שעות`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "אתמול";
  if (days < 30) return `לפני ${days} ימים`;
  const months = Math.floor(days / 30);
  return months === 1 ? "לפני חודש" : `לפני ${months} חודשים`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });
}

export function DevicesScreen() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/security/sessions", {
        headers: buildClientAuthHeaders(),
        cache: "no-store",
      });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        setState({ kind: "error" });
        return;
      }
      const body = (await res.json()) as { sessions?: SessionView[]; currentIdentified?: boolean };
      setState({
        kind: "ready",
        sessions: Array.isArray(body.sessions) ? body.sessions : [],
        currentIdentified: body.currentIdentified === true,
      });
    } catch {
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revokeOne(id: string, wasCurrentGuess: boolean) {
    setBusy(id);
    setConfirming(null);
    try {
      const res = await fetch(`/api/security/sessions/${id}/revoke`, {
        method: "POST",
        headers: buildClientAuthHeaders(),
      });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { wasCurrent?: boolean };
      // The server decides whether that was this device; the button only guessed.
      if (body.wasCurrent === true || (res.ok && wasCurrentGuess)) {
        redirectToLogin();
        return;
      }
      await load();
    } catch {
      setState({ kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    setBusy("others");
    setConfirming(null);
    try {
      const res = await fetch("/api/security/sessions/revoke-others", {
        method: "POST",
        headers: buildClientAuthHeaders(),
      });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (res.status === 409) {
        // This browser is still holding a token from before device management
        // shipped. It will name its session after the next refresh, so the honest
        // message is "try again shortly", not "something went wrong".
        setState({ kind: "error" });
        return;
      }
      await load();
    } catch {
      setState({ kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  if (state.kind === "loading") {
    return <p className="px-4 py-6 text-sm text-[var(--dz-text-secondary)]">טוען…</p>;
  }

  if (state.kind === "error") {
    return (
      <div className="px-4 py-6">
        <p className="text-sm text-[var(--dz-text-secondary)]">לא הצלחנו לטעון את רשימת המכשירים.</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 min-h-11 rounded-2xl bg-[var(--dz-app-chrome)] px-4 text-sm font-bold text-[var(--dz-text-on-brand)]"
        >
          נסה שוב
        </button>
      </div>
    );
  }

  const live = state.sessions.filter((s) => s.status === "active");
  const others = live.filter((s) => !s.current);

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-sm text-[var(--dz-text-secondary)]">
        אלה המכשירים שמחוברים כרגע לחשבון שלך. אם משהו כאן לא מוכר לך, נתק אותו.
      </p>

      {!state.currentIdentified && (
        <p className="rounded-2xl bg-[var(--dz-surface-sunk,#f5f5f5)] px-4 py-3 text-sm text-[var(--dz-text-secondary)]">
          כדי לזהות את המכשיר הזה ולנתק את כל השאר, רענן את הדף בעוד רגע.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {live.map((s) => (
          <li
            key={s.id}
            className="rounded-3xl dz-mist px-4 py-4 shadow-sm"
            aria-current={s.current ? "true" : undefined}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-[var(--dz-text-primary)]">{s.label}</p>
                {s.current ? (
                  <p className="mt-1 text-xs font-bold text-[var(--dz-app-chrome)]">המכשיר הזה</p>
                ) : (
                  <p className="mt-1 text-xs text-[var(--dz-text-secondary)]">
                    פעילות אחרונה: {relativeTime(s.lastUsedAt)}
                  </p>
                )}
                <p className="mt-1 text-xs text-[var(--dz-text-secondary)]">
                  מחובר מאז {shortDate(s.createdAt)}
                </p>
              </div>

              {confirming === s.id ? (
                <div className="flex shrink-0 flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => void revokeOne(s.id, s.current)}
                    disabled={busy !== null}
                    className="min-h-11 rounded-2xl bg-[var(--dz-danger,#9c3232)] px-3 text-xs font-bold text-white disabled:opacity-70"
                  >
                    {s.current ? "נתק והתנתק" : "כן, נתק"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    disabled={busy !== null}
                    className="min-h-11 rounded-2xl px-3 text-xs font-bold text-[var(--dz-text-secondary)]"
                  >
                    ביטול
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(s.id)}
                  disabled={busy !== null}
                  className="min-h-11 shrink-0 rounded-2xl border border-[var(--dz-border-subtle)] px-3 text-xs font-bold text-[var(--dz-text-primary)] disabled:opacity-70"
                >
                  {busy === s.id ? "מנתק…" : "ניתוק"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {others.length > 0 && state.currentIdentified && (
        <div className="px-1 pt-2">
          {confirming === "others" ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-[var(--dz-text-secondary)]">
                לנתק את כל {others.length} המכשירים האחרים? המכשיר הזה יישאר מחובר.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void revokeOthers()}
                  disabled={busy !== null}
                  className="min-h-11 rounded-2xl bg-[var(--dz-danger,#9c3232)] px-4 text-sm font-bold text-white disabled:opacity-70"
                >
                  כן, נתק את כולם
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  disabled={busy !== null}
                  className="min-h-11 rounded-2xl px-4 text-sm font-bold text-[var(--dz-text-secondary)]"
                >
                  ביטול
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming("others")}
              disabled={busy !== null}
              className="min-h-11 w-full rounded-2xl border border-[var(--dz-border-subtle)] px-4 text-sm font-bold text-[var(--dz-text-primary)] disabled:opacity-70"
            >
              {busy === "others" ? "מנתק…" : "נתק את כל המכשירים האחרים"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
