"use client";

import { useIdentityLabels } from "@/components/business/identity/identity-labels";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { CompositionResult } from "@/lib/services/landing/composer/landing-composer";
import { useLandingLabels } from "./landing-labels";
import styles from "./landing-strategy.module.css";

/**
 * P3-C — internal STRUCTURED preview of a composed blueprint (content + order + action + missing items).
 * Not a landing-page renderer: no theme, no layout engine, nothing public. The action is shown as a
 * non-functional chip naming the channel the strategy decided.
 */
export function BlueprintPreview({ result }: { result: CompositionResult }) {
  const { t } = useI18n();
  const { CHANNEL_LABELS } = useIdentityLabels();
  const { BLUEPRINT_MISSING_LABELS, COMPOSITION_STATUS_LABELS, SECTION_LABELS } = useLandingLabels();
  const bp = result.blueprint;
  if (!bp) {
    return (
      <section className={styles.blueprint} aria-label={t("content.identity.blueprint.aria")}>
        <p className={styles.alert}>{COMPOSITION_STATUS_LABELS[result.compositionStatus] ?? result.compositionStatus}</p>
        {result.violations.length > 0 && <p className={styles.muted}>{t("content.identity.blueprint.violations", { count: new Set(result.violations.map((v) => v.code)).size })}</p>}
      </section>
    );
  }
  const action = bp.primaryAction;
  return (
    <section className={styles.blueprint} aria-label={t("content.identity.blueprint.aria")}>
      <div className={styles.bpStatus}>
        <span className={styles.ok}>{t("content.identity.blueprint.passed")}</span>
        <span className={bp.readiness.publishReady ? styles.ok : styles.warnText}>{bp.readiness.publishReady ? t("content.identity.blueprint.publishReady") : t("content.identity.blueprint.notReady")}</span>
      </div>

      <div className={styles.bpHero}>
        <p className={styles.bpEyebrow}>{t("content.identity.blueprint.hero")}</p>
        <h3 className={styles.bpHeadline}>{bp.hero.headline}</h3>
        <p className={styles.why}>{bp.hero.subheadline}</p>
        {action ? (
          <span className={styles.bpAction}>{action.label} · {CHANNEL_LABELS[action.channel] ?? action.channel}</span>
        ) : (
          <span className={styles.muted}>{t("content.identity.blueprint.noAction")}</span>
        )}
        {bp.hero.missingAsset && <p className={styles.muted}>{t("content.identity.blueprint.noHeroImage")}</p>}
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
          <strong>{t("content.identity.blueprint.missingToPublish")}</strong>
          <ul>{bp.readiness.missingForPublication.map((m) => <li key={m}>{BLUEPRINT_MISSING_LABELS[m] ?? BLUEPRINT_MISSING_LABELS[m.replace(/^ASSET:/, "")] ?? m}</li>)}</ul>
        </div>
      )}
      <p className={styles.muted}>{t("content.identity.blueprint.footnote")}</p>
    </section>
  );
}
