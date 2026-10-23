"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import { useConsumeQueryFlag } from "@/hooks/useConsumeQueryFlag";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMediaQuery } from "@/lib/ui/use-breakpoint";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";
import { formatMoney as formatAmount } from "@/lib/ui/money";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table/data-table";
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
import { PayablesSummary } from "./payables-summary";
import { FILTER_LABEL, FILTER_ORDER, buildPayablesList, type PayablesFilter } from "./payables-list-model";
import styles from "./payables.module.css";
import list from "./payables-list.module.css";

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
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<CommitmentListApi[] | null>(null);
  // The Israel calendar day the rows were judged against — taken when they
  // arrive, so "late" is decided once per load and never mid-render.
  const [today, setToday] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useEntryState<"open" | "all">("scope", "open");
  // Arriving from "+" opens the form the label promised.
  const [showForm, setShowForm] = useState(searchParams.get("new") === "1");
  useConsumeQueryFlag("new");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PayablesFilter>("ALL");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const desk = useMediaQuery("(min-width: 1200px)");
  const tablet = useMediaQuery("(min-width: 720px)");

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
        setToday(jerusalemDayKey(new Date()));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        // The server's own text only when it is Hebrew; the owner never sees an English error.
        const raw = e instanceof Error ? e.message : "";
        setError(/[֐-׿]/.test(raw) ? raw : "טעינת ההתחייבויות נכשלה. אפשר לנסות שוב בעוד רגע.");
      });
    return () => {
      cancelled = true;
    };
  }, [scope, reloadToken]);

  // The small "more" menu (under 720px): first item takes focus, a press
  // outside closes it. Escape and the arrows are handled on the menu itself.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setMenuOpen(false);
      menuButtonRef.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  const includeClosed = scope === "all";
  const view = useMemo(
    () => (rows ? buildPayablesList({ rows, today, query, filter, includeClosed }) : null),
    [rows, today, query, filter, includeClosed],
  );
  const selected = view?.visible.find((row) => row.id === selectedId) ?? view?.visible[0] ?? null;
  const openFlow = (row: CommitmentListApi) => router.push(`/payables/${row.id}`);

  const titleColumn: DataTableColumn<CommitmentListApi> = {
    key: "title",
    header: "התחייבות",
    render: (row) => (
      <>
        <span className={list.cellTitle}>{row.title}</span>
        <span className={list.cellSub}>{row.payeeNameSnapshot}</span>
      </>
    ),
  };
  const dueColumn: DataTableColumn<CommitmentListApi> = {
    key: "due",
    header: "מועד",
    width: "104px",
    render: (row) => (row.next ? formatDate(row.next.dueAt) : "—"),
  };
  const stateColumn: DataTableColumn<CommitmentListApi> = {
    key: "state",
    header: "מצב",
    width: "120px",
    render: (row) => <Badge state={row.attention} />,
  };
  // What the next open occurrence still wants — a server field, never a sum.
  const dueAmount = (row: CommitmentListApi) => (
    <span className={list.money}>{row.next ? formatAmount(row.next.remaining, row.currency) : "—"}</span>
  );
  const deskColumns: DataTableColumn<CommitmentListApi>[] = [
    titleColumn,
    {
      key: "kind",
      header: "סוג",
      width: "116px",
      render: (row) =>
        `${scheduleLabel(t, row.scheduleKind)}${row.scheduleKind === "INSTALLMENT_PLAN" ? ` · ${row.installmentCount}` : ""}`,
    },
    dueColumn,
    { key: "amount", header: "לתשלום במועד", align: "end", width: "128px", render: dueAmount },
    {
      key: "paid",
      header: "שולם עד כה",
      align: "end",
      width: "128px",
      render: (row) => <span className={list.money}>{formatAmount(row.paid, row.currency)}</span>,
    },
    stateColumn,
  ];
  const tabletColumns: DataTableColumn<CommitmentListApi>[] = [
    titleColumn,
    dueColumn,
    { key: "amount", header: "לתשלום", align: "end", width: "136px", render: dueAmount },
    stateColumn,
  ];

  const clearSearch = () => {
    setQuery("");
    setFilter("ALL");
  };

  return (
    <main className={styles.page} style={PAYABLES_THEME} dir="rtl" aria-labelledby="payables-title">
      <header className={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h1 id="payables-title" className={`${styles.title} ${list.mainTitle}`}>התחייבויות</h1>
          <p className={styles.subtitle}>
            מה העסק חייב, מתי, וכמה כבר שולם.
          </p>
        </div>
        <div className={styles.toolbar}>
          <span className={list.toolsWide}>
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
          </span>
          <span className={list.toolsMore}>
            <button
              ref={menuButtonRef}
              type="button"
              className={styles.buttonQuiet}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls="payables-more-menu"
              onClick={() => setMenuOpen((v) => !v)}
            >
              עוד
            </button>
            {menuOpen && (
              <div
                id="payables-more-menu"
                ref={menuRef}
                role="menu"
                aria-label="פעולות נוספות"
                className={list.menu}
                onKeyDown={onMenuKey}
              >
                <button
                  type="button"
                  role="menuitem"
                  className={list.menuItem}
                  onClick={() => router.push("/payables/cheques")}
                >
                  צ׳קים וחשבונות בנק
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={list.menuItem}
                  onClick={() => router.push("/payables/bank")}
                >
                  תנועות בנק
                </button>
              </div>
            )}
          </span>
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

      <PayablesSummary />

      <div className={`${styles.desk} ${list.listDesk}`}>
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
          <aside className={`${styles.side} ${styles.inspectOnly}`} aria-label="ההתחייבות שנבחרה">
            <PayableInspector row={selected} />
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
              נסה שוב
            </button>
          </div>
        </div>
      )}

      {rows === null && !error && (
        <div className={styles.list} aria-busy="true">
          <span className={list.srOnly}>טוען…</span>
          <div className={list.skeletonRow} />
          <div className={list.skeletonRow} />
          <div className={list.skeletonRow} />
        </div>
      )}

      {rows !== null && view && (
        <div className={list.groups}>
          <div className={list.tools}>
            <input
              type="search"
              className={list.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="חיפוש לפי שם התחייבות או מקבל תשלום"
              aria-label="חיפוש לפי שם התחייבות או מקבל תשלום"
            />
            <div className={list.chips} role="group" aria-label="סינון מהיר">
              {FILTER_ORDER.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={list.chip}
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {FILTER_LABEL[f]}
                  <span className={list.chipCount}>{view.counts[f]}</span>
                </button>
              ))}
              {/* The same `scope` toggle as before — entry state, history and all. */}
              <button
                type="button"
                className={list.chipToggle}
                aria-pressed={includeClosed}
                onClick={() => setScope((s) => (s === "open" ? "all" : "open"))}
              >
                כולל שנסגרו
              </button>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className={styles.empty}>
              אין עדיין התחייבויות
              <div className={list.emptyActions}>
                <button type="button" className={styles.buttonPrimary} onClick={() => setShowForm(true)}>
                  התחייבות חדשה
                </button>
              </div>
            </div>
          ) : view.inScope === 0 ? (
            <div className={styles.empty}>אין התחייבויות פתוחות כרגע.</div>
          ) : view.visible.length === 0 ? (
            <div className={styles.empty} role="status">
              לא נמצאו התחייבויות שמתאימות לחיפוש.
              <div className={list.emptyActions}>
                <button type="button" className={styles.buttonQuiet} onClick={clearSearch}>
                  נקה חיפוש וסינון
                </button>
              </div>
            </div>
          ) : (
            view.groups.map((group) => (
              <section key={group.key} className={list.group} aria-labelledby={`pay-group-${group.key}`}>
                <h2 id={`pay-group-${group.key}`} className={list.groupHead}>
                  {group.label}
                  {/* A count, never an amount — the browser does not add money. */}
                  <span className={list.groupCount}>({group.rows.length})</span>
                </h2>
                {desk ? (
                  <div className={`${list.tableBox} ${list.tableDesk}`}>
                    <DataTable
                      columns={deskColumns}
                      rows={group.rows}
                      getRowId={(row) => String(row.id)}
                      onRowOpen={(row) => setSelectedId(row.id)}
                      selectedRowId={selected ? String(selected.id) : undefined}
                      ariaLabel={group.label}
                    />
                  </div>
                ) : tablet ? (
                  <div className={list.tableBox}>
                    <DataTable
                      columns={tabletColumns}
                      rows={group.rows}
                      getRowId={(row) => String(row.id)}
                      onRowOpen={openFlow}
                      ariaLabel={group.label}
                    />
                  </div>
                ) : (
                  <div className={styles.list}>
                    {group.rows.map((row) => (
                      <button key={row.id} type="button" className={styles.card} onClick={() => openFlow(row)}>
                        <div className={styles.cardTop}>
                          <span className={styles.cardTitle}>{row.title}</span>
                          {/* A sibling of the clamped title — never inside it. */}
                          <span className={styles.badges}>
                            <Badge state={row.attention} />
                          </span>
                        </div>
                        <span className={styles.payee}>{row.payeeNameSnapshot}</span>
                        <div className={list.cardLine}>
                          {row.next ? (
                            <>
                              <span className={list.cardAmount}>{formatAmount(row.next.remaining, row.currency)}</span>
                              <span className={list.cardDue}>מועד {formatDate(row.next.dueAt)}</span>
                            </>
                          ) : (
                            <span className={list.cardDue}>
                              שולם עד כה {formatAmount(row.paid, row.currency)}
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
      )}
        </div>
      </div>
    </main>
  );
}

function PayableInspector({ row }: { row: CommitmentListApi | null }) {
  const { t } = useI18n();
  if (!row) {
    return <p className={styles.subtitle}>אין שורה להצגה. התור עצמו נשאר ריק עד שיש התחייבות אמיתית.</p>;
  }
  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        <span className={styles.cardTitle}>{row.title}</span>
        <Badge state={row.attention} />
      </div>
      <span className={styles.payee}>{row.payeeNameSnapshot}</span>
      <dl className={list.inspectFigures}>
        <dt>לתשלום במועד</dt>
        <dd>{row.next ? formatAmount(row.next.remaining, row.currency) : "—"}</dd>
        <dt>שולם עד כה</dt>
        <dd>{formatAmount(row.paid, row.currency)}</dd>
        <dt>נותר</dt>
        <dd>
          {row.remaining === null
            ? /* RECURRING has no end, so it has no remaining total.
                 Inventing one would be a number nobody owes. */
              "—"
            : formatAmount(row.remaining, row.currency)}
        </dd>
        <dt>מועד</dt>
        <dd>{row.next ? `תשלום ${row.next.sequence} · ${formatDate(row.next.dueAt)}` : "—"}</dd>
      </dl>
      <span className={styles.nextLine}>
        {scheduleLabel(t, row.scheduleKind)}
        {row.scheduleKind === "INSTALLMENT_PLAN" ? ` · ${installmentsText(t, row.installmentCount)}` : ""}
      </span>
      {row.isLegacy ? <p className={styles.subtitle}>נמסרה דרך המזכירה. זה אינו תשלום שנרשם.</p> : null}
      <p className={styles.subtitle}>המסמך שמוכיח חיוב נשאר ב<Link href="/billing">חשבוניות</Link>. כאן מנהלים את מהלך התשלום.</p>
      <div className={styles.formActions}>
        <Link className={styles.buttonPrimary} href={`/payables/${row.id}`}>פתח את מהלך התשלום</Link>
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
