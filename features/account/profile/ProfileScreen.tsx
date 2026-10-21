"use client";

/**
 * Profile — the business's own account page (approved reference: profile.html).
 *
 * Three compositions of the same content (profile.module.css):
 *   mobile   the 390px reference, stacked
 *   tablet   a wider hero with contact details in two columns; the completion
 *            card opens its checklist; signature and subscription side by side
 *   desktop  a single identity band (details · metrics · logo) over a workspace:
 *            completion checklist as the main column, the other cards beside it
 *
 * Every value comes from /api/profile/summary. Reference elements Dubiz has no
 * capability for (signature rate, multiple businesses, team) are not drawn.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import {
  CheckGlyph,
  ChevronGlyph,
  MailGlyph,
  PencilGlyph,
  PhoneGlyph,
  PinGlyph,
  StoreGlyph,
} from "@/components/ui/warm-surface/glyphs";
import {
  WarmPageHeading,
  WarmPill,
  WarmSkeleton,
  WarmTile,
  warmStyles,
} from "@/components/ui/warm-surface/warm-surface";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag } from "@/lib/i18n/config";
import type { ProfileSummary } from "@/lib/services/profile/profile-summary.service";

import { useProfileSummary } from "../data/use-account-data";
import { BusinessLogo } from "../ui/BusinessLogo";
import { NotificationsAction, SettingsAction } from "../ui/header-actions";
import s from "./profile.module.css";

export function ProfileScreen() {
  const [load, reload] = useProfileSummary();
  const { t } = useI18n();
  const data = load.state === "ready" ? load.data : null;

  return (
    <div className={`${warmStyles.surface} ${s.page}`}>
      <WarmPageHeading
        className={s.heading}
        title={t("account.profile.title")}
        subtitle={t("account.profile.subtitle")}
        actions={
          <>
            <SettingsAction />
            <NotificationsAction />
          </>
        }
      />

      {load.state === "error" ? (
        <div className={s.loadError} role="alert">
          {t("account.profile.loadError")}{" "}
          <button type="button" className={s.retry} onClick={reload}>
            {t("account.profile.retry")}
          </button>
        </div>
      ) : (
        <div className={s.layout}>
          <Hero data={data} onLogoSaved={reload} />
          <div className={s.cards}>
            <CompletionCard data={data} />
            <SignatureCard data={data} />
            <SubscriptionCard data={data} />
            <IdentityLink />
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- hero --- */

function Hero({ data, onLogoSaved }: { data: ProfileSummary | null; onLogoSaved: () => void }) {
  const { t } = useI18n();
  const business = data?.business ?? null;
  const contacts: Array<{ key: string; icon: ReactNode; text: string; ltr?: boolean }> = business
    ? [
        business.location ? { key: "location", icon: <PinGlyph size={15} />, text: business.location } : null,
        business.phone ? { key: "phone", icon: <PhoneGlyph size={15} />, text: business.phone, ltr: true } : null,
        business.email ? { key: "email", icon: <MailGlyph size={15} />, text: business.email, ltr: true } : null,
      ].filter((c): c is NonNullable<typeof c> => c !== null)
    : [];

  return (
    <section className={s.hero} aria-label={t("account.profile.hero.ariaLabel")}>
      <Link href="/business" className={s.editPill}>
        {t("account.profile.hero.edit")}
        <PencilGlyph size={14} />
      </Link>

      <div className={s.heroIdentity}>
        <span className={s.businessName}>{business ? business.name : <WarmSkeleton />}</span>
        {business?.categoryLabel ? (
          <span className={s.category}>
            <StoreGlyph size={16} />
            {business.categoryLabel}
          </span>
        ) : null}
        {business ? (
          contacts.length > 0 ? (
            <ul className={s.contacts} dir="ltr">
              {contacts.map((c) => (
                <li key={c.key} className={s.contact}>
                  {c.icon}
                  <span dir={c.ltr ? "ltr" : "auto"} className={s.contactText}>
                    {c.text}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Link href="/business" className={s.addContacts}>
              {t("account.profile.hero.addContacts")}
            </Link>
          )
        ) : null}
      </div>

      <div className={s.heroLogo}>
        {business ? (
          <BusinessLogo
            name={business.name}
            logoDataUrl={business.logoDataUrl}
            size={124}
            editable
            onSaved={onLogoSaved}
            className={s.logo}
          />
        ) : (
          <span className={s.logoPlaceholder} aria-hidden="true" />
        )}
      </div>

      <Metrics data={data} />
    </section>
  );
}

/**
 * DOM order is right-to-left on screen: quotes, issued documents, customers —
 * so read left-to-right the strip is customers · documents · quotes, the
 * reference's order without the signature-rate column Dubiz cannot measure.
 */
function Metrics({ data }: { data: ProfileSummary | null }) {
  const { t, locale } = useI18n();
  const numberFormat = new Intl.NumberFormat(intlTag(locale));
  const m = data?.metrics ?? null;
  const items = [
    { key: "quotes", label: t("account.profile.metrics.activeQuotes"), value: m?.activeQuotes },
    { key: "issued", label: t("account.profile.metrics.issuedDocuments"), value: m?.issuedDocuments },
    { key: "customers", label: t("account.profile.metrics.activeCustomers"), value: m?.activeCustomers },
  ];
  return (
    <dl className={s.metrics}>
      {items.map((item) => (
        <div key={item.key} className={s.metric}>
          <dt className={s.metricLabel}>{item.label}</dt>
          <dd className={s.metricValue}>
            {typeof item.value === "number" ? numberFormat.format(item.value) : <WarmSkeleton />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------------------------------------------------------- completion --- */

function CompletionCard({ data }: { data: ProfileSummary | null }) {
  const { t } = useI18n();
  const completion = data?.completion ?? null;
  const firstMissing = completion?.items.find((item) => !item.filled) ?? null;
  const complete = completion !== null && completion.filled === completion.total;

  return (
    <section className={`${s.completion} ${s.area_completion}`} aria-label={t("account.profile.completion.title")}>
      <Link href={firstMissing?.href ?? "/business"} className={s.completionHead}>
        <span className={s.completionTop}>
          <WarmTile tone="amber" icon="📋" onWhite />
          <span className={s.cardText}>
            <span className={s.cardTitle}>{t("account.profile.completion.title")}</span>
            <span className={s.cardSubtitle}>
              {complete ? t("account.profile.completion.complete") : t("account.profile.completion.incomplete")}
            </span>
          </span>
          <span className={s.completionPercent}>{completion ? `${completion.percent}%` : <WarmSkeleton />}</span>
        </span>
        <span
          className={s.progress}
          role="progressbar"
          aria-label={t("account.profile.completion.title")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={completion?.percent ?? 0}
        >
          <span className={s.progressFill} style={{ width: `${completion?.percent ?? 0}%` }} />
        </span>
      </Link>

      {completion ? (
        <div className={s.checklist}>
          <p className={s.checklistTitle}>
            {t("account.profile.completion.progress", { filled: completion.filled, total: completion.total })}
          </p>
          <ul className={s.checklistItems}>
            {completion.items.map((item) => (
              <li key={item.key} className={s.checkItem}>
                {item.filled ? (
                  <span className={s.checkDone}>
                    <span className={s.checkMark}>
                      <CheckGlyph size={12} />
                    </span>
                    {item.label}
                  </span>
                ) : (
                  <Link href={item.href} className={s.checkMissing}>
                    <span className={s.checkEmpty} aria-hidden="true" />
                    <span className={s.checkLabel}>{item.label}</span>
                    <span className={s.checkAction}>{t("account.profile.completion.toComplete")}</span>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------- feature cards --- */

function SignatureCard({ data }: { data: ProfileSummary | null }) {
  const { t } = useI18n();
  const configured = data?.documentSignature.configured ?? null;
  return (
    <section className={`${s.featureCard} ${s.featureMint} ${s.area_signature}`} aria-label={t("account.profile.signature.title")}>
      <WarmTile tone="teal" icon="✍️" onWhite className={s.fTile} />
      <span className={s.fPill}>
        {configured === null ? null : configured ? (
          <WarmPill tone="mint">{t("account.profile.signature.configured")}</WarmPill>
        ) : (
          <WarmPill tone="neutral">{t("account.profile.signature.notConfigured")}</WarmPill>
        )}
      </span>
      <span className={`${s.cardTitle} ${s.fTitle}`}>{t("account.profile.signature.title")}</span>
      <span className={s.fText}>{t("account.profile.signature.text")}</span>
      <Link href="/business" className={`${s.featureButton} ${s.fAction}`}>
        {t("account.profile.signature.manage")}
      </Link>
    </section>
  );
}

/**
 * The subscription area is kept on purpose for the plans that are coming
 * (owner decision). Today it says so and offers nothing to press; when a real
 * subscription exists, `SubscriptionView.status === "active"` renders it here.
 */
function SubscriptionCard({ data }: { data: ProfileSummary | null }) {
  const { t } = useI18n();
  const view = data?.subscription ?? null;
  return (
    <section className={`${s.featureCard} ${s.featureSand} ${s.area_subscription}`} aria-label={t("account.profile.subscription.title")}>
      <WarmTile tone="amber" icon="👑" onWhite className={s.fTile} />
      <span className={s.fPill}>
        {view?.status === "active" ? (
          <WarmPill tone="sand">{view.planName}</WarmPill>
        ) : view ? (
          <WarmPill tone="sand">{t("account.profile.subscription.soon")}</WarmPill>
        ) : null}
      </span>
      <span className={`${s.cardTitle} ${s.fTitle}`}>{t("account.profile.subscription.title")}</span>
      <span className={s.fText}>
        {view?.status === "active" ? view.detail ?? view.planName : t("account.profile.subscription.comingSoon")}
      </span>
      {view?.status === "active" ? (
        <Link href={view.manageHref} className={`${s.featureButton} ${s.fAction}`}>
          {t("account.profile.subscription.details")}
        </Link>
      ) : (
        <span className={`${s.featureNote} ${s.fAction}`}>{t("account.profile.subscription.none")}</span>
      )}
    </section>
  );
}

function IdentityLink() {
  const { t } = useI18n();
  return (
    <Link href="/business/identity" className={`${s.rowCard} ${s.area_identity}`}>
      <WarmTile tone="violet" icon="🪪" />
      <span className={s.cardText}>
        <span className={s.cardTitle}>{t("account.profile.identity.title")}</span>
        <span className={s.cardSubtitle}>{t("account.profile.identity.subtitle")}</span>
      </span>
      <ChevronGlyph className={s.rowChevron} />
    </Link>
  );
}
