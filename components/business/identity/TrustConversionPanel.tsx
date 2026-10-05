"use client";

import { useCallback, useEffect, useState } from "react";
import { OBJECTIVE_CHANNELS } from "@/lib/services/identity/identity-vocabulary";
import {
  BLOCKING_LABELS,
  CAPABILITY_LABELS,
  CHANNEL_LABELS,
  CLAIM_ISSUE_LABELS,
  CLAIM_KIND_LABELS,
  CODE_LABELS,
  CONFLICT_LABELS,
  DECLARATION_LABELS,
  READINESS_LABELS,
} from "./identity-labels";
import styles from "./trust-conversion.module.css";

/**
 * P3-A — what customers can do, what Dubiz may say, and what is still missing, in plain language.
 * Reads ONE canonical model (GET /api/business/identity-context). Every owner action is a narrow,
 * explicit call; nothing is approved, published or substituted on the owner's behalf:
 *   a claim is confirmed INTERNAL; public use is a second tap; a missing document blocks it;
 *   a preference that cannot work is shown as such — never silently replaced.
 */

type Claim = {
  id: number;
  kind: string;
  wording: string;
  verification: { required: boolean; provided: boolean; label: string | null };
  publicUseApproved: boolean;
  publicEffective: boolean;
  issues: string[];
};
type Path = { objective: string; channel: string | null; state: string; blocking: string[]; terminal: boolean };
type Context = {
  identity: { statements: { id: number; dimension: string; code: string | null; text: string | null; channel?: string | null }[] };
  trust: {
    claims: Claim[];
    servedCustomers: { count: number; supportedBucket: number | null };
    claimLikeStatements: { statementId: number; dimension: string; publicUseApproved: boolean; suggestedClaimKinds: (string | null)[] }[];
  };
  conversion: {
    channels: { channel: string; state: string; blocking: string[] }[];
    paths: Path[];
    preference: { role: string; objective: string; channel: string | null; resolvedChannel: string | null; state: string }[];
    effectivePrimary: { objective: string; channel: string | null } | "UNRESOLVED" | "UNSET";
    recommendations: { objective: string; channel: string | null }[];
    conflicts: { code: string; objective: string | null; channel: string | null; detail: string[] }[];
    fallback: "NONE" | "SURFACE_ONLY";
  };
  readiness: Record<"identity" | "publicFacts" | "conversion" | "trust", { ready: boolean; missing: string[] }> & { hasBlockingConflicts: boolean };
};

function authHeaders(json = true): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem("token");
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { "Content-Type": "application/json" } : {}) };
}

async function fetchContext(): Promise<Context | null> {
  try {
    const res = await fetch("/api/business/identity-context", { headers: authHeaders(), cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { context: Context }).context;
  } catch {
    return null;
  }
}

const SERVED_BUCKETS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const CLAIM_FIELDS: Record<string, { key: string; label: string; type?: string }[]> = {
  FOUNDED_YEAR: [{ key: "foundedYear", label: "שנת הקמה", type: "number" }],
  SERVED_CUSTOMERS: [],
  LICENSED: [{ key: "licenseType", label: "סוג הרישיון" }, { key: "issuer", label: "מי הנפיק" }, { key: "licenseNumber", label: "מספר רישיון (לא חובה)" }, { key: "validUntil", label: "בתוקף עד (לא חובה)", type: "date" }],
  CERTIFIED: [{ key: "certificationName", label: "שם ההסמכה / התעודה" }, { key: "issuer", label: "מי הנפיק" }, { key: "validUntil", label: "בתוקף עד (לא חובה)", type: "date" }],
  AUTHORIZED_DEALER: [{ key: "brand", label: "המותג" }, { key: "validUntil", label: "בתוקף עד (לא חובה)", type: "date" }],
  GUARANTEE: [{ key: "coverage", label: "על מה האחריות" }, { key: "duration", label: "לכמה זמן" }, { key: "conditions", label: "באילו תנאים" }],
};

function claimStatus(c: Claim): { text: string; tone: "ok" | "warn" | "muted" } {
  if (c.publicEffective) return { text: c.verification.label ? "מאושר לשימוש פומבי · לפי מידע שמסר העסק" : "מאושר לשימוש פומבי", tone: "ok" };
  if (c.issues.length) return { text: CLAIM_ISSUE_LABELS[c.issues[0]] ?? "דורש טיפול", tone: "warn" };
  return { text: "אישרת שזה נכון — פנימי, לא מוצג ללקוחות", tone: "muted" };
}

export function TrustConversionPanel() {
  const [ctx, setCtx] = useState<Context | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<string>("");
  const [fields, setFields] = useState<Record<string, string>>({});

  const apply = useCallback((next: Context | null) => {
    setCtx(next);
    setStatus(next ? "ok" : "error");
  }, []);
  const load = useCallback(async () => apply(await fetchContext()), [apply]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await fetchContext();
      if (!cancelled) apply(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const act = useCallback(
    async (fn: () => Promise<Response>) => {
      setBusy(true);
      setMessage(null);
      try {
        const res = await fn();
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setMessage(body.error ?? "הפעולה לא הצליחה");
        }
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (status === "loading") return <p className={styles.muted}>טוען…</p>;
  if (status === "error" || !ctx) return <p className={styles.muted}>לא הצלחנו לטעון את המידע. נסו לרענן.</p>;

  const statement = (dimension: string, code: string) => ctx.identity.statements.find((s) => s.dimension === dimension && s.code === code);
  const primary = ctx.identity.statements.find((s) => s.dimension === "PRIMARY_OBJECTIVE");
  const primaryChannels = primary?.code ? (OBJECTIVE_CHANNELS as Record<string, readonly string[]>)[primary.code] ?? [] : [];
  const readinessRows = [
    { key: "identity", title: "מי העסק" },
    { key: "publicFacts", title: "פרטים ציבוריים" },
    { key: "conversion", title: "דרכי פנייה" },
    { key: "trust", title: "אמון" },
  ] as const;

  return (
    <div className={styles.panel}>
      {message ? (
        <p role="alert" className={styles.alert}>
          {message}
        </p>
      ) : null}

      {/* ── readiness ── */}
      <section className={styles.card} aria-labelledby="p3-ready">
        <h2 id="p3-ready" className={styles.h2}>מה כבר מוכן</h2>
        <p className={styles.hint}>מה Dubiz יכול להציג בשם העסק, ומה עוד חסר.</p>
        <ul className={styles.readiness}>
          {readinessRows.map((r) => {
            const d = ctx.readiness[r.key];
            return (
              <li key={r.key} className={d.ready ? styles.readyOk : styles.readyMissing}>
                <strong>{r.title}</strong>
                <span>{d.ready ? "מוכן" : `חסר: ${d.missing.map((m) => READINESS_LABELS[m] ?? m).join(" · ")}`}</span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── conversion ── */}
      <section className={styles.card} aria-labelledby="p3-conv">
        <h2 id="p3-conv" className={styles.h2}>איך לקוחות יכולים לפנות אליך</h2>
        <p className={styles.hint}>Dubiz יציע ללקוחות רק דרכים שבאמת זמינות ושאישרת לשימוש ציבורי.</p>

        <h3 className={styles.h3}>מה העסק עושה בפועל</h3>
        <div className={styles.declarations}>
          {Object.entries(DECLARATION_LABELS).map(([code, l]) => {
            const s = statement("CONVERSION_DECLARATION", code);
            return (
              <label key={code} className={styles.check}>
                <input
                  type="checkbox"
                  checked={!!s}
                  disabled={busy}
                  onChange={() =>
                    act(() =>
                      s
                        ? fetch(`/api/business/identity/${s.id}`, { method: "DELETE", headers: authHeaders() })
                        : fetch("/api/business/identity", { method: "POST", headers: authHeaders(), body: JSON.stringify({ dimension: "CONVERSION_DECLARATION", code }) }),
                    )
                  }
                />
                <span>
                  <strong>{l.title}</strong>
                  <small>{l.hint}</small>
                </span>
              </label>
            );
          })}
        </div>

        {primary?.code ? (
          <div className={styles.row}>
            <label className={styles.field}>
              <span>
                המטרה העיקרית: <strong>{CODE_LABELS[primary.code] ?? primary.code}</strong> — דרך:
              </span>
              <select
                value={primary.channel ?? ""}
                disabled={busy || primaryChannels.length === 0}
                onChange={(e) =>
                  act(() =>
                    fetch("/api/business/identity", {
                      method: "POST",
                      headers: authHeaders(),
                      body: JSON.stringify({ dimension: "PRIMARY_OBJECTIVE", code: primary.code, channel: e.target.value || null }),
                    }),
                  )
                }
              >
                <option value="">הדרך הזמינה הטובה ביותר</option>
                {primaryChannels.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABELS[c] ?? c}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <p className={styles.muted}>בחר למעלה מה הכי חשוב שלקוח יעשה, ואז תוכל לבחור גם את הדרך.</p>
        )}

        {ctx.conversion.conflicts.filter((c) => c.code !== "PREFERENCE_EVIDENCE_DIVERGENCE" || ctx.conversion.recommendations.length).map((c, i) => (
          <p key={`${c.code}-${i}`} className={c.code === "PLATFORM_UNPROVEN" || c.code === "PREFERENCE_EVIDENCE_DIVERGENCE" ? styles.note : styles.warn}>
            {CONFLICT_LABELS[c.code] ?? c.code}
            {c.detail.length ? <span className={styles.sub}>{c.detail.map((d) => BLOCKING_LABELS[d] ?? d).join(" · ")}</span> : null}
          </p>
        ))}
        {ctx.conversion.fallback === "SURFACE_ONLY" ? (
          <p className={styles.warn}>כרגע אין אף דרך פנייה זמינה ומאושרת. Dubiz יציג את העסק בלי כפתור פעולה, ולא ימציא אחד.</p>
        ) : null}

        <h3 className={styles.h3}>מצב כל ערוץ</h3>
        <ul className={styles.channels}>
          {ctx.conversion.channels.map((c) => (
            <li key={c.channel}>
              <strong>{CHANNEL_LABELS[c.channel] ?? c.channel}</strong>
              <span className={c.state === "AVAILABLE" || c.state === "AVAILABLE_UNOBSERVED" ? styles.ok : styles.muted}>{CAPABILITY_LABELS[c.state] ?? c.state}</span>
              {c.blocking.length ? <small>{c.blocking.map((b) => BLOCKING_LABELS[b] ?? b).join(" · ")}</small> : null}
            </li>
          ))}
        </ul>

        {ctx.conversion.recommendations.length ? (
          <>
            <h3 className={styles.h3}>Dubiz מציע</h3>
            <p className={styles.hint}>הצעה בלבד, לפי הנתונים של העסק — שום דבר לא משתנה בלי שתבחר.</p>
            <ul className={styles.list}>
              {ctx.conversion.recommendations.slice(0, 3).map((r) => (
                <li key={r.objective}>
                  {CODE_LABELS[r.objective] ?? r.objective}
                  {r.channel ? ` — ${CHANNEL_LABELS[r.channel] ?? r.channel}` : ""}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      {/* ── trust ── */}
      <section className={styles.card} aria-labelledby="p3-trust">
        <h2 id="p3-trust" className={styles.h2}>אמון</h2>
        <p className={styles.hint}>
          רק דברים שאישרת, ושאישרת לשימוש ציבורי, יכולים להופיע ללקוחות. Dubiz לא ממציא המלצות, ביקורות, מספרי לקוחות או רישיונות.
        </p>

        {ctx.trust.claims.length === 0 ? <p className={styles.muted}>עדיין אין טענות אמון.</p> : null}
        <ul className={styles.claims}>
          {ctx.trust.claims.map((c) => {
            const st = claimStatus(c);
            const canApprove = !c.publicUseApproved && c.issues.length === 0;
            return (
              <li key={c.id} className={styles.claim}>
                <div className={styles.claimHead}>
                  <strong>{CLAIM_KIND_LABELS[c.kind]?.title ?? c.kind}</strong>
                  <span className={st.tone === "ok" ? styles.ok : st.tone === "warn" ? styles.warnText : styles.muted}>{st.text}</span>
                </div>
                <p className={styles.wording}>{c.wording}</p>
                <div className={styles.actions}>
                  {canApprove ? (
                    <button type="button" disabled={busy} onClick={() => act(() => fetch(`/api/business/trust-claims/${c.id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ publicUseApproved: true }) }))}>
                      אשר לשימוש פומבי
                    </button>
                  ) : null}
                  {c.publicUseApproved ? (
                    <button type="button" disabled={busy} onClick={() => act(() => fetch(`/api/business/trust-claims/${c.id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ publicUseApproved: false }) }))}>
                      הסר משימוש פומבי
                    </button>
                  ) : null}
                  {c.verification.required ? (
                    <label className={styles.upload}>
                      {c.verification.provided ? "החלף מסמך תומך" : "צרף מסמך תומך"}
                      <input
                        type="file"
                        accept="application/pdf,image/jpeg,image/png,image/webp"
                        disabled={busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const form = new FormData();
                          form.append("file", file);
                          void act(() => fetch(`/api/business/trust-claims/${c.id}/document`, { method: "POST", headers: authHeaders(false), body: form }));
                        }}
                      />
                    </label>
                  ) : null}
                  <button type="button" disabled={busy} className={styles.quiet} onClick={() => act(() => fetch(`/api/business/trust-claims/${c.id}`, { method: "DELETE", headers: authHeaders() }))}>
                    הסר
                  </button>
                </div>
                {c.verification.required ? <small className={styles.sub}>המסמך נשמר באופן פרטי ואינו מוצג ללקוחות. בפרסום יופיע &quot;לפי מידע שמסר העסק&quot;.</small> : null}
              </li>
            );
          })}
        </ul>

        <h3 className={styles.h3}>הוספת טענת אמון</h3>
        <div className={styles.addClaim}>
          <select value={newKind} disabled={busy} onChange={(e) => { setNewKind(e.target.value); setFields({}); }}>
            <option value="">בחר סוג…</option>
            {Object.entries(CLAIM_KIND_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l.title}
              </option>
            ))}
          </select>
          {newKind ? <small className={styles.sub}>{CLAIM_KIND_LABELS[newKind]?.hint}</small> : null}
          {newKind === "SERVED_CUSTOMERS" ? (
            ctx.trust.servedCustomers.supportedBucket ? (
              <select value={fields.threshold ?? ""} onChange={(e) => setFields({ threshold: e.target.value })}>
                <option value="">כמה (רק מה שהנתונים תומכים בו)</option>
                {SERVED_BUCKETS.filter((b) => b <= (ctx.trust.servedCustomers.supportedBucket ?? 0)).map((b) => (
                  <option key={b} value={b}>
                    יותר מ-{b.toLocaleString("he-IL")}
                  </option>
                ))}
              </select>
            ) : (
              <p className={styles.muted}>לפי העבודות שהושלמו ב-Dubiz עדיין אין מספיק לקוחות כדי לטעון מספר (צריך לפחות 50).</p>
            )
          ) : null}
          {(CLAIM_FIELDS[newKind] ?? []).map((f) => (
            <label key={f.key} className={styles.field}>
              <span>{f.label}</span>
              <input type={f.type ?? "text"} value={fields[f.key] ?? ""} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} />
            </label>
          ))}
          {newKind ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                act(() =>
                  fetch("/api/business/trust-claims", {
                    method: "POST",
                    headers: authHeaders(),
                    body: JSON.stringify({ kind: newKind, params: { ...fields, ...(fields.foundedYear ? { foundedYear: Number(fields.foundedYear) } : {}), ...(fields.threshold ? { threshold: Number(fields.threshold) } : {}) } }),
                  }),
                ).then(() => { setNewKind(""); setFields({}); })
              }
            >
              אשר שזה נכון (נשמר כפנימי)
            </button>
          ) : null}
        </div>

        {ctx.trust.claimLikeStatements.length ? (
          <>
            <h3 className={styles.h3}>טקסט שכדאי לבדוק</h3>
            <p className={styles.hint}>הטקסטים האלה נשמעים כמו טענת אמון (ותק, רישיון, אחריות, &quot;הכי טוב&quot;). Dubiz לא משנה אותם — כדאי להוסיף אותם כטענת אמון עם הוכחה, או לנסח אחרת.</p>
            <ul className={styles.list}>
              {ctx.trust.claimLikeStatements.map((c) => {
                const s = ctx.identity.statements.find((x) => x.id === c.statementId);
                return (
                  <li key={c.statementId}>
                    “{s?.text}” {c.publicUseApproved ? <em className={styles.warnText}>(מאושר לשימוש פומבי — מסומן לבדיקה)</em> : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        <p className={styles.sub}>
          לפי העבודות שהושלמו ב-Dubiz: {ctx.trust.servedCustomers.count.toLocaleString("he-IL")} לקוחות קיבלו שירות (מידע פנימי, לא מוצג ללקוחות).
        </p>
      </section>
    </div>
  );
}
