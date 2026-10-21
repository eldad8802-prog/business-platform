"use client";

/**
 * The companion panels: how Dubiz understands the business today (owner-provided), what Dubiz
 * learned from activity (machine proposals, owner-adoptable), and the future landing page
 * preview (approved public material only).
 */
import Link from "next/link";

import { businessCategoryLabel } from "@/lib/business/business-categories";
import type { BusinessIdentityContext } from "@/lib/services/identity/business-identity-context";
import type { LandingKnowledge } from "@/lib/services/identity/landing-knowledge";
import { WarmPill, WarmTile } from "@/components/ui/warm-surface/warm-surface";

import { useI18n } from "@/components/i18n/I18nProvider";
import { identityHe } from "@/lib/i18n/messages/areas/content/identity";

import { translateTree } from "../../i18n-tree";
import { useIdentityLabels } from "../identity-labels";
import type { IdentityActions } from "./identity-api";
import s from "./identity-screen.module.css";

type Ctx = BusinessIdentityContext;

const codes = (ctx: Ctx, dimension: string, CODE_LABELS: Record<string, string>) =>
  ctx.identity.statements.filter((st) => st.dimension === dimension && st.code).map((st) => CODE_LABELS[st.code!] ?? st.code!);

/* ── what you told us ── */
export function UnderstandingCard({ ctx }: { ctx: Ctx }) {
  const profile = (k: string) => ctx.identity.profile.find((p) => p.key === k)?.value ?? null;
  const description = ctx.identity.statements.find((st) => st.dimension === "DESCRIPTION")?.text ?? null;
  const { t } = useI18n();
  const { CODE_LABELS } = useIdentityLabels();
  const rows: Array<[string, string]> = [];
  const category = businessCategoryLabel(profile("category"), profile("subCategory"), t);
  if (category) rows.push([t("content.identity.panels.told.rowCategory"), category]);
  if (description) rows.push([t("content.identity.panels.told.rowDescription"), description]);
  const audience = codes(ctx, "TARGET_AUDIENCE", CODE_LABELS);
  if (audience.length) rows.push([t("content.identity.panels.told.rowAudience"), audience.join(" · ")]);
  const positioning = codes(ctx, "POSITIONING", CODE_LABELS);
  if (positioning.length) rows.push([t("content.identity.panels.told.rowPositioning"), positioning.join(" · ")]);
  const tone = codes(ctx, "TONE", CODE_LABELS);
  if (tone.length) rows.push([t("content.identity.panels.told.rowTone"), tone.join(" · ")]);
  const primary = codes(ctx, "PRIMARY_OBJECTIVE", CODE_LABELS);
  if (primary.length) rows.push([t("content.identity.panels.told.rowPrimary"), primary.join(" · ")]);

  return (
    <section className={`${s.card} ${s.area_summary}`} aria-labelledby="identity-told">
      <div className={s.cardHead}>
        <WarmTile tone="teal" icon="🗣️" />
        <div>
          <h2 id="identity-told" className={s.cardTitle}>
            {t("content.identity.panels.told.title")}
          </h2>
          <p className={s.cardSub}>{t("content.identity.panels.told.sub")}</p>
        </div>
      </div>
      {rows.length ? (
        <dl className={s.understanding}>
          {rows.map(([k, v]) => (
            <div key={k} className={s.understandingRow}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={s.emptyLine}>{t("content.identity.panels.told.empty")}</p>
      )}
    </section>
  );
}

/* ── what Dubiz learned ── */

export function LearnedCard({ knowledge, actions, busy }: { knowledge: LandingKnowledge; actions: IdentityActions; busy: boolean }) {
  const { suggestions, observations } = knowledge.learned;
  const { t } = useI18n();
  const { CODE_LABELS, describeSignal } = useIdentityLabels();
  const DIMENSION_SHORT = translateTree(t, "content.identity.panels.learned.dimension", identityHe.panels.learned.dimension) as Record<string, string>;
  return (
    <section className={`${s.card} ${s.learnedCard} ${s.area_learned}`} aria-labelledby="identity-learned">
      <div className={s.cardHead}>
        <WarmTile tone="violet" icon="💡" />
        <div>
          <h2 id="identity-learned" className={s.cardTitle}>
            {t("content.identity.panels.learned.title")}
          </h2>
          <p className={s.cardSub}>{t("content.identity.panels.learned.sub")}</p>
        </div>
      </div>

      {suggestions.length ? (
        <ul className={s.learnedList}>
          {suggestions.map((g) => (
            <li key={`${g.signalKey}>${g.dimension}:${g.code}`} className={s.learnedItem}>
              <p className={s.learnedText}>{describeSignal(g.kind, g.value)}</p>
              <p className={s.learnedProposal}>
                {t("content.identity.panels.learned.proposalPrefix")}<strong>{DIMENSION_SHORT[g.dimension] ?? g.dimension} — {CODE_LABELS[g.code] ?? g.code}</strong>
              </p>
              <button type="button" className={s.secondaryButton} disabled={busy} onClick={() => actions.adoptSuggestion(g.signalKey, g.dimension, g.code)}>
                {t("content.identity.panels.learned.adopt")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {observations.length ? (
        <div className={s.observations}>
          <p className={s.observationsTitle}>{t("content.identity.panels.learned.observationsTitle")}</p>
          <ul>
            {observations.map((o) => (
              <li key={o.signalKey}>{describeSignal(o.kind, o.value)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {suggestions.length === 0 && observations.length === 0 ? (
        <p className={s.emptyLine}>
          {t("content.identity.panels.learned.empty")}
        </p>
      ) : (
        <p className={s.fieldHint}>{t("content.identity.panels.learned.notAccurate")}</p>
      )}
    </section>
  );
}

/* ── the future landing page ── */
export function PreviewCard({ ctx, knowledge }: { ctx: Ctx; knowledge: LandingKnowledge }) {
  const sections = Object.fromEntries(knowledge.preview.sections.map((sec) => [sec.role, sec]));
  const hero = sections.HERO;
  const name = hero.items.find((i) => i.key === "BUSINESS_NAME")?.text ?? null;
  const description = hero.items.find((i) => i.key === "DESCRIPTION")?.text ?? null;
  const cta = sections.CALL_TO_ACTION;
  const effective = ctx.publicUse.conversion.effectivePrimary;
  const { t, locale } = useI18n();
  const { CHANNEL_LABELS, CODE_LABELS, PREVIEW_ROLE_LABELS } = useIdentityLabels();

  const body = (role: "ABOUT" | "DIFFERENTIATORS" | "TRUST" | "CONTACT") => {
    const sec = sections[role];
    return (
      <div className={s.previewSection} key={role}>
        <p className={s.previewSectionTitle}>{PREVIEW_ROLE_LABELS[role].title}</p>
        {sec.items.length ? (
          <ul className={s.previewItems}>
            {sec.items.map((i, n) => (
              <li key={`${i.key}-${n}`} dir="auto">
                {i.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.previewEmpty}>{PREVIEW_ROLE_LABELS[role].empty}</p>
        )}
        {sec.awaitingApproval ? <p className={s.previewAwaiting}>{t("content.identity.panels.preview.awaiting", { count: sec.awaitingApproval })}</p> : null}
      </div>
    );
  };

  return (
    <section className={`${s.card} ${s.area_preview}`} aria-labelledby="identity-preview">
      <div className={s.cardHead}>
        <WarmTile tone="blue" icon="🖥️" />
        <div>
          <h2 id="identity-preview" className={s.cardTitle}>
            {t("content.identity.panels.preview.title")}
          </h2>
          <p className={s.cardSub}>{t("content.identity.panels.preview.sub")}</p>
          <WarmPill tone="neutral" className={s.draftPill}>
            {/* Hebrew stays literal here: landing-knowledge.verify pins "לא פורסם" in this screen's source. */}
            {locale === "he" ? "טיוטה · לא פורסם" : t("content.identity.panels.preview.draftPill")}
          </WarmPill>
        </div>
      </div>

      <div className={s.previewFrame} aria-label={t("content.identity.panels.preview.frameAria")}>
        <div className={s.previewHero}>
          {name ? <p className={s.previewName}>{name}</p> : <span className={s.previewBar} aria-hidden="true" />}
          {description ? <p className={s.previewDescription}>{description}</p> : <span className={`${s.previewBar} ${s.previewBarShort}`} aria-hidden="true" />}
          {!name || !description ? <p className={s.previewEmpty}>{PREVIEW_ROLE_LABELS.HERO.empty}</p> : null}
          {cta.status === "READY" && typeof effective === "object" ? (
            <span className={s.previewCta}>
              {CODE_LABELS[effective.objective] ?? effective.objective}
              {effective.channel ? ` · ${CHANNEL_LABELS[effective.channel] ?? effective.channel}` : ""}
            </span>
          ) : (
            <span className={s.previewCtaEmpty}>{PREVIEW_ROLE_LABELS.CALL_TO_ACTION.empty}</span>
          )}
        </div>
        {(["ABOUT", "DIFFERENTIATORS", "TRUST", "CONTACT"] as const).map(body)}
      </div>
      <p className={s.fieldHint}>{t("content.identity.panels.preview.notYet")}</p>
      <Link href="/business/landing-strategy" className={s.inlineLink}>
        {t("content.identity.panels.preview.strategiesLink")}
      </Link>
      <Link href="/business/landing" className={s.inlineLink}>
        {t("content.identity.panels.preview.versionsLink")}
      </Link>
    </section>
  );
}
