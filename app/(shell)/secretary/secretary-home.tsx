"use client";

/**
 * The Secretary home — "במה צריך לטפל עכשיו?".
 *
 * One status sentence built from the server's counts, then every item that
 * needs the owner, grouped by the server's own reason (עבר המועד / להיום /
 * בשבוע הקרוב), each with its actions in the row; then what is in quiet
 * tracking. The business-cost and leads cards sit in the side column.
 *
 * handled ≠ paid: "שילמתי" opens the existing payment path ("שילמת?" →
 * POST /api/payables/payments). Closing a reminder without a payment is a
 * separate, explicit menu action.
 */

import { useState, type ReactNode } from "react";
import { BusinessCostCard } from "@/components/business-cost/BusinessCostCard";
import { LeadsBriefingCard } from "@/components/leads/LeadsBriefingCard";
import {
  ActionMenu,
  Button,
  ButtonLink,
  ConfirmDialog,
  ObligationRow,
  PlusIcon,
  RowList,
  SectionHeading,
  SkeletonRows,
  StatusChip,
  civilDaysFromToday,
  formatLongDay,
  formatShortDate,
  hebrewErrorMessage,
  relativeDayText,
  type MenuItem,
  type StatusTone,
} from "@/components/finance-ui";
import type { HomeGroupKey, HomeRow, SecretaryHomeView } from "./secretary-home-model";
import h from "./secretary-home.module.css";

const GROUP_TONE: Record<HomeGroupKey, StatusTone> = {
  OVERDUE: "danger",
  DUE_TODAY: "warning",
  DUE_SOON: "warning",
  WATCHING: "neutral",
};

export const SECRETARY_HREF = {
  home: "/secretary",
  capture: "/secretary?screen=capture",
  bank: "/secretary?screen=bank",
  watching: "/secretary?screen=watching",
  legacyAll: "/secretary?screen=all",
  detail: (id: number) => "/secretary?screen=detail&id=" + id,
  remind: (id: number) => "/secretary?screen=remind&id=" + id,
  update: (id: number) => "/secretary?screen=update&id=" + id,
  commitment: (id: number) => "/payables/" + id,
};

export type SecretaryHomeActions = {
  /** Opens "שילמת?" at the payment details (ledger rows with something left). */
  onRecordPayment: (obligationId: number) => void;
  /** The existing "טופל" flow (asks "שילמת?" on ledger rows). */
  onHandled: (obligationId: number) => Promise<void>;
  onRelease: (obligationId: number) => Promise<void>;
};

export function SecretaryHome({ view, actions, now = new Date() }: { view: SecretaryHomeView; actions: SecretaryHomeActions; now?: Date }) {
  const [releasing, setReleasing] = useState<HomeRow | null>(null);
  const allHref = view.ledgerBacked ? "/payables" : SECRETARY_HREF.legacyAll;

  return (
    <main className={h.page} dir="rtl" aria-labelledby="secretary-title">
      <header className={h.head}>
        <div className={h.headText}>
          <p className={h.eyebrow}>{formatLongDay(now)}</p>
          <h1 id="secretary-title" className={h.title}>
            המזכירה שלי
          </h1>
        </div>
        <div className={h.headActions}>
          {view.state !== "new" ? (
            <ButtonLink href={allHref} variant="secondary">
              כל ההתחייבויות
            </ButtonLink>
          ) : null}
          <ButtonLink href={SECRETARY_HREF.capture} variant="primary">
            <PlusIcon />
            מסירה למזכירה
          </ButtonLink>
        </div>
      </header>

      <StatusBand view={view} />

      <div className={h.ws}>
        <div className={h.list}>
          {view.state === "new" ? (
            <div className={h.newCard}>
              <p>אפשר להתחיל מרשימת ההוצאות הקבועות (שכירות, ארנונה, חשמל…) או למסור תשלום אחד עכשיו.</p>
              <div className={h.newActions}>
                <ButtonLink href={SECRETARY_HREF.bank} variant="primary">
                  בחירה מרשימת ההוצאות הקבועות
                </ButtonLink>
                <ButtonLink href={SECRETARY_HREF.capture} variant="secondary">
                  מסירת תשלום אחד
                </ButtonLink>
              </div>
            </div>
          ) : (
            view.groups.map((group) => (
              <section key={group.key} className={h.group} aria-labelledby={`sec-group-${group.key}`}>
                <SectionHeading id={`sec-group-${group.key}`} tone={GROUP_TONE[group.key]} count={group.rows.length}>
                  {group.title}
                </SectionHeading>
                <RowList ariaLabelledBy={`sec-group-${group.key}`}>
                  {group.rows.map((row) => (
                    <HomeObligationRow key={row.obligation.id} row={row} now={now} actions={actions} onAskRelease={() => setReleasing(row)} />
                  ))}
                </RowList>
              </section>
            ))
          )}

          {view.state !== "new" ? (
            <div className={h.footLinks}>
              <ButtonLink href={SECRETARY_HREF.capture} variant="quiet" size="sm">
                <PlusIcon />
                מסירת תשלום נוסף
              </ButtonLink>
              <ButtonLink href={SECRETARY_HREF.bank} variant="quiet" size="sm">
                רשימת ההוצאות הקבועות
              </ButtonLink>
              {view.counts.watching > 0 ? (
                <ButtonLink href={SECRETARY_HREF.watching} variant="quiet" size="sm">
                  מה במעקב שקט
                </ButtonLink>
              ) : null}
            </div>
          ) : null}
        </div>

        <aside className={h.aside} aria-label="תמונת מצב">
          {/* What the business costs — straight from the business-cost engine. */}
          <BusinessCostCard embedded />
          {/* The sales side: leads that need the owner today. */}
          <LeadsBriefingCard embedded />
        </aside>
      </div>

      <ConfirmDialog
        open={releasing !== null}
        title="להסיר את ההתחייבות מהמעקב?"
        body={
          releasing ? (
            <>
              {releasing.name} לא תופיע יותר במזכירה. תשלומים שכבר נרשמו לא משתנים, ואפשר למסור אותה מחדש בכל רגע.
            </>
          ) : null
        }
        confirmLabel="כן, להסיר"
        cancelLabel="לא, להשאיר"
        onCancel={() => setReleasing(null)}
        translateError={hebrewErrorMessage}
        errorFallback="לא הצלחנו להסיר. ההתחייבות נשארה במעקב, ואפשר לנסות שוב."
        onConfirm={async () => {
          if (!releasing) return;
          await actions.onRelease(releasing.obligation.id);
          setReleasing(null);
        }}
      />
    </main>
  );
}

function StatusBand({ view }: { view: SecretaryHomeView }) {
  const stats: Array<{ label: string; value: number; danger?: boolean }> = [
    { label: "עבר המועד", value: view.counts.overdue, danger: true },
    { label: "להיום", value: view.counts.today },
    { label: "השבוע", value: view.counts.soon },
    { label: "במעקב", value: view.counts.watching },
  ];
  return (
    <section className={h.band} aria-label="מצב היום">
      <div className={h.say}>
        <div className={h.who}>
          <span className={h.avatar} aria-hidden="true">
            <PersonIcon />
          </span>
          המזכירה שלך
        </div>
        <h2 className={h.headline} aria-live="polite">
          {view.title}
        </h2>
        <p className={h.subline}>{view.subtitle}</p>
      </div>
      {view.state !== "new" ? (
        <dl className={h.stats}>
          {stats.map((s) => (
            <div key={s.label} className={[h.stat, s.danger && s.value > 0 ? h.statDanger : "", s.value === 0 ? h.statZero : ""].join(" ")}>
              <dt className={h.statLabel}>{s.label}</dt>
              <dd className={h.statValue}>{s.value.toLocaleString("he-IL")}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

function dueLine(row: HomeRow, now: Date): ReactNode {
  const days = civilDaysFromToday(row.obligation.dueAt, now);
  const date = formatShortDate(row.obligation.dueAt);
  const passed = row.status === "OVERDUE";
  return (
    <span className={h.meta}>
      <span>{row.cadence}</span>
      <span className={h.sep} aria-hidden="true">·</span>
      <span>{passed ? `היה לתשלום ב־${date}` : `לתשלום ב־${date}`}</span>
      {days !== null ? (
        <>
          <span className={h.sep} aria-hidden="true">·</span>
          <span className={passed ? h.late : undefined}>{relativeDayText(days)}</span>
        </>
      ) : null}
    </span>
  );
}

function HomeObligationRow({ row, now, actions, onAskRelease }: { row: HomeRow; now: Date; actions: SecretaryHomeActions; onAskRelease: () => void }) {
  const [busy, setBusy] = useState(false);
  const id = row.obligation.id;
  const needsOwner = row.status !== "WATCHING";

  const menu: MenuItem[] = [
    { kind: "link", label: "פרטים", href: SECRETARY_HREF.detail(id) },
    ...(row.commitmentId ? [{ kind: "link" as const, label: "פתיחה בהתחייבויות", href: SECRETARY_HREF.commitment(row.commitmentId) }] : []),
    ...(needsOwner && row.canRecordPayment
      ? [{ label: "סימון שטופל בלי תשלום…", onSelect: () => void runHandled() }]
      : []),
    { kind: "link", label: "להזכיר אחר כך", href: SECRETARY_HREF.remind(id) },
    { kind: "link", label: "עריכה", href: SECRETARY_HREF.update(id) },
    { kind: "separator" },
    { label: "כבר לא רלוונטי…", onSelect: onAskRelease, danger: true },
  ];

  async function runHandled() {
    if (busy) return;
    setBusy(true);
    try {
      await actions.onHandled(id);
    } finally {
      setBusy(false);
    }
  }

  let primary: ReactNode = null;
  if (needsOwner && row.canRecordPayment) {
    primary = (
      <Button variant="primary" size="sm" onClick={() => actions.onRecordPayment(id)}>
        שילמתי
      </Button>
    );
  } else if (needsOwner) {
    // No ledger link: the only existing path is "טופל" (nothing is recorded as paid).
    primary = (
      <Button variant="primary" size="sm" busy={busy} onClick={() => void runHandled()}>
        סמן שטופל
      </Button>
    );
  }

  return (
    <ObligationRow
      title={row.name}
      href={SECRETARY_HREF.detail(id)}
      chips={
        row.status === "WATCHING" ? (
          <StatusChip status={{ domain: "secretary", state: "WATCHING" }} />
        ) : (
          <StatusChip status={{ domain: "secretary", state: row.status }} />
        )
      }
      meta={dueLine(row, now)}
      progress={row.progress ?? undefined}
      amount={{ value: row.amount, currency: row.obligation.currency, caption: row.amountCaption ?? undefined }}
      actions={
        <>
          {primary}
          <ActionMenu items={menu} label={`פעולות נוספות ל${row.name}`} />
        </>
      }
    />
  );
}

export function SecretaryHomeLoading() {
  return (
    <main className={h.page} dir="rtl" aria-busy="true" aria-label="טוען את המזכירה">
      <header className={h.head}>
        <div className={h.headText}>
          <span className={h.skel} style={{ inlineSize: 140, blockSize: 12 }} />
          <h1 className={h.title}>המזכירה שלי</h1>
        </div>
      </header>
      <section className={h.band}>
        <div className={h.say}>
          <span className={h.skel} style={{ inlineSize: "60%", blockSize: 22 }} />
          <span className={h.skel} style={{ inlineSize: "40%", blockSize: 14 }} />
        </div>
      </section>
      <div className={h.ws}>
        <SkeletonRows count={3} label="טוען את מה שדורש טיפול" />
      </div>
    </main>
  );
}

export function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.3" />
      <path d="M5.4 19c0-3.7 3-6.2 6.6-6.2s6.6 2.5 6.6 6.2" />
    </svg>
  );
}
