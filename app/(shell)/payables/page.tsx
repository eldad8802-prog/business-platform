"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CADENCE_LABEL,
  SCHEDULE_LABEL,
  STATE_LABEL,
  createCommitment,
  fetchCommitments,
  formatDate,
  formatMoney,
  type Cadence,
  type CommitmentListApi,
  type DerivedState,
  type ScheduleKind,
} from "@/lib/payables/payables-client";
import { generateInstallmentPlan, fromMinorUnits, toMinorUnits } from "@/lib/services/payables/payables-core";
import { PAYABLES_THEME } from "./payables-theme";
import { PayeeField } from "./payee-field";
import styles from "./payables.module.css";

const BADGE_CLASS: Record<DerivedState, string> = {
  OVERDUE: styles.badgeOverdue,
  DUE: styles.badgeDue,
  PARTIALLY_PAID: styles.badgePartial,
  PAID: styles.badgePaid,
  SCHEDULED: styles.badgeQuiet,
  CANCELLED: styles.badgeQuiet,
  SETTLED_LEGACY: styles.badgeQuiet,
};

function Badge({ state }: { state: DerivedState }) {
  return (
    <span className={`${styles.badge} ${BADGE_CLASS[state]}`}>
      {STATE_LABEL[state]}
    </span>
  );
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function PayablesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<CommitmentListApi[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"open" | "all">("open");
  // Arriving from "+" opens the form the label promised.
  const [showForm, setShowForm] = useState(searchParams.get("new") === "1");

  // Bumped to ask for a reload; the effect below owns every setState, so a
  // response for a scope the owner has already switched away from is discarded
  // instead of overwriting the newer one.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Deliberately no `setRows(null)` here: blanking the list on every scope
    // switch flashes an empty screen before the new rows land. The previous
    // rows stay until the newer answer replaces them.
    fetchCommitments(scope)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "טעינה נכשלה");
      });
    return () => {
      cancelled = true;
    };
  }, [scope, reloadToken]);

  return (
    <div className={styles.page} style={PAYABLES_THEME} dir="rtl">
      <header className={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h1 className={styles.title}>התחייבויות</h1>
          <p className={styles.subtitle}>
            מה העסק חייב, מתי, וכמה כבר שולם.
          </p>
        </div>
        <div className={styles.toolbar}>
          <button
            type="button"
            className={styles.buttonQuiet}
            onClick={() => router.push("/payables/cheques")}
          >
            צ׳קים וחשבונות בנק
          </button>
          <button
            type="button"
            className={styles.buttonQuiet}
            onClick={() => router.push("/payables/bank")}
          >
            תנועות בנק
          </button>
          <button
            type="button"
            className={styles.buttonQuiet}
            onClick={() => setScope((s) => (s === "open" ? "all" : "open"))}
          >
            {scope === "open" ? "הצג הכול" : "הצג פתוחות בלבד"}
          </button>
          <button
            type="button"
            className={styles.buttonPrimary}
            onClick={() => setShowForm((v) => !v)}
            aria-expanded={showForm}
          >
            {showForm ? "סגור" : "התחייבות חדשה"}
          </button>
        </div>
      </header>

      {showForm && (
        <CommitmentForm
          onCreated={(id) => {
            setShowForm(false);
            router.push(`/payables/${id}`);
          }}
        />
      )}

      {error && (
        <div className={styles.error}>
          {error}
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.buttonQuiet}
              onClick={() => setReloadToken((n) => n + 1)}
            >
              נסה שוב
            </button>
          </div>
        </div>
      )}

      {rows === null && !error && <div className={styles.empty}>טוען…</div>}

      {rows !== null && rows.length === 0 && (
        <div className={styles.empty}>
          אין התחייבויות להצגה. אפשר להוסיף התחייבות חדשה.
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className={styles.list}>
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className={styles.card}
              onClick={() => router.push(`/payables/${row.id}`)}
            >
              <div className={styles.cardTop}>
                <span className={styles.cardTitle}>{row.title}</span>
                {/* A sibling of the clamped title — never inside it. */}
                <span className={styles.badges}>
                  <Badge state={row.attention} />
                  {row.isLegacy && (
                    <span className={`${styles.badge} ${styles.badgeQuiet}`}>
                      הועבר מהמזכירה
                    </span>
                  )}
                </span>
              </div>

              <span className={styles.payee}>{row.payeeNameSnapshot}</span>

              <div className={styles.figures}>
                <span className={styles.figure}>
                  <span className={styles.figureLabel}>שולם</span>
                  <span className={styles.figureValue}>
                    {formatMoney(row.paid, row.currency)}
                  </span>
                </span>
                <span className={styles.figure}>
                  <span className={styles.figureLabel}>נותר</span>
                  <span className={styles.figureValue}>
                    {row.remaining === null
                      ? /* RECURRING has no end, so it has no remaining total.
                           Inventing one would be a number nobody owes. */
                        "—"
                      : formatMoney(row.remaining, row.currency)}
                  </span>
                </span>
                <span className={styles.figure}>
                  <span className={styles.figureLabel}>סוג</span>
                  <span className={styles.figureValueMuted}>
                    {SCHEDULE_LABEL[row.scheduleKind]}
                    {row.scheduleKind === "INSTALLMENT_PLAN" &&
                      ` · ${row.installmentCount} תשלומים`}
                  </span>
                </span>
              </div>

              {row.next && (
                <span className={styles.nextLine}>
                  הבא: תשלום {row.next.sequence} · {formatDate(row.next.dueAt)} ·{" "}
                  {formatMoney(row.next.remaining, row.currency)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────── create commitment ──────────────────────────── */

function CommitmentForm({ onCreated }: { onCreated: (id: number) => void }) {
  const [title, setTitle] = useState("");
  const [payee, setPayee] = useState<{ payeeId: number | null; payeeName: string }>({
    payeeId: null,
    payeeName: "",
  });
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>("ONE_OFF");
  const [totalAmount, setTotalAmount] = useState("");
  const [recurringAmount, setRecurringAmount] = useState("");
  const [installmentCount, setInstallmentCount] = useState("12");
  const [recurrence, setRecurrence] = useState<Cadence>("MONTHLY");
  const [firstDueAt, setFirstDueAt] = useState(todayISO());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The schedule the owner is about to create, computed with the SAME function
   * the server uses. It is a preview of a real plan, not an illustration: the
   * remainder lands on the last installment here exactly as it will in the
   * ledger, so 1,000 over 3 never displays as 333.33 × 3 and then stores
   * something else.
   */
  const preview = useMemo(() => {
    if (scheduleKind !== "INSTALLMENT_PLAN") return null;
    const count = Number(installmentCount);
    if (!Number.isInteger(count) || count < 1 || count > 120) return null;
    let totalMinor: number;
    try {
      totalMinor = toMinorUnits(totalAmount || "0");
    } catch {
      return null;
    }
    if (totalMinor <= 0) return null;
    const first = new Date(firstDueAt);
    if (Number.isNaN(first.getTime())) return null;
    try {
      return generateInstallmentPlan({
        totalMinor,
        count,
        firstDueAt: first,
        cadence: recurrence === "NONE" ? "MONTHLY" : recurrence,
      });
    } catch {
      return null;
    }
  }, [scheduleKind, installmentCount, totalAmount, firstDueAt, recurrence]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const commitment = await createCommitment({
        title,
        payeeId: payee.payeeId,
        payeeName: payee.payeeId == null ? payee.payeeName : null,
        scheduleKind,
        totalAmount: scheduleKind === "RECURRING" ? undefined : totalAmount,
        recurringAmount: scheduleKind === "RECURRING" ? recurringAmount : undefined,
        installmentCount:
          scheduleKind === "INSTALLMENT_PLAN" ? Number(installmentCount) : undefined,
        recurrence:
          scheduleKind === "ONE_OFF" ? "NONE" : recurrence,
        firstDueAt: new Date(firstDueAt).toISOString(),
        note: note.trim() || null,
      });
      onCreated(commitment.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "היצירה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="pay-title">
          שם ההתחייבות
        </label>
        <input
          id="pay-title"
          className={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="ארנונה 2027"
          required
        />
      </div>

      <PayeeField
        payeeId={payee.payeeId}
        payeeName={payee.payeeName}
        onChange={setPayee}
        disabled={busy}
      />

      <div className={styles.field}>
        <label className={styles.label} htmlFor="pay-kind">
          אופן התשלום
        </label>
        <select
          id="pay-kind"
          className={styles.select}
          value={scheduleKind}
          onChange={(e) => setScheduleKind(e.target.value as ScheduleKind)}
        >
          <option value="ONE_OFF">{SCHEDULE_LABEL.ONE_OFF}</option>
          <option value="INSTALLMENT_PLAN">{SCHEDULE_LABEL.INSTALLMENT_PLAN}</option>
          <option value="RECURRING">{SCHEDULE_LABEL.RECURRING}</option>
        </select>
      </div>

      <div className={styles.formRow2}>
        {scheduleKind === "RECURRING" ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="pay-recurring">
              סכום לכל תשלום
            </label>
            <input
              id="pay-recurring"
              className={styles.input}
              inputMode="decimal"
              value={recurringAmount}
              onChange={(e) => setRecurringAmount(e.target.value)}
              placeholder="6000.00"
              required
            />
          </div>
        ) : (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="pay-total">
              סכום כולל
            </label>
            <input
              id="pay-total"
              className={styles.input}
              inputMode="decimal"
              value={totalAmount}
              onChange={(e) => setTotalAmount(e.target.value)}
              placeholder="7200.00"
              required
            />
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="pay-first-due">
            מועד התשלום הראשון
          </label>
          <input
            id="pay-first-due"
            className={styles.input}
            type="date"
            value={firstDueAt}
            onChange={(e) => setFirstDueAt(e.target.value)}
            required
          />
        </div>
      </div>

      {scheduleKind !== "ONE_OFF" && (
        <div className={styles.formRow2}>
          {scheduleKind === "INSTALLMENT_PLAN" && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="pay-count">
                מספר תשלומים
              </label>
              <input
                id="pay-count"
                className={styles.input}
                inputMode="numeric"
                value={installmentCount}
                onChange={(e) => setInstallmentCount(e.target.value)}
                required
              />
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="pay-cadence">
              תדירות
            </label>
            <select
              id="pay-cadence"
              className={styles.select}
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as Cadence)}
            >
              <option value="WEEKLY">{CADENCE_LABEL.WEEKLY}</option>
              <option value="MONTHLY">{CADENCE_LABEL.MONTHLY}</option>
              <option value="BIMONTHLY">{CADENCE_LABEL.BIMONTHLY}</option>
              <option value="QUARTERLY">{CADENCE_LABEL.QUARTERLY}</option>
              <option value="SEMIANNUAL">{CADENCE_LABEL.SEMIANNUAL}</option>
              <option value="YEARLY">{CADENCE_LABEL.YEARLY}</option>
            </select>
          </div>
        </div>
      )}

      {scheduleKind === "RECURRING" && (
        <div className={styles.notice}>
          התחייבות מתחדשת היא פתוחה — אין לה סכום כולל ואין לה תאריך סיום. ייווצר
          תשלום אחד למועד הקרוב, והבא אחריו ייווצר לאחר שיוסדר.
        </div>
      )}

      {preview && (
        <div className={styles.preview}>
          <div className={styles.previewHead}>
            לוח התשלומים שייווצר ({preview.length})
          </div>
          <div className={styles.previewScroll}>
            {preview.slice(0, 6).map((p) => (
              <div key={p.sequence} className={styles.previewRow}>
                <span>
                  תשלום {p.sequence} · {formatDate(p.dueAt.toISOString())}
                </span>
                <span style={{ unicodeBidi: "isolate" }}>
                  {formatMoney(fromMinorUnits(p.amountMinor))}
                </span>
              </div>
            ))}
            {preview.length > 6 && (
              <div className={styles.previewRow}>
                <span>…ועוד {preview.length - 6} תשלומים</span>
                <span style={{ unicodeBidi: "isolate" }}>
                  סה״כ{" "}
                  {formatMoney(
                    fromMinorUnits(
                      preview.reduce((s, p) => s + p.amountMinor, 0),
                    ),
                  )}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className={styles.field}>
        <label className={styles.label} htmlFor="pay-note">
          הערה (רשות)
        </label>
        <input
          id="pay-note"
          className={styles.input}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy}>
          {busy ? "יוצר…" : "צור התחייבות"}
        </button>
      </div>
    </form>
  );
}
