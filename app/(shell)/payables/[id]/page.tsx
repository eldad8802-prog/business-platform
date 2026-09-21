"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  METHOD_LABEL,
  SCHEDULE_LABEL,
  STATE_LABEL,
  cancelInstallment,
  fetchBankAccounts,
  fetchCheques,
  fetchCommitment,
  formatDate,
  formatMoney,
  recordPayment,
  reverseAllocation,
  voidPayment,
  type BankAccountApi,
  type ChequeApi,
  type CommitmentDetailApi,
  type DerivedState,
  type InstallmentApi,
} from "@/lib/payables/payables-client";
import { PAYABLES_THEME } from "../payables-theme";
import { ChequeCard, ChequeForm } from "../cheque-parts";
import styles from "../payables.module.css";

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
  const router = useRouter();

  const [detail, setDetail] = useState<CommitmentDetailApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cheques, setCheques] = useState<ChequeApi[]>([]);
  const [accounts, setAccounts] = useState<BankAccountApi[]>([]);
  const [showChequeForm, setShowChequeForm] = useState(false);

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
    ])
      .then(([d, list, bank]) => {
        if (cancelled) return;
        setDetail(d);
        setCheques(list);
        setAccounts(bank);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "טעינה נכשלה");
      });
    return () => {
      cancelled = true;
    };
  }, [commitmentId, reloadToken]);

  async function run(action: () => Promise<unknown>, success: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "הפעולה נכשלה");
    }
  }

  if (error && !detail) {
    return (
      <div className={styles.page} style={PAYABLES_THEME} dir="rtl">
        <div className={styles.error}>{error}</div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className={styles.page} style={PAYABLES_THEME} dir="rtl">
        <div className={styles.empty}>טוען…</div>
      </div>
    );
  }

  const surplusPayments = detail.payments.filter(
    (p) => p.status === "RECORDED" && Number(p.unallocated) > 0,
  );

  return (
    <div className={styles.page} style={PAYABLES_THEME} dir="rtl">
      <button
        type="button"
        className={styles.backLink}
        onClick={() => router.push("/payables")}
      >
        ← כל ההתחייבויות
      </button>

      <header className={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h1 className={styles.title}>{detail.title}</h1>
          <p className={styles.payee}>{detail.payeeNameSnapshot}</p>
        </div>
        <span className={styles.badges}>
          <span className={`${styles.badge} ${styles.badgeQuiet}`}>
            {SCHEDULE_LABEL[detail.scheduleKind]}
          </span>
          {detail.isLegacy && (
            <span className={`${styles.badge} ${styles.badgeQuiet}`}>
              הועבר מהמזכירה
            </span>
          )}
        </span>
      </header>

      <div className={styles.figures}>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>סכום כולל</span>
          <span className={styles.figureValue}>
            {detail.total === null ? "—" : formatMoney(detail.total, detail.currency)}
          </span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>שולם</span>
          <span className={styles.figureValue}>
            {formatMoney(detail.paid, detail.currency)}
          </span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>נותר</span>
          <span className={styles.figureValue}>
            {detail.remaining === null
              ? "—"
              : formatMoney(detail.remaining, detail.currency)}
          </span>
        </span>
      </div>

      {detail.scheduleKind === "RECURRING" && (
        <div className={styles.notice}>
          התחייבות מתחדשת — אין סכום כולל ואין יתרה סופית. מוצג התשלום הקרוב בלבד.
        </div>
      )}

      {/* The legacy assertion, stated as an assertion. It must not read as a
          payment: nothing was ever observed, and no amount was recorded. */}
      {detail.legacy && (
        <div className={styles.legacyNote}>
          סומן כטופל
          {detail.legacy.metAt ? ` בתאריך ${formatDate(detail.legacy.metAt)}` : ""}
          {detail.legacy.assertedBy ? ` על ידי ${detail.legacy.assertedBy}` : ""}. זו
          הצהרה שהועברה מהמזכירה, ולא תשלום שנרשם — לא נשמר סכום, אמצעי תשלום או
          אסמכתא, והיא אינה נספרת כתשלום.
        </div>
      )}

      {notice && <div className={styles.notice}>{notice}</div>}
      {error && <div className={styles.error}>{error}</div>}

      {surplusPayments.length > 0 && (
        <div className={styles.notice}>
          {surplusPayments.map((p) => (
            <div key={p.id}>
              בתשלום מ־{formatDate(p.paidAt)} נותרו{" "}
              <strong>{formatMoney(p.unallocated, detail.currency)}</strong> שלא
              שויכו לאף תשלום. אפשר לשייך אותם בתשלום חדש, או להשאירם כפי שהם.
            </div>
          ))}
        </div>
      )}

      <h2 className={styles.sectionTitle}>רישום תשלום</h2>
      <PaymentForm
        detail={detail}
        onDone={(message) => {
          setNotice(message);
          reload();
        }}
      />

      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>צ׳קים</h2>
        {detail.status === "ACTIVE" && (
          <div className={styles.toolbar}>
            <button
              type="button"
              className={styles.buttonQuiet}
              onClick={() => setShowChequeForm((v) => !v)}
              aria-expanded={showChequeForm}
            >
              {showChequeForm ? "סגור" : "רשום צ׳ק"}
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
            setNotice(`צ׳ק #${c.chequeNumber} נרשם. הוא ייספר כתשלום כשתסמן שנפרע.`);
            reload();
          }}
        />
      )}
      {cheques.length === 0 ? (
        !showChequeForm && (
          <div className={styles.empty}>לא נרשמו צ׳קים להתחייבות הזו.</div>
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

      <h2 className={styles.sectionTitle}>לוח התשלומים</h2>
      <div className={styles.timeline}>
        {detail.installments.map((inst) => (
          <InstallmentRow
            key={inst.id}
            inst={inst}
            currency={detail.currency}
            onReverse={(allocationId) =>
              run(
                () => reverseAllocation(allocationId, "תוקן על ידי בעל העסק"),
                "השיוך בוטל. הכסף חזר ליתרה הלא-משויכת של התשלום.",
              )
            }
            onCancel={(installmentId) =>
              run(
                () => cancelInstallment(installmentId, "בוטל על ידי בעל העסק"),
                "התשלום בוטל.",
              )
            }
          />
        ))}
      </div>

      {detail.payments.length > 0 && (
        <>
          <h2 className={styles.sectionTitle}>תשלומים</h2>
          <div className={styles.timeline}>
            {detail.payments.map((p) => (
              <div key={p.id} className={styles.installment}>
                <div className={styles.installmentHead}>
                  <span className={styles.installmentSeq}>
                    {formatMoney(p.amount, detail.currency)} ·{" "}
                    {METHOD_LABEL[p.method] ?? p.method}
                  </span>
                  <span className={styles.badges}>
                    {p.status === "VOID" ? (
                      <span className={`${styles.badge} ${styles.badgeQuiet}`}>
                        בוטל
                      </span>
                    ) : (
                      <span className={`${styles.badge} ${styles.badgePaid}`}>
                        נרשם
                      </span>
                    )}
                  </span>
                </div>
                <span className={styles.nextLine}>
                  {formatDate(p.paidAt)} · שויך{" "}
                  {formatMoney(p.allocated, detail.currency)} · לא שויך{" "}
                  {formatMoney(p.unallocated, detail.currency)}
                  {p.externalReference ? ` · אסמכתא ${p.externalReference}` : ""}
                </span>
                {p.status === "RECORDED" && (
                  <div className={styles.formActions}>
                    <button
                      type="button"
                      className={styles.buttonQuiet}
                      onClick={() => {
                        if (
                          window.confirm(
                            "לבטל את התשלום? הרישום נשמר, אך הסכום יפסיק להיספר. הפעולה מתועדת.",
                          )
                        ) {
                          run(
                            () => voidPayment(p.id, "בוטל על ידי בעל העסק"),
                            "התשלום בוטל. הרישום נשמר וכל השיוכים שלו הפסיקו להיספר.",
                          );
                        }
                      }}
                    >
                      בטל תשלום
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
          <h2 className={styles.sectionTitle}>תיעוד</h2>
          <div className={styles.auditList}>
            {detail.audit.map((a) => (
              <div key={a.id} className={styles.auditRow}>
                <span>{a.summary ?? a.eventType}</span>
                <span>{formatDate(a.occurredAt)}</span>
              </div>
            ))}
          </div>
        </>
      )}
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
  const hasActive = inst.allocations.some((a) => a.active);
  const cancellable =
    inst.status === "SCHEDULED" && !hasActive && Number(inst.paid) === 0;

  return (
    <div className={styles.installment}>
      <div className={styles.installmentHead}>
        <span className={styles.installmentSeq}>
          תשלום {inst.sequence} · {formatDate(inst.dueAt)}
        </span>
        <span className={styles.badges}>
          <span className={`${styles.badge} ${BADGE_CLASS[inst.state]}`}>
            {STATE_LABEL[inst.state]}
          </span>
        </span>
      </div>

      <div className={styles.figures}>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>לתשלום</span>
          <span className={styles.figureValue}>
            {formatMoney(inst.scheduled, currency)}
          </span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>שולם</span>
          <span className={styles.figureValue}>
            {formatMoney(inst.paid, currency)}
          </span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>נותר</span>
          <span className={styles.figureValue}>
            {formatMoney(inst.remaining, currency)}
          </span>
        </span>
      </div>

      {inst.state === "SETTLED_LEGACY" && (
        <span className={styles.nextLine}>
          סומן כטופל לפני שהפנקס קיים — לא נרשם תשלום, ואינו נספר כשולם.
        </span>
      )}

      {inst.allocations.map((a) => (
        <div
          key={a.id}
          className={a.active ? styles.allocation : styles.allocationReversed}
        >
          <span>
            {formatMoney(a.amount, currency)} · {METHOD_LABEL[a.paymentMethod] ?? a.paymentMethod} ·{" "}
            {formatDate(a.paymentPaidAt)}
            {a.reversedAt ? ` · בוטל השיוך${a.reversalReason ? ` (${a.reversalReason})` : ""}` : ""}
            {!a.reversedAt && a.paymentStatus === "VOID" ? " · התשלום בוטל" : ""}
          </span>
          {a.active && (
            <button
              type="button"
              className={styles.buttonQuiet}
              onClick={() => onReverse(a.id)}
            >
              בטל שיוך
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
            בטל תשלום זה
          </button>
        </div>
      )}
      {inst.status === "SCHEDULED" && hasActive && (
        <span className={styles.nextLine}>
          לא ניתן לבטל תשלום שכבר שויך אליו כסף. יש לבטל קודם את השיוך.
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
  const [selected, setSelected] = useState<number[]>([]);
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
        אין תשלומים פתוחים לשיוך בהתחייבות הזו.
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
        onDone("זהו אותו תשלום שנרשם קודם — לא נוצר תשלום נוסף.");
        return;
      }
      const surplus = Number(result.unallocated ?? "0");
      onDone(
        surplus > 0
          ? `התשלום נרשם. ${formatMoney(String(surplus), detail.currency)} לא שויכו ונשארו פתוחים.`
          : "התשלום נרשם ושויך במלואו.",
      );
      setAmount("");
      setSelected([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "רישום התשלום נכשל");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-amount">
            סכום ששולם
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
            תאריך התשלום
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
            אמצעי תשלום
          </label>
          <select
            id="pm-method"
            className={styles.select}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m] ?? m}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-ref">
            אסמכתא (רשות)
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
          שיוך לתשלומים (אם לא נבחר — לפי סדר מועדי הפירעון)
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
              תשלום {inst.sequence} · {formatDate(inst.dueAt)} · נותר{" "}
              {formatMoney(inst.remaining, detail.currency)}
            </span>
          </label>
        ))}
      </fieldset>

      <div className={styles.notice}>
        סכום גבוה מהנדרש לא יחולק לתשלומים אחרים מעצמו — העודף יישאר פתוח ויוצג כאן.
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy}>
          {busy ? "רושם…" : "רשום תשלום"}
        </button>
      </div>
    </form>
  );
}
