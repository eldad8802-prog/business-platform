"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CHEQUE_ADVANCE_LABEL,
  CHEQUE_STATUS_LABEL,
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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
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
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>, message: string) {
    setError(null);
    try {
      await action();
      onChanged(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "הפעולה נכשלה");
    }
  }

  return (
    <>
      {!configured && (
        <div className={styles.notice}>
          שמירת חשבונות בנק עדיין לא הופעלה במערכת. אפשר לצפות בנתונים קיימים, אך לא
          להוסיף חשבון חדש.
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}

      {accounts.length === 0 ? (
        <div className={styles.empty}>
          עוד לא נוסף חשבון בנק. צ׳ק נכתב תמיד מחשבון מסוים, לכן יש להוסיף חשבון לפני
          רישום צ׳ק.
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
                    <span className={`${styles.badge} ${styles.badgePaid}`}>ברירת מחדל</span>
                  )}
                  {!a.isActive && (
                    <span className={`${styles.badge} ${styles.badgeQuiet}`}>בארכיון</span>
                  )}
                </span>
              </div>
              {a.isActive && (
                <div className={styles.formActions}>
                  {!a.isDefault && (
                    <button
                      type="button"
                      className={styles.buttonQuiet}
                      onClick={() => run(() => setDefaultBankAccount(a.id), "החשבון נקבע כברירת מחדל.")}
                    >
                      קבע כברירת מחדל
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.buttonQuiet}
                    onClick={() => {
                      if (
                        window.confirm(
                          "להעביר את החשבון לארכיון? צ׳קים שכבר נכתבו ממנו נשמרים, אך לא ניתן יהיה לכתוב ממנו צ׳קים חדשים.",
                        )
                      ) {
                        run(() => archiveBankAccount(a.id), "החשבון הועבר לארכיון.");
                      }
                    }}
                  >
                    העבר לארכיון
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
            {showForm ? "סגור" : "הוסף חשבון בנק"}
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
          ? `החשבון ${result.account.masked} כבר היה שמור בארכיון, והוחזר לשימוש.`
          : `החשבון ${result.account.masked} נוסף.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "הוספת החשבון נכשלה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} autoComplete="off">
      <div className={styles.field}>
        <label className={styles.label} htmlFor="ba-label">
          שם החשבון
        </label>
        <input
          id="ba-label"
          className={styles.input}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="חשבון העסק הראשי"
          maxLength={80}
          required
        />
      </div>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ba-bank">
            קוד בנק (2 ספרות)
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
            מספר סניף (3 ספרות)
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
          מספר חשבון
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
        <span>חשבון ברירת המחדל לצ׳קים חדשים</span>
      </label>
      <div className={styles.notice}>
        פרטי החשבון נשמרים מוצפנים. אחרי השמירה יוצגו רק ארבע הספרות האחרונות.
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy}>
          {busy ? "שומר…" : "שמור חשבון"}
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
        כדי לרשום צ׳ק יש להוסיף קודם חשבון בנק, בעמוד{" "}
        <Link href="/payables/cheques">צ׳קים וחשבונות בנק</Link>.
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
      setError(err instanceof Error ? err.message : "רישום הצ׳ק נכשל");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cq-number">
            מספר צ׳ק
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
            סכום
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
            לפקודת
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
            עבור תשלום
          </label>
          <select
            id="cq-inst"
            className={styles.select}
            value={installmentId ?? ""}
            onChange={(e) => setInstallmentId(e.target.value ? Number(e.target.value) : null)}
          >
            {openInstallments.map((i) => (
              <option key={i.id} value={i.id}>
                תשלום {i.sequence} · {formatDate(i.dueAt)} · נותר {formatMoney(i.remaining)}
              </option>
            ))}
            <option value="">ללא שיוך לתשלום מסוים</option>
          </select>
        </div>
      )}

      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cq-issue">
            תאריך כתיבה
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
            תאריך פירעון
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
          מחשבון
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
        <span>הצ׳ק כבר נכתב (אחרת יירשם כמתוכנן)</span>
      </label>

      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy}>
          {busy ? "רושם…" : "רשום צ׳ק"}
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
      setError(e instanceof Error ? e.message : "הפעולה נכשלה");
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
          צ׳ק <bdi dir="ltr">#{cheque.chequeNumber}</bdi> · {formatMoney(cheque.amount, cheque.currency)}
        </span>
        <span className={styles.badges}>
          <span className={`${styles.badge} ${STATUS_BADGE[cheque.status]}`}>
            {CHEQUE_STATUS_LABEL[cheque.status]}
          </span>
        </span>
      </div>

      <span className={styles.nextLine}>
        לפקודת {cheque.payeeNameSnapshot} · פירעון {formatDate(cheque.dueDate)} · מחשבון{" "}
        {cheque.sourceBankAccount.label} <bdi dir="ltr">{cheque.sourceBankAccount.masked}</bdi>
      </span>
      {showCommitment && cheque.commitment && (
        <span className={styles.nextLine}>
          עבור <Link href={`/payables/${cheque.commitment.id}`}>{cheque.commitment.title}</Link>
          {cheque.installment ? ` · תשלום ${cheque.installment.sequence}` : ""}
        </span>
      )}

      {cheque.cleared && (
        <span className={styles.nextLine}>
          סומן כנפרע על ידך
          {cheque.cleared.assertedAt ? ` בתאריך ${formatDate(cheque.cleared.assertedAt)}` : ""} — זו
          הצהרה שלך, לא אישור מהבנק.
          {cheque.payment && cheque.payment.status === "RECORDED" && Number(cheque.payment.unallocated) > 0
            ? ` ${formatMoney(cheque.payment.unallocated, cheque.currency)} מהסכום לא שויכו לתשלום.`
            : ""}
        </span>
      )}
      {cheque.status === "BOUNCED" && cheque.payment?.status === "VOID" && (
        <span className={styles.nextLine}>
          הצ׳ק חזר אחרי שסומן כנפרע — התשלום שנרשם בוטל ואינו נספר.
        </span>
      )}
      {cheque.replaces && (
        <span className={styles.nextLine}>
          מחליף את צ׳ק <bdi dir="ltr">#{cheque.replaces.chequeNumber}</bdi>
        </span>
      )}
      {cheque.replacedBy && (
        <span className={styles.nextLine}>
          הוחלף בצ׳ק <bdi dir="ltr">#{cheque.replacedBy.chequeNumber}</bdi>
        </span>
      )}
      {cheque.cancellationReason && (
        <span className={styles.nextLine}>סיבה: {cheque.cancellationReason}</span>
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
                  return `צ׳ק #${cheque.chequeNumber}: ${CHEQUE_STATUS_LABEL[to]}.`;
                })
              }
            >
              {CHEQUE_ADVANCE_LABEL[to] ?? to}
            </button>
          ))}
          {a.clear && (
            <button type="button" className={styles.buttonQuiet} disabled={busy} onClick={() => setMode("clear")}>
              סמן כנפרע
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
                    ? "לסמן שהצ׳ק חזר? התשלום שנרשם כשסומן כנפרע יבוטל (הרישום נשמר ומתועד)."
                    : "לסמן שהצ׳ק חזר?";
                if (window.confirm(note)) {
                  run(async () => {
                    await bounceCheque(cheque.id, "סומן כחוזר על ידי בעל העסק");
                    return `צ׳ק #${cheque.chequeNumber} סומן כחוזר.`;
                  });
                }
              }}
            >
              סמן כחוזר
            </button>
          )}
          {a.replace && (
            <button type="button" className={styles.buttonQuiet} disabled={busy} onClick={() => setMode("replace")}>
              החלף בצ׳ק אחר
            </button>
          )}
          {a.cancel && (
            <button
              type="button"
              className={styles.buttonQuiet}
              disabled={busy}
              onClick={() => {
                if (window.confirm("לבטל את הצ׳ק? הרישום נשמר, והמספר ישוחרר.")) {
                  run(async () => {
                    await cancelCheque(cheque.id, "בוטל על ידי בעל העסק");
                    return `צ׳ק #${cheque.chequeNumber} בוטל.`;
                  });
                }
              }}
            >
              בטל צ׳ק
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
              if (r.replayed) return "הצ׳ק כבר סומן כנפרע — לא נוצר תשלום נוסף.";
              return Number(r.unallocated) > 0
                ? `הצ׳ק סומן כנפרע ונרשם כתשלום. ${formatMoney(r.unallocated, cheque.currency)} לא שויכו ונשארו פתוחים.`
                : "הצ׳ק סומן כנפרע ונרשם כתשלום.";
            });
          }}
        >
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`cq-clear-${cheque.id}`}>
              מתי הכסף ירד מהחשבון?
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
            הסימון נרשם כהצהרה שלך (לא כאישור מהבנק), והצ׳ק ייספר כתשלום אחד על ההתחייבות.
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.buttonPrimary} disabled={busy}>
              {busy ? "רושם…" : "אשר שהצ׳ק נפרע"}
            </button>
            <button type="button" className={styles.buttonQuiet} onClick={() => setMode("idle")}>
              ביטול
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
              return `צ׳ק #${cheque.chequeNumber} הוחלף בצ׳ק #${r.replacement.chequeNumber}.`;
            });
          }}
        >
          <div className={styles.formRow2}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`cq-rep-num-${cheque.id}`}>
                מספר הצ׳ק החדש
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
                תאריך פירעון
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
              תאריך כתיבה
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
            הצ׳ק הנוכחי יישמר ויסומן כמוחלף; הצ׳ק החדש יקושר אליו.
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.buttonPrimary} disabled={busy}>
              {busy ? "רושם…" : "החלף"}
            </button>
            <button type="button" className={styles.buttonQuiet} onClick={() => setMode("idle")}>
              ביטול
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
