"use client";

/**
 * Commitment detail — one screen, three compositions (owner-approved redesign, 25.10.2026).
 *
 *   mobile   one calm column: identity → the payment that matters now → the
 *            two actions → a compact schedule → "פרטי ההתחייבות" / "ניהול".
 *   tablet   two zones: the commitment and its current payment on one side,
 *            the schedule on the other; details and management open on demand.
 *   desktop  a working screen: title + actions across the top, the status and
 *            a wide schedule table in the main zone, details / management /
 *            payments / history as their own panels beside it.
 *
 * The layout follows the width the screen actually gets (the app's side rail
 * and sidebar take part of the viewport), measured on the root element.
 *
 * Nothing here changes what anything means or costs: every figure is the
 * server's, every action is the same client call with the same arguments,
 * and every form is the same component the screen always used.
 */

import { use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import BackButton from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";
import {
  cancelInstallment,
  fetchBankAccounts,
  fetchCheques,
  fetchCommitment,
  fetchOutboundProviders,
  fetchPreparations,
  formatDate,
  formatMoney,
  reverseAllocation,
  type BankAccountApi,
  type ChequeApi,
  type CommitmentDetailApi,
  type PreparationApi,
} from "@/lib/payables/payables-client";
import { TOKEN } from "@/lib/design/tokens";
import { PAYABLES_THEME } from "../payables-theme";
import { PreparePaymentForm } from "../prepare-parts";
import { iconFor } from "../payables-list-model";
import base from "../payables.module.css";
import s from "./commitment-detail.module.css";
import {
  SCHEDULE_PREVIEW,
  chequeCountLabel,
  heroOf,
  openPreparations,
  openPreparationsLabel,
  orderSchedule,
  payableInstallments,
} from "./commitment-detail-model";
import {
  FactsList,
  HeroBox,
  HistoryList,
  Icon,
  Identity,
  InstallmentDetail,
  ManageSection,
  NoteAndLegacy,
  PaymentsList,
  ProgressLine,
  ScheduleList,
  ScheduleTable,
  Sheet,
} from "./detail-parts";
import { PaymentForm } from "./payment-form";

/** PAYABLES_THEME plus the few extra Mist roles this screen needs (overlay paper, soft accent). */
const DETAIL_THEME = {
  ...PAYABLES_THEME,
  "--cd-accent-soft": TOKEN.dsv1.accentSoft,
  "--cd-accent-soft-strong": TOKEN.dsv1.accentSoftStrong,
  "--cd-overlay": TOKEN.dsv1.overlay,
  "--cd-backdrop": TOKEN.dsv1.backdrop,
  "--cd-shadow-overlay": TOKEN.dsv1.shadowOverlay,
  "--cd-action-hover": TOKEN.dsv1.actionPrimaryHover,
  "--cd-secondary-bg": TOKEN.dsv1.actionSecondaryBg,
  "--cd-secondary-hover": TOKEN.dsv1.actionSecondaryHover,
  "--cd-secondary-border": TOKEN.dsv1.actionSecondaryBorder,
  "--cd-secondary-text": TOKEN.dsv1.actionSecondaryText,
} as React.CSSProperties;

type Layout = "mobile" | "tablet" | "desktop";

/** Content-width breakpoints (px of the screen's own box, not the viewport). */
function layoutFor(width: number): Layout {
  if (width >= 1000) return "desktop";
  if (width >= 600) return "tablet";
  return "mobile";
}

function useLayout(ref: React.RefObject<HTMLElement | null>): Layout {
  const [layout, setLayout] = useState<Layout>("mobile");
  useLayoutEffect(() => {
    // The PARENT's width: the root's own max-width depends on the layout, so
    // measuring the root would lock it into whatever it started as.
    const el = ref.current?.parentElement;
    if (!el) return;
    const measure = () => setLayout(layoutFor(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return layout;
}

type SheetState =
  | { kind: "record"; preselect: number | null }
  | { kind: "prepare" }
  | { kind: "installment"; id: number }
  | { kind: "details" }
  | { kind: "manage" }
  | null;

export default function CommitmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const commitmentId = Number(id);
  const { t, locale } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const layout = useLayout(rootRef);

  const [detail, setDetail] = useState<CommitmentDetailApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cheques, setCheques] = useState<ChequeApi[]>([]);
  const [accounts, setAccounts] = useState<BankAccountApi[]>([]);
  const [preparations, setPreparations] = useState<PreparationApi[]>([]);
  const [providersLive, setProvidersLive] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [showAll, setShowAll] = useState(false);

  // Every setState for the fetch lives inside the effect, so a response for a
  // commitment the owner has already navigated away from cannot land on the
  // new one. `reloadToken` is how an action asks for fresh data.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);
  const arrivalHandled = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Cheques are secondary to the ledger: if they fail to load, the
    // commitment still renders and the cheque section simply stays empty.
    Promise.all([
      fetchCommitment(commitmentId),
      fetchCheques({ scope: "all", commitmentId }).catch(() => [] as ChequeApi[]),
      fetchBankAccounts()
        .then((r) => r.accounts)
        .catch(() => [] as BankAccountApi[]),
      fetchPreparations({ commitmentId, scope: "all" }).catch(() => [] as PreparationApi[]),
      fetchOutboundProviders()
        .then((r) => r.live)
        .catch(() => false),
    ])
      .then(([d, list, bank, preps, live]) => {
        if (cancelled) return;
        setDetail(d);
        setCheques(list);
        setAccounts(bank);
        setPreparations(preps);
        setProvidersLive(live);
        setError(null);
        // Arriving from a Dubiz recommendation (`?pay=<installmentId>`): the
        // payment form opens with that open installment preselected — once,
        // on the first load only.
        if (!arrivalHandled.current) {
          arrivalHandled.current = true;
          const pay = Number(new URLSearchParams(window.location.search).get("pay"));
          if (Number.isInteger(pay) && pay > 0 && payableInstallments(d.installments).some((i) => i.id === pay)) {
            setSheet({ kind: "record", preselect: pay });
          }
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : t("money.payables.list.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [commitmentId, reloadToken, t]);

  async function run(action: () => Promise<unknown>, success: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("money.common.actionFailed"));
    }
  }

  const onChanged = useCallback(
    (message: string) => {
      setNotice(message);
      reload();
    },
    [reload],
  );

  const view = useMemo(() => {
    if (!detail) return null;
    const hero = heroOf(detail);
    const ordered = orderSchedule(detail.installments);
    const preview = SCHEDULE_PREVIEW[layout];
    return {
      hero,
      ordered,
      visibleRows: showAll ? ordered : ordered.slice(0, preview),
      canToggle: ordered.length > preview,
      payable: payableInstallments(detail.installments),
      openPreps: openPreparations(preparations),
      surplus: detail.payments.filter((p) => p.status === "RECORDED" && Number(p.unallocated) > 0),
      icon: iconFor({ title: detail.title, payeeNameSnapshot: detail.payeeNameSnapshot }),
    };
  }, [detail, preparations, layout, showAll]);

  /* ───────────── loading / error ───────────── */

  if (!detail || !view) {
    return (
      <div ref={rootRef} className={s.root} style={DETAIL_THEME} data-layout={layout}>
        <div className={s.topbar}>
          <BackButton />
        </div>
        {error ? <div className={base.error}>{error}</div> : <div className={base.empty}>{t("money.common.loading")}</div>}
      </div>
    );
  }

  const { hero, payable, openPreps, surplus } = view;
  const canRecord = payable.length > 0;
  const canPrepare = detail.status === "ACTIVE" && payable.length > 0;
  const currentId = hero.installment && (hero.kind === "OPEN" || hero.kind === "OVERDUE") ? hero.installment.id : null;
  const recurringActive = detail.scheduleKind === "RECURRING" && detail.status === "ACTIVE";
  const chequeCount = chequeCountLabel(cheques);

  const openSheet = (next: SheetState) => {
    setNotice(null);
    setError(null);
    setSheet(next);
  };
  const closeSheet = () => setSheet(null);

  /* ───────────── shared blocks ───────────── */

  const feedback = (
    <>
      {notice && (
        <div className={base.notice} role="status" data-testid="notice">
          {notice}
        </div>
      )}
      {error && (
        <div className={base.error} role="alert" data-testid="error">
          {error}
        </div>
      )}
    </>
  );

  const actions =
    canRecord || canPrepare ? (
      <div className={s.actions} data-testid="actions">
        {canRecord && (
          <button type="button" className={s.btnPrimary} onClick={() => openSheet({ kind: "record", preselect: null })} data-testid="open-record">
            <Icon name="plus" /> רשום תשלום
          </button>
        )}
        {canPrepare && (
          <button type="button" className={s.btnSecondary} onClick={() => openSheet({ kind: "prepare" })} data-testid="open-prepare">
            <Icon name="doc" /> {t("money.payables.detail.prepareTitle")}
          </button>
        )}
      </div>
    ) : null;

  const strips = (
    <>
      {openPreps.length > 0 && (
        <button
          type="button"
          className={s.strip}
          onClick={() =>
            layout === "desktop"
              ? document.getElementById("cd-manage")?.scrollIntoView({ block: "start", behavior: "smooth" })
              : openSheet({ kind: "manage" })
          }
          data-testid="strip-preparations"
        >
          <span className={s.stripDot} aria-hidden />
          <span className={s.stripText}>{openPreparationsLabel(openPreps.length)}</span>
          <Icon name="chev" size={16} />
        </button>
      )}
      {surplus.length > 0 && (
        <div className={base.notice} data-testid="surplus">
          {surplus.map((p) => (
            <div key={p.id}>
              {t("money.payables.detail.surplusBefore", { date: formatDate(p.paidAt, locale) })}{" "}
              <strong>{formatMoney(p.unallocated, detail.currency, locale)}</strong> {t("money.payables.detail.surplusAfter")}
            </div>
          ))}
        </div>
      )}
    </>
  );

  // Under the status box only while it shows a current payment ("מוצג התשלום הקרוב בלבד");
  // the details always carry it.
  const recurringLine =
    detail.scheduleKind === "RECURRING" && currentId !== null ? (
      <p className={s.noteLine}>{t("money.payables.detail.recurringNotice")}</p>
    ) : null;

  const scheduleProps = {
    rows: view.visibleRows,
    currency: detail.currency,
    currentId,
    total: view.ordered.length,
    expanded: showAll,
    onToggle: view.canToggle ? () => setShowAll((v) => !v) : null,
    onOpen: (installmentId: number) => openSheet({ kind: "installment", id: installmentId }),
  };

  const detailsSub = ["סוג, סכומים ותאריכים", "מוטב", detail.note ? "הערה" : null, "תשלומים והיסטוריה"].filter(Boolean).join(", ");
  const manageSub = [
    recurringActive ? "שינוי סכום, סיום התחייבות" : null,
    chequeCount || t("money.payables.detail.chequesTitle"),
    openPreps.length > 0 ? openPreparationsLabel(openPreps.length) : "תשלומים מוכנים",
  ]
    .filter(Boolean)
    .join(" · ");

  const navRows = (
    <nav className={s.navRows} aria-label="פרטים וניהול">
      <button type="button" className={s.navRow} onClick={() => openSheet({ kind: "details" })} data-testid="open-details">
        <span className={`${s.navIcon} ${s.navIconGreen}`}>
          <Icon name="doc" size={22} />
        </span>
        <span className={s.navText}>
          <b>פרטי ההתחייבות</b>
          <span>{detailsSub}</span>
        </span>
        <span className={s.chev}>
          <Icon name="chev" />
        </span>
      </button>
      <button type="button" className={s.navRow} onClick={() => openSheet({ kind: "manage" })} data-testid="open-manage">
        <span className={`${s.navIcon} ${s.navIconRed}`}>
          <Icon name="gear" size={22} />
        </span>
        <span className={s.navText}>
          <b>ניהול ההתחייבות</b>
          <span data-testid="manage-sub">{manageSub}</span>
        </span>
        <span className={s.chev}>
          <Icon name="chev" />
        </span>
      </button>
    </nav>
  );

  const manage = (
    <ManageSection
      detail={detail}
      cheques={cheques}
      accounts={accounts}
      preparations={preparations}
      providersLive={providersLive}
      run={run}
      onChanged={onChanged}
    />
  );

  /* ───────────── sheets ───────────── */

  let sheetNode: React.ReactNode = null;
  if (sheet?.kind === "record") {
    sheetNode = (
      <Sheet title={t("money.payables.detail.recordTitle")} subtitle="הסכום והתאריך הם מה שבאמת שולם." onClose={closeSheet} testId="sheet-record">
        <PaymentForm
          detail={detail}
          preselect={sheet.preselect}
          onDone={(message) => {
            closeSheet();
            onChanged(message);
          }}
        />
      </Sheet>
    );
  } else if (sheet?.kind === "prepare") {
    sheetNode = (
      <Sheet title={t("money.payables.detail.prepareTitle")} onClose={closeSheet} testId="sheet-prepare">
        {!providersLive ? <p className={s.hint}>{t("money.payables.detail.noProvider")}</p> : null}
        {feedback}
        <PreparePaymentForm
          detail={detail}
          accounts={accounts}
          onPayeeLinked={() => {
            setNotice(t("money.payables.detail.payeeLinked"));
            reload();
          }}
          onPrepared={() => {
            closeSheet();
            onChanged(t("money.payables.detail.prepared"));
          }}
        />
      </Sheet>
    );
  } else if (sheet?.kind === "installment") {
    const inst = detail.installments.find((i) => i.id === sheet.id);
    if (inst) {
      sheetNode = (
        <Sheet
          title={t("money.payables.detail.installmentHead", { sequence: inst.sequence, date: formatDate(inst.dueAt, locale) })}
          onClose={closeSheet}
          testId="sheet-installment"
        >
          {feedback}
          <InstallmentDetail
            inst={inst}
            currency={detail.currency}
            payable={payable.some((p) => p.id === inst.id)}
            onPay={() => openSheet({ kind: "record", preselect: inst.id })}
            onReverse={(allocationId) =>
              run(() => reverseAllocation(allocationId, "תוקן על ידי בעל העסק"), t("money.payables.detail.allocationReversed"))
            }
            onCancel={(installmentId) =>
              run(() => cancelInstallment(installmentId, "בוטל על ידי בעל העסק"), t("money.payables.detail.installmentCancelled"))
            }
          />
        </Sheet>
      );
    }
  } else if (sheet?.kind === "details") {
    sheetNode = (
      <Sheet title="פרטי ההתחייבות" onClose={closeSheet} testId="sheet-details">
        {feedback}
        <FactsList detail={detail} current={hero.installment} />
        <NoteAndLegacy detail={detail} />
        <h3 className={s.groupTitle}>{t("money.payables.detail.paymentsTitle")}</h3>
        <PaymentsList detail={detail} run={run} />
        <h3 className={s.groupTitle}>היסטוריה</h3>
        <HistoryList detail={detail} />
      </Sheet>
    );
  } else if (sheet?.kind === "manage") {
    sheetNode = (
      <Sheet title="ניהול ההתחייבות" onClose={closeSheet} testId="sheet-manage">
        {feedback}
        {manage}
      </Sheet>
    );
  }

  /* ───────────── compositions ───────────── */

  if (layout === "desktop") {
    return (
      <div ref={rootRef} className={s.root} style={DETAIL_THEME} data-layout="desktop" data-testid="detail">
        <header className={s.deskHead}>
          <BackButton />
          <Identity detail={detail} icon={view.icon} size="lg" />
          <div className={s.deskHeadActions}>{actions}</div>
        </header>
        {!sheet && feedback}
        <div className={s.deskGrid}>
          <div className={s.deskMain}>
            <HeroBox detail={detail} hero={hero} />
            <ProgressLine detail={detail} />
            {recurringLine}
            {strips}
            <ScheduleTable {...scheduleProps} />
            <div className={s.foldPair}>
              <details className={s.panelFold} data-testid="fold-payments">
                <summary>
                  {t("money.payables.detail.paymentsTitle")} <span className={s.count}>({detail.payments.length})</span>
                </summary>
                <PaymentsList detail={detail} run={run} />
              </details>
              <details className={s.panelFold} data-testid="fold-history">
                <summary>
                  היסטוריה <span className={s.count}>({detail.audit.length})</span>
                </summary>
                <HistoryList detail={detail} />
              </details>
            </div>
          </div>
          <aside className={s.deskSide} aria-label="פרטים וניהול">
            <section className={s.panel} aria-labelledby="cd-details-title" data-testid="panel-details">
              <h2 id="cd-details-title" className={s.panelTitle}>
                <span className={`${s.navIcon} ${s.navIconGreen} ${s.navIconSm}`}>
                  <Icon name="doc" size={18} />
                </span>
                פרטי ההתחייבות
              </h2>
              <FactsList detail={detail} current={hero.installment} />
              <NoteAndLegacy detail={detail} />
            </section>
            <section className={s.panel} id="cd-manage" aria-labelledby="cd-manage-title" data-testid="panel-manage">
              <h2 id="cd-manage-title" className={s.panelTitle}>
                <span className={`${s.navIcon} ${s.navIconRed} ${s.navIconSm}`}>
                  <Icon name="gear" size={18} />
                </span>
                ניהול ההתחייבות
              </h2>
              {manage}
            </section>
          </aside>
        </div>
        {sheetNode}
      </div>
    );
  }

  if (layout === "tablet") {
    return (
      <div ref={rootRef} className={s.root} style={DETAIL_THEME} data-layout="tablet" data-testid="detail">
        <div className={s.topbar}>
          <BackButton />
        </div>
        <div className={s.tabGrid}>
          <div className={s.col}>
            <Identity detail={detail} icon={view.icon} />
            <HeroBox detail={detail} hero={hero} />
            <ProgressLine detail={detail} />
            {recurringLine}
            {!sheet && feedback}
            {actions}
            {strips}
            {navRows}
          </div>
          <div className={s.col}>
            <ScheduleList {...scheduleProps} />
          </div>
        </div>
        {sheetNode}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={s.root} style={DETAIL_THEME} data-layout="mobile" data-testid="detail">
      <div className={s.topbar}>
        <BackButton />
      </div>
      <div className={s.col}>
        <Identity detail={detail} icon={view.icon} />
        <HeroBox detail={detail} hero={hero} />
        <ProgressLine detail={detail} />
        {recurringLine}
        {!sheet && feedback}
        {actions}
        {strips}
        <ScheduleList {...scheduleProps} />
        {navRows}
      </div>
      {sheetNode}
    </div>
  );
}
