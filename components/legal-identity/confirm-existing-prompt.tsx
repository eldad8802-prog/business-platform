"use client";

/**
 * Runbook §5 step 1: a dismissible, non-blocking prompt on /business for an EXISTING business that has not confirmed
 * its legal identity. Renders nothing unless GET /api/business/legal-identity/confirm answers 200 — i.e. nothing at
 * all while LEGAL_IDENTITY_COMPLETION_ENABLED is off. Confirms only what the business itself saved; never writes a value.
 */

import { useEffect, useState } from "react";

import { getClientAuthToken } from "@/lib/client-session";
import {
  COMPLETION_DISMISS_KEY,
  completionOutcome,
  shouldOfferCompletion,
} from "@/lib/legal-identity/completion-prompt";

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(COMPLETION_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function ConfirmExistingPrompt({ locked, onConfirmed }: { locked: boolean; onConfirmed: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDismissed(readDismissed());
    if (locked) return;
    let alive = true;
    const token = getClientAuthToken();
    if (!token) return;
    fetch("/api/business/legal-identity/confirm", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
      .then((r) => { if (alive) setEnabled(r.status === 200); })
      .catch(() => { /* not offered */ });
    return () => { alive = false; };
  }, [locked]);

  if (!shouldOfferCompletion({ enabled, locked, dismissed })) return null;

  async function confirm() {
    const token = getClientAuthToken();
    if (!token || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch("/api/business/legal-identity/confirm", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = (await r.json().catch(() => ({}))) as { result?: unknown };
      const out = completionOutcome(body.result);
      setMessage(out.message);
      if (out.done) onConfirmed();
    } catch {
      setMessage(completionOutcome(undefined).message);
    } finally {
      setBusy(false);
    }
  }

  function dismiss() {
    try { window.sessionStorage.setItem(COMPLETION_DISMISS_KEY, "1"); } catch { /* per-tab convenience only */ }
    setDismissed(true);
  }

  return (
    <div
      data-testid="legal-identity-completion-prompt"
      role="region"
      aria-label="השלמת פרטי העסק החוקיים"
      style={{
        border: "1px solid var(--dz-warning)",
        borderRadius: 12,
        padding: 12,
        margin: "0 0 12px",
        background: "var(--dz-surface)",
        fontSize: 14,
      }}
    >
      <strong>השלימו ואשרו את פרטי העסק החוקיים</strong>
      <p style={{ margin: "6px 0" }}>
        מלאו סוג עסק, שם חוקי ומספר עוסק / ח״פ בטופס שלמטה, שמרו, ואז לחצו &quot;אישור הפרטים&quot;. לאחר האישור הפרטים
        נעולים לשינוי (תיקון ייעשה בבקשה מסודרת). זה לא חובה כרגע והעסק ממשיך לעבוד כרגיל.
      </p>
      {message ? <p role="status" style={{ margin: "6px 0", fontWeight: 600 }}>{message}</p> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={confirm} disabled={busy}>אישור הפרטים</button>
        <button type="button" onClick={dismiss} disabled={busy}>לא עכשיו</button>
      </div>
    </div>
  );
}
