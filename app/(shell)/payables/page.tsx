"use client";

import { useEffect, useMemo, useState } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import { useConsumeQueryFlag } from "@/hooks/useConsumeQueryFlag";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMediaQuery } from "@/lib/ui/use-breakpoint";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";
import {
  cadenceLabel,
  scheduleLabel,
  stateLabel,
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
  const { t } = useI18n();
  return (
    <span className={`${styles.badge} ${BADGE_CLASS[state]}`}>
      {stateLabel(t, state)}
    </span>
  );
}

function installmentsText(t: Translator, count: number): string {
  return t(count === 1 ? "money.payables.list.installmentsOne" : "money.payables.list.installmentsMany", { count });
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function PayablesPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<CommitmentListApi[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useEntryState<"open" | "all">("scope", "open");
  // Arriving from "+" opens the form the label promised.
  const [showForm, setShowForm] = useState(searchParams.get("new") === "1");
  useConsumeQueryFlag("new");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const desk = useMediaQuery("(min-width: 1200px)");

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
        setError(e instanceof Error ? e.message : t("money.payables.list.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [scope, reloadToken, t]);

  return (
    <div className={styles.page} style={PAYABLES_THEME}>
      <header className={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h1 className={styles.title}>{t("money.payables.list.title")}</h1>
          <p className={styles.subtitle}>
            {t("money.payables.list.subtitle")}
          </p>
        </div>
        <div className={styles.toolbar}>
          <button
            type="button"
            className={styles.buttonQuiet}
            onClick={() => router.push("/payables/cheques")}
          >
            {t("money.payables.list.chequesAndAccounts")}
          </button>
          <button
            type="button"
            className={styles.buttonQuiet}
            onClick={() => router.push("/payables/bank")}
          >
            {t("money.payables.list.bankLines")}
          </button>
          <button
            type="button"
            className={styles.buttonQuiet}
            onClick={() => setScope((s) => (s === "open" ? "all" : "open"))}
          >
            {scope === "open" ? t("money.payables.list.showAll") : t("money.payables.list.showOpenOnly")}
          </button>
          <button
            type="button"
            className={styles.buttonPrimary}
            onClick={() => setShowForm((v) => !v)}
            aria-expanded={showForm}
          >
            {showForm ? t("money.common.close") : t("money.payables.list.newCommitment")}
          </button>
        </div>
      </header>

      <div className={styles.desk}>
        {showForm ? (
          <div className={styles.side}>
            <CommitmentForm
              onCreated={(id) => {
                setShowForm(false);
                router.push(`/payables/${id}`);
              }}
            />
          </div>
        ) : (
          <aside className={`${styles.side} ${styles.inspectOnly}`} aria-label={t("money.payables.list.selectedAria")}>
            <PayableInspector row={rows?.find((row) => row.id === selectedId) ?? rows?.[0] ?? null} />
          </aside>
        )}
        <div className={styles.queue}>
      {error && (
        <div className={styles.error}>
          {error}
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.buttonQuiet}
              onClick={() => setReloadToken((n) => n + 1)}
            >
              {t("money.common.retry")}
            </button>
          </div>
        </div>
      )}

      {rows === null && !error && <div className={styles.empty}>{t("money.common.loading")}</div>}

      {rows !== null && rows.length === 0 && (
        <div className={styles.empty}>
          {t("money.payables.list.empty")}
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className={styles.list}>
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className={`${styles.card} ${(selectedId ?? rows[0]?.id) === row.id ? styles.cardSelected : ""}`}
              onClick={() => (desk ? setSelectedId(row.id) : router.push(`/payables/${row.id}`))}
              aria-pressed={desk ? (selectedId ?? rows[0]?.id) === row.id : undefined}
            >
              <div className={styles.cardTop}>
                <span className={styles.cardTitle}>{row.title}</span>
                {/* A sibling of the clamped title — never inside it. */}
                <span className={styles.badges}>
                  <Badge state={row.attention} />
                  {row.isLegacy && (
                    <span className={`${styles.badge} ${styles.badgeQuiet}`}>
                      {t("money.payables.list.legacyBadge")}
                    </span>
                  )}
                </span>
              </div>

              <span className={styles.payee}>{row.payeeNameSnapshot}</span>

              <div className={styles.figures}>
                <span className={styles.figure}>
                  <span className={styles.figureLabel}>{t("money.payables.list.paid")}</span>
                  <span className={styles.figureValue}>
                    {formatMoney(row.paid, row.currency, locale)}
                  </span>
                </span>
                <span className={styles.figure}>
                  <span className={styles.figureLabel}>{t("money.payables.list.remaining")}</span>
                  <span className={styles.figureValue}>
                    {row.remaining === null
                      ? /* RECURRING has no end, so it has no remaining total.
                           Inventing one would be a number nobody owes. */
                        "—"
                      : formatMoney(row.remaining, row.currency, locale)}
                  </span>
                </span>
                <span className={styles.figure}>
                  <span className={styles.figureLabel}>{t("money.payables.list.kind")}</span>
                  <span className={styles.figureValueMuted}>
                    {scheduleLabel(t, row.scheduleKind)}
                    {row.scheduleKind === "INSTALLMENT_PLAN" &&
                      ` · ${installmentsText(t, row.installmentCount)}`}
                  </span>
                </span>
              </div>

              {row.next && (
                <span className={styles.nextLine}>
                  {t("money.payables.list.nextLine", {
                    sequence: row.next.sequence,
                    date: formatDate(row.next.dueAt, locale),
                    amount: formatMoney(row.next.remaining, row.currency, locale),
                  })}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
        </div>
      </div>
    </div>
  );
}

function PayableInspector({ row }: { row: CommitmentListApi | null }) {
  const { t, locale } = useI18n();
  if (!row) {
    return <p className={styles.subtitle}>{t("money.payables.list.inspectorEmpty")}</p>;
  }
  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        <span className={styles.cardTitle}>{row.title}</span>
        <Badge state={row.attention} />
      </div>
      <span className={styles.payee}>{row.payeeNameSnapshot}</span>
      <div className={styles.figures}>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{t("money.payables.list.paid")}</span>
          <span className={styles.figureValue}>{formatMoney(row.paid, row.currency, locale)}</span>
        </span>
        <span className={styles.figure}>
          <span className={styles.figureLabel}>{t("money.payables.list.remaining")}</span>
          <span className={styles.figureValue}>{row.remaining === null ? "—" : formatMoney(row.remaining, row.currency, locale)}</span>
        </span>
      </div>
      <span className={styles.nextLine}>
        {scheduleLabel(t, row.scheduleKind)}
        {row.scheduleKind === "INSTALLMENT_PLAN" ? ` · ${installmentsText(t, row.installmentCount)}` : ""}
        {row.next ? ` · ${t("money.payables.list.nextShort", { date: formatDate(row.next.dueAt, locale) })}` : ""}
      </span>
      {row.isLegacy ? <p className={styles.subtitle}>{t("money.payables.list.legacyNote")}</p> : null}
      <p className={styles.subtitle}>
        {t("money.payables.list.billingNoteBefore")}
        <Link href="/billing">{t("money.payables.list.billingLink")}</Link>
        {t("money.payables.list.billingNoteAfter")}
      </p>
      <div className={styles.formActions}>
        <Link className={styles.buttonPrimary} href={`/payables/${row.id}`}>{t("money.payables.list.openFlow")}</Link>
      </div>
    </div>
  );
}

/* ──────────────────────────── create commitment ──────────────────────────── */

function CommitmentForm({ onCreated }: { onCreated: (id: number) => void }) {
  const { t, locale } = useI18n();
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
      setError(e instanceof Error ? e.message : t("money.payables.form.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="pay-title">
          {t("money.payables.form.titleLabel")}
        </label>
        <input
          id="pay-title"
          className={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("money.payables.form.titlePlaceholder")}
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
          {t("money.payables.form.scheduleLabel")}
        </label>
        <select
          id="pay-kind"
          className={styles.select}
          value={scheduleKind}
          onChange={(e) => setScheduleKind(e.target.value as ScheduleKind)}
        >
          <option value="ONE_OFF">{scheduleLabel(t, "ONE_OFF")}</option>
          <option value="INSTALLMENT_PLAN">{scheduleLabel(t, "INSTALLMENT_PLAN")}</option>
          <option value="RECURRING">{scheduleLabel(t, "RECURRING")}</option>
        </select>
      </div>

      <div className={styles.formRow2}>
        {scheduleKind === "RECURRING" ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="pay-recurring">
              {t("money.payables.form.recurringAmount")}
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
              {t("money.payables.form.totalAmount")}
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
            {t("money.payables.form.firstDue")}
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
                {t("money.payables.form.installmentCount")}
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
              {t("money.payables.form.cadence")}
            </label>
            <select
              id="pay-cadence"
              className={styles.select}
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as Cadence)}
            >
              <option value="WEEKLY">{cadenceLabel(t, "WEEKLY")}</option>
              <option value="MONTHLY">{cadenceLabel(t, "MONTHLY")}</option>
              <option value="BIMONTHLY">{cadenceLabel(t, "BIMONTHLY")}</option>
              <option value="QUARTERLY">{cadenceLabel(t, "QUARTERLY")}</option>
              <option value="SEMIANNUAL">{cadenceLabel(t, "SEMIANNUAL")}</option>
              <option value="YEARLY">{cadenceLabel(t, "YEARLY")}</option>
            </select>
          </div>
        </div>
      )}

      {scheduleKind === "RECURRING" && (
        <div className={styles.notice}>
          {t("money.payables.form.recurringNotice")}
        </div>
      )}

      {preview && (
        <div className={styles.preview}>
          <div className={styles.previewHead}>
            {t("money.payables.form.previewHead", { count: preview.length })}
          </div>
          <div className={styles.previewScroll}>
            {preview.slice(0, 6).map((p) => (
              <div key={p.sequence} className={styles.previewRow}>
                <span>
                  {t("money.payables.form.previewRow", { sequence: p.sequence, date: formatDate(p.dueAt.toISOString(), locale) })}
                </span>
                <span style={{ unicodeBidi: "isolate" }}>
                  {formatMoney(fromMinorUnits(p.amountMinor), undefined, locale)}
                </span>
              </div>
            ))}
            {preview.length > 6 && (
              <div className={styles.previewRow}>
                <span>
                  {t(preview.length - 6 === 1 ? "money.payables.form.previewMoreOne" : "money.payables.form.previewMoreMany", {
                    count: preview.length - 6,
                  })}
                </span>
                <span style={{ unicodeBidi: "isolate" }}>
                  {t("money.payables.form.previewTotal", {
                    amount: formatMoney(
                      fromMinorUnits(preview.reduce((s, p) => s + p.amountMinor, 0)),
                      undefined,
                      locale,
                    ),
                  })}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className={styles.field}>
        <label className={styles.label} htmlFor="pay-note">
          {t("money.payables.form.note")}
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
          {busy ? t("money.common.creating") : t("money.payables.form.submit")}
        </button>
      </div>
    </form>
  );
}
