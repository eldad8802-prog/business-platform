"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";

import { DubizLogo } from "@/components/ui/dubiz-logo";
import {
  HOME_ROUTES,
  TOOL_GROUPS,
  groupHref,
  obligationHref,
  type ToolGroupKey,
} from "@/lib/navigation/home-routes";
import {
  DUE_BADGE_LABEL,
  formatAmount,
  formatDueDate,
  type CounterValue,
  type GroupStatus,
  type TodayRow,
  type VerdictView,
} from "@/features/home/lib/home-model";

/**
 * Dubiz home screen (HOME 2B).
 *
 * The presentational layer only: it renders the view-model it is handed and
 * owns none of the auth/session/fetch logic (that stays in
 * `app/(shell)/app/page.tsx`).
 *
 * THE RULE THIS SCREEN IS BUILT ON — every element on it is backed by a source
 * that already exists on main:
 *   - the secretary's verdict          GET /api/obligations/briefing
 *   - the four counters                collection-workspace · documents inbox
 *                                      summary · the same briefing
 *   - the three group status labels    GET /api/business-status
 *   - "היום שלך"                       the briefing's attention obligations
 * Nothing here has a default value. A source that fails to load says so; it
 * never falls back to a plausible number, and the screen shows no percentages,
 * no charts and no aggregate ("הוצאות היום") that the product cannot compute.
 *
 * NAVIGATION — every destination comes from `lib/navigation/home-routes.ts` and
 * is proven to resolve by `npm run verify:home-routes`. There is no `href="#"`
 * and no empty handler on this screen. A counter reading 0 stays a link: it
 * opens the (empty) list, which is an answer.
 *
 * COLOUR — the `.dzhome` custom properties below are carried over from main
 * unchanged, including the `--brand` value. The three group cards carry their
 * own deep tones (teal · wine · navy), scoped to the cards. The audit
 * found that it differs from the platform `--dz-brand`; reconciling the two is
 * explicitly out of scope here, and is reported rather than fixed.
 */

/* --------------------------------------------------------------- types -- */

export type HomeCounter = {
  key: string;
  label: string;
  value: CounterValue;
  href: string;
  /** Qualifier under the figure, when the figure's window needs naming. */
  note?: string;
};

export type HomeGroupView = {
  key: ToolGroupKey;
  label: string;
  href: string;
  status: GroupStatus | null;
};

export type HomeSecretaryView = {
  label: string;
  /** The verdict, or `null` while it is loading. */
  verdict: VerdictView | null;
  /** True when the briefing request failed — shows the retry, not a guess. */
  failed: boolean;
};

export type HomeView = {
  greeting: string;
  subGreeting: string;
  /** First letter of the owner's (or business's) name, for the top bar. */
  initial: string;
  secretary: HomeSecretaryView;
  counters: HomeCounter[];
  groups: HomeGroupView[];
  /** `null` while loading. Never `[]` unless the day genuinely has no dates. */
  today: TodayRow[] | null;
  /**
   * The briefing failed, so we do NOT know whether the day is empty. Kept
   * apart from `today: []` on purpose: "nothing is due" and "I could not find
   * out what is due" are different claims, and only one of them is ours to
   * make when the request failed.
   */
  todayFailed: boolean;
  notifications: { href: string; hasUnread: boolean };
};

/* --------------------------------------------------------------- icons -- */

function IconBell() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
  );
}

function IconChevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
  );
}

function IconPerson() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8.5" r="3.6" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></svg>
  );
}

/** Group glyphs — invoice and box reused, unchanged, from the tool strip. */
function IconInvoice() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M9 13h6M9 17h4" /></svg>
  );
}

function IconPeople() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8.5" r="3.3" /><path d="M3 19.5a6 6 0 0 1 12 0" /><path d="M15.5 5.4a3.3 3.3 0 0 1 0 6.2M17.5 14.2a6 6 0 0 1 3.5 5.3" /></svg>
  );
}

function IconBox() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></svg>
  );
}

/*
 * Decorative line drawings, one per group. Pure SVG, no raster assets; they
 * are aria-hidden and the first thing to go when the card gets narrow.
 */
function ArtMoney() {
  return (
    <svg viewBox="0 0 96 68" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 6h30l10 10v44a3 3 0 0 1-3 3H22a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z" />
      <path d="M52 6v10h10M27 26h20M27 34h26M27 42h14" />
      <circle cx="68" cy="48" r="13" />
      <path d="M62.5 48.5l4 4 7.5-8" />
    </svg>
  );
}

function ArtCustomers() {
  return (
    <svg viewBox="0 0 96 68" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="30" y="6" width="54" height="34" rx="6" />
      <circle cx="44" cy="20" r="5" />
      <path d="M55 17h20M55 25h13" />
      <rect x="12" y="26" width="54" height="34" rx="6" />
      <circle cx="26" cy="40" r="5" />
      <path d="M18 53a8 8 0 0 1 16 0M40 37h18M40 45h12" />
    </svg>
  );
}

function ArtOperations() {
  return (
    <svg viewBox="0 0 96 68" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M30 34l14 8v16l-14 8-14-8V42z" />
      <path d="M16 42l14 8 14-8M30 50v16" />
      <path d="M58 34l14 8v16l-14 8-14-8" />
      <path d="M44 42l14 8 14-8M58 50v16" />
      <path d="M44 10l14 8v16l-14 8-14-8V18z" />
      <path d="M30 18l14 8 14-8M44 26v16" />
    </svg>
  );
}

/**
 * Home-only presentation of the three groups. The titles are the Home card
 * names; /tools keeps its own group headings (`TOOL_GROUPS[].label`). Each
 * line names only tools that really live in that group on /tools — nothing
 * without a route ("הוצאות", "יומן") and nothing from another group.
 */
const GROUP_CARD: Record<
  ToolGroupKey,
  { title: string; blurb: string; Icon: () => ReactNode; Art: () => ReactNode }
> = {
  money: {
    title: "כסף וחשבוניות",
    blurb: "חשבוניות, גבייה, מסמכים והצעות מחיר",
    Icon: IconInvoice,
    Art: ArtMoney,
  },
  customers: {
    title: "לקוחות ומכירות",
    blurb: "לקוחות, לידים, שיחות וקופונים",
    Icon: IconPeople,
    Art: ArtCustomers,
  },
  operations: {
    title: "ניהול העסק",
    // U+00A0 binds "מזכירת תשלומים" so it never breaks across lines.
    blurb: "מלאי, ספקים, מזכירת\u00a0תשלומים וחיבורים",
    Icon: IconBox,
    Art: ArtOperations,
  },
};

/* ------------------------------------------------------------ sections -- */

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="sttl">{children}</h2>;
}

/**
 * The secretary — the loudest element on the screen, and the only one that
 * states a conclusion. The whole card is the link to `/attention`, so the
 * exception engine is one tap from Home in every state. The CTA inside is a
 * span rather than a nested button for exactly that reason; it carries the
 * platform's own primary-action tokens, not a new button variant.
 */
function SecretaryCard({
  secretary,
  onRetry,
}: {
  secretary: HomeSecretaryView;
  onRetry: () => void;
}) {
  if (secretary.failed) {
    return (
      <section className="seccard sec-failed" aria-live="polite">
        <div className="srow">
          <span className="sav">
            <Image src="/secretary-avatar.jpg" alt="" width={64} height={64} priority />
          </span>
          <div className="stx">
            <div className="lb">{secretary.label}</div>
            <div className="hi">לא הצלחתי לטעון את מצב היום</div>
          </div>
        </div>
        <p className="smsg">
          זו תקלת טעינה אצלי, לא מצב של העסק. לא אנחש לך ורדיקט.
        </p>
        <div className="sfoot">
          <button type="button" className="dzcta dzcta-quiet" onClick={onRetry}>
            נסה שוב
          </button>
        </div>
      </section>
    );
  }

  if (!secretary.verdict) {
    return (
      <section className="seccard" aria-busy="true">
        <div className="srow">
          <span className="sav sav-sk" />
          <div className="stx" style={{ flex: 1 }}>
            <span className="sk sk-lb" />
            <span className="sk sk-hi" />
          </div>
        </div>
        <span className="sk sk-msg" />
        <div className="sfoot">
          <span className="sk sk-cta" />
        </div>
      </section>
    );
  }

  const { badge, sentence, ctaLabel, tone } = secretary.verdict;

  return (
    <Link
      href={HOME_ROUTES.attention}
      className={`seccard seccard-link tone-${tone}`}
      aria-label={`${badge}. ${sentence} ${ctaLabel}`}
    >
      <div className="srow">
        <span className="sav">
          <Image src="/secretary-avatar.jpg" alt="" width={64} height={64} priority />
        </span>
        <div className="stx">
          <div className="lb">{secretary.label}</div>
          <span className={`sbadge sbadge-${tone}`}>{badge}</span>
        </div>
      </div>

      <p className="smsg">{sentence}</p>

      <div className="sfoot">
        <span className="dzcta">
          {ctaLabel}
          <span className="dzcta-arrow" aria-hidden>
            <IconChevron />
          </span>
        </span>
      </div>
    </Link>
  );
}

/**
 * One counter, in exactly one of three honest states.
 *
 *   loading → a skeleton the size of the figure. NOT the failure wording: a
 *             request still in flight has not failed, and saying so would be
 *             a claim we have not earned.
 *   ready   → the figure, including a legitimate 0. Zero is an answer.
 *   failed  → "לא נטען", and only then.
 *
 * A value of 0 keeps its link — the empty list is an answer too.
 */
function CounterTile({ counter }: { counter: HomeCounter }) {
  const v = counter.value;
  return (
    <Link
      href={counter.href}
      className="ntile"
      aria-label={counter.label}
      aria-busy={v.state === "loading" || undefined}
    >
      {v.state === "loading" ? (
        <span className="nval nval-loading">
          <span className="sk sk-num" aria-hidden />
        </span>
      ) : v.state === "failed" ? (
        <span className="nval nval-off">לא נטען</span>
      ) : (
        <span className="nval">{v.value}</span>
      )}
      <span className="nlab">{counter.label}</span>
      {counter.note ? <span className="nnote">{counter.note}</span> : null}
    </Link>
  );
}

/**
 * One group card. The whole card is the link (no nested controls); the status
 * label from /api/business-status is kept, as a quiet chip under the copy.
 * While that source is loading — or failed — the chip slot holds a skeleton
 * and no words, exactly as the tile it replaces did.
 */
function GroupCard({ group }: { group: HomeGroupView }) {
  const { title, blurb, Icon, Art } = GROUP_CARD[group.key];
  const status = group.status;
  return (
    <Link
      href={group.href}
      className={`ftile fcard-${group.key}`}
      aria-label={status ? `${title}. ${blurb}. ${status.label}` : `${title}. ${blurb}`}
    >
      <span className="fin">
        <span className="fic" aria-hidden>
          <Icon />
        </span>
        <span className="ftx">
          <span className="flab">{title}</span>
          <span className="fdesc">{blurb}</span>
          {status ? (
            <span className={`fstat fstat-${status.tone}`}>
              <span className="fdot" aria-hidden />
              {status.label}
            </span>
          ) : (
            <span className="fstat fstat-loading" aria-hidden>
              <span className="sk sk-stat" />
            </span>
          )}
        </span>
        <span className="fart" aria-hidden>
          <Art />
        </span>
        <span className="fchev" aria-hidden>
          <IconChevron />
        </span>
      </span>
    </Link>
  );
}

function TodaySection({
  rows,
  failed,
}: {
  rows: TodayRow[] | null;
  failed: boolean;
}) {
  if (failed) {
    return (
      <p className="tempty tempty-failed">
        לא הצלחתי לבדוק אילו מועדים פתוחים היום.
      </p>
    );
  }

  if (rows === null) {
    return (
      <div className="tlist" aria-busy="true">
        <span className="sk sk-row" />
        <span className="sk sk-row" />
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className="tempty">אין היום מועדים פתוחים. אני ממשיכה להשגיח.</p>;
  }

  return (
    <ul className="tlist">
      {rows.map((row) => (
        <li key={row.obligationId}>
          <Link href={obligationHref(row.obligationId)} className="trow">
            <span className={`tbadge tbadge-${row.badge}`}>
              {DUE_BADGE_LABEL[row.badge]}
            </span>
            <span className="ttx">
              <span className="tname">{row.title}</span>
              <span className="tmeta">{formatDueDate(row.dueAtIso)}</span>
            </span>
            <span className="tamt">{formatAmount(row.amount, row.currency)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------------------- screen -- */

export function HomeScreen({
  view,
  onRetryVerdict,
}: {
  view: HomeView;
  onRetryVerdict: () => void;
}) {
  const {
    greeting,
    subGreeting,
    initial,
    secretary,
    counters,
    groups,
    today,
    todayFailed,
    notifications,
  } = view;

  return (
    <main className="dzhome" dir="rtl" data-page-intent="content">
      <style>{HOME_CSS}</style>
      <div className="wrap">
        <header className="top">
          <Link href={HOME_ROUTES.profile} className="ib avatar" aria-label="החשבון שלי">
            {initial ? <span className="avin">{initial}</span> : <IconPerson />}
          </Link>

          <span className="brandmark">
            <DubizLogo height={22} />
          </span>

          <Link
            href={notifications.href}
            className={`ib bell${notifications.hasUnread ? " has-unread" : ""}`}
            aria-label={notifications.hasUnread ? "התראות — יש חדשות" : "התראות"}
          >
            <IconBell />
          </Link>
        </header>

        <div className="greet">
          <h1 className="ghi">{greeting}</h1>
          <p className="gsub">{subGreeting}</p>
        </div>

        <SecretaryCard secretary={secretary} onRetry={onRetryVerdict} />

        <section className="sect">
          <SectionTitle>היום במספרים</SectionTitle>
          <div className="ngrid">
            {counters.map((counter) => (
              <CounterTile key={counter.key} counter={counter} />
            ))}
          </div>
        </section>

        <section className="sect" aria-label="אזורי העבודה">
          <div className="fcards">
            {groups.map((group) => (
              <GroupCard key={group.key} group={group} />
            ))}
          </div>
        </section>

        <section className="sect">
          <SectionTitle>היום שלך</SectionTitle>
          <TodaySection rows={today} failed={todayFailed} />
        </section>
      </div>
    </main>
  );
}

/** The groups, in map order, with their status resolved by the page. */
export function buildGroupViews(
  resolve: (key: ToolGroupKey) => GroupStatus | null
): HomeGroupView[] {
  return TOOL_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    href: groupHref(group),
    status: resolve(group.key),
  }));
}

/**
 * Scoped styles, namespaced under `.dzhome`.
 *
 * The custom-property block is carried over from the screen that shipped on
 * main WITHOUT edits — same values, same names — and does not touch the
 * `--brand` / `--dz-brand` discrepancy the audit recorded. Everything the new
 * sections paint is composed from those existing variables plus the platform's
 * own `--dz-action-*` role tokens for the primary CTA.
 *
 * The staged entrance animation that used to play here is gone: the ratified
 * design language (`docs/dubiz-design-language-v1.md` §4, principle 10) bans
 * entrance animations outright, and these sections are new markup rather than
 * markup being preserved.
 */
const HOME_CSS = `
.dzhome{
  --bg:#F7F4ED; --card:#FFFFFF; --ink:#2C2A26; --ink2:#8A8478; --hair:#EAE4D7;
  --brand:#2E7C6E; --brand-d:#1B4A45; --brand-t:#E7F2EF; --brand-t2:#D6E9E3; --brand-l:#5FCEB0;
  --pos:#3E9A6B; --pos-t:#DEEFE4; --neg:#C4674A; --neg-t:#F6E4DC;
  --amber:#B8801F; --amber-t:#F8EBD2;
  --sh:0 1px 2px rgba(70,55,25,.04),0 12px 26px -16px rgba(90,70,35,.2);
  --hl:inset 0 1px 0 rgba(255,255,255,.7);
  direction:rtl;
  min-height:100dvh;
  color:var(--ink);
  font-family:var(--font-heebo),'Heebo','Assistant',system-ui,sans-serif;
  background:radial-gradient(120% 38% at 78% 0%,#F3EFE3,transparent 58%),var(--bg);
  /* Safe-area contract (Spec v1 §12): the top inset comes ONLY from the
     shell-published var, never a raw env(). */
  padding:calc(6px + var(--dz-safe-top,0px)) 20px 18px;
  -webkit-font-smoothing:antialiased;
}
.dzhome .wrap{max-width:480px;margin:0 auto}
.dzhome a{text-decoration:none;color:inherit;-webkit-tap-highlight-color:transparent}

/* --- top bar -------------------------------------------------------- */
.dzhome .top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0 16px}
.dzhome .ib{width:44px;height:44px;min-width:44px;border-radius:15px;background:rgba(255,255,255,.8);border:1px solid rgba(120,98,64,.12);display:flex;align-items:center;justify-content:center;color:#5c5344;box-shadow:0 6px 14px -10px rgba(90,66,30,.5),var(--hl);flex:0 0 auto}
.dzhome .ib svg{width:21px;height:21px}
.dzhome .ib.avatar{background:var(--brand-t);border-color:var(--brand-t2);color:var(--brand-d)}
.dzhome .avin{font-size:17px;font-weight:700;line-height:1}
.dzhome .brandmark{display:flex;align-items:center;justify-content:center;flex:1 1 auto;min-width:0}
.dzhome .ib.bell{position:relative}
.dzhome .ib.bell.has-unread::after{content:"";position:absolute;top:10px;right:11px;width:8px;height:8px;border-radius:50%;background:var(--neg);border:2px solid #fff}

/* --- greeting ------------------------------------------------------- */
.dzhome .greet{padding:0 2px;margin-bottom:16px}
.dzhome .ghi{font-family:var(--font-rubik),'Rubik',sans-serif;font-weight:700;font-size:23px;letter-spacing:-.015em;line-height:1.2;margin:0;color:var(--brand-d)}
.dzhome .gsub{font-size:13.5px;color:#6b6353;margin:5px 0 0;line-height:1.5}

/* --- secretary: the loudest element on the screen -------------------- */
.dzhome .seccard{position:relative;display:block;padding:18px 18px 16px;margin-bottom:28px;border-radius:26px;
  background:linear-gradient(155deg,#22544E 0%,#1A4340 55%,#153A3A 100%);
  box-shadow:0 22px 44px -22px rgba(18,52,52,.75),inset 0 1px 0 rgba(255,255,255,.09);
  overflow:hidden;color:#EAF7F2}
.dzhome .seccard::before{content:"";position:absolute;top:-70px;left:-50px;width:210px;height:210px;border-radius:50%;
  background:radial-gradient(circle,rgba(95,206,176,.26),transparent 68%);pointer-events:none}
.dzhome .seccard>*{position:relative;z-index:1}
.dzhome .seccard-link{transition:transform .14s ease}
.dzhome .seccard-link:active{transform:scale(.995)}
.dzhome .seccard .srow{display:flex;align-items:center;gap:14px}
.dzhome .seccard .sav{width:64px;height:64px;border-radius:50%;overflow:hidden;flex:0 0 auto;box-shadow:0 8px 20px -14px rgba(0,0,0,.6);background:rgba(255,255,255,.08)}
.dzhome .seccard .sav img{width:100%;height:100%;display:block;object-fit:cover}
.dzhome .seccard .stx{min-width:0}
.dzhome .seccard .stx .lb{font-size:12px;color:#7FDCC2;font-weight:600}
.dzhome .seccard .stx .hi{font-family:var(--font-rubik),'Rubik',sans-serif;font-weight:700;font-size:19px;line-height:1.25;margin-top:4px;color:#EAF7F2}
.dzhome .seccard .smsg{font-family:var(--font-rubik),'Rubik',sans-serif;font-size:19px;font-weight:700;line-height:1.42;letter-spacing:-.015em;color:#EAF7F2;margin:16px 0 0}
.dzhome .seccard .sfoot{display:flex;justify-content:flex-start;margin-top:18px}

/* State chip — colour is information: it says which of the four states we are
   in, and nothing on this screen is tinted to look interesting.
   The ink/ground pairs are the platform's SEMANTIC Mist tokens, not the home's
   own tints: those tints are ICON colours (#B8801F on #F8EBD2 is ~3.3:1) and
   would fail AA as 11.5px text. The QA pass measures the rendered contrast
   rather than trusting this comment. */
.dzhome .sbadge{display:inline-flex;align-items:center;margin-top:6px;font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:999px;border:1px solid transparent}
.dzhome .sbadge-calm{background:var(--dz-success-bg);color:var(--dz-success);border-color:var(--dz-success-border)}
.dzhome .sbadge-busy{background:var(--dz-warning-bg);color:var(--dz-warning);border-color:var(--dz-warning-border)}
.dzhome .sbadge-critical{background:var(--dz-danger-bg);color:var(--dz-danger);border-color:var(--dz-danger-border)}
.dzhome .sbadge-settling{background:var(--brand-t);color:var(--brand-d);border-color:var(--brand-t2)}

/* Primary action — the platform's own role tokens, not a new variant.
   Rendered as a span because the whole card is the link (one tap target).
   No hex fallback: these are declared on :root in app/dubiz-mist.css, which is
   loaded app-wide. A fallback is a second copy of a colour that can drift —
   which is how a CTA once ended up painting nothing at 1.03:1. */
.dzhome .dzcta{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 20px;border-radius:14px;
  background:var(--dz-action-primary);color:var(--dz-action-primary-text);
  box-shadow:var(--dz-action-primary-shadow);
  font-family:inherit;font-size:15px;font-weight:600;border:none;cursor:pointer;line-height:1.15}
.dzhome .dzcta-arrow{display:inline-flex;width:14px;height:14px}
.dzhome .dzcta-arrow svg{width:14px;height:14px}
.dzhome .dzcta-quiet{background:rgba(255,255,255,.12);color:#EAF7F2;box-shadow:none;border:1px solid rgba(255,255,255,.2)}
.dzhome .sec-failed .smsg{font-family:inherit;font-size:13.5px;font-weight:500;color:#7FDCC2;margin-top:12px}

/* --- section heads --------------------------------------------------- */
.dzhome .sect{margin-bottom:26px}
.dzhome .sttl{font-size:14.5px;font-weight:700;margin:0 2px 12px;color:var(--ink)}

/* --- היום במספרים: four counters, no percentages, no money aggregate -- */
.dzhome .ngrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.dzhome .ntile{display:flex;flex-direction:column;gap:3px;min-height:88px;padding:14px;border-radius:18px;
  background:var(--card);border:1px solid var(--hair);box-shadow:var(--sh);transition:transform .14s ease}
.dzhome .ntile:active{transform:scale(.99)}
.dzhome .nval{font-family:var(--font-rubik),'Rubik',sans-serif;font-size:26px;font-weight:700;line-height:1.05;letter-spacing:-.02em;color:var(--ink);font-variant-numeric:tabular-nums}
.dzhome .nval-off{font-family:inherit;font-size:13px;font-weight:600;color:#6b6353;line-height:1.6}
.dzhome .nval-loading{display:flex;align-items:center;height:27px}
.dzhome .sk-num{width:46px;height:22px;border-radius:8px;background:rgba(0,0,0,.06)}
.dzhome .nlab{font-size:12.5px;font-weight:600;color:#6b6353;line-height:1.35}
.dzhome .nnote{font-size:11px;color:#6b6353;line-height:1.35}

/* --- group cards: three wide cards, each with its own deep tone -------- */
/* Each card sets four local properties and the shared rules paint from them,
   so the three tones stay one family: same geometry, same light, same depth.
   All text on them is near-white; the QA pass measures it against every
   gradient stop rather than trusting this comment. */
.dzhome .fcards{display:flex;flex-direction:column;gap:10px}
.dzhome .fcard-money{--fc-a:#1E5A4D;--fc-b:#113A32;--fc-glow:rgba(118,214,178,.24);--fc-ink:#CDEFE1}
.dzhome .fcard-customers{--fc-a:#6A2B3A;--fc-b:#431A25;--fc-glow:rgba(236,152,170,.22);--fc-ink:#F4D4DB}
.dzhome .fcard-operations{--fc-a:#2A4562;--fc-b:#172A40;--fc-glow:rgba(142,178,224,.24);--fc-ink:#D2E0F1}
.dzhome .ftile{position:relative;display:block;container-type:inline-size;border-radius:22px;overflow:hidden;
  color:#fff;border:1px solid rgba(255,255,255,.07);
  background:radial-gradient(90% 130% at 0% 0%,var(--fc-glow),transparent 60%),linear-gradient(135deg,var(--fc-a) 0%,var(--fc-b) 100%);
  box-shadow:0 16px 30px -22px rgba(22,30,40,.6),inset 0 1px 0 rgba(255,255,255,.09);
  transition:transform .14s ease,box-shadow .14s ease}
.dzhome .ftile:active{transform:scale(.99)}
.dzhome .ftile:focus-visible{outline:3px solid var(--brand);outline-offset:3px}
@media (hover:hover){
  .dzhome .ftile:hover{transform:translateY(-1px);box-shadow:0 20px 34px -22px rgba(22,30,40,.7),inset 0 1px 0 rgba(255,255,255,.09)}
}
/* RTL grid: icon (right) · text · art · chevron (left). The art column is
   auto-sized, so hiding the art gives its width straight back to the text. */
.dzhome .fin{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;column-gap:14px;min-height:98px;padding:16px 16px 16px 14px}
.dzhome .fic{width:46px;height:46px;border-radius:15px;display:flex;align-items:center;justify-content:center;color:var(--fc-ink);
  background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
.dzhome .fic svg{width:23px;height:23px}
.dzhome .ftx{display:flex;flex-direction:column;align-items:flex-start;gap:3px;min-width:0}
.dzhome .flab{font-family:var(--font-rubik),'Rubik',sans-serif;font-size:17px;font-weight:700;line-height:1.25;letter-spacing:-.01em;color:#fff}
.dzhome .fdesc{font-size:12.5px;font-weight:500;line-height:1.45;color:rgba(255,255,255,.8);text-wrap:balance}
.dzhome .fstat{display:inline-flex;align-items:center;gap:6px;margin-top:7px;padding:3px 9px 3px 10px;border-radius:999px;
  font-size:11.5px;font-weight:600;line-height:1.35;color:rgba(255,255,255,.92);background:rgba(255,255,255,.1)}
.dzhome .fdot{width:6px;height:6px;border-radius:50%;flex:0 0 auto}
.dzhome .fstat-clear .fdot{background:#8EDDB9}
.dzhome .fstat-review .fdot{background:#F3C46A}
.dzhome .fstat-urgent{background:rgba(255,255,255,.16)}
.dzhome .fstat-urgent .fdot{background:#FF9C86;box-shadow:0 0 0 3px rgba(255,156,134,.22)}
.dzhome .fstat-loading{background:none;padding:0}
.dzhome .sk-stat{width:74px;height:20px;border-radius:999px;background:rgba(255,255,255,.1)}
.dzhome .fart{display:none;width:84px;color:var(--fc-ink);opacity:.34}
.dzhome .fart svg{display:block;width:84px;height:60px}
.dzhome .fchev{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  color:rgba(255,255,255,.9);background:rgba(255,255,255,.1)}
.dzhome .fchev svg{width:15px;height:15px}
/* The art only appears when the card itself has room for it — a container
   query, so it holds at any viewport and in the desktop three-up row. */
@container (min-width:360px){
  .dzhome .fart{display:block}
}

/* --- היום שלך -------------------------------------------------------- */
.dzhome .tlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.dzhome .trow{display:flex;align-items:center;gap:11px;min-height:60px;padding:11px 14px;border-radius:16px;
  background:var(--card);border:1px solid var(--hair);box-shadow:var(--sh)}
.dzhome .trow:active{transform:scale(.995)}
.dzhome .tbadge{flex:0 0 auto;font-size:11px;font-weight:700;padding:4px 9px;border-radius:999px}
.dzhome .tbadge-late{background:var(--dz-danger-bg);color:var(--dz-danger)}
.dzhome .tbadge-today{background:var(--dz-warning-bg);color:var(--dz-warning)}
.dzhome .tbadge-tomorrow{background:var(--brand-t);color:var(--brand-d)}
.dzhome .ttx{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dzhome .tname{font-size:14px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dzhome .tmeta{font-size:11.5px;color:#6b6353}
.dzhome .tamt{flex:0 0 auto;font-family:var(--font-rubik),'Rubik',sans-serif;font-size:15px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
.dzhome .tempty{font-size:13.5px;color:#6b6353;line-height:1.6;margin:0;padding:2px}
.dzhome .tempty-failed{color:#6b6353}

/* --- skeletons: the size of the thing they stand in for --------------- */
.dzhome .sk{display:block;border-radius:10px;background:rgba(255,255,255,.14)}
.dzhome .sav-sk{width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,.14);flex:0 0 auto}
.dzhome .sk-lb{width:88px;height:12px;margin-bottom:8px}
.dzhome .sk-hi{width:120px;height:20px}
.dzhome .sk-msg{width:100%;height:46px;margin-top:16px}
.dzhome .sk-cta{width:150px;height:44px;border-radius:14px}
.dzhome .sk-row{height:60px;border-radius:16px;background:rgba(0,0,0,.05)}

/* ============================================================
   Adaptive recomposition (Adaptive + Native Spec v1 §22). The 480 column is
   the MOBILE composition and is unchanged below 768; everything here is
   additive, at the canonical tiers only (LAYOUT.bp 768 / 1024).
   ============================================================ */
@media (min-width:768px){
  .dzhome .wrap{max-width:600px}
  /* The shell reserves 32px below the content from this tier up. */
  .dzhome{min-height:calc(100dvh - 32px)}
  .dzhome .ngrid{grid-template-columns:repeat(4,minmax(0,1fr))}
}
@media (min-width:1024px){
  .dzhome{padding:calc(6px + var(--dz-safe-top,0px)) 32px 24px}
  .dzhome .wrap{max-width:960px;display:grid;grid-template-columns:1fr 1fr;column-gap:32px;row-gap:0;align-items:start}
  .dzhome .wrap>*{grid-column:1 / -1;min-width:0}
  /* The secretary and the day's numbers are both "where the business stands
     right now" and read together; pairing them removes a screen of scrolling.
     In RTL the first grid item takes the inline-start (right) edge, so the
     reading order stays secretary -> numbers, exactly as on mobile. */
  .dzhome .wrap>.seccard{grid-column:1;margin-bottom:26px}
  .dzhome .wrap>.sect:first-of-type{grid-column:2}
  .dzhome .ngrid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .dzhome .fcards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
}
`;
