"use client";

import { useEffect, useMemo, useState } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import { useConsumeQueryFlag } from "@/hooks/useConsumeQueryFlag";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMediaQuery } from "@/lib/ui/use-breakpoint";
import {
  CADENCE_LABEL,
  SCHEDULE_LABEL,
  createCommitment,
  fetchCommitments,
  formatDate,
  formatMoney,
  type Cadence,
  type CommitmentListApi,
  type ScheduleKind,
} from "@/lib/payables/payables-client";
import { fetchBusinessCostSummary, type BusinessCostSummaryApi } from "@/lib/business-cost/business-cost-client";
import { generateInstallmentPlan, fromMinorUnits, toMinorUnits } from "@/lib/services/payables/payables-core";
import {
  ActionMenu,
  Button,
  ButtonLink,
  Card,
  ChevronIcon,
  DialogFrame,
  EmptyState,
  ErrorState,
  Money,
  Notice,
  ObligationRow,
  PlusIcon,
  RowList,
  SectionHeading,
  SkeletonRows,
  StatusChip,
  SummaryStrip,
  Tag,
  civilDaysFromToday,
  formatShortDate,
  hebrewErrorMessage,
  israelDayKey,
  relativeDayText,
  type StatusTone,
} from "@/components/finance-ui";
import { PAYABLES_THEME } from "./payables-theme";
import { PayeeField } from "./payee-field";
import {
  FILTER_LABEL,
  filterCounts,
  groupRows,
  matchesFilter,
  matchesQuery,
  nextDuePassed,
  type ListFilter,
  type ListGroupKey,
} from "./payables-list-model";
import styles from "./payables.module.css";
import ui from "./payables-ui.module.css";

const GROUP_TONE: Record<ListGroupKey, StatusTone> = {
  PASSED: "danger",
  DUE: "warning",
  PLANNED: "neutral",
  DONE: "success",
};

function todayISO(): string {
  // The Israel calendar day (a UTC slice reads "yesterday" before 03:00).
  return israelDayKey(new Date());
}

export default function PayablesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<CommitmentListApi[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useEntryState<"open" | "all">("scope", "open");
  const [filter, setFilter] = useEntryState<ListFilter>("filter", "open");
  const [view, setView] = useEntryState<"list" | "calendar">("view", "list");
  const [query, setQuery] = useState("");
  // Arriving from "+" opens the form the label promised.
  const [showForm, setShowForm] = useState(searchParams.get("new") === "1");
  useConsumeQueryFlag("new");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const desk = useMediaQuery("(min-width: 1200px)");
  const now = useMemo(() => new Date(), []);

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
        setError(hebrewErrorMessage(e, "לא הצלחנו לטעון את ההתחייבויות."));
      });
    return () => {
      cancelled = true;
    };
  }, [scope, reloadToken]);

  const visible = useMemo(
    () => (rows ?? []).filter((r) => matchesFilter(r, filter, now) && matchesQuery(r, query)),
    [rows, filter, query, now],
  );
  const groups = useMemo(() => groupRows(visible, now), [visible, now]);
  const counts = useMemo(() => filterCounts(rows ?? [], now), [rows, now]);
  const selected = visible.find((r) => r.id === selectedId) ?? groups[0]?.rows[0] ?? null;

  const open = (row: CommitmentListApi) => (desk ? setSelectedId(row.id) : router.push(`/payables/${row.id}`));

  return (
    <div className={ui.page} style={PAYABLES_THEME} dir="rtl">
      <header className={ui.head}>
        <div className={ui.headText}>
          <h1 className={ui.title}>התחייבויות</h1>
          <p className={ui.subtitle}>למי העסק חייב, כמה, מתי, ומה כבר שולם.</p>
        </div>
        <div className={ui.headActions}>
          <span className={ui.wideOnly}>
            <ButtonLink href="/payables/cheques" variant="secondary">צ׳קים וחשבונות בנק</ButtonLink>
          </span>
          <span className={ui.wideOnly}>
            <ButtonLink href="/payables/bank" variant="secondary">תנועות בנק</ButtonLink>
          </span>
          <Button variant="primary" onClick={() => setShowForm(true)}>
            <PlusIcon />
            התחייבות חדשה
          </Button>
          <span className={ui.narrowOnly}>
            <ActionMenu
              label="עוד בהתחייבויות"
              size="md"
              items={[
                { kind: "link", label: "צ׳קים וחשבונות בנק", href: "/payables/cheques" },
                { kind: "link", label: "תנועות בנק", href: "/payables/bank" },
              ]}
            />
          </span>
        </div>
      </header>

      <CostSummary />

      <div className={ui.tools}>
        <div className={ui.toolRow}>
          <label className="sr-only" htmlFor="pay-search" style={srOnly}>
            חיפוש התחייבות
          </label>
          <input
            id="pay-search"
            className={ui.search}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="חיפוש לפי שם או מוטב"
            autoComplete="off"
          />
          <div className={ui.segmented} role="group" aria-label="תצוגה">
            <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>רשימה</button>
            <button type="button" aria-pressed={view === "calendar"} onClick={() => setView("calendar")}>לוח שנה</button>
          </div>
        </div>
        <div className={ui.chips} role="group" aria-label="סינון">
          {(Object.keys(FILTER_LABEL) as ListFilter[]).map((f) => (
            <button key={f} type="button" className={ui.chip} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {FILTER_LABEL[f]}
              <span className={ui.chipCount}>{counts[f].toLocaleString("he-IL")}</span>
            </button>
          ))}
          <button type="button" className={ui.chip} aria-pressed={scope === "all"} onClick={() => setScope((s) => (s === "open" ? "all" : "open"))}>
            כולל שנסגרו
          </button>
        </div>
      </div>

      {error && rows === null ? (
        <ErrorState title="לא הצלחנו לטעון את ההתחייבויות" body={error} onRetry={() => setReloadToken((n) => n + 1)} />
      ) : null}
      {error && rows !== null ? <Notice tone="danger" role="alert">{error}</Notice> : null}

      {rows === null && !error ? <SkeletonRows count={4} label="טוען את ההתחייבויות" /> : null}

      {rows !== null && rows.length === 0 ? (
        <EmptyState
          title="אין עדיין התחייבויות"
          body="כאן יופיע כל מה שהעסק צריך לשלם: חשבונות, שכירות, פריסות וצ׳קים, עם המועדים ומה כבר שולם."
          action={
            <Button variant="primary" onClick={() => setShowForm(true)}>
              <PlusIcon />
              התחייבות חדשה
            </Button>
          }
        />
      ) : null}

      {rows !== null && rows.length > 0 && view === "calendar" ? <DueCalendar rows={visible} now={now} /> : null}

      {rows !== null && rows.length > 0 && view === "list" ? (
        <div className={ui.work}>
          <div className={ui.groups}>
            {visible.length === 0 ? (
              <EmptyState title="אין התחייבויות שמתאימות לחיפוש" body="אפשר לנקות את החיפוש או לבחור סינון אחר." />
            ) : (
              groups.map((group) => (
                <section key={group.key} className={ui.group} aria-labelledby={`pay-group-${group.key}`}>
                  <SectionHeading id={`pay-group-${group.key}`} tone={GROUP_TONE[group.key]} count={group.rows.length}>
                    {group.title}
                  </SectionHeading>
                  <div className={ui.tableWrap}>
                    <table className={ui.table} aria-labelledby={`pay-group-${group.key}`}>
                      <thead>
                        <tr>
                          <th scope="col">התחייבות</th>
                          <th scope="col" className={ui.desktopCol}>סוג</th>
                          <th scope="col">מועד הבא</th>
                          <th scope="col" className={ui.num}>לתשלום במועד</th>
                          <th scope="col" className={`${ui.num} ${ui.desktopCol}`}>שולם עד כה</th>
                          <th scope="col">מצב</th>
                          <th scope="col"><span style={srOnly}>פתיחה</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.rows.map((row) => (
                          <TableRow key={row.id} row={row} now={now} desk={desk} selected={desk && selected?.id === row.id} onOpen={() => open(row)} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className={ui.cards}>
                    <RowList ariaLabelledBy={`pay-group-${group.key}`}>
                      {group.rows.map((row) => (
                        <ObligationRow
                          key={row.id}
                          title={row.title}
                          href={`/payables/${row.id}`}
                          chips={row.next ? <StatusChip status={{ domain: "payables", state: row.next.state }} /> : <StatusChip status={{ domain: "payables", state: row.attention }} />}
                          meta={<DueMeta row={row} now={now} />}
                          amount={row.next ? { value: row.next.remaining, currency: row.currency, caption: Number(row.next.remaining) < Number(row.next.scheduled) ? <>מתוך <Money amount={row.next.scheduled} currency={row.currency} /></> : "לתשלום במועד" } : undefined}
                        />
                      ))}
                    </RowList>
                  </div>
                </section>
              ))
            )}
          </div>
          <aside className={ui.inspector} aria-label="ההתחייבות שנבחרה">
            <Inspector row={selected} now={now} />
          </aside>
        </div>
      ) : null}

      <DialogFrame open={showForm} onClose={() => setShowForm(false)} title="התחייבות חדשה">
        <CommitmentForm
          onCreated={(id) => {
            setShowForm(false);
            router.push(`/payables/${id}`);
          }}
          onCancel={() => setShowForm(false)}
        />
      </DialogFrame>
    </div>
  );
}

const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

function DueMeta({ row, now }: { row: CommitmentListApi; now: Date }) {
  const kind = row.scheduleKind === "INSTALLMENT_PLAN" ? `${SCHEDULE_LABEL[row.scheduleKind]} · ${row.installmentCount} תשלומים` : SCHEDULE_LABEL[row.scheduleKind];
  if (!row.next) return <span>{kind}</span>;
  const days = civilDaysFromToday(row.next.dueAt, now);
  const passed = nextDuePassed(row, now);
  return (
    <span>
      {kind} · {formatShortDate(row.next.dueAt)}
      {days !== null && Number(row.next.remaining) > 0 ? (
        <>
          {" · "}
          <span className={passed ? ui.late : undefined}>{passed ? `המועד עבר ${relativeDayText(days)}` : relativeDayText(days)}</span>
        </>
      ) : null}
    </span>
  );
}

function TableRow({ row, now, desk, selected, onOpen }: { row: CommitmentListApi; now: Date; desk: boolean; selected: boolean; onOpen: () => void }) {
  const payeeDiffers = row.payeeNameSnapshot && row.payeeNameSnapshot !== row.title;
  const days = row.next ? civilDaysFromToday(row.next.dueAt, now) : null;
  const passed = nextDuePassed(row, now);
  return (
    <tr data-selected={selected || undefined} onClick={onOpen} style={selected ? { background: "var(--dz-selection-bg)" } : undefined}>
      <td>
        <span className={ui.rowTitle}>
          {desk ? (
            <button type="button" className={ui.rowLink} aria-pressed={selected} onClick={(e) => { e.stopPropagation(); onOpen(); }}>
              {row.title}
            </button>
          ) : (
            <Link href={`/payables/${row.id}`} className={ui.rowLink} onClick={(e) => e.stopPropagation()}>
              {row.title}
            </Link>
          )}
          <span className={ui.rowSub}>
            {payeeDiffers ? row.payeeNameSnapshot : SCHEDULE_LABEL[row.scheduleKind]}
          </span>
        </span>
      </td>
      <td className={ui.desktopCol}>
        {SCHEDULE_LABEL[row.scheduleKind]}
        {row.scheduleKind === "INSTALLMENT_PLAN" ? ` · ${row.installmentCount}` : ""}
      </td>
      <td>
        {row.next ? (
          <span className={ui.rowTitle}>
            <span>{formatShortDate(row.next.dueAt)}</span>
            {days !== null && Number(row.next.remaining) > 0 ? (
              <span className={passed ? `${ui.rowSub} ${ui.late}` : ui.rowSub}>{passed ? `עבר ${relativeDayText(days)}` : relativeDayText(days)}</span>
            ) : null}
          </span>
        ) : (
          <span className={ui.muted}>—</span>
        )}
      </td>
      <td className={ui.num}>
        {row.next ? <Money amount={row.next.remaining} currency={row.currency} /> : <span className={ui.muted}>—</span>}
        {row.next && Number(row.next.remaining) < Number(row.next.scheduled) && Number(row.next.remaining) > 0 ? (
          <span className={ui.rowSub} style={{ display: "block" }}>
            מתוך <Money amount={row.next.scheduled} currency={row.currency} />
          </span>
        ) : null}
      </td>
      <td className={`${ui.num} ${ui.desktopCol}`}>
        <Money amount={row.paid} currency={row.currency} />
      </td>
      <td>
        <StatusChip status={{ domain: "payables", state: row.next?.state ?? row.attention }} />
      </td>
      <td aria-hidden="true" style={{ color: "var(--dz-text-muted)", width: 28 }}>
        <span style={{ display: "inline-flex", width: 16, height: 16 }}><ChevronIcon /></span>
      </td>
    </tr>
  );
}

function Inspector({ row, now }: { row: CommitmentListApi | null; now: Date }) {
  if (!row) {
    return (
      <Card title="פרטי התחייבות">
        <p className={ui.inspectNote}>בחרו שורה כדי לראות כאן את המועד הבא, מה שולם ומה הפעולה הבאה.</p>
      </Card>
    );
  }
  const finite = row.scheduleKind !== "RECURRING";
  const canPay = Boolean(row.next && Number(row.next.remaining) > 0 && row.status === "ACTIVE");
  return (
    <Card
      title={row.title}
      action={row.next ? <StatusChip status={{ domain: "payables", state: row.next.state }} /> : undefined}
    >
      {row.payeeNameSnapshot && row.payeeNameSnapshot !== row.title ? <p className={ui.inspectNote}>מוטב: {row.payeeNameSnapshot}</p> : null}
      <dl className={ui.figs}>
        <div className={ui.fig}>
          <dt>לתשלום במועד הבא</dt>
          <dd>{row.next ? <Money amount={row.next.remaining} currency={row.currency} /> : "—"}</dd>
        </div>
        <div className={ui.fig}>
          <dt>שולם עד כה</dt>
          <dd><Money amount={row.paid} currency={row.currency} /></dd>
        </div>
        <div className={ui.fig}>
          <dt>{finite ? "נותר בסך הכול" : "מועד הבא"}</dt>
          <dd>{finite ? (row.remaining === null ? "—" : <Money amount={row.remaining} currency={row.currency} />) : row.next ? formatShortDate(row.next.dueAt) : "—"}</dd>
        </div>
      </dl>
      <div className={ui.inspectNote}>
        <DueMeta row={row} now={now} />
      </div>
      {!finite ? <p className={ui.inspectNote}>התחייבות מתחדשת: אין לה סכום כולל. מוצג המועד הקרוב.</p> : null}
      {row.isLegacy ? (
        <div>
          <Tag>נמסרה דרך המזכירה</Tag>
        </div>
      ) : null}
      <div className={ui.inspectActions}>
        {canPay && row.next ? (
          <ButtonLink href={`/payables/${row.id}?pay=${row.next.id}`} variant="primary">
            רישום תשלום
          </ButtonLink>
        ) : null}
        <ButtonLink href={`/payables/${row.id}`} variant="secondary">
          פתיחת ההתחייבות
        </ButtonLink>
      </div>
      <p className={ui.inspectNote}>רישום תשלום כאן לא מעביר כסף. המסמך שמוכיח חיוב נשאר ב<Link href="/billing">חשבוניות</Link>.</p>
    </Card>
  );
}

/**
 * What the cost engine says (GET /api/business-cost/summary): money already
 * due and not paid, what is recorded for the coming days, and — separately —
 * what is only a projection of recurring commitments. A projection is never
 * shown as a debt.
 */
function CostSummary() {
  const [summary, setSummary] = useState<BusinessCostSummaryApi | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetchBusinessCostSummary(controller.signal)
      .then((s) => setSummary(s))
      .catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
      });
    return () => controller.abort();
  }, []);
  if (failed) return <Notice tone="neutral">הסיכום הכספי לא זמין כרגע. הרשימה למטה מעודכנת.</Notice>;
  if (!summary) return null;
  if (summary.baseline.completeness.state === "EMPTY") return null;
  const cur = summary.currency;
  const u = summary.upcoming;
  const projected30 = Number(u.next30Days.projected) > 0;
  return (
    <SummaryStrip
      ariaLabel="סיכום התחייבויות"
      figures={[
        {
          label: "המועד עבר ולא שולם",
          value: <Money amount={u.overdue.total} currency={cur} />,
          hint: u.overdue.items.length === 1 ? "מועד אחד" : `${u.overdue.items.length.toLocaleString("he-IL")} מועדים`,
          tone: Number(u.overdue.total) > 0 ? "danger" : "default",
        },
        {
          label: "לתשלום ב־7 הימים הקרובים",
          value: <Money amount={u.next7Days.recorded} currency={cur} />,
          hint: Number(u.next7Days.projected) > 0 ? <>ועוד <Money amount={u.next7Days.projected} currency={cur} /> תחזית</> : "מועדים רשומים",
        },
        {
          label: "לתשלום ב־30 יום",
          value: <Money amount={u.next30Days.recorded} currency={cur} />,
          hint: projected30 ? <>ועוד <Money amount={u.next30Days.projected} currency={cur} /> תחזית</> : "מועדים רשומים",
        },
        {
          label: "עלות חודשית קבועה",
          value: <Money amount={summary.baseline.monthly} currency={cur} />,
          hint: <><Money amount={summary.baseline.calendarDay.daily} currency={cur} /> ליום</>,
          tone: "muted",
        },
      ]}
      footnote="מהחישוב של כמה העסק עולה. ״לתשלום״ הוא מועדים שכבר רשומים; ״תחזית״ היא מועדים מתחדשים שעוד לא נוצרו, ואינה חוב."
    />
  );
}

/** Next due dates on a month grid (moved here from the Secretary's list). */
function DueCalendar({ rows, now }: { rows: CommitmentListApi[]; now: Date }) {
  const todayKey = israelDayKey(now);
  const [month, setMonth] = useState(() => todayKey.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(null);
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1, 12));
  const daysInMonth = new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
  const lead = first.getUTCDay();
  const byDay = new Map<string, CommitmentListApi[]>();
  for (const r of rows) {
    if (!r.next) continue;
    const key = israelDayKey(new Date(r.next.dueAt));
    byDay.set(key, [...(byDay.get(key) ?? []), r]);
  }
  const shift = (delta: number) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1, 12));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    setPicked(null);
  };
  const monthName = new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric", timeZone: "UTC" }).format(first);
  const pickedRows = picked ? byDay.get(picked) ?? [] : [];
  return (
    <Card>
      <div className={ui.calendar}>
        <div className={ui.calHead}>
          <h2 className={ui.calTitle}>{monthName}</h2>
          <div className={ui.calNav}>
            <Button size="sm" variant="secondary" onClick={() => shift(-1)} ariaLabel="החודש הקודם">הקודם</Button>
            <Button size="sm" variant="secondary" onClick={() => { setMonth(todayKey.slice(0, 7)); setPicked(null); }}>היום</Button>
            <Button size="sm" variant="secondary" onClick={() => shift(1)} ariaLabel="החודש הבא">הבא</Button>
          </div>
        </div>
        <div className={ui.calGrid} role="group" aria-label={`מועדי תשלום ב${monthName}`}>
          {["א", "ב", "ג", "ד", "ה", "ו", "ש"].map((d) => (
            <div key={d} className={ui.calDow} aria-hidden="true">{d}</div>
          ))}
          {Array.from({ length: lead }, (_, i) => (
            <button key={`e${i}`} type="button" className={ui.calDay} disabled aria-hidden="true" tabIndex={-1} />
          ))}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const key = `${month}-${String(i + 1).padStart(2, "0")}`;
            const items = byDay.get(key) ?? [];
            const tones = new Set(items.map((r) => (nextDuePassed(r, now) ? "danger" : r.next && r.next.state === "PAID" ? "neutral" : key <= todayKey ? "warning" : "neutral")));
            const label = items.length === 0 ? `${i + 1}` : `${i + 1}, ${items.length === 1 ? "מועד אחד" : `${items.length} מועדים`}`;
            return (
              <button
                key={key}
                type="button"
                className={ui.calDay}
                aria-pressed={picked === key}
                aria-label={label}
                onClick={() => setPicked(picked === key ? null : key)}
              >
                <span className={key === todayKey ? ui.calToday : undefined}>{i + 1}</span>
                {items.length > 0 ? (
                  <span className={ui.calDots} aria-hidden="true">
                    {tones.has("danger") ? <i className={`${ui.calDot} ${ui.calDotDanger}`} /> : null}
                    {tones.has("warning") ? <i className={`${ui.calDot} ${ui.calDotWarning}`} /> : null}
                    {tones.has("neutral") ? <i className={`${ui.calDot} ${ui.calDotNeutral}`} /> : null}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className={ui.calLegend} aria-hidden="true">
          <span><i className={`${ui.calDot} ${ui.calDotDanger}`} />המועד עבר</span>
          <span><i className={`${ui.calDot} ${ui.calDotWarning}`} />היום</span>
          <span><i className={`${ui.calDot} ${ui.calDotNeutral}`} />מתוכנן</span>
        </div>
        {picked ? (
          pickedRows.length > 0 ? (
            <RowList ariaLabel={`מועדים ב־${formatShortDate(picked + "T12:00:00+03:00")}`}>
              {pickedRows.map((row) => (
                <ObligationRow
                  key={row.id}
                  title={row.title}
                  href={`/payables/${row.id}`}
                  chips={row.next ? <StatusChip status={{ domain: "payables", state: row.next.state }} /> : null}
                  meta={<DueMeta row={row} now={now} />}
                  amount={row.next ? { value: row.next.remaining, currency: row.currency, caption: "לתשלום במועד" } : undefined}
                />
              ))}
            </RowList>
          ) : (
            <p className={ui.inspectNote}>אין מועד תשלום ביום הזה.</p>
          )
        ) : (
          <p className={ui.inspectNote}>בחרו יום כדי לראות את המועדים בו. מוצג המועד הבא של כל התחייבות.</p>
        )}
      </div>
    </Card>
  );
}

/* ──────────────────────────── create commitment ──────────────────────────── */

function CommitmentForm({ onCreated, onCancel }: { onCreated: (id: number) => void; onCancel: () => void }) {
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
      setError(hebrewErrorMessage(e, "לא הצלחנו ליצור את ההתחייבות. אפשר לנסות שוב."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} style={{ border: 0, padding: 0, background: "transparent", boxShadow: "none" }}>
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
        <Notice tone="info">
          התחייבות מתחדשת היא פתוחה: אין לה סכום כולל ואין לה תאריך סיום. נוצר מועד אחד לתאריך הקרוב, והבא אחריו נוצר אחרי שהמועד הזה שולם.
        </Notice>
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

      {error && <Notice tone="danger" role="alert">{error}</Notice>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button type="submit" variant="primary" busy={busy} busyLabel="יוצר…">
          יצירת ההתחייבות
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
