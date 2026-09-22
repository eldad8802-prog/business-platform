"use client";

import { useEffect, useState } from "react";
import {
  COMPLETION_SOURCE_LABEL,
  METHOD_LABEL,
  PREPARATION_STATUS_LABEL,
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
function nextStep(p: PreparationApi, providersLive: boolean): string {
  switch (p.status) {
    case "PREPARED":
      return "עדיין לא שולם דבר. בדוק את הפרטים ואשר — האישור מקבע את הסכום ואת החשבון, ועדיין לא מעביר כסף.";
    case "APPROVED":
      return providersLive
        ? "מאושר. אפשר לשלוח לביצוע דרך ספק התשלום, או להעביר בעצמך מהבנק ולסמן שבוצע."
        : "מאושר. העבר את התשלום מהבנק שלך (אפשר להציג את פרטי החשבון המלאים), ואז סמן שבוצע. עד אז שום דבר לא נרשם כשולם.";
    case "SUBMITTED":
      return "נשלח לספק. עד שהספק מאשר שהכסף הועבר — לא נרשם תשלום.";
    case "FAILED":
      return "הביצוע נכשל ולא שולם דבר. אפשר לנסות שוב, לשלם בדרך אחרת ולסמן שבוצע, או לבטל.";
    case "COMPLETED":
      return `נרשם כתשלום${p.completionSource ? ` (${COMPLETION_SOURCE_LABEL[p.completionSource] ?? p.completionSource})` : ""}.`;
    case "CANCELLED":
      return "בוטל. לא שולם דבר.";
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
      setError(e instanceof Error ? e.message : "הפעולה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  const a = prep.actions;
  return (
    <div className={styles.installment}>
      <div className={styles.installmentHead}>
        <span className={styles.installmentSeq}>
          {formatMoney(prep.amount, prep.currency)} · {METHOD_LABEL[prep.method] ?? prep.method}
        </span>
        <span className={styles.badges}>
          <span className={`${styles.badge} ${STATUS_BADGE[prep.status]}`}>{PREPARATION_STATUS_LABEL[prep.status]}</span>
        </span>
      </div>

      <dl className={styles.prepGrid}>
        <dt>למי</dt>
        <dd>{prep.payee.name}</dd>
        <dt>כמה</dt>
        <dd>{formatMoney(prep.amount, prep.currency)}</dd>
        <dt>מאיפה</dt>
        <dd>{prep.source ? <>{prep.source.label} <bdi dir="ltr">{prep.source.masked}</bdi></> : "לא נבחר חשבון מקור"}</dd>
        <dt>לאן</dt>
        <dd>
          {prep.destination ? (
            <>
              {prep.destination.beneficiaryName} · {prep.destination.label} <bdi dir="ltr">{prep.destination.masked}</bdi>
              <span className={styles.nextLine}> (הוזנו על ידך — הבנק לא בדק אותם)</span>
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>עבור</dt>
        <dd>
          {prep.commitment.title}
          {prep.installment ? ` · תשלום ${prep.installment.sequence} (${formatDate(prep.installment.dueAt)})` : ""}
        </dd>
        {prep.reference && (
          <>
            <dt>אסמכתא</dt>
            <dd>
              <bdi dir="ltr">{prep.reference}</bdi>
            </dd>
          </>
        )}
      </dl>

      <div className={styles.notice}>
        <strong>מה הלאה: </strong>
        {nextStep(prep, providersLive)}
      </div>

      {revealed && (
        <div className={styles.notice} data-testid="revealed-destination">
          פרטי החשבון להעברה: בנק <bdi dir="ltr">{revealed.bankCode}</bdi> · סניף{" "}
          <bdi dir="ltr">{revealed.branchCode}</bdi> · חשבון <bdi dir="ltr">{revealed.accountNumber}</bdi> ·{" "}
          {prep.destination?.beneficiaryName}
          <div className={styles.formActions}>
            <button type="button" className={styles.buttonQuiet} onClick={() => setRevealed(null)}>
              הסתר
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
                if (window.confirm(`לאשר תשלום של ${formatMoney(prep.amount, prep.currency)} ל${prep.payee.name}? האישור לא מעביר כסף.`)) {
                  run(async () => {
                    await approvePreparation(prep.id);
                    return "התשלום אושר. עדיין לא הועבר כסף.";
                  });
                }
              }}
            >
              אשר תשלום
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
                  if (!r.coordinates) throw new Error("לא ניתן להציג את פרטי החשבון כרגע");
                  setRevealed(r.coordinates);
                  return "פרטי החשבון מוצגים. הצגתם נרשמה ביומן.";
                })
              }
            >
              הצג פרטי חשבון להעברה
            </button>
          )}
          {a.reportCompleted && (
            <button type="button" className={styles.buttonQuiet} disabled={busy} onClick={() => setMode("complete")}>
              סמן שביצעתי את התשלום
            </button>
          )}
          {a.cancel && (
            <button
              type="button"
              className={styles.buttonQuiet}
              disabled={busy}
              onClick={() => {
                if (window.confirm("לבטל את התשלום המוכן? לא שולם דבר.")) {
                  run(async () => {
                    await cancelPreparation(prep.id, "בוטל על ידי בעל העסק");
                    return "התשלום המוכן בוטל.";
                  });
                }
              }}
            >
              בטל
            </button>
          )}
        </div>
      )}
      {a.execute && !providersLive && (
        <span className={styles.nextLine}>ביצוע אוטומטי אינו זמין: לא מחובר ספק לתשלומים יוצאים.</span>
      )}

      {mode === "complete" && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await completePreparation(prep.id, toIso(paidAt), ref.trim() || null);
              if (r.replayed) return "התשלום כבר נרשם — לא נוצר תשלום נוסף.";
              return Number(r.unallocated) > 0
                ? `נרשם כתשלום. ${formatMoney(r.unallocated, prep.currency)} לא שויכו ונשארו פתוחים.`
                : "נרשם כתשלום ושויך להתחייבות.";
            });
          }}
        >
          <div className={styles.formRow2}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`pp-date-${prep.id}`}>
                מתי שילמת?
              </label>
              <input id={`pp-date-${prep.id}`} className={styles.input} type="date" value={paidAt} max={todayISO()} onChange={(e) => setPaidAt(e.target.value)} required />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`pp-ref-${prep.id}`}>
                אסמכתת ההעברה (רשות)
              </label>
              <input id={`pp-ref-${prep.id}`} className={styles.input} dir="ltr" value={ref} maxLength={80} onChange={(e) => setRef(e.target.value)} />
            </div>
          </div>
          <div className={styles.notice}>
            יירשם תשלום אחד לפי דיווחך. אם הפרטים שאושרו השתנו מאז — הרישום יסורב.
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.buttonPrimary} disabled={busy}>
              {busy ? "רושם…" : "אשר שהתשלום בוצע"}
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
    return <div className={styles.empty}>אין תשלום פתוח להכנה בהתחייבות הזו.</div>;
  }

  if (!detail.payeeId && method === "BANK_TRANSFER") {
    return (
      <div className={styles.notice}>
        כדי להכין העברה בנקאית צריך מוטב רשום, שאליו שייך חשבון היעד. ההתחייבות רשומה על שם
        &quot;{detail.payeeNameSnapshot}&quot; בלבד.
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
                setError(e instanceof Error ? e.message : "הפעולה נכשלה");
              } finally {
                setBusy(false);
              }
            }}
          >
            רשום את &quot;{detail.payeeNameSnapshot}&quot; כמוטב
          </button>
          <button type="button" className={styles.buttonQuiet} onClick={() => setMethod("CASH")}>
            אשלם בדרך אחרת
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
      setError(err instanceof Error ? err.message : "הכנת התשלום נכשלה");
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
            עבור תשלום
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
                תשלום {i.sequence} · {formatDate(i.dueAt)} · נותר {formatMoney(i.remaining, detail.currency)}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pr-amount">
            סכום
          </label>
          <input id="pr-amount" className={styles.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
      </div>

      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pr-method">
            אמצעי תשלום
          </label>
          <select id="pr-method" className={styles.select} value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m] ?? m}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pr-source">
            מאיזה חשבון (רשות)
          </label>
          <select
            id="pr-source"
            className={styles.select}
            value={sourceId ?? ""}
            onChange={(e) => setSourceId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">לא לציין</option>
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
            לאיזה חשבון של {detail.payeeNameSnapshot}
          </label>
          {destinations === null ? (
            <div className={styles.empty}>טוען…</div>
          ) : activeDest.length === 0 ? (
            <div className={styles.empty}>עוד לא נשמר חשבון יעד למוטב הזה.</div>
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
              {addingDestination ? "סגור" : "הוסף חשבון יעד"}
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
          אסמכתא / פרטים להעברה (רשות)
        </label>
        <input id="pr-ref" className={styles.input} value={reference} maxLength={140} onChange={(e) => setReference(e.target.value)} />
      </div>

      <div className={styles.notice}>
        הכנת תשלום אינה מעבירה כסף ואינה מסמנת דבר כשולם. אחרי ההכנה תאשר, תשלם בעצמך, ותסמן שבוצע.
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy || (method === "BANK_TRANSFER" && !destinationId)}>
          {busy ? "מכין…" : "הכן תשלום"}
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
  const [label, setLabel] = useState("חשבון ראשי");
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
      setError(e instanceof Error ? e.message : "שמירת החשבון נכשלה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.form} data-testid="destination-form">
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="dst-name">
            שם המוטב בבנק
          </label>
          <input id="dst-name" className={styles.input} value={beneficiaryName} maxLength={120} onChange={(e) => setBeneficiaryName(e.target.value)} autoComplete="off" />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="dst-label">
            כינוי
          </label>
          <input id="dst-label" className={styles.input} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
        </div>
      </div>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="dst-bank">
            קוד בנק (2 ספרות)
          </label>
          <input id="dst-bank" className={styles.input} inputMode="numeric" dir="ltr" maxLength={2} value={bankCode} onChange={(e) => setBankCode(e.target.value)} autoComplete="off" />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="dst-branch">
            סניף (3 ספרות)
          </label>
          <input id="dst-branch" className={styles.input} inputMode="numeric" dir="ltr" maxLength={3} value={branchCode} onChange={(e) => setBranchCode(e.target.value)} autoComplete="off" />
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="dst-account">
          מספר חשבון
        </label>
        <input id="dst-account" className={styles.input} inputMode="numeric" dir="ltr" maxLength={20} value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} autoComplete="off" />
      </div>
      <div className={styles.notice}>
        הפרטים נשמרים מוצפנים ומוצגים בהמשך רק כארבע ספרות אחרונות. הבנק לא בודק אותם — ודא שהם נכונים.
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.formActions}>
        <button type="button" className={styles.buttonPrimary} disabled={busy} onClick={save}>
          {busy ? "שומר…" : "שמור חשבון יעד"}
        </button>
      </div>
    </div>
  );
}
