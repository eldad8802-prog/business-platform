"use client";

/**
 * The four chapters of business knowledge. Each is a re-organisation of fields the identity
 * screen already had — same dimensions, same limits, same endpoints — grouped by the question
 * the owner is answering rather than by the table it is stored in.
 */
import Link from "next/link";
import { useState } from "react";

import { businessCategoryLabel } from "@/lib/business/business-categories";
import type { BusinessIdentityContext } from "@/lib/services/identity/business-identity-context";
import { OBJECTIVE_CHANNELS, OBJECTIVE_CODES, POSITIONING_CODES, TONE_CODES } from "@/lib/services/identity/identity-vocabulary";

import {
  BLOCKING_LABELS,
  CAPABILITY_LABELS,
  CHANNEL_LABELS,
  CLAIM_ISSUE_LABELS,
  CLAIM_KIND_LABELS,
  CODE_LABELS,
  CONFLICT_LABELS,
  DECLARATION_LABELS,
} from "../identity-labels";
import { CodeChips, FactRow, Field, PublicSwitch, TextStatements } from "./controls";
import type { IdentityActions } from "./identity-api";
import s from "./identity-screen.module.css";

type Ctx = BusinessIdentityContext;
type Props = { ctx: Ctx; actions: IdentityActions; busy: boolean };

/* ── 1 · מי העסק שלך ── */
export function ChapterWho({ ctx, actions, busy }: Props) {
  const profile = (k: string) => ctx.identity.profile.find((p) => p.key === k)?.value ?? null;
  const category = businessCategoryLabel(profile("category"), profile("subCategory"));
  const { activeServices, activeProducts } = ctx.identity.offering;
  return (
    <>
      <Field title="השם והתחום" hint="שם העסק מגיע מפרטי העסק. התחום נקבע בהגדרת העסק.">
        <ul className={s.factList}>
          <FactRow ctx={ctx} fact="BUSINESS_NAME" actions={actions} busy={busy} />
        </ul>
        <p className={s.inlineFact}>
          <span className={s.factLabel}>תחום</span>
          <span>{category ?? "עדיין לא נבחר"}</span>
          <Link href="/onboarding" className={s.inlineLink}>
            {category ? "שינוי" : "בחירת תחום"}
          </Link>
        </p>
      </Field>
      <Field title="במשפט אחד — מה העסק" hint="איך היית מתאר את העסק ללקוח חדש. זה המשפט שיפתח את הדף.">
        <TextStatements ctx={ctx} dimension="DESCRIPTION" placeholder="למשל: מאפייה שכונתית עם לחם מחמצת ועוגות לאירועים" actions={actions} busy={busy} />
      </Field>
      <Field title="במה העסק מתמחה" hint="עד 3 תחומי התמחות.">
        <TextStatements ctx={ctx} dimension="SPECIALIZATION" placeholder="תחום התמחות" actions={actions} busy={busy} />
      </Field>
      <Field title="איפה ומתי" hint="ערים או אזורים שאתם משרתים, ופרטים מפרטי העסק.">
        <TextStatements ctx={ctx} dimension="SERVICE_AREA" placeholder="עיר או אזור" actions={actions} busy={busy} />
        <ul className={s.factList}>
          <FactRow ctx={ctx} fact="CITY" actions={actions} busy={busy} />
          <FactRow ctx={ctx} fact="OPENING_HOURS" actions={actions} busy={busy} />
        </ul>
      </Field>
      <p className={s.offeringLine}>
        {activeServices + activeProducts > 0
          ? `ב-Dubiz רשומים ${activeServices} שירותים ו-${activeProducts} מוצרים פעילים — הם יוכלו להופיע בדף בהמשך.`
          : "עדיין אין שירותים או מוצרים פעילים ב-Dubiz."}
      </p>
    </>
  );
}

/* ── 2 · למי אתם רוצים להגיע ── */
const AUDIENCE_GROUPS: Array<{ title: string; codes: string[] }> = [
  { title: "מי הלקוחות", codes: ["INDIVIDUALS", "BUSINESSES"] },
  { title: "איפה הם", codes: ["LOCAL_CUSTOMERS", "REMOTE_CUSTOMERS", "HOME_SERVICE_CUSTOMERS", "WALK_IN_CUSTOMERS"] },
  { title: "איזה קשר", codes: ["NEW_CUSTOMERS", "RETURNING_CUSTOMERS"] },
  { title: "איך הם מגיעים", codes: ["APPOINTMENT_CUSTOMERS", "EVENT_CUSTOMERS"] },
];

export function ChapterAudience({ ctx, actions, busy }: Props) {
  const chosen = ctx.identity.statements.filter((st) => st.dimension === "TARGET_AUDIENCE").length;
  return (
    <>
      <p className={s.counter}>
        נבחרו {chosen} מתוך 4 — בחרו את הקהלים החשובים ביותר.
      </p>
      <div className={s.audienceGrid}>
        {AUDIENCE_GROUPS.map((g) => (
          <Field key={g.title} title={g.title}>
            <CodeChips ctx={ctx} dimension="TARGET_AUDIENCE" codes={g.codes} actions={actions} busy={busy} />
          </Field>
        ))}
      </div>
    </>
  );
}

/* ── 3 · למה שיבחרו דווקא בכם ── */
export function ChapterWhy({ ctx, actions, busy }: Props) {
  return (
    <>
      <Field title="הטון של העסק" hint="איך העסק מדבר. בחירה אחת.">
        <CodeChips ctx={ctx} dimension="TONE" codes={TONE_CODES} actions={actions} busy={busy} />
      </Field>
      <Field title="במה אתם רוצים שיזכרו אתכם" hint="עד 3.">
        <CodeChips ctx={ctx} dimension="POSITIONING" codes={POSITIONING_CODES} actions={actions} busy={busy} />
      </Field>
      <Field title="מה מבדל אתכם" hint="רק דברים נכונים שאפשר לעמוד מאחוריהם. עד 6.">
        <TextStatements ctx={ctx} dimension="DIFFERENTIATOR" placeholder="משהו שמבדל אתכם" actions={actions} busy={busy} />
      </Field>
      <TrustClaims ctx={ctx} actions={actions} busy={busy} />
    </>
  );
}

const SERVED_BUCKETS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const CLAIM_FIELDS: Record<string, { key: string; label: string; type?: string }[]> = {
  FOUNDED_YEAR: [{ key: "foundedYear", label: "שנת הקמה", type: "number" }],
  SERVED_CUSTOMERS: [],
  LICENSED: [
    { key: "licenseType", label: "סוג הרישיון" },
    { key: "issuer", label: "מי הנפיק" },
    { key: "licenseNumber", label: "מספר רישיון (לא חובה)" },
    { key: "validUntil", label: "בתוקף עד (לא חובה)", type: "date" },
  ],
  CERTIFIED: [
    { key: "certificationName", label: "שם ההסמכה / התעודה" },
    { key: "issuer", label: "מי הנפיק" },
    { key: "validUntil", label: "בתוקף עד (לא חובה)", type: "date" },
  ],
  AUTHORIZED_DEALER: [
    { key: "brand", label: "המותג" },
    { key: "validUntil", label: "בתוקף עד (לא חובה)", type: "date" },
  ],
  GUARANTEE: [
    { key: "coverage", label: "על מה האחריות" },
    { key: "duration", label: "לכמה זמן" },
    { key: "conditions", label: "באילו תנאים" },
  ],
};

function TrustClaims({ ctx, actions, busy }: Props) {
  const [kind, setKind] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const { claims, servedCustomers } = ctx.trust;

  return (
    <Field title="אמון" hint="רק מה שאישרת — ואישרת להציג — יופיע ללקוחות. Dubiz לא ממציא המלצות, ביקורות, מספרי לקוחות או רישיונות.">
      {claims.length ? (
        <ul className={s.claimList}>
          {claims.map((c) => {
            const canApprove = !c.publicUseApproved && c.issues.length === 0;
            return (
              <li key={c.id} className={s.claim}>
                <div className={s.textItemHead}>
                  <span className={s.textValue}>
                    <strong>{CLAIM_KIND_LABELS[c.kind]?.title ?? c.kind}</strong> · {c.wording}
                  </span>
                  <button type="button" className={s.linkButton} disabled={busy} onClick={() => actions.retireTrustClaim(c.id)}>
                    הסרה
                  </button>
                </div>
                {c.issues.length ? <p className={s.warnLine}>{CLAIM_ISSUE_LABELS[c.issues[0]] ?? "דורש טיפול"}</p> : null}
                <div className={s.statementMeta}>
                  {canApprove || c.publicUseApproved ? (
                    <PublicSwitch approved={c.publicUseApproved} disabled={busy} onChange={(next) => actions.setTrustClaimPublic(c.id, next)} />
                  ) : null}
                  {c.verification.required ? (
                    <label className={s.uploadButton}>
                      {c.verification.provided ? "החלפת מסמך תומך" : "צירוף מסמך תומך"}
                      <input
                        type="file"
                        accept="application/pdf,image/jpeg,image/png,image/webp"
                        disabled={busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void actions.attachTrustDocument(c.id, file);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  ) : null}
                </div>
                {c.verification.required ? <small className={s.fieldHint}>המסמך נשמר באופן פרטי ואינו מוצג ללקוחות.</small> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={s.emptyLine}>עדיין אין טענות אמון.</p>
      )}

      <div className={s.addClaim}>
        <select className={s.select} value={kind} disabled={busy} aria-label="סוג טענת אמון" onChange={(e) => { setKind(e.target.value); setFields({}); }}>
          <option value="">הוספת טענת אמון…</option>
          {Object.entries(CLAIM_KIND_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l.title}
            </option>
          ))}
        </select>
        {kind ? <small className={s.fieldHint}>{CLAIM_KIND_LABELS[kind]?.hint}</small> : null}
        {kind === "SERVED_CUSTOMERS" ? (
          servedCustomers.supportedBucket ? (
            <select className={s.select} value={fields.threshold ?? ""} aria-label="כמה לקוחות" onChange={(e) => setFields({ threshold: e.target.value })}>
              <option value="">כמה (רק מה שהנתונים תומכים בו)</option>
              {SERVED_BUCKETS.filter((b) => b <= (servedCustomers.supportedBucket ?? 0)).map((b) => (
                <option key={b} value={b}>
                  יותר מ-{b.toLocaleString("he-IL")}
                </option>
              ))}
            </select>
          ) : (
            <p className={s.emptyLine}>לפי העבודות שהושלמו ב-Dubiz עדיין אין מספיק לקוחות כדי לטעון מספר (צריך לפחות 50).</p>
          )
        ) : null}
        {(CLAIM_FIELDS[kind] ?? []).map((f) => (
          <label key={f.key} className={s.labeledInput}>
            <span>{f.label}</span>
            <input className={s.input} type={f.type ?? "text"} value={fields[f.key] ?? ""} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} />
          </label>
        ))}
        {kind ? (
          <button
            type="button"
            className={s.secondaryButton}
            disabled={busy}
            onClick={async () => {
              const params: Record<string, unknown> = { ...fields };
              if (fields.foundedYear) params.foundedYear = Number(fields.foundedYear);
              if (fields.threshold) params.threshold = Number(fields.threshold);
              const ok = await actions.addTrustClaim(kind, params);
              if (ok) {
                setKind("");
                setFields({});
              }
            }}
          >
            אישור שזה נכון (נשמר כפנימי)
          </button>
        ) : null}
      </div>
    </Field>
  );
}

/* ── 4 · מה אתם רוצים שהלקוח יעשה ── */
export function ChapterAction({ ctx, actions, busy }: Props) {
  const primary = ctx.identity.statements.find((st) => st.dimension === "PRIMARY_OBJECTIVE");
  const primaryPref = ctx.conversion.preference.find((p) => p.role === "PRIMARY");
  const effective = ctx.conversion.effectivePrimary;
  const primaryChannels = primary?.code ? (OBJECTIVE_CHANNELS as Record<string, readonly string[]>)[primary.code] ?? [] : [];
  const pathFor = (objective: string) => ctx.conversion.paths.filter((p) => p.objective === objective);
  const blockers = primary?.code ? [...new Set(pathFor(primary.code).flatMap((p) => p.blocking))] : [];

  return (
    <>
      <Field title="מה הכי חשוב שלקוח יעשה" hint="פעולה אחת עיקרית — הכפתור המרכזי בדף.">
        <CodeChips ctx={ctx} dimension="PRIMARY_OBJECTIVE" codes={OBJECTIVE_CODES} actions={actions} busy={busy} />
        {primary?.code ? (
          <div className={typeof effective === "object" ? s.availabilityOk : s.availabilityWarn} role="status">
            {typeof effective === "object" ? (
              <>
                זמין ללקוחות: <strong>{CODE_LABELS[effective.objective] ?? effective.objective}</strong>
                {effective.channel ? ` דרך ${CHANNEL_LABELS[effective.channel] ?? effective.channel}` : ""}
              </>
            ) : (
              <>
                עדיין לא זמין ללקוחות.
                {blockers.length ? <span className={s.subLine}>{blockers.map((b) => BLOCKING_LABELS[b] ?? b).join(" · ")}</span> : null}
              </>
            )}
          </div>
        ) : null}
        {primary?.code && primaryChannels.length ? (
          <label className={s.labeledInput}>
            <span>דרך הפנייה</span>
            <select
              className={s.select}
              value={primary.channel ?? ""}
              disabled={busy}
              onChange={(e) => actions.addStatement({ dimension: "PRIMARY_OBJECTIVE", code: primary.code!, channel: e.target.value || null })}
            >
              <option value="">הדרך הזמינה הטובה ביותר</option>
              {primaryChannels.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c] ?? c}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {primaryPref && primaryPref.state === "PLATFORM_UNPROVEN" ? <p className={s.noteLine}>{CONFLICT_LABELS.PLATFORM_UNPROVEN}</p> : null}
      </Field>

      <Field title="פעולות נוספות" hint="עד 2.">
        <CodeChips ctx={ctx} dimension="SECONDARY_OBJECTIVE" codes={OBJECTIVE_CODES.filter((c) => c !== primary?.code)} actions={actions} busy={busy} />
      </Field>

      <Field title="מה העסק עושה בפועל" hint="Dubiz יציע ללקוחות רק דרכים שבאמת קיימות.">
        <div className={s.declarations}>
          {Object.entries(DECLARATION_LABELS).map(([code, l]) => {
            const st = ctx.identity.statements.find((x) => x.dimension === "CONVERSION_DECLARATION" && x.code === code);
            return (
              <label key={code} className={s.declaration}>
                <input
                  type="checkbox"
                  checked={!!st}
                  disabled={busy}
                  onChange={() => (st ? actions.retireStatement(st.id) : actions.addStatement({ dimension: "CONVERSION_DECLARATION", code }))}
                />
                <span>
                  <strong>{l.title}</strong>
                  <small>{l.hint}</small>
                </span>
              </label>
            );
          })}
        </div>
      </Field>

      <Field title="פרטי קשר" hint="מפרטי העסק. הם פרטיים עד שתאשר להציג אותם.">
        <ul className={s.factList}>
          {["PUBLIC_PHONE", "PUBLIC_WHATSAPP", "PUBLIC_EMAIL", "PUBLIC_ADDRESS"].map((f) => (
            <FactRow key={f} ctx={ctx} fact={f} actions={actions} busy={busy} />
          ))}
        </ul>
        {ctx.identity.facts.some((f) => ["PUBLIC_PHONE", "PUBLIC_WHATSAPP", "PUBLIC_EMAIL", "PUBLIC_ADDRESS"].includes(f.fact) && f.value) ? null : (
          <p className={s.emptyLine}>
            אין עדיין פרטי קשר. <Link href="/business" className={s.inlineLink}>הוספה בפרטי העסק</Link>
          </p>
        )}
      </Field>

      <details className={s.channels}>
        <summary>מצב כל דרך פנייה</summary>
        <ul>
          {ctx.conversion.channels.map((c) => (
            <li key={c.channel}>
              <strong>{CHANNEL_LABELS[c.channel] ?? c.channel}</strong>
              <span className={c.state === "AVAILABLE" || c.state === "AVAILABLE_UNOBSERVED" ? s.statusReady : s.statusInternal}>{CAPABILITY_LABELS[c.state] ?? c.state}</span>
              {c.blocking.length ? <small>{c.blocking.map((b) => BLOCKING_LABELS[b] ?? b).join(" · ")}</small> : null}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}
