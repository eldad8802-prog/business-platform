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

import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

import { useIdentityLabels } from "../identity-labels";
import { CodeChips, FactRow, Field, PublicSwitch, TextStatements } from "./controls";
import type { IdentityActions } from "./identity-api";
import s from "./identity-screen.module.css";

type Ctx = BusinessIdentityContext;
type Props = { ctx: Ctx; actions: IdentityActions; busy: boolean };

/* ── 1 · מי העסק שלך ── */
export function ChapterWho({ ctx, actions, busy }: Props) {
  const profile = (k: string) => ctx.identity.profile.find((p) => p.key === k)?.value ?? null;
  const { activeServices, activeProducts } = ctx.identity.offering;
  const { t } = useI18n();
  const category = businessCategoryLabel(profile("category"), profile("subCategory"), t);
  return (
    <>
      <Field title={t("content.identity.chapters.who.nameTitle")} hint={t("content.identity.chapters.who.nameHint")}>
        <ul className={s.factList}>
          <FactRow ctx={ctx} fact="BUSINESS_NAME" actions={actions} busy={busy} />
        </ul>
        <p className={s.inlineFact}>
          <span className={s.factLabel}>{t("content.identity.chapters.who.categoryLabel")}</span>
          <span>{category ?? t("content.identity.chapters.who.categoryNone")}</span>
          <Link href="/onboarding" className={s.inlineLink}>
            {category ? t("content.identity.chapters.who.categoryChange") : t("content.identity.chapters.who.categoryChoose")}
          </Link>
        </p>
      </Field>
      <Field title={t("content.identity.chapters.who.descriptionTitle")} hint={t("content.identity.chapters.who.descriptionHint")}>
        <TextStatements ctx={ctx} dimension="DESCRIPTION" placeholder={t("content.identity.chapters.who.descriptionPlaceholder")} actions={actions} busy={busy} />
      </Field>
      <Field title={t("content.identity.chapters.who.specializationTitle")} hint={t("content.identity.chapters.who.specializationHint")}>
        <TextStatements ctx={ctx} dimension="SPECIALIZATION" placeholder={t("content.identity.chapters.who.specializationPlaceholder")} actions={actions} busy={busy} />
      </Field>
      <Field title={t("content.identity.chapters.who.whereTitle")} hint={t("content.identity.chapters.who.whereHint")}>
        <TextStatements ctx={ctx} dimension="SERVICE_AREA" placeholder={t("content.identity.chapters.who.wherePlaceholder")} actions={actions} busy={busy} />
        <ul className={s.factList}>
          <FactRow ctx={ctx} fact="CITY" actions={actions} busy={busy} />
          <FactRow ctx={ctx} fact="OPENING_HOURS" actions={actions} busy={busy} />
        </ul>
      </Field>
      <p className={s.offeringLine}>
        {activeServices + activeProducts > 0
          ? t("content.identity.chapters.who.offeringCount", { services: activeServices, products: activeProducts })
          : t("content.identity.chapters.who.offeringNone")}
      </p>
    </>
  );
}

/* ── 2 · למי אתם רוצים להגיע ── */
const AUDIENCE_GROUPS: Array<{ title: MessageKey; codes: string[] }> = [
  { title: "content.identity.chapters.audience.groupWho", codes: ["INDIVIDUALS", "BUSINESSES"] },
  { title: "content.identity.chapters.audience.groupWhere", codes: ["LOCAL_CUSTOMERS", "REMOTE_CUSTOMERS", "HOME_SERVICE_CUSTOMERS", "WALK_IN_CUSTOMERS"] },
  { title: "content.identity.chapters.audience.groupRelation", codes: ["NEW_CUSTOMERS", "RETURNING_CUSTOMERS"] },
  { title: "content.identity.chapters.audience.groupArrival", codes: ["APPOINTMENT_CUSTOMERS", "EVENT_CUSTOMERS"] },
];

export function ChapterAudience({ ctx, actions, busy }: Props) {
  const chosen = ctx.identity.statements.filter((st) => st.dimension === "TARGET_AUDIENCE").length;
  const { t } = useI18n();
  return (
    <>
      <p className={s.counter}>
        {t("content.identity.chapters.audience.counter", { chosen })}
      </p>
      <div className={s.audienceGrid}>
        {AUDIENCE_GROUPS.map((g) => (
          <Field key={g.title} title={t(g.title)}>
            <CodeChips ctx={ctx} dimension="TARGET_AUDIENCE" codes={g.codes} actions={actions} busy={busy} />
          </Field>
        ))}
      </div>
    </>
  );
}

/* ── 3 · למה שיבחרו דווקא בכם ── */
export function ChapterWhy({ ctx, actions, busy }: Props) {
  const { t } = useI18n();
  return (
    <>
      <Field title={t("content.identity.chapters.why.toneTitle")} hint={t("content.identity.chapters.why.toneHint")}>
        <CodeChips ctx={ctx} dimension="TONE" codes={TONE_CODES} actions={actions} busy={busy} />
      </Field>
      <Field title={t("content.identity.chapters.why.positioningTitle")} hint={t("content.identity.chapters.why.positioningHint")}>
        <CodeChips ctx={ctx} dimension="POSITIONING" codes={POSITIONING_CODES} actions={actions} busy={busy} />
      </Field>
      <Field title={t("content.identity.chapters.why.differentiatorTitle")} hint={t("content.identity.chapters.why.differentiatorHint")}>
        <TextStatements ctx={ctx} dimension="DIFFERENTIATOR" placeholder={t("content.identity.chapters.why.differentiatorPlaceholder")} actions={actions} busy={busy} />
      </Field>
      <TrustClaims ctx={ctx} actions={actions} busy={busy} />
    </>
  );
}

const SERVED_BUCKETS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const CLAIM_FIELDS: Record<string, { key: string; label: MessageKey; type?: string }[]> = {
  FOUNDED_YEAR: [{ key: "foundedYear", label: "content.identity.chapters.trust.field.foundedYear", type: "number" }],
  SERVED_CUSTOMERS: [],
  LICENSED: [
    { key: "licenseType", label: "content.identity.chapters.trust.field.licenseType" },
    { key: "issuer", label: "content.identity.chapters.trust.field.issuer" },
    { key: "licenseNumber", label: "content.identity.chapters.trust.field.licenseNumber" },
    { key: "validUntil", label: "content.identity.chapters.trust.field.validUntil", type: "date" },
  ],
  CERTIFIED: [
    { key: "certificationName", label: "content.identity.chapters.trust.field.certificationName" },
    { key: "issuer", label: "content.identity.chapters.trust.field.issuer" },
    { key: "validUntil", label: "content.identity.chapters.trust.field.validUntil", type: "date" },
  ],
  AUTHORIZED_DEALER: [
    { key: "brand", label: "content.identity.chapters.trust.field.brand" },
    { key: "validUntil", label: "content.identity.chapters.trust.field.validUntil", type: "date" },
  ],
  GUARANTEE: [
    { key: "coverage", label: "content.identity.chapters.trust.field.coverage" },
    { key: "duration", label: "content.identity.chapters.trust.field.duration" },
    { key: "conditions", label: "content.identity.chapters.trust.field.conditions" },
  ],
};

function TrustClaims({ ctx, actions, busy }: Props) {
  const [kind, setKind] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const { claims, servedCustomers } = ctx.trust;
  const { t } = useI18n();
  const { CLAIM_ISSUE_LABELS, CLAIM_KIND_LABELS } = useIdentityLabels();

  return (
    <Field title={t("content.identity.chapters.trust.title")} hint={t("content.identity.chapters.trust.hint")}>
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
                    {t("content.identity.chapters.trust.remove")}
                  </button>
                </div>
                {c.issues.length ? <p className={s.warnLine}>{CLAIM_ISSUE_LABELS[c.issues[0]] ?? t("content.identity.chapters.trust.needsAttention")}</p> : null}
                <div className={s.statementMeta}>
                  {canApprove || c.publicUseApproved ? (
                    <PublicSwitch approved={c.publicUseApproved} disabled={busy} onChange={(next) => actions.setTrustClaimPublic(c.id, next)} />
                  ) : null}
                  {c.verification.required ? (
                    <label className={s.uploadButton}>
                      {c.verification.provided ? t("content.identity.chapters.trust.replaceDocument") : t("content.identity.chapters.trust.attachDocument")}
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
                {c.verification.required ? <small className={s.fieldHint}>{t("content.identity.chapters.trust.documentPrivate")}</small> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={s.emptyLine}>{t("content.identity.chapters.trust.empty")}</p>
      )}

      <div className={s.addClaim}>
        <select className={s.select} value={kind} disabled={busy} aria-label={t("content.identity.chapters.trust.kindAria")} onChange={(e) => { setKind(e.target.value); setFields({}); }}>
          <option value="">{t("content.identity.chapters.trust.addPlaceholder")}</option>
          {Object.entries(CLAIM_KIND_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l.title}
            </option>
          ))}
        </select>
        {kind ? <small className={s.fieldHint}>{CLAIM_KIND_LABELS[kind]?.hint}</small> : null}
        {kind === "SERVED_CUSTOMERS" ? (
          servedCustomers.supportedBucket ? (
            <select className={s.select} value={fields.threshold ?? ""} aria-label={t("content.identity.chapters.trust.servedAria")} onChange={(e) => setFields({ threshold: e.target.value })}>
              <option value="">{t("content.identity.chapters.trust.servedPlaceholder")}</option>
              {SERVED_BUCKETS.filter((b) => b <= (servedCustomers.supportedBucket ?? 0)).map((b) => (
                <option key={b} value={b}>
                  {t("content.identity.chapters.trust.servedOver", { count: b.toLocaleString("he-IL") })}
                </option>
              ))}
            </select>
          ) : (
            <p className={s.emptyLine}>{t("content.identity.chapters.trust.servedNotEnough")}</p>
          )
        ) : null}
        {(CLAIM_FIELDS[kind] ?? []).map((f) => (
          <label key={f.key} className={s.labeledInput}>
            <span>{t(f.label)}</span>
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
            {t("content.identity.chapters.trust.confirm")}
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
  const { t } = useI18n();
  const { BLOCKING_LABELS, CAPABILITY_LABELS, CHANNEL_LABELS, CODE_LABELS, CONFLICT_LABELS, DECLARATION_LABELS } = useIdentityLabels();

  return (
    <>
      <Field title={t("content.identity.chapters.action.primaryTitle")} hint={t("content.identity.chapters.action.primaryHint")}>
        <CodeChips ctx={ctx} dimension="PRIMARY_OBJECTIVE" codes={OBJECTIVE_CODES} actions={actions} busy={busy} />
        {primary?.code ? (
          <div className={typeof effective === "object" ? s.availabilityOk : s.availabilityWarn} role="status">
            {typeof effective === "object" ? (
              <>
                {t("content.identity.chapters.action.availableTo")}<strong>{CODE_LABELS[effective.objective] ?? effective.objective}</strong>
                {effective.channel ? t("content.identity.chapters.action.viaChannel", { channel: CHANNEL_LABELS[effective.channel] ?? effective.channel }) : ""}
              </>
            ) : (
              <>
                {t("content.identity.chapters.action.notAvailable")}
                {blockers.length ? <span className={s.subLine}>{blockers.map((b) => BLOCKING_LABELS[b] ?? b).join(" · ")}</span> : null}
              </>
            )}
          </div>
        ) : null}
        {primary?.code && primaryChannels.length ? (
          <label className={s.labeledInput}>
            <span>{t("content.identity.chapters.action.channelLabel")}</span>
            <select
              className={s.select}
              value={primary.channel ?? ""}
              disabled={busy}
              onChange={(e) => actions.addStatement({ dimension: "PRIMARY_OBJECTIVE", code: primary.code!, channel: e.target.value || null })}
            >
              <option value="">{t("content.identity.chapters.action.channelBest")}</option>
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

      <Field title={t("content.identity.chapters.action.secondaryTitle")} hint={t("content.identity.chapters.action.secondaryHint")}>
        <CodeChips ctx={ctx} dimension="SECONDARY_OBJECTIVE" codes={OBJECTIVE_CODES.filter((c) => c !== primary?.code)} actions={actions} busy={busy} />
      </Field>

      <Field title={t("content.identity.chapters.action.declarationsTitle")} hint={t("content.identity.chapters.action.declarationsHint")}>
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

      <Field title={t("content.identity.chapters.action.contactTitle")} hint={t("content.identity.chapters.action.contactHint")}>
        <ul className={s.factList}>
          {["PUBLIC_PHONE", "PUBLIC_WHATSAPP", "PUBLIC_EMAIL", "PUBLIC_ADDRESS"].map((f) => (
            <FactRow key={f} ctx={ctx} fact={f} actions={actions} busy={busy} />
          ))}
        </ul>
        {ctx.identity.facts.some((f) => ["PUBLIC_PHONE", "PUBLIC_WHATSAPP", "PUBLIC_EMAIL", "PUBLIC_ADDRESS"].includes(f.fact) && f.value) ? null : (
          <p className={s.emptyLine}>
            {t("content.identity.chapters.action.noContact")} <Link href="/business" className={s.inlineLink}>{t("content.identity.chapters.action.addContact")}</Link>
          </p>
        )}
      </Field>

      <details className={s.channels}>
        <summary>{t("content.identity.chapters.action.channelsSummary")}</summary>
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
