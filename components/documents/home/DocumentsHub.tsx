"use client";

import { useBackDestination, useGoBack } from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";
import { formatNumber } from "@/lib/i18n/format";
import { computeDelta } from "./PulseCard";
import { formatMoney } from "./home-format";
import type { Locale } from "@/lib/i18n/config";
import { ChevronIcon, GmailLogo, WhatsappLogo } from "./home-icons";

/**
 * Documents hub — the owner-approved illustrated home (mockup 2026-11-02).
 *
 * PRESENTATION ONLY: every number comes from the hub summary the page already
 * loads (`financialPulse`), every action calls back into the page, which keeps
 * the existing upload / camera / duplicate behaviour and routes. New copy is
 * Hebrew-first (no i18n keys yet); existing keys are reused where the text is
 * the same.
 */

const ILLUSTRATION = {
  upload: "/illustrations/documents/upload.svg",
  camera: "/illustrations/documents/camera.svg",
  search: "/illustrations/documents/search.svg",
  verify: "/illustrations/documents/verify.svg",
  pack: "/illustrations/documents/accountant-pack.svg",
} as const;

/** Back control styled as in the mockup ("› חזרה"), with the canonical back behaviour. */
export function HubBackLink() {
  const { target, fallback } = useBackDestination();
  const goBack = useGoBack(fallback.url);
  // Before the navigation trail is known nothing is claimed (same rule as BackButton).
  if (!target) return <span className="dz-dh-back dz-dh-back--pending" aria-hidden />;
  const label = target.kind === "history" ? "חזרה" : fallback.label;
  return (
    <button type="button" className="dz-dh-back" onClick={goBack} data-dz-back={target.kind}>
      <span className="dz-dh-back__chev" aria-hidden>
        <ChevronIcon />
      </span>
      {label}
    </button>
  );
}

/** Whole shekels for the two headline amounts (as in the mockup); the net line keeps agorot. */
function formatHeadlineMoney(n: number, locale: Locale): string {
  if (locale !== "he" || !Number.isFinite(n)) return formatMoney(n, locale);
  return new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);
}

function BarsGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d="M7 17v-5M12 17V7M17 17v-8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

export type HubSummaryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      monthText: string;
      income: number;
      expense: number;
      net: number;
      previousNet: number | null;
      monthDocs: number;
      approved: number;
    };

export function HubSummary({ state, onRetry }: { state: HubSummaryState; onRetry: () => void }) {
  const { t, locale, fmt } = useI18n();

  if (state.status === "error") {
    return (
      <section className="dz-dh-summary dz-dh-summary--error" role="alert">
        <div className="dz-dh-summary__title">{t("documents.hub.loadHubError")}</div>
        <p className="dz-dh-summary__msg">{state.message}</p>
        <button type="button" className="dz-dh-retry" onClick={onRetry}>
          {t("documents.common.retry")}
        </button>
      </section>
    );
  }

  const ready = state.status === "ready" ? state : null;
  const delta = ready ? computeDelta(ready.net, ready.previousNet) : null;
  const empty = ready ? ready.income === 0 && ready.expense === 0 : false;

  return (
    <section
      className="dz-dh-summary"
      aria-label={t("documents.hub.kpisAria")}
      aria-busy={ready ? undefined : true}
    >
      <div className="dz-dh-summary__title">
        {ready ? `סיכום מסמכים · ${ready.monthText}` : "סיכום מסמכים"}
      </div>
      <div className="dz-dh-summary__cols">
        <div className="dz-dh-stat dz-dh-stat--income">
          <span className="dz-dh-stat__ico">
            <BarsGlyph />
          </span>
          <span className="dz-dh-stat__tx">
            <span className="dz-dh-stat__k">{t("documents.home.income")}</span>
            {ready ? (
              <strong className="dz-dh-stat__v">{formatHeadlineMoney(ready.income, locale)}</strong>
            ) : (
              <span className="dz-dh-shimmer dz-dh-shimmer--amount" />
            )}
          </span>
        </div>
        <span className="dz-dh-summary__sep" aria-hidden />
        <div className="dz-dh-stat dz-dh-stat--expense">
          <span className="dz-dh-stat__tx">
            <span className="dz-dh-stat__k">{t("documents.home.expense")}</span>
            {ready ? (
              <strong className="dz-dh-stat__v">{formatHeadlineMoney(ready.expense, locale)}</strong>
            ) : (
              <span className="dz-dh-shimmer dz-dh-shimmer--amount" />
            )}
          </span>
          <span className="dz-dh-stat__ico">
            <BarsGlyph />
          </span>
        </div>
      </div>
      <div className="dz-dh-summary__foot">
        {!ready ? (
          <span className="dz-dh-shimmer dz-dh-shimmer--line" />
        ) : empty ? (
          "אין עדיין הכנסות או הוצאות רשומות לחודש הזה"
        ) : (
          <>
            {`${t("documents.hub.kpiNet")}: `}
            <b>{formatMoney(ready.net, locale)}</b>
            {delta ? (
              <span className={`dz-dh-delta dz-dh-delta--${delta.dir}`}>
                {delta.dir === "up" ? "▲" : delta.dir === "down" ? "▼" : ""}
                {Math.abs(delta.pct)}% מהחודש הקודם
              </span>
            ) : null}
          </>
        )}
        {ready ? (
          <span className="dz-dh-summary__counts">
            {` · ${formatNumber(ready.monthDocs, fmt)} ${t("documents.hub.kpiMonthDocs")} · ${formatNumber(ready.approved, fmt)} ${t("documents.hub.kpiApproved")}`}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function ActionTile({
  art,
  title,
  sub,
  onClick,
  disabled,
  children,
}: {
  art: string;
  title: string;
  sub?: string;
  onClick: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <button type="button" className="dz-dh-action" onClick={onClick} disabled={disabled}>
      {/* Decorative: the title names the action. */}
      <img className="dz-dh-action__art" src={art} alt="" width={240} height={190} draggable={false} />
      <span className="dz-dh-action__title">{title}</span>
      {sub ? <span className="dz-dh-action__sub">{sub}</span> : null}
      {children}
    </button>
  );
}

/** Pending-approval count for the verify tile; null while unknown (loading / error). */
export function HubActions({
  pending,
  uploading,
  onUpload,
  onCamera,
  onVerify,
  onSearch,
}: {
  pending: number | null;
  uploading: boolean;
  onUpload: () => void;
  onCamera: () => void;
  onVerify: () => void;
  onSearch: () => void;
}) {
  const { t, fmt } = useI18n();
  return (
    <section className="dz-dh-actions-wrap" aria-labelledby="dz-dh-actions-h">
      <h2 id="dz-dh-actions-h" className="dz-dh-h2">
        מה תרצה לעשות?
      </h2>
      <div className="dz-dh-actions">
        <ActionTile
          art={ILLUSTRATION.upload}
          title={uploading ? t("documents.home.uploading") : "להעלות קובץ"}
          sub="PDF או תמונה מהמכשיר"
          onClick={onUpload}
          disabled={uploading}
        />
        <ActionTile
          art={ILLUSTRATION.camera}
          title="לצלם מסמך"
          sub="ישירות מהמצלמה"
          onClick={onCamera}
          disabled={uploading}
        />
        <ActionTile art={ILLUSTRATION.verify} title="לאמת מסמכים" onClick={onVerify}>
          {pending === null ? (
            <span className="dz-dh-pill dz-dh-pill--loading" aria-label="טוען מספר ממתינים" />
          ) : pending > 0 ? (
            <span className="dz-dh-pill">{`${formatNumber(pending, fmt)} ממתינים לאישור`}</span>
          ) : (
            <span className="dz-dh-pill dz-dh-pill--clear">אין מסמכים ממתינים</span>
          )}
        </ActionTile>
        <ActionTile
          art={ILLUSTRATION.search}
          title="למצוא מסמך"
          sub={t("documents.home.stationSearchSub")}
          onClick={onSearch}
        />
      </div>
      <p className="dz-dh-hint">{t("documents.home.fileHint")}</p>
    </section>
  );
}

/** Gmail = manual pick + preview (its own screen); WhatsApp intake is not open yet. */
export function HubChannels({ onGmail }: { onGmail: () => void }) {
  return (
    <section className="dz-dh-channels" aria-label="קליטה ממקורות נוספים">
      <button type="button" className="dz-dh-channel" onClick={onGmail}>
        <span className="dz-dh-channel__tx">
          <span className="dz-dh-channel__title">
            בחירה מ־Gmail
            <span className="dz-dh-channel__logo">
              <GmailLogo />
            </span>
          </span>
          <span className="dz-dh-channel__sub">לבחור מסמכים באופן ידני</span>
        </span>
        <span className="dz-dh-chev" aria-hidden>
          <ChevronIcon />
        </span>
      </button>
      <span className="dz-dh-channels__sep" aria-hidden />
      <div className="dz-dh-channel dz-dh-channel--off" aria-disabled="true">
        <span className="dz-dh-channel__tx">
          <span className="dz-dh-channel__title">
            <span className="dz-dh-channel__soon">בקרוב ·</span> WhatsApp
            <span className="dz-dh-channel__logo dz-dh-channel__logo--wa">
              <WhatsappLogo />
            </span>
          </span>
          <span className="dz-dh-channel__sub">שלחו מסמכים ישירות מ־WhatsApp</span>
        </span>
      </div>
    </section>
  );
}

export function HubAccountantPack({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" className="dz-dh-pack" onClick={onOpen}>
      <img className="dz-dh-pack__art" src={ILLUSTRATION.pack} alt="" width={240} height={190} draggable={false} />
      <span className="dz-dh-pack__tx">
        <span className="dz-dh-pack__title">{t("documents.home.stationPack")}</span>
        <span className="dz-dh-pack__sub">{t("documents.home.stationPackSub")}</span>
      </span>
      <span className="dz-dh-chev" aria-hidden>
        <ChevronIcon />
      </span>
    </button>
  );
}
