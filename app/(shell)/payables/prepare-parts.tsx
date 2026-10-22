"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";
import {
  completionSourceLabel,
  methodLabel,
  preparationStatusLabel,
  approvePreparation,
  cancelPreparation,
  completePreparation,
  createDestination,
  createPayee,
  fetchDestinations,
  formatDate,
  formatMoney,
  linkCommitmentPayee,
  preparePayment,
  revealDestination,
  type BankAccountApi,
  type CommitmentDetailApi,
  type DestinationApi,
  type PreparationApi,
  type PreparationStatus,
} from "@/lib/payables/payables-client";
import styles from "./payables.module.css";

const METHODS = ["BANK_TRANSFER", "CASH", "CREDIT_CARD", "DIRECT_DEBIT", "STANDING_ORDER", "BIT", "PAYBOX", "OTHER"] as const;

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const toIso = (date: string) => new Date(`${date}T12:00:00`).toISOString();

const STATUS_BADGE: Record<PreparationStatus, string> = {
  PREPARED: styles.badgeDue,
  APPROVED: styles.badgePartial,
  SUBMITTED: styles.badgePartial,
  COMPLETED: styles.badgePaid,
  FAILED: styles.badgeOverdue,
  CANCELLED: styles.badgeQuiet,
};

/** What happens next, in the owner's words. Never implies money moved when it did not. */
function nextStep(t: Translator, p: PreparationApi, providersLive: boolean): string {
  switch (p.status) {
    case "PREPARED":
      return t("money.payables.prepare.next.PREPARED");
    case "APPROVED":
      return providersLive ? t("money.payables.prepare.next.APPROVED_LIVE") : t("money.payables.prepare.next.APPROVED_MANUAL");
    case "SUBMITTED":
      return t("money.payables.prepare.next.SUBMITTED");
    case "FAILED":
      return t("money.payables.prepare.next.FAILED");
    case "COMPLETED":
      return p.completionSource
        ? t("money.payables.prepare.next.COMPLETED_SOURCE", {
            source: completionSourceLabel(t, p.completionSource) ?? p.completionSource,
          })
        : t("money.payables.prepare.next.COMPLETED");
    case "CANCELLED":
      return t("money.payables.prepare.next.CANCELLED");
  }
}

/* ─────────────────────────── the prepared payment ─────────────────────────── */

export function PreparationCard({
  prep,
  providersLive,
  onChanged,
}: {
  prep: PreparationApi;
  providersLive: boolean;
  onChanged: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "complete">("idle");
  const [paidAt, setPaidAt] = useState(todayISO());
  const [ref, setRef] = useState("");
  const [revealed, setRevealed] = useState<{ bankCode: string; branchCode: string; accountNumber: string } | null>(null);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await fn());
      setMode("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("money.common.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const a = prep.actions;
  return (
    <div className={styles.installment}>
      <div className={styles.installmentHead}>
        <span className={styles.installmentSeq}>
          {formatMoney(prep.amount, prep.currency, locale)} · {methodLabel(t, prep.method) ?? prep.method}
        </span>
        <span className={styles.badges}>
          <span className={`${styles.badge} ${STATUS_BADGE[prep.status]}`}>{preparationStatusLabel(t, prep.status)}</span>
        </span>
      </div>

      <dl className={styles.prepGrid}>
        <dt>{t("money.payables.prepare.card.who")}</dt>
        <dd>{prep.payee.name}</dd>
        <dt>{t("money.payables.prepare.card.howMuch")}</dt>
        <dd>{formatMoney(prep.amount, prep.currency, locale)}</dd>
        <dt>{t("money.payables.prepare.card.from")}</dt>
        <dd>{prep.source ? <>{prep.source.label} <bdi dir="ltr">{prep.source.masked}</bdi></> : t("money.payables.prepare.card.noSource")}</dd>
        <dt>{t("money.payables.prepare.card.to")}</dt>
        <dd>
          {prep.destination ? (
            <>
              {prep.destination.beneficiaryName} · {prep.destination.label} <bdi dir="ltr">{prep.destination.masked}</bdi>
              <span className={styles.nextLine}> {t("money.payables.prepare.card.enteredByYou")}</span>
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>{t("money.payables.prepare.card.forWord")}</dt>
        <dd>
          {prep.commitment.title}
          {prep.installment
            ? ` · ${t("money.payables.prepare.card.installmentWithDate", {
                sequence: prep.installment.sequence,
                date: formatDate(prep.installment.dueAt, locale),
              })}`
            : ""}
        </dd>
        {prep.reference && (
          <>
            <dt>{t("money.payables.prepare.card.reference")}</dt>
            <dd>
              <bdi dir="ltr">{prep.reference}</bdi>
            </dd>
          </>
        )}
      </dl>

      <div className={styles.notice}>
        <strong>{t("money.payables.prepare.card.whatNext")} </strong>
        {nextStep(t, prep, providersLive)}
      </div>

      {revealed && (
        <div className={styles.notice} data-testid="revealed-destination">
          {t("money.payables.prepare.card.revealedIntro")} {t("money.payables.prepare.card.bank")} <bdi dir="ltr">{revealed.bankCode}</bdi> ·{" "}
          {t("money.payables.prepare.card.branch")} <bdi dir="ltr">{revealed.branchCode}</bdi> · {t("money.payables.prepare.card.account")}{" "}
          <bdi dir="ltr">{revealed.accountNumber}</bdi> ·{" "}
          {prep.destination?.beneficiaryName}
          <div className={styles.formActions}>
            <button type="button" className={styles.buttonQuiet} onClick={() => setRevealed(null)}>
              {t("money.payables.prepare.card.hide")}
            </button>
          </div>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {mode === "idle" && (
        <div className={styles.formActions}>
          {a.approve && (
            <button
              type="button"
              className={styles.buttonPrimary}
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("money.payables.prepare.card.approveConfirm", { amount: formatMoney(prep.amount, prep.currency, locale), payee: prep.payee.name }))) {
                  run(async () => {
                    await approvePreparation(prep.id);
                    return t("money.payables.prepare.card.approved");
                  });
                }
              }}
            >
              {t("money.payables.prepare.card.approve")}
            </button>
          )}
          {prep.destination && (a.reportCompleted || a.execute) && !revealed && (
            <button
              type="button"
              className={styles.buttonQuiet}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await revealDestination(prep.destination!.id);
                  if (!r.coordinates) throw new Error(t("money.payables.prepare.card.revealUnavailable"));
                  setRevealed(r.coordinates);
                  return t("money.payables.prepare.card.revealedDone");
                })
              }
            >
              {t("money.payables.prepare.card.reveal")}
            </button>
          )}
          {a.reportCompleted && (
            <button type="button" className={styles.buttonQuiet} disabled={busy} onClick={() => setMode("complete")}>
              {t("money.payables.prepare.card.markDone")}
            </button>
          )}
          {a.cancel && (
            <button
              type="button"
              className={styles.buttonQuiet}
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("money.payables.prepare.card.cancelConfirm"))) {
                  run(async () => {
                    await cancelPreparation(prep.id, "בוטל על ידי בעל העסק");
                    return t("money.payables.prepare.card.cancelled");
                  });
                }
              }}
            >
              {t("money.payables.prepare.card.cancel")}
            </button>
          )}
        </div>
      )}
      {a.execute && !providersLive && (
        <span className={styles.nextLine}>{t("money.payables.prepare.card.noAuto")}</span>
      )}

      {mode === "complete" && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await completePreparation(prep.id, toIso(paidAt), ref.trim() || null);
              if (r.replayed) return t("money.payables.prepare.card.completeReplayed");
              return Number(r.unallocated) > 0
                ? t("money.payables.prepare.card.completeUnallocated", { amount: formatMoney(r.unallocated, prep.currency, locale) })
                : t("money.payables.prepare.card.completeDone");
            });
          }}
        >
          <div className={styles.formRow2}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`pp-date-${prep.id}`}>
                {t("money.payables.prepare.card.whenPaid")}
              </label>
              <input id={`pp-date-${prep.id}`} className={styles.input} type="date" value={paidAt} max={todayISO()} onChange={(e) => setPaidAt(e.target.value)} required />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`pp-ref-${prep.id}`}>
                {t("money.payables.prepare.card.transferRef")}
              </label>
              <input id={`pp-ref-${prep.id}`} className={styles.input} dir="ltr" value={ref} maxLength={80} onChange={(e) => setRef(e.target.value)} />
            </div>
          </div>
          <div className={styles.notice}>
            {t("money.payables.prepare.card.completeNotice")}
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.buttonPrimary} disabled={busy}>
              {busy ? t("money.common.recording") : t("money.payables.prepare.card.confirmDone")}
            </button>
            <button type="button" className={styles.buttonQuiet} onClick={() => setMode("idle")}>
              {t("money.common.cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ─────────────────────────── the preparation form ─────────────────────────── */

export function PreparePaymentForm({
  detail,
  accounts,
  onPrepared,
  onPayeeLinked,
}: {
  detail: CommitmentDetailApi;
  accounts: BankAccountApi[];
  onPrepared: (p: PreparationApi) => void;
  onPayeeLinked: () => void;
}) {
  const { t, locale } = useI18n();
  const open = detail.installments.filter((i) => i.status === "SCHEDULED" && Number(i.remaining) > 0);
  const [installmentId, setInstallmentId] = useState<number | null>(open[0]?.id ?? null);
  const [amount, setAmount] = useState(open[0]?.remaining ?? "");
  const [method, setMethod] = useState<string>("BANK_TRANSFER");
  const [destinations, setDestinations] = useState<DestinationApi[] | null>(null);
  const [destinationId, setDestinationId] = useState<number | null>(null);
  const activeAccounts = accounts.filter((a) => a.isActive);
  const [sourceId, setSourceId] = useState<number | null>((activeAccounts.find((a) => a.isDefault) ?? activeAccounts[0])?.id ?? null);
  const [reference, setReference] = useState("");
  const [addingDestination, setAddingDestination] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadDest, setReloadDest] = useState(0);

  useEffect(() => {
    if (!detail.payeeId) return;
    let cancelled = false;
    fetchDestinations(detail.payeeId)
      .then((list) => {
        if (cancelled) return;
        setDestinations(list);
        setDestinationId((cur) => cur ?? (list.find((d) => d.isDefault) ?? list[0])?.id ?? null);
      })
      .catch(() => !cancelled && setDestinations([]));
    return () => {
      cancelled = true;
    };
  }, [detail.payeeId, reloadDest]);

  if (open.length === 0) {
    return <div className={styles.empty}>{t("money.payables.prepare.form.noOpen")}</div>;
  }

  if (!detail.payeeId && method === "BANK_TRANSFER") {
    return (
      <div className={styles.notice}>
        {t("money.payables.prepare.form.needPayee", { name: detail.payeeNameSnapshot })}
        {error && <div className={styles.error}>{error}</div>}
        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const payee = await createPayee({ displayName: detail.payeeNameSnapshot, kind: "SUPPLIER" });
                await linkCommitmentPayee(detail.id, payee.id);
                onPayeeLinked();
              } catch (e) {
                setError(e instanceof Error ? e.message : t("money.common.actionFailed"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("money.payables.prepare.form.registerPayee", { name: detail.payeeNameSnapshot })}
          </button>
          <button type="button" className={styles.buttonQuiet} onClick={() => setMethod("CASH")}>
            {t("money.payables.prepare.form.payOtherWay")}
          </button>
        </div>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await preparePayment({
        commitmentId: detail.id,
        installmentId,
        amount,
        method,
        destinationId: method === "BANK_TRANSFER" ? destinationId : null,
        sourceBankAccountId: sourceId,
        reference: reference.trim() || null,
      });
      onPrepared(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("money.payables.prepare.form.prepareFailed"));
    } finally {
      setBusy(false);
    }
  }

  const activeDest = (destinations ?? []).filter((d) => d.isActive);

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pr-inst">
            {t("money.payables.cheques.form.forInstallment")}
          </label>
          <select
            id="pr-inst"
            className={styles.select}
            value={installmentId ?? ""}
            onChange={(e) => {
              const id = Number(e.target.value);
              setInstallmentId(id);
              setAmount(open.find((i) => i.id === id)?.remaining ?? "");
            }}
          >
            {open.map((i) => (
              <option key={i.id} value={i.id}>
                {t("money.payables.cheques.form.installmentOption", {
                  sequence: i.sequence,
                  date: formatDate(i.dueAt, locale),
                  amount: formatMoney(i.remaining, detail.currency, locale),
                })}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pr-amount">
            {t("money.common.amount")}
          </label>
          <input id="pr-amount" className={styles.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
      </div>

      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pr-method">
            {t("money.payables.prepare.form.method")}
          </label>
          <select id="pr-method" className={styles.select} value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {methodLabel(t, m) ?? m}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pr-source">
            {t("money.payables.prepare.form.sourceOptional")}
          </label>
          <select
            id="pr-source"
            className={styles.select}
            value={sourceId ?? ""}
            onChange={(e) => setSourceId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{t("money.payables.prepare.form.notSpecified")}</option>
            {activeAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} · {a.masked}
              </option>
            ))}
          </select>
        </div>
      </div>

      {method === "BANK_TRANSFER" && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pr-dest">
            {t("money.payables.prepare.form.destFor", { name: detail.payeeNameSnapshot })}
          </label>
          {destinations === null ? (
            <div className={styles.empty}>{t("money.common.loading")}</div>
          ) : activeDest.length === 0 ? (
            <div className={styles.empty}>{t("money.payables.prepare.form.noDest")}</div>
          ) : (
            <select
              id="pr-dest"
              className={styles.select}
              value={destinationId ?? ""}
              onChange={(e) => setDestinationId(Number(e.target.value))}
            >
              {activeDest.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.beneficiaryName} · {d.label} · {d.masked}
                </option>
              ))}
            </select>
          )}
          <div className={styles.formActions}>
            <button type="button" className={styles.buttonQuiet} onClick={() => setAddingDestination((v) => !v)}>
              {addingDestination ? t("money.common.close") : t("money.payables.prepare.form.addDest")}
            </button>
          </div>
        </div>
      )}

      {method === "BANK_TRANSFER" && addingDestination && detail.payeeId && (
        <DestinationForm
          payeeId={detail.payeeId}
          defaultName={detail.payeeNameSnapshot}
          onCreated={(d) => {
            setAddingDestination(false);
            setDestinationId(d.id);
            setReloadDest((n) => n + 1);
          }}
        />
      )}

      <div className={styles.field}>
        <label className={styles.label} htmlFor="pr-ref">
          {t("money.payables.prepare.form.refDetails")}
        </label>
        <input id="pr-ref" className={styles.input} value={reference} maxLength={140} onChange={(e) => setReference(e.target.value)} />
      </div>

      <div className={styles.notice}>
        {t("money.payables.prepare.form.notice")}
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy || (method === "BANK_TRANSFER" && !destinationId)}>
          {busy ? t("money.payables.prepare.form.preparing") : t("money.payables.prepare.form.submit")}
        </button>
      </div>
    </form>
  );
}

/**
 * A payee's destination account. Text inputs throughout (leading zeros), cleared
 * after a successful save, autocomplete off — the same contract as the business
 * bank-account form.
 */
function DestinationForm({
  payeeId,
  defaultName,
  onCreated,
}: {
  payeeId: number;
  defaultName: string;
  onCreated: (d: DestinationApi) => void;
}) {
  const { t } = useI18n();
  const [label, setLabel] = useState(() => t("money.payables.prepare.destination.defaultLabel"));
  const [beneficiaryName, setBeneficiaryName] = useState(defaultName);
  const [bankCode, setBankCode] = useState("");
  const [branchCode, setBranchCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await createDestination({ payeeId, label, beneficiaryName, bankCode, branchCode, accountNumber });
      setBankCode("");
      setBranchCode("");
      setAccountNumber("");
      onCreated(r.destination);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("money.payables.prepare.destination.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.form} data-testid="destination-form">
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="dst-name">
            {t("money.payables.prepare.destination.beneficiary")}
          </label>
          <input id="dst-name" className={styles.input} value={beneficiaryName} maxLength={120} onChange={(e) => setBeneficiaryName(e.target.value)} autoComplete="off" />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="dst-label">
            {t("money.payables.prepare.destination.nickname")}
          </label>
          <input id="dst-label" className={styles.input} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
        </div>
      </div>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="dst-bank">
            {t("money.payables.cheques.accounts.bankCode")}
          </label>
          <input id="dst-bank" className={styles.input} inputMode="numeric" dir="ltr" maxLength={2} value={bankCode} onChange={(e) => setBankCode(e.target.value)} autoComplete="off" />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="dst-branch">
            {t("money.payables.prepare.destination.branch")}
          </label>
          <input id="dst-branch" className={styles.input} inputMode="numeric" dir="ltr" maxLength={3} value={branchCode} onChange={(e) => setBranchCode(e.target.value)} autoComplete="off" />
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="dst-account">
          {t("money.payables.cheques.accounts.accountNumber")}
        </label>
        <input id="dst-account" className={styles.input} inputMode="numeric" dir="ltr" maxLength={20} value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} autoComplete="off" />
      </div>
      <div className={styles.notice}>
        {t("money.payables.prepare.destination.notice")}
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="button" className={styles.buttonPrimary} disabled={busy} onClick={save}>
          {busy ? t("money.common.saving") : t("money.payables.prepare.destination.save")}
        </button>
      </div>
    </div>
  );
}
