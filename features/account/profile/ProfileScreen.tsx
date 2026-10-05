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
import type { ProfileSummary } from "@/lib/services/profile/profile-summary.service";

import { useProfileSummary } from "../data/use-account-data";
import { BusinessLogo } from "../ui/BusinessLogo";
import { NotificationsAction, SettingsAction } from "../ui/header-actions";
import s from "./profile.module.css";

const numberFormat = new Intl.NumberFormat("he-IL");

export function ProfileScreen() {
  const [load, reload] = useProfileSummary();
  const data = load.state === "ready" ? load.data : null;

  return (
    <div className={`${warmStyles.surface} ${s.page}`} dir="rtl">
      <WarmPageHeading
        className={s.heading}
        title="פרופיל"
        subtitle="החשבון העסקי שלך"
        actions={
          <>
            <SettingsAction />
            <NotificationsAction />
          </>
        }
      />

      {load.state === "error" ? (
        <div className={s.loadError} role="alert">
          לא הצלחנו לטעון את פרטי הפרופיל.{" "}
          <button type="button" className={s.retry} onClick={reload}>
            נסו שוב
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
  const business = data?.business ?? null;
  const contacts: Array<{ key: string; icon: ReactNode; text: string; ltr?: boolean }> = business
    ? [
        business.location ? { key: "location", icon: <PinGlyph size={15} />, text: business.location } : null,
        business.phone ? { key: "phone", icon: <PhoneGlyph size={15} />, text: business.phone, ltr: true } : null,
        business.email ? { key: "email", icon: <MailGlyph size={15} />, text: business.email, ltr: true } : null,
      ].filter((c): c is NonNullable<typeof c> => c !== null)
    : [];

  return (
    <section className={s.hero} aria-label="פרטי העסק">
      <Link href="/business" className={s.editPill}>
        עריכת פרופיל
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
                  <span dir={c.ltr ? "ltr" : "rtl"} className={s.contactText}>
                    {c.text}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Link href="/business" className={s.addContacts}>
              הוספת פרטי התקשרות
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
  const m = data?.metrics ?? null;
  const items = [
    { key: "quotes", label: "הצעות פעילות", value: m?.activeQuotes },
    { key: "issued", label: "מסמכים שהופקו", value: m?.issuedDocuments },
    { key: "customers", label: "לקוחות רשומים", value: m?.activeCustomers },
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
  const completion = data?.completion ?? null;
  const firstMissing = completion?.items.find((item) => !item.filled) ?? null;
  const complete = completion !== null && completion.filled === completion.total;

  return (
    <section className={`${s.completion} ${s.area_completion}`} aria-label="השלמת פרטי העסק">
      <Link href={firstMissing?.href ?? "/business"} className={s.completionHead}>
        <span className={s.completionTop}>
          <WarmTile tone="amber" icon="📋" onWhite />
          <span className={s.cardText}>
            <span className={s.cardTitle}>השלמת פרטי העסק</span>
            <span className={s.cardSubtitle}>
              {complete ? "כל פרטי העסק מולאו" : "עוד כמה פרטים לחיזוק האמינות מול לקוחות"}
            </span>
          </span>
          <span className={s.completionPercent}>{completion ? `${completion.percent}%` : <WarmSkeleton />}</span>
        </span>
        <span
          className={s.progress}
          role="progressbar"
          aria-label="השלמת פרטי העסק"
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
            {completion.filled} מתוך {completion.total} פרטים מולאו
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
                    <span className={s.checkAction}>להשלמה</span>
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
  const configured = data?.documentSignature.configured ?? null;
  return (
    <section className={`${s.featureCard} ${s.featureMint} ${s.area_signature}`} aria-label="חתימה על מסמכים">
      <WarmTile tone="teal" icon="✍️" onWhite className={s.fTile} />
      <span className={s.fPill}>
        {configured === null ? null : configured ? (
          <WarmPill tone="mint">מוגדרת</WarmPill>
        ) : (
          <WarmPill tone="neutral">לא מוגדרת</WarmPill>
        )}
      </span>
      <span className={`${s.cardTitle} ${s.fTitle}`}>חתימה על מסמכים</span>
      <span className={s.fText}>החתימה של העסק שמופיעה על המסמכים שהוא מפיק</span>
      <Link href="/business" className={`${s.featureButton} ${s.fAction}`}>
        ניהול חתימה
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
  const view = data?.subscription ?? null;
  return (
    <section className={`${s.featureCard} ${s.featureSand} ${s.area_subscription}`} aria-label="המנוי שלי">
      <WarmTile tone="amber" icon="👑" onWhite className={s.fTile} />
      <span className={s.fPill}>
        {view?.status === "active" ? (
          <WarmPill tone="sand">{view.planName}</WarmPill>
        ) : view ? (
          <WarmPill tone="sand">בקרוב</WarmPill>
        ) : null}
      </span>
      <span className={`${s.cardTitle} ${s.fTitle}`}>המנוי שלי</span>
      <span className={s.fText}>
        {view?.status === "active" ? view.detail ?? view.planName : "תוכניות המנוי של Dubiz יגיעו בקרוב"}
      </span>
      {view?.status === "active" ? (
        <Link href={view.manageHref} className={`${s.featureButton} ${s.fAction}`}>
          פרטי המנוי
        </Link>
      ) : (
        <span className={`${s.featureNote} ${s.fAction}`}>אין מנוי לניהול כרגע</span>
      )}
    </section>
  );
}

function IdentityLink() {
  return (
    <Link href="/business/identity" className={`${s.rowCard} ${s.area_identity}`}>
      <WarmTile tone="violet" icon="🪪" />
      <span className={s.cardText}>
        <span className={s.cardTitle}>הנוכחות הדיגיטלית</span>
        <span className={s.cardSubtitle}>מה Dubiz לומד לקראת דף הנחיתה של העסק</span>
      </span>
      <ChevronGlyph className={s.rowChevron} />
    </Link>
  );
}
