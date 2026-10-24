"use client";

/**
 * In-app task reminders (owner-approved plan 2026-10-21): while Dubiz is open, a due reminder appears on ANY screen
 * within a minute — a toast with "בוצע", "עוד 10 דקות", "לפתיחה" and close. The poll also asks the server to send
 * what is due for this business, so the open app never waits for a late scheduled call; a reminder that came while
 * the app was closed is still unseen and shows on the next visit (and stays in the bell until read).
 *
 * Self-disabling: 401 / 404 (signed out, or daily_tasks off for the business) stops the poll. Every minute while
 * the tab is visible, and at once when the owner returns to it.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { buildClientAuthHeaders } from "@/lib/client-session";
import { fetchPendingReminders, markReminderSeen, taskAction, TasksApiError, type PendingReminder } from "@/lib/tasks/tasks-client";

const POLL_MS = 60_000;

export function ReminderCenter() {
  const router = useRouter();
  const [current, setCurrent] = useState<PendingReminder | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const stopped = useRef(false);
  const dismissed = useRef<Set<number>>(new Set());

  const poll = useCallback(async () => {
    if (stopped.current || document.visibilityState !== "visible") return;
    try {
      const { reminders } = await fetchPendingReminders();
      const next = reminders.find((r) => !dismissed.current.has(r.id)) ?? null;
      setCurrent((prev) => (prev && next && prev.id === next.id ? prev : next));
    } catch (e) {
      if (e instanceof TasksApiError && (e.status === 401 || e.status === 404)) stopped.current = true;
    }
  }, []);

  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    const onVis = () => void poll();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [poll]);

  if (!current) return note ? <Toast><p style={{ margin: 0 }}>{note}</p></Toast> : null;

  const seen = async (r: PendingReminder) => {
    dismissed.current.add(r.id);
    setCurrent(null);
    await markReminderSeen(r.id).catch(() => undefined);
  };
  const withTask = async (r: PendingReminder, fn: (version: number) => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${r.taskId}`, { cache: "no-store", headers: buildClientAuthHeaders() });
      const j = (await res.json()) as { task?: { version: number; status: string } };
      if (!j.task || j.task.status !== "OPEN") throw new Error("closed");
      await fn(j.task.version);
      await seen(r);
      setNote(done);
      setTimeout(() => setNote(null), 4000);
    } catch {
      setNote("לא הצלחנו לעדכן. אפשר לפתוח את המשימה ולנסות שוב.");
      setTimeout(() => setNote(null), 5000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Toast>
      <p style={{ margin: 0, fontSize: 12, color: "var(--dz-text-muted, #6b746a)" }}>תזכורת</p>
      <p style={{ margin: "2px 0 0", fontWeight: 600 }}>{current.title}</p>
      {current.summary ? <p style={{ margin: "2px 0 8px", fontSize: 13 }}>{current.summary}</p> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          disabled={busy}
          style={btn(true)}
          onClick={() => void withTask(current, (version) => taskAction(current.taskId, "complete", { expectedVersion: version }), "סומן כבוצע")}
        >
          בוצע
        </button>
        <button
          type="button"
          disabled={busy}
          style={btn(false)}
          onClick={() =>
            void withTask(
              current,
              (version) => taskAction(current.taskId, "snooze-reminder", { expectedVersion: version, until: inMinutes(10) }),
              "נזכיר שוב בעוד 10 דקות",
            )
          }
        >
          עוד 10 דקות
        </button>
        <button
          type="button"
          disabled={busy}
          style={btn(false)}
          onClick={() => {
            void seen(current);
            router.push(current.href);
          }}
        >
          לפתיחה
        </button>
        <button type="button" aria-label="סגירת התזכורת" disabled={busy} style={{ ...btn(false), marginInlineStart: "auto" }} onClick={() => void seen(current)}>
          ✕
        </button>
      </div>
    </Toast>
  );
}

function inMinutes(n: number): string {
  const d = new Date(Date.now() + n * 60_000);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  return d.toISOString();
}

/**
 * Below 768px the shell's bottom bar (84px + the raised "+") is fixed at the bottom: the toast sits above it, so "+"
 * and the navigation stay reachable while a reminder is shown. Wider screens have no bottom bar.
 */
const TOAST_CSS = `
.dz-reminder-toast { bottom: calc(104px + env(safe-area-inset-bottom, 0px)); }
@media (min-width: 768px) { .dz-reminder-toast { bottom: calc(16px + env(safe-area-inset-bottom, 0px)); } }
`;

function Toast({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      dir="rtl"
      className="dz-reminder-toast"
      style={{
        position: "fixed",
        insetInline: 16,
        zIndex: 1000,
        maxWidth: 420,
        marginInline: "auto",
        background: "var(--dz-surface, #fff)",
        color: "var(--dz-text, #23302b)",
        border: "1px solid var(--dz-border, #e3e5dd)",
        borderRadius: 14,
        boxShadow: "0 8px 24px rgba(20, 30, 25, 0.16)",
        padding: "12px 14px",
      }}
    >
      <style>{TOAST_CSS}</style>
      {children}
    </div>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return {
    font: "inherit",
    fontSize: 13,
    borderRadius: 10,
    padding: "6px 12px",
    cursor: "pointer",
    border: primary ? "1px solid #246966" : "1px solid var(--dz-border, #e3e5dd)",
    background: primary ? "#246966" : "transparent",
    color: primary ? "#fff" : "inherit",
  };
}
