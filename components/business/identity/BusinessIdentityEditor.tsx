"use client";

import { useCallback, useEffect, useState } from "react";
import { DIMENSION_RULES } from "@/lib/services/identity/identity-vocabulary";
import { CODE_LABELS, CONTACT_FACTS, DIMENSION_LABELS, FACT_LABELS, FACT_STATE_LABELS, describeSignal } from "./identity-labels";

/**
 * P2 — the owner's identity screen. Everything is optional; nothing is pre-filled from a guess.
 *
 *   facts        values from the business profile; the owner confirms them and, separately,
 *                approves public use (a changed value loses its approval by itself)
 *   statements   what the owner states (each one owner-confirmed)
 *   suggestions  what Dubiz noticed; one tap to adopt, never applied on its own
 *   public use   a separate, explicit toggle on claim-like text only
 */

type Statement = {
  id: number;
  dimension: string;
  code: string | null;
  text: string | null;
  source: "OWNER_INPUT" | "OWNER_ADOPTED_SUGGESTION";
  publicUseApproved: boolean;
  publicUseEligible: boolean;
};
type Suggestion = { dimension: string; code: string; alreadyConfirmed: boolean };
type Signal = {
  key: string;
  kind: string;
  status: "SUPPORTED" | "INSUFFICIENT_EVIDENCE";
  value: Record<string, string | number | boolean>;
  suggestions: Suggestion[];
};
type Fact = {
  fact: string;
  value: string | null;
  state: "UNKNOWN" | "KNOWN" | "OWNER_CONFIRMED" | "PUBLIC_USE_APPROVED";
  authorityStale: boolean;
};
type Identity = {
  facts: Fact[];
  profile: { key: string; value: string | null }[];
  statements: Statement[];
  signals: Signal[];
};

const CODED_ORDER = ["TARGET_AUDIENCE", "PRIMARY_OBJECTIVE", "SECONDARY_OBJECTIVE", "TONE", "POSITIONING"] as const;
const TEXT_LIST_ORDER = ["SPECIALIZATION", "DIFFERENTIATOR", "SERVICE_AREA"] as const;

function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function fetchIdentity(): Promise<Identity | null> {
  try {
    const res = await fetch("/api/business/identity", { headers: authHeaders(), cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { identity: Identity }).identity;
  } catch {
    return null;
  }
}

const card: React.CSSProperties = {
  background: "var(--dz-surface)",
  border: "1px solid var(--dz-border)",
  borderRadius: 14,
  padding: 16,
};
const h2: React.CSSProperties = { margin: "0 0 4px", fontSize: 15, fontWeight: 800, color: "var(--dz-text-primary)" };
const hint: React.CSSProperties = { margin: "0 0 10px", fontSize: 12, color: "var(--dz-text-muted)" };

function Chip({ active, disabled, label, onClick }: { active: boolean; disabled?: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      style={{
        minHeight: 36,
        padding: "0 12px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        border: `1px solid ${active ? "var(--dz-accent)" : "var(--dz-border)"}`,
        background: active ? "var(--dz-accent-bg-soft, var(--dz-surface-muted))" : "var(--dz-surface)",
        color: active ? "var(--dz-accent)" : "var(--dz-text-secondary)",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function PublicUseToggle({ statement, onToggle, busy }: { statement: Statement; onToggle: (s: Statement) => void; busy: boolean }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dz-text-muted)" }}>
      <input type="checkbox" checked={statement.publicUseApproved} disabled={busy} onChange={() => onToggle(statement)} />
      מאושר לשימוש פומבי
    </label>
  );
}

export function BusinessIdentityEditor() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const apply = useCallback((next: Identity | null) => {
    if (!next) {
      setStatus("error");
      return;
    }
    setIdentity(next);
    setDescription(next.statements.find((s) => s.dimension === "DESCRIPTION")?.text ?? "");
    setStatus("ok");
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await fetchIdentity();
      if (!cancelled) apply(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const load = async () => apply(await fetchIdentity());

  async function call(url: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: authHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "הפעולה לא הצליחה");
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (status === "loading") return <div style={{ marginTop: 24, color: "var(--dz-text-muted)" }}>טוען…</div>;
  if (status === "error" || !identity) {
    return <p style={{ marginTop: 24, color: "var(--dz-danger)", fontSize: 13 }}>לא הצלחנו לטעון את זהות העסק כרגע.</p>;
  }

  const active = (dimension: string) => identity.statements.filter((s) => s.dimension === dimension);
  const togglePublic = (s: Statement) => call(`/api/business/identity/${s.id}`, "PATCH", { publicUseApproved: !s.publicUseApproved });
  const retire = (s: Statement) => call(`/api/business/identity/${s.id}`, "DELETE");
  const currentDescription = active("DESCRIPTION")[0] ?? null;
  const openSuggestions = identity.signals.flatMap((sig) =>
    sig.status === "SUPPORTED" ? sig.suggestions.filter((s) => !s.alreadyConfirmed).map((s) => ({ sig, s })) : [],
  );
  const noticed = identity.signals.filter((sig) => sig.status === "SUPPORTED" && sig.suggestions.length === 0);
  const decideFact = (fact: string, action: string) => call("/api/business/identity/facts", "POST", { fact, action });
  const knownFacts = identity.facts.filter((f) => f.value);
  const profileFacts = identity.profile.filter((f) => f.value);
  const factRow = (f: Fact) => (
    <div key={f.fact} style={{ display: "grid", gap: 6, padding: "8px 0", borderTop: "1px solid var(--dz-border-subtle, var(--dz-border))", fontSize: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span style={{ color: "var(--dz-text-muted)" }}>{FACT_LABELS[f.fact] ?? f.fact}</span>
        <span style={{ color: "var(--dz-text-primary)", fontWeight: 600 }}>{f.value}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--dz-text-muted)" }}>
          {FACT_STATE_LABELS[f.state] ?? f.state}
          {f.authorityStale ? " · הערך השתנה מאז האישור" : ""}
        </span>
        <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
          {f.state === "KNOWN" ? (
            <button type="button" disabled={busy} onClick={() => decideFact(f.fact, "CONFIRM")} style={{ fontSize: 12, fontWeight: 700 }}>
              נכון
            </button>
          ) : null}
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dz-text-muted)" }}>
            <input
              type="checkbox"
              checked={f.state === "PUBLIC_USE_APPROVED"}
              disabled={busy}
              onChange={() => decideFact(f.fact, f.state === "PUBLIC_USE_APPROVED" ? "WITHDRAW_PUBLIC" : "APPROVE_PUBLIC")}
            />
            מאושר לשימוש פומבי
          </label>
        </span>
      </div>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
      {error ? (
        <div role="alert" style={{ background: "var(--dz-danger-bg-soft)", color: "var(--dz-danger)", padding: "10px 12px", borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      ) : null}

      {knownFacts.length > 0 || profileFacts.length > 0 ? (
        <section style={card}>
          <h2 style={h2}>מה כבר ידוע על העסק</h2>
          <p style={hint}>מתוך פרטי העסק שכבר הזנת. שום פרט לא יוצג ללקוחות בלי שסימנת &quot;מאושר לשימוש פומבי&quot;.</p>
          {profileFacts.map((f) => (
            <div key={f.key} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", fontSize: 13 }}>
              <span style={{ color: "var(--dz-text-muted)" }}>{FACT_LABELS[f.key] ?? f.key}</span>
              <span style={{ color: "var(--dz-text-primary)", fontWeight: 600 }}>{f.value}</span>
            </div>
          ))}
          {knownFacts.filter((f) => !CONTACT_FACTS.has(f.fact)).map(factRow)}
          {knownFacts.some((f) => CONTACT_FACTS.has(f.fact)) ? (
            <>
              <p style={{ ...hint, marginTop: 12 }}>פרטי הקשר שהזנת לחשבוניות. הם פרטיים עד שתאשר להציג אותם.</p>
              {knownFacts.filter((f) => CONTACT_FACTS.has(f.fact)).map(factRow)}
            </>
          ) : null}
        </section>
      ) : null}

      {openSuggestions.length > 0 ? (
        <section style={card}>
          <h2 style={h2}>Dubiz שם לב</h2>
          <p style={hint}>הצעות מתוך מה שכבר קורה בעסק. שום דבר לא נשמר בלי אישור שלך.</p>
          <div style={{ display: "grid", gap: 10 }}>
            {openSuggestions.map(({ sig, s }) => (
              <div key={`${sig.key}>${s.dimension}:${s.code}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
                <span style={{ color: "var(--dz-text-secondary)" }}>
                  {describeSignal(sig.kind, sig.value)} — {DIMENSION_LABELS[s.dimension]?.title}: <strong>{CODE_LABELS[s.code] ?? s.code}</strong>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => call("/api/business/identity/suggestions", "POST", { signalKey: sig.key, dimension: s.dimension, code: s.code })}
                  style={{ minHeight: 36, padding: "0 12px", borderRadius: 10, border: "1px solid var(--dz-border)", fontWeight: 700, fontSize: 13 }}
                >
                  נכון, להוסיף
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section style={card}>
        <h2 style={h2}>{DIMENSION_LABELS.DESCRIPTION.title}</h2>
        <p style={hint}>{DIMENSION_LABELS.DESCRIPTION.hint}</p>
        <textarea
          value={description}
          maxLength={500}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
          style={{ width: "100%", borderRadius: 10, border: "1px solid var(--dz-border)", padding: 10, fontSize: 14 }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 8 }}>
          {currentDescription ? <PublicUseToggle statement={currentDescription} onToggle={togglePublic} busy={busy} /> : <span />}
          <button
            type="button"
            disabled={busy || !description.trim() || description.trim() === (currentDescription?.text ?? "")}
            onClick={() => call("/api/business/identity", "POST", { dimension: "DESCRIPTION", text: description })}
            style={{ minHeight: 36, padding: "0 14px", borderRadius: 10, border: "1px solid var(--dz-border)", fontWeight: 700, fontSize: 13 }}
          >
            שמירה
          </button>
        </div>
      </section>

      {CODED_ORDER.map((dimension) => {
        const rule = DIMENSION_RULES[dimension];
        if (rule.kind !== "CODED") return null;
        const rows = active(dimension);
        const full = rows.length >= rule.maxActive && !rule.single;
        return (
          <section key={dimension} style={card}>
            <h2 style={h2}>{DIMENSION_LABELS[dimension].title}</h2>
            <p style={hint}>{DIMENSION_LABELS[dimension].hint}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {rule.codes.map((code) => {
                const row = rows.find((r) => r.code === code);
                return (
                  <Chip
                    key={code}
                    active={!!row}
                    disabled={busy || (!row && full)}
                    label={CODE_LABELS[code] ?? code}
                    onClick={() => (row ? retire(row) : call("/api/business/identity", "POST", { dimension, code }))}
                  />
                );
              })}
            </div>
          </section>
        );
      })}

      {TEXT_LIST_ORDER.map((dimension) => {
        const rule = DIMENSION_RULES[dimension];
        const rows = active(dimension);
        const draft = drafts[dimension] ?? "";
        return (
          <section key={dimension} style={card}>
            <h2 style={h2}>{DIMENSION_LABELS[dimension].title}</h2>
            <p style={hint}>{DIMENSION_LABELS[dimension].hint}</p>
            <div style={{ display: "grid", gap: 8 }}>
              {rows.map((row) => (
                <div key={row.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
                  <span style={{ color: "var(--dz-text-primary)" }}>{row.text}</span>
                  <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
                    <PublicUseToggle statement={row} onToggle={togglePublic} busy={busy} />
                    <button type="button" disabled={busy} onClick={() => retire(row)} style={{ fontSize: 12, color: "var(--dz-text-muted)" }}>
                      הסרה
                    </button>
                  </span>
                </div>
              ))}
              {rows.length < rule.maxActive ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={draft}
                    maxLength={rule.kind === "TEXT" ? rule.maxLength : undefined}
                    onChange={(e) => setDrafts((d) => ({ ...d, [dimension]: e.target.value }))}
                    style={{ flex: 1, minHeight: 36, borderRadius: 10, border: "1px solid var(--dz-border)", padding: "0 10px", fontSize: 14 }}
                  />
                  <button
                    type="button"
                    disabled={busy || !draft.trim()}
                    onClick={async () => {
                      await call("/api/business/identity", "POST", { dimension, text: draft });
                      setDrafts((d) => ({ ...d, [dimension]: "" }));
                    }}
                    style={{ minHeight: 36, padding: "0 12px", borderRadius: 10, border: "1px solid var(--dz-border)", fontWeight: 700, fontSize: 13 }}
                  >
                    הוספה
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        );
      })}

      {noticed.length > 0 ? (
        <section style={card}>
          <h2 style={h2}>עוד דברים ש-Dubiz רואה</h2>
          <p style={hint}>לשימוש פנימי בלבד. לא מופיע ללקוחות.</p>
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13, color: "var(--dz-text-secondary)", display: "grid", gap: 4 }}>
            {noticed.map((sig) => (
              <li key={sig.key}>{describeSignal(sig.kind, sig.value)}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
