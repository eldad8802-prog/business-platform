"use client";

/**
 * The commitment detail screen's building blocks. Layout lives in page.tsx;
 * these render what the server sent and call the SAME client functions and
 * forms the screen always used. No amount is computed here.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";
import {
  cadenceLabel,
  formatDate,
  formatMoney,
  methodLabel,
  scheduleLabel,
  stateLabel,
  voidPayment,
  type BankAccountApi,
  type ChequeApi,
  type CommitmentDetailApi,
  type DerivedState,
  type InstallmentApi,
  type PreparationApi,
} from "@/lib/payables/payables-client";
import { ChequeCard, ChequeForm } from "../cheque-parts";
import { PreparationCard } from "../prepare-parts";
import base from "../payables.module.css";
import s from "./commitment-detail.module.css";
import { RecurringChanges } from "./recurring-changes";
import {
  HERO_TITLE,
  STATE_TONE,
  auditLabel,
  chequeCountLabel,
  isPartlyPaid,
  type Hero,
} from "./commitment-detail-model";

export type RunAction = (action: () => Promise<unknown>, success: string) => Promise<void>;

/* ───────────────────────────── small pieces ───────────────────────────── */

const TONE_CLASS = {
  overdue: s.badgeOverdue,
  due: s.badgeDue,
  partial: s.badgePartial,
  paid: s.badgePaid,
  quiet: s.badgeQuiet,
} as const;

export function StateBadge({ state, label }: { state: DerivedState; label?: string }) {
  const { t } = useI18n();
  return <span className={`${s.badge} ${TONE_CLASS[STATE_TONE[state]]}`}>{label ?? stateLabel(t, state)}</span>;
}

function QuietBadge({ children }: { children: ReactNode }) {
  return <span className={`${s.badge} ${s.badgeQuiet}`}>{children}</span>;
}

export function longDate(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(intlTag(locale), { day: "numeric", month: "long", year: "numeric" }).format(d);
}

/** "סומן כטופל ב־… על ידי …. <explanation>" — the legacy assertion, worded exactly as before. */
export function legacyText(t: Translator, locale: Locale, legacy: NonNullable<CommitmentDetailApi["legacy"]>): string {
  return (
    t("money.payables.detail.legacyMarked") +
    (legacy.metAt ? ` ${t("money.payables.detail.legacyOnDate", { date: formatDate(legacy.metAt, locale) })}` : "") +
    (legacy.assertedBy ? ` ${t("money.payables.detail.legacyBy", { who: legacy.assertedBy })}` : "") +
    `. ${t("money.payables.detail.legacyExplain")}`
  );
}

export function kindLabel(t: Translator, detail: Pick<CommitmentDetailApi, "scheduleKind" | "recurrence" | "installments">): string {
  const kind = scheduleLabel(t, detail.scheduleKind);
  if (detail.scheduleKind === "INSTALLMENT_PLAN") return `${kind} · ${detail.installments.length}`;
  if (detail.recurrence && detail.recurrence !== "NONE") return `${kind} · ${cadenceLabel(t, detail.recurrence)}`;
  return kind;
}

/* ───────────────────────────── icons ───────────────────────────── */

type IconName = "calendar" | "check" | "alert" | "stop" | "info" | "plus" | "doc" | "gear" | "chev" | "close" | "repeat" | "once" | "split";

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "calendar":
      return (
        <svg {...p} strokeWidth={1.9}>
          <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
          <path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" strokeWidth={2.6} />
        </svg>
      );
    case "check":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.5 12.2l2.4 2.4 4.6-4.9" />
        </svg>
      );
    case "alert":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5v5.5M12 16.3h.01" />
        </svg>
      );
    case "stop":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.5 12h7" />
        </svg>
      );
    case "info":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      );
    case "plus":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
    case "doc":
      return (
        <svg {...p}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5M9 13h6M9 17h6" />
        </svg>
      );
    case "gear":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      );
    case "chev":
      return (
        <svg {...p} strokeWidth={2.2}>
          <path d="M15 6l-6 6 6 6" />
        </svg>
      );
    case "close":
      return (
        <svg {...p} strokeWidth={2.2}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      );
    case "repeat":
      return (
        <svg {...p} strokeWidth={2.2}>
          <path d="M17 2l4 4-4 4" />
          <path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" />
          <path d="M21 13v1a4 4 0 0 1-4 4H3" />
        </svg>
      );
    case "once":
      return (
        <svg {...p} strokeWidth={2.2}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l2.5 2" />
        </svg>
      );
    case "split":
      return (
        <svg {...p} strokeWidth={2.2}>
          <rect x="3" y="5" width="5" height="14" rx="1.5" />
          <rect x="10" y="5" width="5" height="14" rx="1.5" />
          <rect x="17" y="5" width="4" height="14" rx="1.5" />
        </svg>
      );
  }
}

/* ───────────────────────────── the sheet / dialog ───────────────────────────── */

/**
 * One modal surface for every secondary step: a bottom sheet on a phone, a
 * centred dialog from tablet up (CSS, by the page's data-layout). Native
 * <dialog> gives the focus trap, Esc and the top layer; focus returns to the
 * control that opened it.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  testId,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={s.sheet}
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={s.sheetInner}>
        <div className={s.grab} aria-hidden />
        <div className={s.sheetHead}>
          <h2 id={titleId} className={s.sheetTitle}>
            {title}
          </h2>
          <button type="button" className={s.roundBtn} onClick={onClose} aria-label="סגירה">
            <Icon name="close" size={18} />
          </button>
        </div>
        {subtitle ? <p className={s.sheetSub}>{subtitle}</p> : null}
        <div className={s.sheetBody}>{children}</div>
      </div>
    </dialog>
  );
}

/* ───────────────────────────── the status box ───────────────────────────── */

const HERO_ICON: Record<Hero["kind"], IconName> = {
  OPEN: "calendar",
  OVERDUE: "alert",
  PAID: "check",
  ENDED: "stop",
  LEGACY: "info",
  RELEASED: "stop",
  CANCELLED: "stop",
  NONE: "info",
};

const HERO_TONE: Record<Hero["kind"], string> = {
  OPEN: s.heroOpen,
  OVERDUE: s.heroOverdue,
  PAID: s.heroPaid,
  ENDED: s.heroQuiet,
  LEGACY: s.heroQuiet,
  RELEASED: s.heroQuiet,
  CANCELLED: s.heroQuiet,
  NONE: s.heroQuiet,
};

export function HeroBox({ detail, hero }: { detail: CommitmentDetailApi; hero: Hero }) {
  const { t, locale } = useI18n();
  const inst = hero.installment;
  let amount: string | null = null;
  let when = "";
  let extra: string | null = null;
  let badge: ReactNode = null;

  switch (hero.kind) {
    case "OPEN":
    case "OVERDUE":
      amount = formatMoney(inst!.remaining, detail.currency, locale);
      when = longDate(inst!.dueAt, locale);
      if (isPartlyPaid(inst!)) {
        extra = `נותרו ${formatMoney(inst!.remaining, detail.currency, locale)} מתוך ${formatMoney(inst!.scheduled, detail.currency, locale)}`;
      }
      badge = <StateBadge state={inst!.state} />;
      break;
    // Nothing open: the title already states the outcome, so no badge repeats it.
    case "PAID":
      amount = detail.total === null ? null : formatMoney(detail.total, detail.currency, locale);
      when = hero.lastPayment ? `שולם ב־${formatDate(hero.lastPayment.paidAt, locale)}` : "";
      break;
    case "ENDED":
      when = detail.endAt ? t("money.payables.recurring.endsNotice", { date: formatDate(detail.endAt, locale) }) : "אין תשלומים פתוחים.";
      break;
    case "LEGACY":
      if (detail.legacy) {
        when = [
          detail.legacy.metAt ? `ב־${formatDate(detail.legacy.metAt, locale)}` : null,
          detail.legacy.assertedBy ? t("money.payables.detail.legacyBy", { who: detail.legacy.assertedBy }) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        extra = t("money.payables.detail.legacyExplain");
      } else {
        extra = t("money.payables.detail.settledLegacy");
      }
      break;
    case "RELEASED":
      when = "ההתחייבות סומנה כלא רלוונטית. אין תשלומים פתוחים.";
      break;
    case "CANCELLED":
      when = "כל התשלומים בהתחייבות הזו בוטלו.";
      break;
    case "NONE":
      when = "אין כרגע תשלום שממתין.";
      break;
  }
  if ((hero.kind === "OPEN" || hero.kind === "OVERDUE") && detail.endAt) {
    extra = [extra, t("money.payables.recurring.endsNotice", { date: formatDate(detail.endAt, locale) })].filter(Boolean).join(" · ");
  }

  return (
    <section className={`${s.hero} ${HERO_TONE[hero.kind]}`} aria-label={HERO_TITLE[hero.kind]} data-testid="hero" data-kind={hero.kind}>
      <span className={s.heroIcon}>
        <Icon name={HERO_ICON[hero.kind]} size={26} />
      </span>
      <div className={s.heroMain}>
        <p className={amount ? s.heroLabel : s.heroLabelStrong}>{HERO_TITLE[hero.kind]}</p>
        {amount ? (
          <p className={s.heroAmount}>
            {amount}
          </p>
        ) : null}
        {when ? <p className={s.heroWhen}>{when}</p> : null}
        {extra ? <p className={s.heroExtra}>{extra}</p> : null}
      </div>
      {badge ? <span className={s.heroBadge}>{badge}</span> : null}
    </section>
  );
}

/** Total / paid / remaining exactly as the server sent them — never for a recurring commitment. */
export function ProgressLine({ detail }: { detail: CommitmentDetailApi }) {
  const { t, locale } = useI18n();
  if (detail.scheduleKind === "RECURRING" || detail.total === null) return null;
  return (
    <p className={s.progress} data-testid="progress">
      <span>
        {t("money.payables.detail.totalAmount")} <b>{formatMoney(detail.total, detail.currency, locale)}</b>
      </span>
      <span>
        {t("money.payables.list.paid")} <b>{formatMoney(detail.paid, detail.currency, locale)}</b>
      </span>
      <span>
        {t("money.payables.list.remaining")}{" "}
        <b>{detail.remaining === null ? "—" : formatMoney(detail.remaining, detail.currency, locale)}</b>
      </span>
    </p>
  );
}

/* ───────────────────────────── identity ───────────────────────────── */

export function Identity({ detail, icon, size = "md" }: { detail: CommitmentDetailApi; icon: string; size?: "md" | "lg" }) {
  const { t } = useI18n();
  const showPayee = detail.payeeNameSnapshot && detail.payeeNameSnapshot.trim() !== detail.title.trim();
  const kindIcon: IconName = detail.scheduleKind === "RECURRING" ? "repeat" : detail.scheduleKind === "INSTALLMENT_PLAN" ? "split" : "once";
  return (
    <div className={`${s.ident} ${size === "lg" ? s.identLg : ""}`}>
      <span className={s.avatar} aria-hidden>
        {icon}
      </span>
      <div className={s.identText}>
        <h1 className={s.title}>{detail.title}</h1>
        {showPayee ? <p className={s.payee}>{detail.payeeNameSnapshot}</p> : null}
        <div className={s.kindRow}>
          <span className={s.kind}>
            <Icon name={kindIcon} size={14} /> {kindLabel(t, detail)}
          </span>
          {detail.isLegacy ? <span className={`${s.kind} ${s.kindQuiet}`}>{t("money.payables.list.legacyBadge")}</span> : null}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── schedule ───────────────────────────── */

export function ScheduleList({
  rows,
  currency,
  currentId,
  total,
  expanded,
  onToggle,
  onOpen,
}: {
  rows: InstallmentApi[];
  currency: string;
  currentId: number | null;
  total: number;
  expanded: boolean;
  onToggle: (() => void) | null;
  onOpen: (id: number) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <section className={s.schedule} aria-labelledby="cd-schedule-title" data-testid="schedule">
      <div className={s.scheduleHead}>
        <h2 id="cd-schedule-title" className={s.sectionTitle}>
          {t("money.payables.detail.scheduleTitle")}
        </h2>
        {onToggle ? (
          <button type="button" className={s.linkBtn} onClick={onToggle} aria-expanded={expanded} data-testid="schedule-toggle">
            {expanded ? "הצג פחות" : `הצג הכל (${total})`}
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? <p className={s.muted}>אין תשלומים בלוח.</p> : null}
      <ul className={s.rows}>
        {rows.map((inst) => {
          const partly = isPartlyPaid(inst);
          const tone = inst.id === currentId ? (inst.state === "OVERDUE" ? s.rowOverdue : s.rowCurrent) : "";
          return (
            <li key={inst.id}>
              <button
                type="button"
                className={`${s.row} ${tone} ${inst.state === "CANCELLED" ? s.rowCancelled : ""}`}
                onClick={() => onOpen(inst.id)}
                data-testid={`row-${inst.id}`}
              >
                <span className={s.rowAmount}>
                  <span>{formatMoney(inst.scheduled, currency, locale)}</span>
                  {partly ? (
                    <span className={s.rowSub}>
                      {t("money.payables.list.remaining")} <span>{formatMoney(inst.remaining, currency, locale)}</span>
                    </span>
                  ) : null}
                </span>
                <StateBadge state={inst.state} />
                <span className={s.rowDate}>{formatDate(inst.dueAt, locale)}</span>
                <span className={s.chev}>
                  <Icon name="chev" size={16} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Desktop: the same rows as a wide, readable table (sequence, due, scheduled, paid, remaining, state). */
export function ScheduleTable({
  rows,
  currency,
  currentId,
  total,
  expanded,
  onToggle,
  onOpen,
}: {
  rows: InstallmentApi[];
  currency: string;
  currentId: number | null;
  total: number;
  expanded: boolean;
  onToggle: (() => void) | null;
  onOpen: (id: number) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <section className={`${s.schedule} ${s.scheduleWide}`} aria-labelledby="cd-schedule-title" data-testid="schedule">
      <div className={s.scheduleHead}>
        <h2 id="cd-schedule-title" className={s.sectionTitle}>
          {t("money.payables.detail.scheduleTitle")}
        </h2>
        {onToggle ? (
          <button type="button" className={s.linkBtn} onClick={onToggle} aria-expanded={expanded} data-testid="schedule-toggle">
            {expanded ? "הצג פחות" : `הצג הכל (${total})`}
          </button>
        ) : null}
      </div>
      <div className={s.tableHead} aria-hidden>
        <span>תשלום</span>
        <span>מועד</span>
        <span>{t("money.payables.detail.due")}</span>
        <span>{t("money.payables.list.paid")}</span>
        <span>{t("money.payables.list.remaining")}</span>
        <span>מצב</span>
        <span />
      </div>
      {rows.length === 0 ? <p className={s.muted}>אין תשלומים בלוח.</p> : null}
      <ul className={s.rows}>
        {rows.map((inst) => {
          const tone = inst.id === currentId ? (inst.state === "OVERDUE" ? s.rowOverdue : s.rowCurrent) : "";
          return (
            <li key={inst.id}>
              <button
                type="button"
                className={`${s.tableRow} ${tone} ${inst.state === "CANCELLED" ? s.rowCancelled : ""}`}
                onClick={() => onOpen(inst.id)}
                data-testid={`row-${inst.id}`}
              >
                <span className={s.cellSeq}>{inst.sequence}</span>
                <span className={s.cellNum}>{formatDate(inst.dueAt, locale)}</span>
                <span className={s.cellMoney}>
                  {formatMoney(inst.scheduled, currency, locale)}
                </span>
                <span className={s.cellMoneyMuted}>
                  {formatMoney(inst.paid, currency, locale)}
                </span>
                <span className={s.cellMoney}>
                  {formatMoney(inst.remaining, currency, locale)}
                </span>
                <span>
                  <StateBadge state={inst.state} />
                </span>
                <span className={s.chev}>
                  <Icon name="chev" size={16} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ───────────────────────────── one installment ───────────────────────────── */

export function InstallmentDetail({
  inst,
  currency,
  payable,
  onPay,
  onReverse,
  onCancel,
}: {
  inst: InstallmentApi;
  currency: string;
  payable: boolean;
  onPay: () => void;
  onReverse: (allocationId: number) => void;
  onCancel: (installmentId: number) => void;
}) {
  const { t, locale } = useI18n();
  const hasActive = inst.allocations.some((a) => a.active);
  const cancellable = inst.status === "SCHEDULED" && !hasActive && Number(inst.paid) === 0;

  return (
    <div className={s.stack} data-testid="installment-detail">
      <div>
        <StateBadge state={inst.state} />
      </div>
      <dl className={s.facts}>
        <div>
          <dt>{t("money.payables.detail.due")}</dt>
          <dd>{formatMoney(inst.scheduled, currency, locale)}</dd>
        </div>
        <div>
          <dt>{t("money.payables.list.paid")}</dt>
          <dd>{formatMoney(inst.paid, currency, locale)}</dd>
        </div>
        <div>
          <dt>{t("money.payables.list.remaining")}</dt>
          <dd>{formatMoney(inst.remaining, currency, locale)}</dd>
        </div>
      </dl>

      {inst.state === "SETTLED_LEGACY" && <p className={s.hint}>{t("money.payables.detail.settledLegacy")}</p>}

      {inst.allocations.length > 0 && (
        <div className={s.stackTight}>
          <h3 className={s.groupTitle}>שיוכים</h3>
          {inst.allocations.map((a) => (
            <div key={a.id} className={a.active ? s.mini : `${s.mini} ${s.miniReversed}`}>
              <span className={s.miniText}>
                <span>
                  {formatMoney(a.amount, currency, locale)} · {methodLabel(t, a.paymentMethod) ?? a.paymentMethod}
                </span>
                <span className={s.miniSub}>
                  {formatDate(a.paymentPaidAt, locale)}
                  {a.reversedAt ? ` · ${t("money.payables.detail.allocReversedTag")}${a.reversalReason ? ` (${a.reversalReason})` : ""}` : ""}
                  {!a.reversedAt && a.paymentStatus === "VOID" ? ` · ${t("money.payables.detail.allocPaymentVoided")}` : ""}
                </span>
              </span>
              {a.active && (
                <button type="button" className={base.buttonQuiet} onClick={() => onReverse(a.id)}>
                  {t("money.payables.detail.reverseAllocation")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {payable && (
        <button type="button" className={s.btnPrimary} onClick={onPay} data-testid="pay-this">
          <Icon name="plus" /> רשום תשלום לתשלום הזה
        </button>
      )}

      {cancellable && (
        <div className={base.formActions}>
          <button type="button" className={base.buttonQuiet} onClick={() => onCancel(inst.id)}>
            {t("money.payables.detail.cancelInstallment")}
          </button>
        </div>
      )}
      {inst.status === "SCHEDULED" && hasActive && <p className={s.muted}>{t("money.payables.detail.cannotCancel")}</p>}
    </div>
  );
}

/* ───────────────────────────── details ───────────────────────────── */

export function FactsList({ detail, current }: { detail: CommitmentDetailApi; current: InstallmentApi | null }) {
  const { t, locale } = useI18n();
  const byDue = [...detail.installments].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  const first = byDue[0] ?? null;
  const last = byDue[byDue.length - 1] ?? null;
  const facts: Array<[string, ReactNode]> = [["סוג", kindLabel(t, detail)]];
  if (detail.scheduleKind === "RECURRING") {
    if (current) facts.push(["סכום התשלום הקרוב", <span key="a">{formatMoney(current.scheduled, detail.currency, locale)}</span>]);
  } else if (detail.total !== null) {
    facts.push([t("money.payables.detail.totalAmount"), <span key="t">{formatMoney(detail.total, detail.currency, locale)}</span>]);
    facts.push([t("money.payables.list.paid"), <span key="p">{formatMoney(detail.paid, detail.currency, locale)}</span>]);
    facts.push([
      t("money.payables.list.remaining"),
      <span key="r">{detail.remaining === null ? "—" : formatMoney(detail.remaining, detail.currency, locale)}</span>,
    ]);
  }
  if (first) facts.push([detail.scheduleKind === "ONE_OFF" ? "מועד" : "תשלום ראשון", formatDate(first.dueAt, locale)]);
  if (last && last !== first && detail.scheduleKind !== "RECURRING") facts.push(["תשלום אחרון", formatDate(last.dueAt, locale)]);
  if (detail.endAt) facts.push(["בתוקף עד", formatDate(detail.endAt, locale)]);
  if (detail.payeeNameSnapshot) facts.push(["מוטב", detail.payeeNameSnapshot]);
  if (detail.isLegacy) facts.push(["מקור", t("money.payables.list.legacyBadge")]);

  return (
    <dl className={s.facts} data-testid="facts">
      {facts.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function NoteAndLegacy({ detail }: { detail: CommitmentDetailApi }) {
  const { t, locale } = useI18n();
  return (
    <>
      {detail.scheduleKind === "RECURRING" ? <p className={s.hint}>{t("money.payables.detail.recurringNotice")}</p> : null}
      {detail.note ? (
        <div className={s.stackTight} data-testid="note">
          <h3 className={s.groupTitle}>הערה</h3>
          <p className={s.noteText}>{detail.note}</p>
        </div>
      ) : null}
      {/* The legacy assertion, stated as an assertion. It must not read as a
          payment: nothing was ever observed, and no amount was recorded. */}
      {detail.legacy ? <p className={s.hint}>{legacyText(t, locale, detail.legacy)}</p> : null}
    </>
  );
}

/** Recorded payments, with the existing "void" — confirmed in place before anything is sent. */
export function PaymentsList({ detail, run }: { detail: CommitmentDetailApi; run: RunAction }) {
  const { t, locale } = useI18n();
  const [confirming, setConfirming] = useState<number | null>(null);
  if (detail.payments.length === 0) return <p className={s.muted}>לא נרשמו תשלומים.</p>;
  return (
    <div className={s.stackTight} data-testid="payments">
      {detail.payments.map((p) => (
        <div key={p.id} className={s.mini}>
          <span className={s.miniText}>
            <span>
              {formatMoney(p.amount, detail.currency, locale)} · {methodLabel(t, p.method) ?? p.method}
            </span>
            <span className={s.miniSub}>
              {t("money.payables.detail.paymentLine", {
                date: formatDate(p.paidAt, locale),
                allocated: formatMoney(p.allocated, detail.currency, locale),
                unallocated: formatMoney(p.unallocated, detail.currency, locale),
              })}
              {p.externalReference ? ` · ${t("money.payables.detail.referenceN", { reference: p.externalReference })}` : ""}
            </span>
            {confirming === p.id ? <span className={s.confirmText}>{t("money.payables.detail.voidConfirm")}</span> : null}
          </span>
          <span className={s.miniActions}>
            {p.status === "VOID" ? (
              <QuietBadge>{t("money.payables.detail.voidBadge")}</QuietBadge>
            ) : confirming === p.id ? (
              <>
                <button
                  type="button"
                  className={`${base.buttonQuiet} ${s.dangerBtn}`}
                  onClick={() => {
                    setConfirming(null);
                    void run(() => voidPayment(p.id, "בוטל על ידי בעל העסק"), t("money.payables.detail.voided"));
                  }}
                  data-testid={`void-confirm-${p.id}`}
                >
                  כן, בטל רישום
                </button>
                <button type="button" className={base.buttonQuiet} onClick={() => setConfirming(null)}>
                  {t("money.common.close")}
                </button>
              </>
            ) : (
              <>
                <span className={`${s.badge} ${s.badgePaid}`}>{t("money.payables.detail.recordedBadge")}</span>
                <button type="button" className={base.buttonQuiet} onClick={() => setConfirming(p.id)} data-testid={`void-${p.id}`}>
                  {t("money.payables.detail.voidPayment")}
                </button>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

export function HistoryList({ detail }: { detail: CommitmentDetailApi }) {
  const { locale } = useI18n();
  if (detail.audit.length === 0) return <p className={s.muted}>אין תיעוד עדיין.</p>;
  return (
    <ul className={s.history} data-testid="history">
      {detail.audit.map((a) => (
        <li key={a.id} className={s.historyRow}>
          <div className={s.historyMain}>
            <span>{auditLabel(a)}</span>
            {a.summary ? (
              <details className={s.tech}>
                <summary>פרטים טכניים</summary>
                <code dir="ltr">{a.summary}</code>
              </details>
            ) : null}
          </div>
          <span className={s.historyDate}>{formatDate(a.occurredAt, locale)}</span>
        </li>
      ))}
    </ul>
  );
}

/* ───────────────────────────── management ───────────────────────────── */

export function ManageSection({
  detail,
  cheques,
  accounts,
  preparations,
  providersLive,
  run,
  onChanged,
}: {
  detail: CommitmentDetailApi;
  cheques: ChequeApi[];
  accounts: BankAccountApi[];
  preparations: PreparationApi[];
  providersLive: boolean;
  run: RunAction;
  onChanged: (message: string) => void;
}) {
  const { t } = useI18n();
  const [showChequeForm, setShowChequeForm] = useState(false);
  const recurringActive = detail.scheduleKind === "RECURRING" && detail.status === "ACTIVE";
  const chequeCount = chequeCountLabel(cheques);

  return (
    <div className={s.stack} data-testid="manage">
      <div className={s.stackTight}>
        <h3 className={s.groupTitle}>סכום ותאריכים</h3>
        {recurringActive ? (
          <RecurringChanges commitmentId={detail.id} endAt={detail.endAt} run={run} />
        ) : (
          <p className={s.hint}>
            שינוי סכום מתאריך וסיום ההתחייבות זמינים להתחייבות מתחדשת פעילה בלבד. ביטול תשלום בודד נעשה מלוח התשלומים.
          </p>
        )}
      </div>

      <div className={s.stackTight} data-testid="cheques">
        <div className={s.groupHead}>
          <h3 className={s.groupTitle}>
            {t("money.payables.detail.chequesTitle")}
            {chequeCount ? <span className={s.count}> · {chequeCount}</span> : null}
          </h3>
          {detail.status === "ACTIVE" && (
            <button
              type="button"
              className={base.buttonQuiet}
              onClick={() => setShowChequeForm((v) => !v)}
              aria-expanded={showChequeForm}
            >
              {showChequeForm ? t("money.common.close") : t("money.payables.detail.recordCheque")}
            </button>
          )}
        </div>
        {showChequeForm && (
          <ChequeForm
            accounts={accounts}
            commitmentId={detail.id}
            installments={detail.installments}
            onCreated={(c) => {
              setShowChequeForm(false);
              onChanged(t("money.payables.detail.chequeRecorded", { number: c.chequeNumber }));
            }}
          />
        )}
        {cheques.length === 0
          ? !showChequeForm && <p className={s.muted}>{t("money.payables.detail.noCheques")}</p>
          : cheques.map((c) => <ChequeCard key={c.id} cheque={c} accounts={accounts} showCommitment={false} onChanged={onChanged} />)}
      </div>

      <div className={s.stackTight} data-testid="preparations">
        <h3 className={s.groupTitle}>תשלומים מוכנים</h3>
        {preparations.length === 0 ? (
          <p className={s.muted}>אין תשלומים מוכנים.</p>
        ) : (
          preparations.map((p) => <PreparationCard key={p.id} prep={p} providersLive={providersLive} onChanged={onChanged} />)
        )}
      </div>
    </div>
  );
}
