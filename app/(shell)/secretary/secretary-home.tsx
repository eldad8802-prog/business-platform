"use client";

/**
 * "המזכירה שלי" — the main screen (alternative B, owner-approved 22.10.2026).
 *
 * A workspace that stays an assistant, not a table: one status sentence built
 * from the server's counts, every item that needs the owner with its action in
 * the row, quiet tracking kept apart, and the existing cost card in a side
 * column. Leads are not the Secretary's: they live on the home screen.
 *
 * Flow is unchanged:
 *   - "סמן שטופל" calls the page's existing onCompleteFlow — the same "שילמת?"
 *     question, at the same step, for ledger items with money left; a direct
 *     close for legacy items. handled ≠ paid is untouched.
 *   - The "⋯" items open the existing screens (?screen=detail / remind /
 *     update); "כבר לא רלוונטי" opens the existing ReleaseControl under the row, which
 *     calls the existing onReleaseFlow.
 *   - "היום שלי" → ?today=1, "כל ההתחייבויות" → ?screen=all (the Secretary's
 *     own list), "הוספה למעקב" → ?screen=bank.
 */

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BusinessCostCard } from "@/components/business-cost/BusinessCostCard";
import { formatMoney } from "@/lib/ui/money";
import { ReleaseControl, secretaryVars } from "./secretary-ui";
import {
  STATUS_LABEL,
  dueDays,
  ownerErrorText,
  relativeDays,
  type HomeGroupKey,
  type HomeRow,
  type SecretaryHomeView,
} from "./secretary-home-model";
import s from "./secretary-home.module.css";

const HREF = {
  today: "/secretary?today=1",
  all: "/secretary?screen=all",
  bank: "/secretary?screen=bank",
  watching: "/secretary?screen=watching",
  capture: "/secretary?screen=capture",
  detail: (id: number) => "/secretary?screen=detail&id=" + id,
  remind: (id: number) => "/secretary?screen=remind&id=" + id,
  update: (id: number) => "/secretary?screen=update&id=" + id,
};

export type SecretaryHomeActions = {
  /** The existing "טופל" flow (page.tsx onCompleteFlow). */
  onHandled: (obligationId: number) => Promise<void>;
  /** The existing release (page.tsx onReleaseFlow). */
  onRelease: (obligationId: number) => Promise<void>;
};

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

function dayLabel(now: Date): string {
  return new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long", day: "numeric", month: "long" }).format(now);
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

export function SecretaryHome({ view, actions, now = new Date() }: { view: SecretaryHomeView; actions: SecretaryHomeActions; now?: Date }) {
  return (
    <main className={s.page} style={secretaryVars()} dir="rtl" aria-labelledby="secretary-title">
      <Header now={now} />
      <StatusBar view={view} />

      <div className={s.work}>
        <div className={s.lists}>
          {view.state === "new" ? (
            <div className={s.note}>
              <p>אפשר להתחיל מרשימת ההוצאות הקבועות (שכירות, ארנונה, חשמל…) או למסור תשלום אחד עכשיו.</p>
              <div className={s.noteActs}>
                <Link href={HREF.bank} className={cx(s.btn, s.primary)}>בחירה מרשימת ההוצאות הקבועות</Link>
                <Link href={HREF.capture} className={cx(s.btn, s.secondary)}>מסירת תשלום אחד</Link>
              </div>
            </div>
          ) : null}

          {view.state === "calm" && view.needs.length === 0 ? (
            <div className={s.calm}>
              <p>אין עכשיו תשלום שדורש טיפול. כשמועד מתקרב, הוא יופיע כאן.</p>
            </div>
          ) : null}

          {view.needs.map((group) => (
            <RowGroup key={group.key} groupKey={group.key} title={group.title} rows={group.rows} now={now} actions={actions} />
          ))}

          {view.watching.length > 0 ? (
            <RowGroup groupKey="WATCHING" title="במעקב שקט" rows={view.watching} now={now} actions={actions} quiet />
          ) : null}

          {view.state !== "new" ? (
            <div className={s.links}>
              {view.watching.length > 0 ? <Link href={HREF.watching} className={s.link}>מה שאני שומרת ›</Link> : null}
              <Link href={HREF.bank} className={s.link}>רשימת ההוצאות הקבועות ›</Link>
            </div>
          ) : null}
        </div>

        <aside className={s.side} aria-label="תמונת מצב">
          {/* What the business costs — the existing card, from the business-cost engine. */}
          <BusinessCostCard embedded />
        </aside>
      </div>
    </main>
  );
}

function Header({ now }: { now: Date }) {
  return (
    <header className={s.head}>
      <div className={s.headText}>
        <p className={s.date}>{dayLabel(now)}</p>
        <h1 id="secretary-title" className={s.title}>המזכירה שלי</h1>
      </div>
      <nav className={s.entries} aria-label="כניסות במזכירה">
        <Link href={HREF.today} className={cx(s.btn, s.secondary)}>היום שלי</Link>
        <Link href={HREF.all} className={cx(s.btn, s.secondary)}>כל ההתחייבויות</Link>
        <Link href={HREF.bank} className={cx(s.btn, s.primary)}>
          <PlusIcon />
          הוספה למעקב
        </Link>
      </nav>
    </header>
  );
}

function StatusBar({ view }: { view: SecretaryHomeView }) {
  const counts: Array<{ label: string; value: number; late?: boolean }> = [
    { label: "עבר המועד", value: view.counts.overdue, late: true },
    { label: "להיום", value: view.counts.today },
    { label: "השבוע", value: view.counts.soon },
    { label: "במעקב", value: view.counts.watching },
  ];
  return (
    <section className={s.status} aria-label="מצב">
      <div className={s.say}>
        <span className={s.avatar} aria-hidden="true"><PersonIcon /></span>
        <div>
          <p className={s.who}>המזכירה שלך</p>
          <h2 className={s.headline}>{view.title}</h2>
          <p className={s.subline}>{view.subtitle}</p>
        </div>
      </div>
      {view.state !== "new" ? (
        <dl className={s.counts}>
          {counts.map((c) => (
            <div key={c.label} className={cx(s.count, c.late && c.value > 0 && s.countLate, c.value === 0 && s.countZero)}>
              <dt className={s.countLabel}>{c.label}</dt>
              <dd className={s.countValue}>{c.value.toLocaleString("he-IL")}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

const DOT: Record<HomeGroupKey, string> = { OVERDUE: s.dotLate, DUE_TODAY: s.dotSoon, DUE_SOON: s.dotSoon, WATCHING: s.dotQuiet };

function RowGroup({ groupKey, title, rows, now, actions, quiet = false }: { groupKey: HomeGroupKey; title: string; rows: HomeRow[]; now: Date; actions: SecretaryHomeActions; quiet?: boolean }) {
  const id = `sec-group-${groupKey}`;
  return (
    <section className={s.group} aria-labelledby={id}>
      <h3 className={s.groupHead} id={id}>
        <span className={cx(s.dot, DOT[groupKey])} aria-hidden="true" />
        {title}
        <em>· {rows.length.toLocaleString("he-IL")}</em>
      </h3>
      <ul className={cx(s.rows, quiet && s.quiet)} aria-labelledby={id}>
        {rows.map((row) => (
          <Row key={row.obligation.id} row={row} now={now} actions={actions} />
        ))}
      </ul>
    </section>
  );
}

function Row({ row, now, actions }: { row: HomeRow; now: Date; actions: SecretaryHomeActions }) {
  const id = row.obligation.id;
  const needsOwner = row.status !== "WATCHING";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const days = dueDays(row.obligation.dueAt, now);
  const currency = row.obligation.currency;

  async function handled() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await actions.onHandled(id);
    } catch (e) {
      setError(ownerErrorText(e, "לא הצלחתי לסמן שטופל. שום דבר לא השתנה, ואפשר לנסות שוב."));
    } finally {
      setBusy(false);
    }
  }

  // ReleaseControl keeps its own busy state but lets a failure through; the row says it in Hebrew.
  async function release() {
    setError(null);
    try {
      await actions.onRelease(id);
    } catch (e) {
      setError(ownerErrorText(e, "לא הצלחתי להסיר. ההתחייבות נשארה במעקב, ואפשר לנסות שוב."));
    }
  }

  const chipClass = row.status === "OVERDUE" ? s.chipLate : row.status === "WATCHING" ? s.chipQuiet : s.chipSoon;

  return (
    <li className={s.row}>
      <span className={s.mark} aria-hidden="true">{row.name.charAt(0)}</span>
      <span className={s.main}>
        <span className={s.nameLine}>
          <Link href={HREF.detail(id)} className={s.name}>{row.name}</Link>
          <span className={cx(s.chip, chipClass)}>{STATUS_LABEL[row.status]}</span>
        </span>
        <span className={s.meta}>
          <span>{row.cadence}</span>
          <span className={s.sep} aria-hidden="true">·</span>
          <span>{row.status === "OVERDUE" ? `היה לתשלום ב־${shortDate(row.obligation.dueAt)}` : `לתשלום ב־${shortDate(row.obligation.dueAt)}`}</span>
          {days !== null ? (
            <>
              <span className={s.sep} aria-hidden="true">·</span>
              <span className={row.status === "OVERDUE" ? s.late : undefined}>{relativeDays(days)}</span>
            </>
          ) : null}
          {row.progress ? (
            <span className={s.progress}>
              <span className={s.sep} aria-hidden="true">·</span>
              <span>
                שולמו <bdi>{formatMoney(row.progress.paid, currency)}</bdi> מתוך <bdi>{formatMoney(row.progress.total, currency)}</bdi>
              </span>
              <span className={s.track} aria-hidden="true">
                <span className={s.fill} style={{ inlineSize: `${progressPercent(row.progress)}%` }} />
              </span>
            </span>
          ) : null}
        </span>
      </span>
      <span className={s.amount}>
        <bdi className={s.money}>{formatMoney(row.amount, currency)}</bdi>
        {row.amountCaption ? <span className={s.caption}>{row.amountCaption}</span> : null}
      </span>
      <span className={s.acts}>
        {needsOwner ? (
          <button type="button" className={cx(s.btn, s.primary, s.small)} onClick={() => void handled()} disabled={busy} aria-busy={busy || undefined}>
            {busy ? "רגע…" : "סמן שטופל"}
          </button>
        ) : null}
        <RowMenu
          label={`פעולות נוספות ל${row.name}`}
          items={[
            { label: "פרטים", href: HREF.detail(id) },
            ...(needsOwner ? [{ label: "להזכיר לי אחר כך", href: HREF.remind(id) }] : []),
            { label: "עריכת התחייבות", href: HREF.update(id) },
            "separator" as const,
            { label: "כבר לא רלוונטי…", onSelect: () => setReleaseOpen(true), danger: true },
          ]}
        />
      </span>
      {releaseOpen ? (
        // The existing release control: same question, same answers, same onReleaseFlow.
        <div className={s.below}>
          <ReleaseControl onRelease={release} />
          <button type="button" className={cx(s.btn, s.secondary, s.small)} onClick={() => setReleaseOpen(false)}>
            סגירה
          </button>
        </div>
      ) : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}
    </li>
  );
}

/** A visual ratio only — the figures shown beside it are the server's. */
function progressPercent(p: { paid: string; total: string }): number {
  const paid = Number(p.paid);
  const total = Number(p.total);
  if (!Number.isFinite(paid) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, paid / total)) * 100);
}

type MenuEntry = { label: string; href: string } | { label: string; onSelect: () => void; danger?: boolean } | "separator";

/** The "⋯" menu: Enter/Space/ArrowDown open, arrows move, Escape closes and returns focus. */
function RowMenu({ label, items }: { label: string; items: MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const entries = () => Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const focusAt = (i: number) => {
    const list = entries();
    if (list.length) list[(i + list.length) % list.length].focus();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    const raf = requestAnimationFrame(() => {
      wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    return () => {
      document.removeEventListener("mousedown", outside);
      cancelAnimationFrame(raf);
    };
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  return (
    <span className={s.menuWrap} ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={cx(s.btn, s.secondary, s.small, s.iconOnly)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreIcon />
      </button>
      {open ? (
        <ul
          className={s.menu}
          role="menu"
          id={menuId}
          aria-label={label}
          onKeyDown={(e) => {
            const at = entries().indexOf(document.activeElement as HTMLElement);
            if (e.key === "Escape") {
              e.preventDefault();
              close(true);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              focusAt(at + 1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              focusAt(at - 1);
            } else if (e.key === "Tab") {
              close(false);
            }
          }}
        >
          {items.map((item, i) => {
            if (item === "separator") return <li key={`sep-${i}`} className={s.menuSep} role="separator" />;
            if ("href" in item) {
              return (
                <li key={item.label} role="none">
                  <Link href={item.href} role="menuitem" className={s.menuItem} onClick={() => setOpen(false)}>
                    {item.label}
                  </Link>
                </li>
              );
            }
            return (
              <li key={item.label} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={cx(s.menuItem, item.danger && s.menuDanger)}
                  onClick={() => {
                    close(true);
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </span>
  );
}

/** Loading: the same structure, so the screen does not jump when data lands. */
export function SecretaryHomeLoading() {
  return (
    <main className={s.page} style={secretaryVars()} dir="rtl" aria-busy="true" aria-label="טוען את המזכירה">
      <Header now={new Date()} />
      <section className={s.status}>
        <div className={s.say}>
          <span className={s.avatar} aria-hidden="true"><PersonIcon /></span>
          <div style={{ display: "grid", gap: 8, minWidth: 0, flex: 1 }}>
            <span className={s.skel} style={{ inlineSize: "62%", blockSize: 22 }} />
            <span className={s.skel} style={{ inlineSize: "40%", blockSize: 14 }} />
          </div>
        </div>
      </section>
      <div className={s.work}>
        <div className={s.lists}>
          <div className={s.rows} style={{ padding: 14, display: "grid", gap: 14 }}>
            {[0, 1, 2].map((i) => (
              <span key={i} className={s.skel} style={{ blockSize: 40 }} />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

/** Load failure of the main screen: said in Hebrew, with a retry that reports its own failure. */
export function SecretaryHomeLoadError({ message, onRetry }: { message: string | null; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState<string | null>(null);
  return (
    <main className={s.page} style={secretaryVars()} dir="rtl" aria-labelledby="secretary-title">
      <Header now={new Date()} />
      <section className={s.loadError} role="alert">
        <h2>לא הצלחתי לטעון את המזכירה.</h2>
        <p>{again ?? ownerErrorText(new Error(message ?? ""), "החיבור לשרת נכשל. אפשר לנסות שוב בעוד רגע.")}</p>
        <button
          type="button"
          className={cx(s.btn, s.primary)}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setAgain(null);
            try {
              await onRetry();
            } catch (e) {
              setAgain(ownerErrorText(e, "גם הניסיון החוזר נכשל. אפשר לנסות שוב בעוד רגע."));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "רגע…" : "לנסות שוב"}
        </button>
      </section>
    </main>
  );
}

function PersonIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.3" />
      <path d="M5.4 19c0-3.7 3-6.2 6.6-6.2s6.6 2.5 6.6 6.2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width="18" height="18">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}
