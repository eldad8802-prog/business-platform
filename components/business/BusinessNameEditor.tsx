"use client";

/**
 * The business's display name — the one chosen at signup, editable by its owner.
 *
 * Saved through PATCH /api/business/name on its own, separate from the invoice
 * identity form below it: the name is the business itself, while the legal
 * name on documents (billingLegalName) is an invoicing detail that may differ.
 */

import { useEffect, useState } from "react";

import { buildClientAuthHeaders, redirectToLogin } from "@/lib/client-session";
import { MAX_BUSINESS_NAME_LENGTH, MIN_NAME_LENGTH } from "@/lib/auth/signup-identity";

export function BusinessNameEditor() {
  const [saved, setSaved] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { headers: buildClientAuthHeaders(), cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) return redirectToLogin();
        if (!res.ok) return;
        const me = (await res.json()) as { user?: { businessName?: string | null } };
        const name = me?.user?.businessName ?? "";
        if (!cancelled) {
          setSaved(name);
          setValue(name);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = value.trim();
  const valid = trimmed.length >= MIN_NAME_LENGTH && trimmed.length <= MAX_BUSINESS_NAME_LENGTH;
  const changed = saved !== null && trimmed !== saved;

  async function save() {
    if (!valid || !changed) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/business/name", {
        method: "PATCH",
        headers: buildClientAuthHeaders(),
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.status === 401) return redirectToLogin();
      const data = (await res.json().catch(() => null)) as { name?: string; error?: string } | null;
      if (!res.ok || !data?.name) {
        setMessage({ kind: "error", text: data?.error ?? "השמירה נכשלה. נסו שוב." });
        return;
      }
      setSaved(data.name);
      setValue(data.name);
      // Keep the cached session summary in step with the new name.
      try {
        const raw = window.localStorage.getItem("user");
        if (raw) {
          const user = JSON.parse(raw) as Record<string, unknown>;
          window.localStorage.setItem("user", JSON.stringify({ ...user, businessName: data.name }));
        }
      } catch {
        /* cosmetic only */
      }
      setMessage({ kind: "ok", text: "שם העסק עודכן" });
    } catch {
      setMessage({ kind: "error", text: "אין חיבור כרגע. נסו שוב." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="business-name-title"
      style={{
        background: "var(--dz-surface)",
        border: "1px solid var(--dz-border)",
        borderRadius: 14,
        padding: 16,
        display: "grid",
        gap: 10,
      }}
    >
      <h2 id="business-name-title" style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "var(--dz-text-primary)" }}>
        שם העסק
      </h2>
      <p style={{ margin: 0, fontSize: 13, color: "var(--dz-text-muted)", lineHeight: 1.5 }}>
        השם שמופיע ב-Dubiz ובבית שלך. השם המשפטי למסמכים נקבע בנפרד, למטה.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          aria-label="שם העסק"
          value={value}
          maxLength={MAX_BUSINESS_NAME_LENGTH}
          onChange={(e) => {
            setValue(e.target.value);
            setMessage(null);
          }}
          disabled={saved === null || saving}
          style={{
            flex: "1 1 220px",
            minHeight: 44,
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid var(--dz-border-strong)",
            fontSize: 15,
            fontFamily: "inherit",
          }}
        />
        <button
          type="button"
          onClick={save}
          disabled={!valid || !changed || saving}
          style={{
            minHeight: 44,
            padding: "0 18px",
            borderRadius: 12,
            border: 0,
            background: !valid || !changed || saving ? "var(--dz-action-disabled-bg)" : "var(--dz-action-primary)",
            color: !valid || !changed || saving ? "var(--dz-action-disabled-text)" : "var(--dz-action-primary-text)",
            fontSize: 14,
            fontWeight: 600,
            cursor: !valid || !changed || saving ? "default" : "pointer",
          }}
        >
          {saving ? "שומר…" : "שמירה"}
        </button>
      </div>
      {!valid && trimmed.length > 0 ? (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--dz-danger)" }}>
          שם העסק צריך להכיל {MIN_NAME_LENGTH}–{MAX_BUSINESS_NAME_LENGTH} תווים
        </p>
      ) : message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          style={{ margin: 0, fontSize: 13, color: message.kind === "error" ? "var(--dz-danger)" : "var(--dz-success)" }}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
