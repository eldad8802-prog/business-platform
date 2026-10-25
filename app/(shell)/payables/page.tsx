"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import { useConsumeQueryFlag } from "@/hooks/useConsumeQueryFlag";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";
import { formatMoney as formatAmount } from "@/lib/ui/money";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import {
  cadenceLabel,
  scheduleLabel,
  createCommitment,
  fetchCommitments,
  formatDate,
  formatMoney,
  type Cadence,
  type CommitmentListApi,
  type ScheduleKind,
} from "@/lib/payables/payables-client";
import { generateInstallmentPlan, fromMinorUnits, toMinorUnits } from "@/lib/services/payables/payables-core";
import { PAYABLES_THEME } from "./payables-theme";
import { PayeeField } from "./payee-field";
import {
  CLOSED_LABEL,
  OPEN_BY_DEFAULT,
  STATE_FILTER_LABEL,
  STATE_FILTER_ORDER,
  TYPE_FILTER_LABEL,
  TYPE_FILTER_ORDER,
  buildPayablesList,
  closedKindOf,
  iconFor,
  isPartlyPaid,
  relativeDue,
  type PayablesGroupKey,
  type PayablesStateFilter,
  type PayablesTypeFilter,
} from "./payables-list-model";
import styles from "./payables.module.css";
import home from "./payables-home.module.css";

function installmentsText(t: Translator, count: number): string {
  return t(count === 1 ? "money.payables.list.installmentsOne" : "money.payables.list.installmentsMany", { count });
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * "התחייבויות" — the main screen (owner-approved redesign, 25.10.2026): title, "התחייבות חדשה", state chips,
 * a type menu, "עוד" (cheques and bank), and the commitments as compact cards in four groups. Overdue and soon
 * are open on arrival; planned and closed fold until asked. No money summary, no forecast, no search — the
 * figures stay on the detail screen and in the cost engine. A card opens the existing detail screen.
 *
 * Presentation only: every group, tag and date comes from payables-list-model over the server's own fields.
 * "התחייבות חדשה" opens P3 ("נגדיר את ההתחייבויות") — the one creation path, with its payee link and real payment
 * plan (owner, 25.10.2026). The old form stays in the code for the transition, reachable only by its existing direct
 * link (/payables?new=1); its removal is a separate decision.
 */
/** The one creation path (P3), from its first step. */
const P3_START = "/secretary?screen=bank";

export default function PayablesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<CommitmentListApi[] | null>(null);
  // The Israel calendar day and the instant the rows were judged against — taken when they arrive, so the
  // groups are decided once per load and never mid-render.
  const [loadedAt, setLoadedAt] = useState<{ today: string; now: Date } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useEntryState<PayablesStateFilter>("state", "ALL");
  const [typeFilter, setTypeFilter] = useEntryState<PayablesTypeFilter>("type", "ALL");
  const [openGroups, setOpenGroups] = useState<Record<PayablesGroupKey, boolean>>(OPEN_BY_DEFAULT);
  // Arriving from a "new" link opens the form the label promised.
  const [showForm, setShowForm] = useState(searchParams.get("new") === "1");
  useConsumeQueryFlag("new");
  const [menu, setMenu] = useState<"type" | "more" | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const typeButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  // Bumped to ask for a reload; the effect owns every setState.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Every commitment, closed ones included: "שולם ונסגר" is a group of this screen, not a second request.
    fetchCommitments("all")
      .then((r) => {
        if (cancelled) return;
        const now = new Date();
        setRows(r);
        setLoadedAt({ today: jerusalemDayKey(now), now });
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
  }, [reloadToken]);

  // A menu: first item takes focus, a press outside closes it. Escape and the arrows are handled on the menu.
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || typeButtonRef.current?.contains(target) || moreButtonRef.current?.contains(target)) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  const closeMenu = () => {
    const back = menu === "type" ? typeButtonRef.current : moreButtonRef.current;
    setMenu(null);
    back?.focus();
  };
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  const view = useMemo(
    () => (rows && loadedAt ? buildPayablesList({ rows, today: loadedAt.today, now: loadedAt.now, state: stateFilter, type: typeFilter }) : null),
    [rows, loadedAt, stateFilter, typeFilter],
  );
  const isOpen = (key: PayablesGroupKey) => (stateFilter === "ALL" ? openGroups[key] : true);

  return (
    <main className={styles.page} style={PAYABLES_THEME} dir="rtl" aria-labelledby="payables-title">
      <div className={home.wrap}>
        <header className={home.head}>
          <div className={home.headText}>
            <h1 id="payables-title" className={home.title}>
              <span aria-hidden="true">💼</span> התחייבויות
            </h1>
            <p className={home.subtitle}>כל מה שהעסק חייב, מתי וכמה.</p>
          </div>
          {showForm ? (
            <button type="button" className={home.newButton} onClick={() => setShowForm(false)}>
              סגור
            </button>
          ) : (
            <Link href={P3_START} className={home.newButton}>
              <PlusIcon /> התחייבות חדשה
            </Link>
          )}
        </header>

        {showForm ? (
          <section className={home.formPanel} aria-label="התחייבות חדשה">
            <CommitmentForm
              onCreated={(id) => {
                setShowForm(false);
                router.push(`/payables/${id}`);
              }}
            />
          </section>
        ) : null}

        <div className={home.chips} role="group" aria-label="סינון לפי מצב">
          {STATE_FILTER_ORDER.map((f) => (
            <button key={f} type="button" className={home.chip} data-k={f} aria-pressed={stateFilter === f} onClick={() => setStateFilter(f)}>
              <StateIcon k={f} />
              <span>{STATE_FILTER_LABEL[f]}</span>
            </button>
          ))}
        </div>

        <div className={home.tools}>
          <button
            ref={typeButtonRef}
            type="button"
            className={home.toolButton}
            aria-haspopup="menu"
            aria-expanded={menu === "type"}
            aria-controls={menu === "type" ? "payables-type-menu" : undefined}
            onClick={() => setMenu((m) => (m === "type" ? null : "type"))}
          >
            סוג: {TYPE_FILTER_LABEL[typeFilter]} <ChevronDown />
          </button>
          <button
            ref={moreButtonRef}
            type="button"
            className={home.toolButton}
            aria-haspopup="menu"
            aria-expanded={menu === "more"}
            aria-controls={menu === "more" ? "payables-more-menu" : undefined}
            onClick={() => setMenu((m) => (m === "more" ? null : "more"))}
          >
            עוד <span aria-hidden="true">⋯</span>
          </button>
          {menu === "type" ? (
            <div id="payables-type-menu" ref={menuRef} role="menu" aria-label="סוג התחייבות" className={`${home.menu} ${home.menuStart}`} onKeyDown={onMenuKey}>
              {TYPE_FILTER_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="menuitemradio"
                  aria-checked={typeFilter === t}
                  className={home.menuItem}
                  onClick={() => {
                    setTypeFilter(t);
                    closeMenu();
                  }}
                >
                  {TYPE_FILTER_LABEL[t]}
                  {typeFilter === t ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          {menu === "more" ? (
            <div id="payables-more-menu" ref={menuRef} role="menu" aria-label="פעולות נוספות" className={`${home.menu} ${home.menuEnd}`} onKeyDown={onMenuKey}>
              <button type="button" role="menuitem" className={home.menuItem} onClick={() => router.push("/payables/cheques")}>
                צ׳קים וחשבונות בנק
              </button>
              <button type="button" role="menuitem" className={home.menuItem} onClick={() => router.push("/payables/bank")}>
                תנועות בנק
              </button>
            </div>
          ) : null}
        </div>

        {error ? (
          <div className={styles.error}>
            {error}
            <div className={styles.formActions}>
              <button type="button" className={styles.buttonQuiet} onClick={() => setReloadToken((n) => n + 1)}>
                נסה שוב
              </button>
            </div>
          </div>
        ) : null}

        {rows === null && !error ? (
          <div className={home.groups} aria-busy="true">
            <span className={home.srOnly}>טוען…</span>
            <div className={home.skeleton} />
            <div className={home.skeleton} />
            <div className={home.skeleton} />
          </div>
        ) : null}

        {rows !== null && view && loadedAt ? (
          rows.length === 0 ? (
            <div className={home.empty}>
              <p>אין עדיין התחייבויות.</p>
              <Link href={P3_START} className={home.newButton}>
                <PlusIcon /> התחייבות חדשה
              </Link>
            </div>
          ) : view.groups.length === 0 ? (
            <div className={home.empty} role="status">
              <p>אין התחייבויות שמתאימות לסינון.</p>
              <button
                type="button"
                className={home.toolButton}
                onClick={() => {
                  setStateFilter("ALL");
                  setTypeFilter("ALL");
                }}
              >
                הצג את כל ההתחייבויות
              </button>
            </div>
          ) : (
            <div className={home.groups}>
              {view.groups.map((group) => {
                const open = isOpen(group.key);
                const headId = `pay-group-${group.key}`;
                return (
                  <section key={group.key} className={home.group} data-k={group.key} aria-labelledby={headId}>
                    <h2 className={home.groupTitle} id={headId}>
                      <button
                        type="button"
                        className={home.groupHead}
                        aria-expanded={open}
                        aria-controls={`${headId}-rows`}
                        disabled={stateFilter !== "ALL"}
                        onClick={() => setOpenGroups((o) => ({ ...o, [group.key]: !o[group.key] }))}
                      >
                        <span>
                          {group.label}
                          {/* A count, never an amount — the browser does not add money. */}
                          <span className={home.groupCount}>({group.rows.length})</span>
                        </span>
                        {stateFilter === "ALL" ? <ChevronDown /> : null}
                      </button>
                    </h2>
                    {open ? (
                      <ul className={home.cards} id={`${headId}-rows`}>
                        {group.rows.map((row) => (
                          <li key={row.id}>
                            <CommitmentCard row={row} group={group.key} today={loadedAt.today} onOpen={() => router.push(`/payables/${row.id}`)} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )
        ) : null}
      </div>
    </main>
  );
}

/** One commitment: icon, name and payee, what is owed next, its date and how near — all server fields. */
function CommitmentCard({ row, group, today, onOpen }: { row: CommitmentListApi; group: PayablesGroupKey; today: string; onOpen: () => void }) {
  const { t } = useI18n();
  const closed = closedKindOf(row);
  const kindText =
    row.scheduleKind === "INSTALLMENT_PLAN"
      ? row.next
        ? `תשלום ${row.next.sequence} מתוך ${row.installmentCount}`
        : installmentsText(t, row.installmentCount)
      : scheduleLabel(t, row.scheduleKind);
  // Open: what the next occurrence still wants. Closed: what was paid, or the commitment's own total.
  const amount = row.next && !closed ? row.next.remaining : closed === "PAID" ? row.paid : (row.total ?? row.paid);
  return (
    <button type="button" className={home.card} data-k={group} data-closed={closed ?? undefined} onClick={onOpen}>
      <span className={home.cardIcon} aria-hidden="true">
        {iconFor(row)}
      </span>
      <span className={home.cardMain}>
        <span className={home.cardTitle}>{row.title}</span>
        <span className={home.cardSub}>
          {row.payeeNameSnapshot && row.payeeNameSnapshot !== row.title ? `${row.payeeNameSnapshot} · ` : ""}
          {kindText}
        </span>
      </span>
      <span className={home.cardAmount}>{formatAmount(amount, row.currency)}</span>
      <span className={home.cardSide}>
        {row.next && !closed ? (
          <>
            <span className={home.cardDate}>{formatDate(row.next.dueAt)}</span>
            <span className={home.cardWhen}>{relativeDue(row.next.dueAt, today)}</span>
            {isPartlyPaid(row) ? <span className={`${home.tag} ${home.tagPart}`}>שולם חלקית</span> : null}
          </>
        ) : closed ? (
          <span className={`${home.tag} ${closed === "PAID" ? home.tagPaid : ""}`}>{CLOSED_LABEL[closed]}</span>
        ) : null}
      </span>
    </button>
  );
}

const STATE_ICON_PATH: Record<PayablesStateFilter, ReactNode> = {
  ALL: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
    </>
  ),
  OVERDUE: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16.2h.01" />
    </>
  ),
  UPCOMING: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  PLANNED: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  CLOSED: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.3 12.3l2.5 2.5 4.9-5" />
    </>
  ),
};

function StateIcon({ k }: { k: PayablesStateFilter }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {STATE_ICON_PATH[k]}
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={home.chev}>
      <path d="M6 9l6 6 6-6" />
    </svg>
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
