"use client";

/**
 * Small editing controls for the identity chapters. Each one is a view over an existing endpoint
 * (see identity-api.ts); none of them decides authority. Public use is always its own explicit
 * switch, and only where the server allows it (TEXT statements, facts, trust claims).
 */
import { useState, type ReactNode } from "react";

import type { BusinessIdentityContext } from "@/lib/services/identity/business-identity-context";
import { DIMENSION_RULES } from "@/lib/services/identity/identity-vocabulary";

import { CODE_LABELS, FACT_LABELS, PUBLIC_STATUS_LABELS } from "../identity-labels";
import type { IdentityActions } from "./identity-api";
import s from "./identity-screen.module.css";

type Ctx = BusinessIdentityContext;
type Statement = Ctx["identity"]["statements"][number];

export function Field({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className={s.field}>
      <div className={s.fieldHead}>
        <h4 className={s.fieldTitle}>{title}</h4>
        {hint ? <p className={s.fieldHint}>{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** Coded chips for one dimension. Single-select replaces; multi-select is capped by the server rule. */
export function CodeChips({
  ctx,
  dimension,
  codes,
  actions,
  busy,
}: {
  ctx: Ctx;
  dimension: string;
  codes: readonly string[];
  actions: IdentityActions;
  busy: boolean;
}) {
  const rule = DIMENSION_RULES[dimension as keyof typeof DIMENSION_RULES];
  const active = ctx.identity.statements.filter((st) => st.dimension === dimension);
  const full = !!rule && !rule.single && active.length >= rule.maxActive;
  return (
    <div className={s.chips} role="group">
      {codes.map((code) => {
        const on = active.find((st) => st.code === code);
        return (
          <button
            key={code}
            type="button"
            className={on ? s.chipOn : s.chip}
            aria-pressed={!!on}
            disabled={busy || (!on && full)}
            onClick={() => (on ? actions.retireStatement(on.id) : actions.addStatement({ dimension, code }))}
          >
            {CODE_LABELS[code] ?? code}
          </button>
        );
      })}
    </div>
  );
}

/** The public-use switch for one owner item, with its status in plain words. */
export function PublicSwitch({
  approved,
  disabled,
  onChange,
  label = "להציג בדף הנחיתה",
}: {
  approved: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}) {
  return (
    <label className={s.publicSwitch}>
      <input type="checkbox" checked={approved} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={s.switchTrack} aria-hidden="true" />
      <span className={s.switchText}>
        {label}
        <small className={approved ? s.statusReady : s.statusInternal}>{approved ? PUBLIC_STATUS_LABELS.READY : PUBLIC_STATUS_LABELS.INTERNAL}</small>
      </span>
    </label>
  );
}

/** A text dimension: single (DESCRIPTION) or a short list (SPECIALIZATION, DIFFERENTIATOR, SERVICE_AREA). */
export function TextStatements({
  ctx,
  dimension,
  placeholder,
  actions,
  busy,
}: {
  ctx: Ctx;
  dimension: string;
  placeholder: string;
  actions: IdentityActions;
  busy: boolean;
}) {
  const rule = DIMENSION_RULES[dimension as keyof typeof DIMENSION_RULES];
  const items = ctx.identity.statements.filter((st) => st.dimension === dimension && st.text);
  const single = !!rule?.single;
  const [draft, setDraft] = useState(single ? items[0]?.text ?? "" : "");
  const full = !!rule && !single && items.length >= rule.maxActive;
  const maxLength = rule?.kind === "TEXT" ? rule.maxLength : undefined;
  const claimLike = new Set(ctx.trust.claimLikeStatements.map((c) => c.statementId));

  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    const ok = await actions.addStatement({ dimension, text });
    if (ok && !single) setDraft("");
  };

  return (
    <div className={s.textStatements}>
      {single ? null : (
        <ul className={s.textList}>
          {items.map((st) => (
            <StatementRow key={st.id} st={st} claimLike={claimLike.has(st.id)} actions={actions} busy={busy} />
          ))}
        </ul>
      )}
      {full ? null : (
        <div className={s.inputRow}>
          {single ? (
            <textarea
              className={s.textarea}
              value={draft}
              maxLength={maxLength}
              rows={2}
              placeholder={placeholder}
              aria-label={placeholder}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : (
            <input
              className={s.input}
              value={draft}
              maxLength={maxLength}
              placeholder={placeholder}
              aria-label={placeholder}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
          )}
          <button type="button" className={s.secondaryButton} disabled={busy || !draft.trim() || (single && draft.trim() === (items[0]?.text ?? ""))} onClick={() => void save()}>
            {single ? "שמירה" : "הוספה"}
          </button>
        </div>
      )}
      {single && items[0] ? <StatementPublic st={items[0]} claimLike={claimLike.has(items[0].id)} actions={actions} busy={busy} /> : null}
    </div>
  );
}

function StatementPublic({ st, claimLike, actions, busy }: { st: Statement; claimLike: boolean; actions: IdentityActions; busy: boolean }) {
  if (!st.publicUseEligible) return null;
  return (
    <div className={s.statementMeta}>
      <PublicSwitch approved={st.publicUseApproved} disabled={busy} onChange={(next) => actions.setStatementPublic(st.id, next)} />
      {claimLike ? <p className={s.warnLine}>נשמע כמו טענת אמון (ותק, רישיון, אחריות). כדאי להוסיף אותו כטענת אמון עם הוכחה.</p> : null}
    </div>
  );
}

function StatementRow({ st, claimLike, actions, busy }: { st: Statement; claimLike: boolean; actions: IdentityActions; busy: boolean }) {
  return (
    <li className={s.textItem}>
      <div className={s.textItemHead}>
        <span className={s.textValue}>{st.text}</span>
        <button type="button" className={s.linkButton} disabled={busy} onClick={() => actions.retireStatement(st.id)} aria-label={`הסרה: ${st.text}`}>
          הסרה
        </button>
      </div>
      <StatementPublic st={st} claimLike={claimLike} actions={actions} busy={busy} />
    </li>
  );
}

/** A fact Dubiz reads from the business details: confirm it, then (separately) approve public use. */
export function FactRow({ ctx, fact, actions, busy }: { ctx: Ctx; fact: string; actions: IdentityActions; busy: boolean }) {
  const f = ctx.identity.facts.find((x) => x.fact === fact);
  if (!f?.value) return null;
  const approved = f.state === "PUBLIC_USE_APPROVED";
  return (
    <li className={s.factRow}>
      <div className={s.factHead}>
        <span className={s.factLabel}>{FACT_LABELS[fact] ?? fact}</span>
        <span className={s.factValue} dir="auto">
          {f.value}
        </span>
      </div>
      <div className={s.factMeta}>
        {f.state === "KNOWN" ? (
          <span className={s.statusAwaiting}>{f.authorityStale ? "הפרט השתנה מאז שאישרת — צריך לאשר מחדש" : PUBLIC_STATUS_LABELS.AWAITING}</span>
        ) : null}
        {f.state === "KNOWN" ? (
          <button type="button" className={s.secondaryButton} disabled={busy} onClick={() => actions.decideFact(fact, "CONFIRM")}>
            נכון
          </button>
        ) : null}
        <PublicSwitch approved={approved} disabled={busy} onChange={(next) => actions.decideFact(fact, next ? "APPROVE_PUBLIC" : "WITHDRAW_PUBLIC")} />
      </div>
    </li>
  );
}
