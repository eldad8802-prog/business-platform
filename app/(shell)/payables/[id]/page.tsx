"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import BackButton from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";
import {
  methodLabel,
  scheduleLabel,
  stateLabel,
  cancelInstallment,
  fetchBankAccounts,
  fetchCheques,
  fetchOutboundProviders,
  fetchPreparations,
  fetchCommitment,
  formatDate,
  formatMoney,
  recordPayment,
  reverseAllocation,
  voidPayment,
  type BankAccountApi,
  type ChequeApi,
  type PreparationApi,
  type CommitmentDetailApi,
  type DerivedState,
  type InstallmentApi,
} from "@/lib/payables/payables-client";
import { PAYABLES_THEME } from "../payables-theme";
import { ChequeCard, ChequeForm } from "../cheque-parts";
import { PreparationCard, PreparePaymentForm } from "../prepare-parts";
import styles from "../payables.module.css";
import { RecurringChanges } from "./recurring-changes";

const BADGE_CLASS: Record<DerivedState, string> = {
  OVERDUE: styles.badgeOverdue,
  DUE: styles.badgeDue,
  PARTIALLY_PAID: styles.badgePartial,
  PAID: styles.badgePaid,
  SCHEDULED: styles.badgeQuiet,
  CANCELLED: styles.badgeQuiet,
  SETTLED_LEGACY: styles.badgeQuiet,
};

const METHODS = [
  "BANK_TRANSFER",
  "CASH",
  "CREDIT_CARD",
  "CHECK",
  "DIRECT_DEBIT",
  "STANDING_ORDER",
  "BIT",
  "PAYBOX",
  "OTHER",
] as const;

export default function CommitmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const commitmentId = Number(id);
  const { t, locale } = useI18n();

  const [detail, setDetail] = useState<CommitmentDetailApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cheques, setCheques] = useState<ChequeApi[]>([]);
  const [accounts, setAccounts] = useState<BankAccountApi[]>([]);
  const [showChequeForm, setShowChequeForm] = useState(false);
  const [preparations, setPreparations] = useState<PreparationApi[]>([]);
  const [providersLive, setProvidersLive] = useState(false);
  const [showPrepare, setShowPrepare] = useState(false);

  // Every setState for the fetch lives inside the effect, so a response for a
  // commitment the owner has already navigated away from cannot land on the
  // new one. `reloadToken` is how an action asks for fresh data.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

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

  if (error && !detail) {
    return (
      <div className={styles.page} style={PAYABLES_THEME}>
        <div className={styles.backRow}>
          <BackButton />
        </div>
        <div className={styles.error}>{error}</div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className={styles.page} style={PAYABLES_THEME}>
        <div className={styles.backRow}>
          <BackButton />
        </div>
        <div className={styles.empty}>{t("money.common.loading")}</div>
      </div>
    );
  }

  const surplusPayments = detail.payments.filter(
    (p) => p.status === "RECORDED" && Number(p.unallocated) > 0,
  );

  return (
    <div className={styles.page} style={PAYABLES_THEME}>
      <div className={styles.backRow}>
        <BackButton />
      </div>

      <header className={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h1 className={styles.title}>{detail.title}</h1>
          <p className={styles.payee}>{detail.payeeNameSnapshot}</p>
        </div>
        <span className={styles.badges}>
          <span className={`${styles.badge} ${styles.badgeQuiet}`}>
            {scheduleLabel(t, detail.scheduleKind)}
          </span>
          {detail.isLegacy && (
            <span className={`${styles.badge} ${styles.badgeQuiet}`}>
              {t("money.payables.list.legacyBadge")}
            </span>
          )}
        </span>
      </header>

      <div className={styles.figures}>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{t("money.payables.detail.totalAmount")}</span>
          <span className={styles.figureValue}>
            {detail.total === null ? "—" : formatMoney(detail.total, detail.currency, locale)}
          </span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{t("money.payables.list.paid")}</span>
          <span className={styles.figureValue}>
            {formatMoney(detail.paid, detail.currency, locale)}
          </span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{t("money.payables.list.remaining")}</span>
          <span className={styles.figureValue}>
            {detail.remaining === null
              ? "—"
              : formatMoney(detail.remaining, detail.currency, locale)}
          </span>
        </span>
      </div>

      {detail.scheduleKind === "RECURRING" && (
        <div className={styles.notice}>
          {t("money.payables.detail.recurringNotice")}
        </div>
      )}

      {detail.scheduleKind === "RECURRING" && detail.status === "ACTIVE" && (
        <RecurringChanges commitmentId={detail.id} endAt={detail.endAt} run={run} />
      )}

      {!providersLive ? (
        <p className={styles.subtitle}>
          {t("money.payables.detail.noProvider")}
        </p>
      ) : null}

      {/* The legacy assertion, stated as an assertion. It must not read as a
          payment: nothing was ever observed, and no amount was recorded. */}
      {detail.legacy && (
        <div className={styles.legacyNote}>
          {t("money.payables.detail.legacyMarked")}
          {detail.legacy.metAt ? ` ${t("money.payables.detail.legacyOnDate", { date: formatDate(detail.legacy.metAt, locale) })}` : ""}
          {detail.legacy.assertedBy ? ` ${t("money.payables.detail.legacyBy", { who: detail.legacy.assertedBy })}` : ""}. {t("money.payables.detail.legacyExplain")}
        </div>
      )}

      {notice && <div className={styles.notice}>{notice}</div>}
      {error && <div className={styles.error}>{error}</div>}

      {surplusPayments.length > 0 && (
        <div className={styles.notice}>
          {surplusPayments.map((p) => (
            <div key={p.id}>
              {t("money.payables.detail.surplusBefore", { date: formatDate(p.paidAt, locale) })}{" "}
              <strong>{formatMoney(p.unallocated, detail.currency, locale)}</strong> {t("money.payables.detail.surplusAfter")}
            </div>
          ))}
        </div>
      )}

      <div className={styles.payDesk}>
      <div>
      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>{t("money.payables.detail.prepareTitle")}</h2>
        {detail.status === "ACTIVE" && (
          <div className={styles.toolbar}>
            <button
              type="button"
              className={styles.buttonPrimary}
              onClick={() => setShowPrepare((v) => !v)}
              aria-expanded={showPrepare}
            >
              {showPrepare ? t("money.common.close") : t("money.payables.detail.prepareTitle")}
            </button>
          </div>
        )}
      </div>
      {showPrepare && (
        <PreparePaymentForm
          detail={detail}
          accounts={accounts}
          onPayeeLinked={() => {
            setNotice(t("money.payables.detail.payeeLinked"));
            reload();
          }}
          onPrepared={() => {
            setShowPrepare(false);
            setNotice(t("money.payables.detail.prepared"));
            reload();
          }}
        />
      )}
      {preparations.length > 0 && (
        <div className={styles.timeline}>
          {preparations.map((p) => (
            <PreparationCard
              key={p.id}
              prep={p}
              providersLive={providersLive}
              onChanged={(message) => {
                setNotice(message);
                reload();
              }}
            />
          ))}
        </div>
      )}

      <h2 className={styles.sectionTitle}>{t("money.payables.detail.recordTitle")}</h2>
      <PaymentForm
        detail={detail}
        onDone={(message) => {
          setNotice(message);
          reload();
        }}
      />
      </div>
      <div>

      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>{t("money.payables.detail.chequesTitle")}</h2>
        {detail.status === "ACTIVE" && (
          <div className={styles.toolbar}>
            <button
              type="button"
              className={styles.buttonQuiet}
              onClick={() => setShowChequeForm((v) => !v)}
              aria-expanded={showChequeForm}
            >
              {showChequeForm ? t("money.common.close") : t("money.payables.detail.recordCheque")}
            </button>
          </div>
        )}
      </div>
      {showChequeForm && (
        <ChequeForm
          accounts={accounts}
          commitmentId={detail.id}
          installments={detail.installments}
          onCreated={(c) => {
            setShowChequeForm(false);
            setNotice(t("money.payables.detail.chequeRecorded", { number: c.chequeNumber }));
            reload();
          }}
        />
      )}
      {cheques.length === 0 ? (
        !showChequeForm && (
          <div className={styles.empty}>{t("money.payables.detail.noCheques")}</div>
        )
      ) : (
        <div className={styles.timeline}>
          {cheques.map((c) => (
            <ChequeCard
              key={c.id}
              cheque={c}
              accounts={accounts}
              showCommitment={false}
              onChanged={(message) => {
                setNotice(message);
                reload();
              }}
            />
          ))}
        </div>
      )}

      <h2 className={styles.sectionTitle}>{t("money.payables.detail.scheduleTitle")}</h2>
      <div className={styles.timeline}>
        {detail.installments.map((inst) => (
          <InstallmentRow
            key={inst.id}
            inst={inst}
            currency={detail.currency}
            onReverse={(allocationId) =>
              run(
                () => reverseAllocation(allocationId, "תוקן על ידי בעל העסק"),
                t("money.payables.detail.allocationReversed"),
              )
            }
            onCancel={(installmentId) =>
              run(
                () => cancelInstallment(installmentId, "בוטל על ידי בעל העסק"),
                t("money.payables.detail.installmentCancelled"),
              )
            }
          />
        ))}
      </div>

      {detail.payments.length > 0 && (
        <>
          <h2 className={styles.sectionTitle}>{t("money.payables.detail.paymentsTitle")}</h2>
          <div className={styles.timeline}>
            {detail.payments.map((p) => (
              <div key={p.id} className={styles.installment}>
                <div className={styles.installmentHead}>
                  <span className={styles.installmentSeq}>
                    {formatMoney(p.amount, detail.currency, locale)} ·{" "}
                    {methodLabel(t, p.method) ?? p.method}
                  </span>
                  <span className={styles.badges}>
                    {p.status === "VOID" ? (
                      <span className={`${styles.badge} ${styles.badgeQuiet}`}>
                        {t("money.payables.detail.voidBadge")}
                      </span>
                    ) : (
                      <span className={`${styles.badge} ${styles.badgePaid}`}>
                        {t("money.payables.detail.recordedBadge")}
                      </span>
                    )}
                  </span>
                </div>
                <span className={styles.nextLine}>
                  {t("money.payables.detail.paymentLine", {
                    date: formatDate(p.paidAt, locale),
                    allocated: formatMoney(p.allocated, detail.currency, locale),
                    unallocated: formatMoney(p.unallocated, detail.currency, locale),
                  })}
                  {p.externalReference ? ` · ${t("money.payables.detail.referenceN", { reference: p.externalReference })}` : ""}
                </span>
                {p.status === "RECORDED" && (
                  <div className={styles.formActions}>
                    <button
                      type="button"
                      className={styles.buttonQuiet}
                      onClick={() => {
                        if (
                          window.confirm(
                            t("money.payables.detail.voidConfirm"),
                          )
                        ) {
                          run(
                            () => voidPayment(p.id, "בוטל על ידי בעל העסק"),
                            t("money.payables.detail.voided"),
                          );
                        }
                      }}
                    >
                      {t("money.payables.detail.voidPayment")}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {detail.audit.length > 0 && (
        <>
          <h2 className={styles.sectionTitle}>{t("money.payables.detail.auditTitle")}</h2>
          <div className={styles.auditList}>
            {detail.audit.map((a) => (
              <div key={a.id} className={styles.auditRow}>
                <span>{a.summary ?? a.eventType}</span>
                <span>{formatDate(a.occurredAt, locale)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      </div>
      </div>
    </div>
  );
}

function InstallmentRow({
  inst,
  currency,
  onReverse,
  onCancel,
}: {
  inst: InstallmentApi;
  currency: string;
  onReverse: (allocationId: number) => void;
  onCancel: (installmentId: number) => void;
}) {
  const { t, locale } = useI18n();
  const hasActive = inst.allocations.some((a) => a.active);
  const cancellable =
    inst.status === "SCHEDULED" && !hasActive && Number(inst.paid) === 0;

  return (
    <div className={styles.installment}>
      <div className={styles.installmentHead}>
        <span className={styles.installmentSeq}>
          {t("money.payables.detail.installmentHead", { sequence: inst.sequence, date: formatDate(inst.dueAt, locale) })}
        </span>
        <span className={styles.badges}>
          <span className={`${styles.badge} ${BADGE_CLASS[inst.state]}`}>
            {stateLabel(t, inst.state)}
          </span>
        </span>
      </div>

      <div className={styles.figures}>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{t("money.payables.detail.due")}</span>
          <span className={styles.figureValue}>
            {formatMoney(inst.scheduled, currency, locale)}
          </span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{t("money.payables.list.paid")}</span>
          <span className={styles.figureValue}>
            {formatMoney(inst.paid, currency, locale)}
          </span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{t("money.payables.list.remaining")}</span>
          <span className={styles.figureValue}>
            {formatMoney(inst.remaining, currency, locale)}
          </span>
        </span>
      </div>

      {inst.state === "SETTLED_LEGACY" && (
        <span className={styles.nextLine}>
          {t("money.payables.detail.settledLegacy")}
        </span>
      )}

      {inst.allocations.map((a) => (
        <div
          key={a.id}
          className={a.active ? styles.allocation : styles.allocationReversed}
        >
          <span>
            {formatMoney(a.amount, currency, locale)} · {methodLabel(t, a.paymentMethod) ?? a.paymentMethod} ·{" "}
            {formatDate(a.paymentPaidAt, locale)}
            {a.reversedAt ? ` · ${t("money.payables.detail.allocReversedTag")}${a.reversalReason ? ` (${a.reversalReason})` : ""}` : ""}
            {!a.reversedAt && a.paymentStatus === "VOID" ? ` · ${t("money.payables.detail.allocPaymentVoided")}` : ""}
          </span>
          {a.active && (
            <button
              type="button"
              className={styles.buttonQuiet}
              onClick={() => onReverse(a.id)}
            >
              {t("money.payables.detail.reverseAllocation")}
            </button>
          )}
        </div>
      ))}

      {cancellable && (
        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.buttonQuiet}
            onClick={() => onCancel(inst.id)}
          >
            {t("money.payables.detail.cancelInstallment")}
          </button>
        </div>
      )}
      {inst.status === "SCHEDULED" && hasActive && (
        <span className={styles.nextLine}>
          {t("money.payables.detail.cannotCancel")}
        </span>
      )}
    </div>
  );
}

/* ───────────────────────────── record a payment ──────────────────────────── */

function PaymentForm({
  detail,
  onDone,
}: {
  detail: CommitmentDetailApi;
  onDone: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const open = useMemo(
    () =>
      detail.installments.filter(
        (i) => Number(i.remaining) > 0 && i.status === "SCHEDULED",
      ),
    [detail.installments],
  );

  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<string>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  // Arriving from a Dubiz recommendation (`?pay=<installmentId>`): that open installment is preselected and
  // the form scrolled into view. Only the selection; the amount and date are what the owner actually paid.
  const [selected, setSelected] = useState<number[]>(() => {
    if (typeof window === "undefined") return [];
    const pay = Number(new URLSearchParams(window.location.search).get("pay"));
    return Number.isInteger(pay) && pay > 0 && open.some((i) => i.id === pay) ? [pay] : [];
  });
  const [arrivedToPay] = useState(() => selected.length > 0);
  useEffect(() => {
    if (arrivedToPay) document.getElementById("pm-amount")?.scrollIntoView({ block: "center" });
  }, [arrivedToPay]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh key per mounted form. A double submit — the classic impatient
  // second tap — is then a retry of the SAME logical payment rather than a
  // second economic event.
  const [idempotencyKey] = useState(
    () => `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  if (open.length === 0) {
    return (
      <div className={styles.empty}>
        {t("money.payables.detail.noOpenInstallments")}
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await recordPayment({
        commitmentId: detail.id,
        amount,
        paidAt: new Date(paidAt).toISOString(),
        method,
        externalReference: reference.trim() || null,
        installmentIds: selected.length > 0 ? selected : null,
        idempotencyKey,
      });

      if (result.replayed) {
        onDone(t("money.payables.detail.replayed"));
        return;
      }
      const surplus = Number(result.unallocated ?? "0");
      onDone(
        surplus > 0
          ? t("money.payables.detail.recordedUnallocated", { amount: formatMoney(String(surplus), detail.currency, locale) })
          : t("money.payables.detail.recordedFull"),
      );
      setAmount("");
      setSelected([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("money.payables.detail.recordFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-amount">
            {t("money.payables.detail.amountPaid")}
          </label>
          <input
            id="pm-amount"
            className={styles.input}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1200.00"
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-date">
            {t("money.payables.detail.paidAt")}
          </label>
          <input
            id="pm-date"
            className={styles.input}
            type="date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            required
          />
        </div>
      </div>

      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-method">
            {t("money.payables.prepare.form.method")}
          </label>
          <select
            id="pm-method"
            className={styles.select}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {methodLabel(t, m) ?? m}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-ref">
            {t("money.payables.detail.referenceOptional")}
          </label>
          <input
            id="pm-ref"
            className={styles.input}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <legend className={styles.label}>
          {t("money.payables.detail.allocateLegend")}
        </legend>
        {open.map((inst) => (
          <label key={inst.id} className={styles.checkboxRow}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={selected.includes(inst.id)}
              onChange={(e) =>
                setSelected((prev) =>
                  e.target.checked
                    ? [...prev, inst.id]
                    : prev.filter((x) => x !== inst.id),
                )
              }
            />
            <span>
              {t("money.payables.cheques.form.installmentOption", {
                sequence: inst.sequence,
                date: formatDate(inst.dueAt, locale),
                amount: formatMoney(inst.remaining, detail.currency, locale),
              })}
            </span>
          </label>
        ))}
      </fieldset>

      <div className={styles.notice}>
        {t("money.payables.detail.overpayNotice")}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy}>
          {busy ? t("money.common.recording") : t("money.payables.detail.submit")}
        </button>
      </div>
    </form>
  );
}
