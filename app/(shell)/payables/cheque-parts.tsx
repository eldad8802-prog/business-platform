"use client";

import { useState } from "react";
import Link from "next/link";
import { useI18n } from "@/components/i18n/I18nProvider";
import {
  chequeAdvanceLabel,
  chequeStatusLabel,
  advanceCheque,
  archiveBankAccount,
  bounceCheque,
  cancelCheque,
  clearCheque,
  createBankAccount,
  createCheque,
  formatDate,
  formatMoney,
  replaceCheque,
  setDefaultBankAccount,
  type BankAccountApi,
  type ChequeApi,
  type ChequeStatus,
  type InstallmentApi,
} from "@/lib/payables/payables-client";
import styles from "./payables.module.css";

/** Today in the OWNER's calendar — a UTC date is yesterday before 03:00 in Israel. */
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toIso(date: string): string {
  return new Date(`${date}T12:00:00`).toISOString();
}

const STATUS_BADGE: Record<ChequeStatus, string> = {
  PLANNED: styles.badgeQuiet,
  ISSUED: styles.badgeDue,
  DELIVERED: styles.badgeDue,
  PRESENTED: styles.badgePartial,
  CLEARED: styles.badgePaid,
  BOUNCED: styles.badgeOverdue,
  CANCELLED: styles.badgeQuiet,
  REPLACED: styles.badgeQuiet,
};

/* ───────────────────────────── bank accounts ───────────────────────────── */

export function BankAccountsSection({
  accounts,
  configured,
  onChanged,
}: {
  accounts: BankAccountApi[];
  configured: boolean;
  onChanged: (message: string) => void;
}) {
  const { t } = useI18n();
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>, message: string) {
    setError(null);
    try {
      await action();
      onChanged(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("money.common.actionFailed"));
    }
  }

  return (
    <>
      {!configured && (
        <div className={styles.notice}>
          {t("money.payables.cheques.accounts.notConfigured")}
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}

      {accounts.length === 0 ? (
        <div className={styles.empty}>
          {t("money.payables.cheques.accounts.empty")}
        </div>
      ) : (
        <div className={styles.timeline}>
          {accounts.map((a) => (
            <div key={a.id} className={styles.installment}>
              <div className={styles.installmentHead}>
                <span className={styles.installmentSeq}>
                  {a.label} · <bdi dir="ltr">{a.masked}</bdi>
                </span>
                <span className={styles.badges}>
                  {a.isDefault && (
                    <span className={`${styles.badge} ${styles.badgePaid}`}>{t("money.payables.cheques.accounts.defaultBadge")}</span>
                  )}
                  {!a.isActive && (
                    <span className={`${styles.badge} ${styles.badgeQuiet}`}>{t("money.payables.cheques.accounts.archivedBadge")}</span>
                  )}
                </span>
              </div>
              {a.isActive && (
                <div className={styles.formActions}>
                  {!a.isDefault && (
                    <button
                      type="button"
                      className={styles.buttonQuiet}
                      onClick={() => run(() => setDefaultBankAccount(a.id), t("money.payables.cheques.accounts.setDefaultDone"))}
                    >
                      {t("money.payables.cheques.accounts.setDefault")}
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.buttonQuiet}
                    onClick={() => {
                      if (
                        window.confirm(
                          t("money.payables.cheques.accounts.archiveConfirm"),
                        )
                      ) {
                        run(() => archiveBankAccount(a.id), t("money.payables.cheques.accounts.archiveDone"));
                      }
                    }}
                  >
                    {t("money.payables.cheques.accounts.archive")}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {configured && (
        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.buttonQuiet}
            onClick={() => setShowForm((v) => !v)}
            aria-expanded={showForm}
          >
            {showForm ? t("money.common.close") : t("money.payables.cheques.accounts.add")}
          </button>
        </div>
      )}
      {configured && showForm && (
        <BankAccountForm
          onCreated={(message) => {
            setShowForm(false);
            onChanged(message);
          }}
        />
      )}
    </>
  );
}

/**
 * The only form in the product that holds full bank coordinates. They live in
 * component state just long enough to be sent, are cleared on success, and are
 * text inputs throughout — a number input would drop leading zeros.
 */
function BankAccountForm({ onCreated }: { onCreated: (message: string) => void }) {
  const { t } = useI18n();
  const [label, setLabel] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [branchCode, setBranchCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createBankAccount({ label, bankCode, branchCode, accountNumber, isDefault });
      setBankCode("");
      setBranchCode("");
      setAccountNumber("");
      setLabel("");
      onCreated(
        result.restored
          ? t("money.payables.cheques.accounts.restored", { masked: result.account.masked })
          : t("money.payables.cheques.accounts.added", { masked: result.account.masked }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("money.payables.cheques.accounts.addFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} autoComplete="off">
      <div className={styles.field}>
        <label className={styles.label} htmlFor="ba-label">
          {t("money.payables.cheques.accounts.name")}
        </label>
        <input
          id="ba-label"
          className={styles.input}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("money.payables.cheques.accounts.namePlaceholder")}
          maxLength={80}
          required
        />
      </div>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ba-bank">
            {t("money.payables.cheques.accounts.bankCode")}
          </label>
          <input
            id="ba-bank"
            className={styles.input}
            inputMode="numeric"
            dir="ltr"
            value={bankCode}
            onChange={(e) => setBankCode(e.target.value)}
            maxLength={2}
            pattern="[0-9]{2}"
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ba-branch">
            {t("money.payables.cheques.accounts.branchCode")}
          </label>
          <input
            id="ba-branch"
            className={styles.input}
            inputMode="numeric"
            dir="ltr"
            value={branchCode}
            onChange={(e) => setBranchCode(e.target.value)}
            maxLength={3}
            pattern="[0-9]{3}"
            required
          />
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="ba-account">
          {t("money.payables.cheques.accounts.accountNumber")}
        </label>
        <input
          id="ba-account"
          className={styles.input}
          inputMode="numeric"
          dir="ltr"
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          maxLength={20}
          required
        />
      </div>
      <label className={styles.checkboxRow}>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        <span>{t("money.payables.cheques.accounts.defaultForCheques")}</span>
      </label>
      <div className={styles.notice}>
        {t("money.payables.cheques.accounts.encryptedNote")}
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy}>
          {busy ? t("money.common.saving") : t("money.payables.cheques.accounts.save")}
        </button>
      </div>
    </form>
  );
}

/* ─────────────────────────────── cheque form ────────────────────────────── */

/**
 * Record a cheque. The number is typed, never suggested: the product does not
 * know which chequebook is in the drawer, and "the next number" is arithmetic
 * over paper it has never seen.
 */
export function ChequeForm({
  accounts,
  commitmentId,
  installments,
  onCreated,
}: {
  accounts: BankAccountApi[];
  commitmentId?: number;
  installments?: InstallmentApi[];
  onCreated: (cheque: ChequeApi) => void;
}) {
  const { t, locale } = useI18n();
  const active = accounts.filter((a) => a.isActive);
  const defaultAccount = active.find((a) => a.isDefault) ?? active[0];
  const openInstallments = (installments ?? []).filter(
    (i) => i.status === "SCHEDULED" && Number(i.remaining) > 0,
  );

  const [chequeNumber, setChequeNumber] = useState("");
  const [amount, setAmount] = useState(openInstallments[0]?.remaining ?? "");
  const [payeeName, setPayeeName] = useState("");
  const [issueDate, setIssueDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState(
    openInstallments[0]?.dueAt ? openInstallments[0].dueAt.slice(0, 10) : todayISO(),
  );
  const [accountId, setAccountId] = useState<number | null>(defaultAccount?.id ?? null);
  const [installmentId, setInstallmentId] = useState<number | null>(openInstallments[0]?.id ?? null);
  const [written, setWritten] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (active.length === 0) {
    return (
      <div className={styles.empty}>
        {t("money.payables.cheques.form.noAccountBefore")}
        <Link href="/payables/cheques">{t("money.payables.list.chequesAndAccounts")}</Link>
        {t("money.payables.cheques.form.noAccountAfter")}
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId) return;
    setBusy(true);
    setError(null);
    try {
      const cheque = await createCheque({
        chequeNumber,
        amount,
        issueDate: toIso(issueDate),
        dueDate: toIso(dueDate),
        sourceBankAccountId: accountId,
        commitmentId: commitmentId ?? null,
        installmentId: commitmentId ? installmentId : null,
        payeeName: commitmentId ? null : payeeName.trim() || null,
        status: written ? "ISSUED" : "PLANNED",
      });
      setChequeNumber("");
      onCreated(cheque);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("money.payables.cheques.form.recordFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cq-number">
            {t("money.payables.cheques.form.chequeNumber")}
          </label>
          <input
            id="cq-number"
            className={styles.input}
            dir="ltr"
            value={chequeNumber}
            onChange={(e) => setChequeNumber(e.target.value)}
            maxLength={32}
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cq-amount">
            {t("money.common.amount")}
          </label>
          <input
            id="cq-amount"
            className={styles.input}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1200.00"
            required
          />
        </div>
      </div>

      {!commitmentId && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cq-payee">
            {t("money.payables.cheques.form.payTo")}
          </label>
          <input
            id="cq-payee"
            className={styles.input}
            value={payeeName}
            onChange={(e) => setPayeeName(e.target.value)}
            required
          />
        </div>
      )}

      {commitmentId && openInstallments.length > 0 && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cq-inst">
            {t("money.payables.cheques.form.forInstallment")}
          </label>
          <select
            id="cq-inst"
            className={styles.select}
            value={installmentId ?? ""}
            onChange={(e) => setInstallmentId(e.target.value ? Number(e.target.value) : null)}
          >
            {openInstallments.map((i) => (
              <option key={i.id} value={i.id}>
                {t("money.payables.cheques.form.installmentOption", {
                  sequence: i.sequence,
                  date: formatDate(i.dueAt, locale),
                  amount: formatMoney(i.remaining, undefined, locale),
                })}
              </option>
            ))}
            <option value="">{t("money.payables.cheques.form.noInstallment")}</option>
          </select>
        </div>
      )}

      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cq-issue">
            {t("money.payables.cheques.form.issueDate")}
          </label>
          <input
            id="cq-issue"
            className={styles.input}
            type="date"
            value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cq-due">
            {t("money.payables.cheques.form.dueDate")}
          </label>
          <input
            id="cq-due"
            className={styles.input}
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            required
          />
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="cq-account">
          {t("money.payables.cheques.form.fromAccount")}
        </label>
        <select
          id="cq-account"
          className={styles.select}
          value={accountId ?? ""}
          onChange={(e) => setAccountId(Number(e.target.value))}
        >
          {active.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} · {a.masked}
            </option>
          ))}
        </select>
      </div>

      <label className={styles.checkboxRow}>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={written}
          onChange={(e) => setWritten(e.target.checked)}
        />
        <span>{t("money.payables.cheques.form.alreadyWritten")}</span>
      </label>

      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy}>
          {busy ? t("money.common.recording") : t("money.payables.cheques.form.submit")}
        </button>
      </div>
    </form>
  );
}

/* ─────────────────────────────── cheque card ────────────────────────────── */

export function ChequeCard({
  cheque,
  accounts,
  onChanged,
  showCommitment = true,
}: {
  cheque: ChequeApi;
  accounts: BankAccountApi[];
  onChanged: (message: string) => void;
  showCommitment?: boolean;
}) {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<"idle" | "clear" | "replace">("idle");
  const [clearedAt, setClearedAt] = useState(todayISO());
  const [newNumber, setNewNumber] = useState("");
  const [newIssue, setNewIssue] = useState(todayISO());
  const [newDue, setNewDue] = useState(cheque.dueDate.slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      const message = await action();
      setMode("idle");
      onChanged(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("money.common.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const a = cheque.actions;
  const activeAccounts = accounts.filter((x) => x.isActive);

  return (
    <div className={styles.installment}>
      <div className={styles.installmentHead}>
        <span className={styles.installmentSeq}>
          {t("money.payables.cheques.card.chequeWord")} <bdi dir="ltr">#{cheque.chequeNumber}</bdi> ·{" "}
          {formatMoney(cheque.amount, cheque.currency, locale)}
        </span>
        <span className={styles.badges}>
          <span className={`${styles.badge} ${STATUS_BADGE[cheque.status]}`}>
            {chequeStatusLabel(t, cheque.status)}
          </span>
        </span>
      </div>

      <span className={styles.nextLine}>
        {t("money.payables.cheques.card.meta", {
          payee: cheque.payeeNameSnapshot,
          date: formatDate(cheque.dueDate, locale),
          account: cheque.sourceBankAccount.label,
        })}{" "}
        <bdi dir="ltr">{cheque.sourceBankAccount.masked}</bdi>
      </span>
      {showCommitment && cheque.commitment && (
        <span className={styles.nextLine}>
          {t("money.payables.cheques.card.forWord")} <Link href={`/payables/${cheque.commitment.id}`}>{cheque.commitment.title}</Link>
          {cheque.installment ? ` · ${t("money.payables.cheques.card.installmentN", { sequence: cheque.installment.sequence })}` : ""}
        </span>
      )}

      {cheque.cleared && (
        <span className={styles.nextLine}>
          {cheque.cleared.assertedAt
            ? t("money.payables.cheques.card.clearedOnDate", { date: formatDate(cheque.cleared.assertedAt, locale) })
            : t("money.payables.cheques.card.clearedNoDate")}
          {cheque.payment && cheque.payment.status === "RECORDED" && Number(cheque.payment.unallocated) > 0
            ? ` ${t("money.payables.cheques.card.unallocatedNote", { amount: formatMoney(cheque.payment.unallocated, cheque.currency, locale) })}`
            : ""}
        </span>
      )}
      {cheque.status === "BOUNCED" && cheque.payment?.status === "VOID" && (
        <span className={styles.nextLine}>
          {t("money.payables.cheques.card.bouncedAfterClear")}
        </span>
      )}
      {cheque.replaces && (
        <span className={styles.nextLine}>
          {t("money.payables.cheques.card.replaces")} <bdi dir="ltr">#{cheque.replaces.chequeNumber}</bdi>
        </span>
      )}
      {cheque.replacedBy && (
        <span className={styles.nextLine}>
          {t("money.payables.cheques.card.replacedBy")} <bdi dir="ltr">#{cheque.replacedBy.chequeNumber}</bdi>
        </span>
      )}
      {cheque.cancellationReason && (
        <span className={styles.nextLine}>{t("money.payables.cheques.card.reason", { reason: cheque.cancellationReason })}</span>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {mode === "idle" && (
        <div className={styles.formActions}>
          {a.advance.map((to) => (
            <button
              key={to}
              type="button"
              className={styles.buttonQuiet}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await advanceCheque(cheque.id, to);
                  return t("money.payables.cheques.card.advanced", { number: cheque.chequeNumber, status: chequeStatusLabel(t, to) });
                })
              }
            >
              {chequeAdvanceLabel(t, to) ?? to}
            </button>
          ))}
          {a.clear && (
            <button type="button" className={styles.buttonQuiet} disabled={busy} onClick={() => setMode("clear")}>
              {t("money.payables.cheques.card.markCleared")}
            </button>
          )}
          {a.bounce && (
            <button
              type="button"
              className={styles.buttonQuiet}
              disabled={busy}
              onClick={() => {
                const note =
                  cheque.status === "CLEARED"
                    ? t("money.payables.cheques.card.bounceConfirmCleared")
                    : t("money.payables.cheques.card.bounceConfirm");
                if (window.confirm(note)) {
                  run(async () => {
                    await bounceCheque(cheque.id, "סומן כחוזר על ידי בעל העסק");
                    return t("money.payables.cheques.card.bounced", { number: cheque.chequeNumber });
                  });
                }
              }}
            >
              {t("money.payables.cheques.card.markBounced")}
            </button>
          )}
          {a.replace && (
            <button type="button" className={styles.buttonQuiet} disabled={busy} onClick={() => setMode("replace")}>
              {t("money.payables.cheques.card.replace")}
            </button>
          )}
          {a.cancel && (
            <button
              type="button"
              className={styles.buttonQuiet}
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("money.payables.cheques.card.cancelConfirm"))) {
                  run(async () => {
                    await cancelCheque(cheque.id, "בוטל על ידי בעל העסק");
                    return t("money.payables.cheques.card.cancelled", { number: cheque.chequeNumber });
                  });
                }
              }}
            >
              {t("money.payables.cheques.card.cancelCheque")}
            </button>
          )}
        </div>
      )}

      {mode === "clear" && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await clearCheque(cheque.id, toIso(clearedAt));
              if (r.replayed) return t("money.payables.cheques.card.clearReplayed");
              return Number(r.unallocated) > 0
                ? t("money.payables.cheques.card.clearedUnallocated", { amount: formatMoney(r.unallocated, cheque.currency, locale) })
                : t("money.payables.cheques.card.clearedDone");
            });
          }}
        >
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`cq-clear-${cheque.id}`}>
              {t("money.payables.cheques.card.whenCleared")}
            </label>
            <input
              id={`cq-clear-${cheque.id}`}
              className={styles.input}
              type="date"
              value={clearedAt}
              min={cheque.issueDate.slice(0, 10)}
              max={todayISO()}
              onChange={(e) => setClearedAt(e.target.value)}
              required
            />
          </div>
          <div className={styles.notice}>
            {t("money.payables.cheques.card.clearNotice")}
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.buttonPrimary} disabled={busy}>
              {busy ? t("money.common.recording") : t("money.payables.cheques.card.confirmCleared")}
            </button>
            <button type="button" className={styles.buttonQuiet} onClick={() => setMode("idle")}>
              {t("money.common.cancel")}
            </button>
          </div>
        </form>
      )}

      {mode === "replace" && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await replaceCheque(cheque.id, {
                chequeNumber: newNumber,
                issueDate: toIso(newIssue),
                dueDate: toIso(newDue),
                sourceBankAccountId: cheque.sourceBankAccount.isActive
                  ? cheque.sourceBankAccount.id
                  : (activeAccounts.find((x) => x.isDefault) ?? activeAccounts[0])?.id ?? null,
                reason: "הוחלף על ידי בעל העסק",
              });
              return t("money.payables.cheques.card.replacedDone", { number: cheque.chequeNumber, newNumber: r.replacement.chequeNumber });
            });
          }}
        >
          <div className={styles.formRow2}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`cq-rep-num-${cheque.id}`}>
                {t("money.payables.cheques.card.newNumber")}
              </label>
              <input
                id={`cq-rep-num-${cheque.id}`}
                className={styles.input}
                dir="ltr"
                value={newNumber}
                onChange={(e) => setNewNumber(e.target.value)}
                maxLength={32}
                required
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`cq-rep-due-${cheque.id}`}>
                {t("money.payables.cheques.form.dueDate")}
              </label>
              <input
                id={`cq-rep-due-${cheque.id}`}
                className={styles.input}
                type="date"
                value={newDue}
                onChange={(e) => setNewDue(e.target.value)}
                required
              />
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`cq-rep-issue-${cheque.id}`}>
              {t("money.payables.cheques.form.issueDate")}
            </label>
            <input
              id={`cq-rep-issue-${cheque.id}`}
              className={styles.input}
              type="date"
              value={newIssue}
              onChange={(e) => setNewIssue(e.target.value)}
              required
            />
          </div>
          <div className={styles.notice}>
            {t("money.payables.cheques.card.replaceNotice")}
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.buttonPrimary} disabled={busy}>
              {busy ? t("money.common.recording") : t("money.payables.cheques.card.replaceSubmit")}
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
