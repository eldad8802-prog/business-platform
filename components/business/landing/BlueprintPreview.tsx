"use client";

import { CHANNEL_LABELS } from "@/components/business/identity/identity-labels";
import type { CompositionResult } from "@/lib/services/landing/composer/landing-composer";
import { BLUEPRINT_MISSING_LABELS, COMPOSITION_STATUS_LABELS, SECTION_LABELS } from "./landing-labels";
import styles from "./landing-strategy.module.css";

/**
 * P3-C — internal STRUCTURED preview of a composed blueprint (content + order + action + missing items).
 * Not a landing-page renderer: no theme, no layout engine, nothing public. The action is shown as a
 * non-functional chip naming the channel the strategy decided.
 */
export function BlueprintPreview({ result }: { result: CompositionResult }) {
  const bp = result.blueprint;
  if (!bp) {
    return (
      <section className={styles.blueprint} aria-label="טיוטת דף">
        <p className={styles.alert}>{COMPOSITION_STATUS_LABELS[result.compositionStatus] ?? result.compositionStatus}</p>
        {result.violations.length > 0 && <p className={styles.muted}>נמצאו {new Set(result.violations.map((v) => v.code)).size} בעיות בבדיקה האוטומטית, ולכן הטיוטה לא הוצגה.</p>}
      </section>
    );
  }
  const action = bp.primaryAction;
  return (
    <section className={styles.blueprint} aria-label="טיוטת דף">
      <div className={styles.bpStatus}>
        <span className={styles.ok}>הטיוטה עברה את כל הבדיקות</span>
        <span className={bp.readiness.publishReady ? styles.ok : styles.warnText}>{bp.readiness.publishReady ? "יש את כל מה שצריך לפרסום" : "עדיין לא מוכנה לפרסום"}</span>
      </div>

      <div className={styles.bpHero}>
        <p className={styles.bpEyebrow}>פתיחה</p>
        <h3 className={styles.bpHeadline}>{bp.hero.headline}</h3>
        <p className={styles.why}>{bp.hero.subheadline}</p>
        {action ? (
          <span className={styles.bpAction}>{action.label} · {CHANNEL_LABELS[action.channel] ?? action.channel}</span>
        ) : (
          <span className={styles.muted}>בלי כפתור פעולה — אין עדיין דרך פנייה מאושרת</span>
        )}
        {bp.hero.missingAsset && <p className={styles.muted}>חסרה תמונה ראשית מאושרת</p>}
      </div>

      <ol className={styles.bpSections}>
        {bp.sections.map((s) => (
          <li key={s.sectionType} className={styles.bpSection}>
            <p className={styles.bpEyebrow}>{SECTION_LABELS[s.sectionType] ?? s.sectionType}</p>
            <h4 className={styles.h2}>{s.heading}</h4>
            {s.body && <p className={styles.why}>{s.body}</p>}
            {s.intro && <p className={styles.why}>{s.intro}</p>}
            {s.steps && <ol className={styles.bpList}>{s.steps.map((st, i) => <li key={i}>{st}</li>)}</ol>}
            {s.offerings && (
              <ul className={styles.bpList}>
                {s.offerings.map((o) => (
                  <li key={o.ref}><strong>{o.name}</strong>{o.priceText ? ` · ${o.priceText}` : ""} — {o.blurb}</li>
                ))}
              </ul>
            )}
            {s.trustClaims && <ul className={styles.bpList}>{s.trustClaims.map((c) => <li key={c.ref}>{c.wording}</li>)}</ul>}
            {s.facts && <ul className={styles.bpList}>{s.facts.map((f) => <li key={f.ref}>{f.value}</li>)}</ul>}
            {s.statements && <ul className={styles.bpList}>{s.statements.map((x) => <li key={x.ref}>{x.text}</li>)}</ul>}
            {s.action && <span className={styles.bpAction}>{s.action.label} · {CHANNEL_LABELS[s.action.channel] ?? s.action.channel}</span>}
          </li>
        ))}
      </ol>

      {bp.readiness.missingForPublication.length > 0 && (
        <div className={styles.missing}>
          <strong>חסר כדי לפרסם</strong>
          <ul>{bp.readiness.missingForPublication.map((m) => <li key={m}>{BLUEPRINT_MISSING_LABELS[m] ?? BLUEPRINT_MISSING_LABELS[m.replace(/^ASSET:/, "")] ?? m}</li>)}</ul>
        </div>
      )}
      <p className={styles.muted}>טיוטה בלבד — לא נשמרה ולא פורסמה. הטקסט נכתב אוטומטית, והעובדות, המחירים, טענות האמון ודרך הפנייה נלקחו רק ממה שאישרת.</p>
    </section>
  );
}
