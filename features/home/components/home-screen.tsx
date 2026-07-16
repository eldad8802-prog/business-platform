"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";

/**
 * Dubiz home screen — faithful implementation of the approved home mockup
 * (docs/… `dubiz-home-brief.html`). This is the presentational layer only: it
 * renders whatever view-model it is handed and owns none of the auth/session
 * logic (that stays in app/(shell)/app/page.tsx).
 *
 * Fidelity notes, per the brief's "iron rules":
 *  - The two soft zones (secretary, day-state) are borderless — no card, no
 *    fill, no shadow. They sit directly on the cream canvas with only a radial
 *    "halo" so the texture hierarchy reads: secretary (soft) → day-state (soft)
 *    → tools (round tiles) → insights (the single deep/dark surface).
 *  - The mockup's own status bar and its own bottom nav are intentionally NOT
 *    rendered here: the real app supplies the top-safe area and the global
 *    ShellChrome bottom bar. Everything between them matches the mockup.
 *  - Colors keep their roles: teal = the voice of Dubiz; green/terracotta =
 *    money only; amber/cream = the canvas.
 *
 * Honesty ("מוקאפ כן"): no invented business numbers. Sections whose engine is
 * not yet live (day-state financials, Dubiz insights, secretary activity) fall
 * back to honest empty/neutral states rather than fabricated data. When those
 * engines come online they populate the same typed props with no layout change.
 */

export type HomeInsightTone = "brand" | "amber";

export type HomeInsight = {
  id: string;
  /** The insight itself, e.g. "יוסי לוי נראה ליד חם…". */
  text: string;
  /** The <small> line that explains WHY this insight is here. */
  reason: string;
  ctaLabel: string;
  href?: string;
  tone?: HomeInsightTone;
};

export type HomeDayState = {
  /** e.g. "עודכן ב-13:40". */
  updatedAtLabel: string;
  headline: {
    prefix: string;
    /** The figure rendered inside <em>, e.g. "₪1,590". */
    amount: string;
    suffix: string;
    tone: "pos" | "neg";
  };
  sub?: string;
  moneyIn: string;
  moneyOut: string;
};

export type HomeInsights = {
  headline: string;
  basis: string;
  count?: number;
  items: HomeInsight[];
};

export type HomeSecretaryView = {
  label: string;
  greeting: string;
  message?: ReactNode;
  ctaLabel: string;
  ctaHref: string;
};

export type HomeView = {
  secretary: HomeSecretaryView;
  /** null → engine has nothing to show yet (honest empty state). */
  dayState: HomeDayState | null;
  /** null → insights engine not producing yet (honest empty state). */
  insights: HomeInsights | null;
  notifications: { href: string; hasUnread: boolean };
  settingsHref: string;
};

type Tool = {
  key: string;
  label: string;
  href: string;
  color: "teal" | "sage" | "amber" | "clay" | "slate";
  icon: ReactNode;
};

// Exactly 5 coordinated tints rotated across the 10 tools — do not add hues.
// Order matches the approved mockup. Each href targets the tool's LIVE route on
// main (verified 200): several concepts live inside a hub on main — suppliers
// under /inventory/supplier-purchases, WhatsApp in /inbox, coupons in /revenue,
// the bot at /business/bot, and scheduling via the Secretary. When dedicated
// top-level routes (/coupons, /suppliers, /whatsapp, /bot, /appointments) land
// on main, re-point the matching tiles.
const TOOLS: Tool[] = [
  {
    key: "leads",
    label: "לידים",
    href: "/opportunities",
    color: "slate",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
    ),
  },
  {
    key: "calendar",
    label: "יומן",
    href: "/secretary",
    color: "amber",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2.5" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>
    ),
  },
  {
    key: "invoices",
    label: "חשבוניות",
    href: "/billing",
    color: "sage",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M9 13h6M9 17h4" /></svg>
    ),
  },
  {
    key: "collection",
    label: "גבייה",
    href: "/payments",
    color: "teal",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="13" rx="2.5" /><circle cx="12" cy="12.5" r="2.6" /><path d="M6 9.5h.01M18 15.5h.01" /></svg>
    ),
  },
  {
    key: "inventory",
    label: "מלאי",
    href: "/inventory",
    color: "slate",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></svg>
    ),
  },
  {
    key: "coupons",
    label: "קופונים",
    href: "/revenue",
    color: "clay",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3a2 2 0 0 1 0 6v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3a2 2 0 0 1 0-6z" /><path d="M9 9v6" strokeDasharray="1.5 2.5" /></svg>
    ),
  },
  {
    key: "documents",
    label: "מסמכים",
    href: "/documents",
    color: "teal",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4z" /></svg>
    ),
  },
  {
    key: "suppliers",
    label: "ספקים",
    href: "/inventory/supplier-purchases",
    color: "amber",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M2 5h11v10H2zM13 8h4l4 3v4h-8z" /><circle cx="6" cy="18" r="1.8" /><circle cx="17.5" cy="18" r="1.8" /></svg>
    ),
  },
  {
    key: "whatsapp",
    label: "וואטסאפ",
    href: "/inbox",
    color: "sage",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.2 7.6L3 21l1.9-5.8A8.5 8.5 0 1 1 21 11.5z" /><path d="M8.6 9.2c-.3 1.5 1 3.4 2 4.4s2.9 2.3 4.4 2c.6-.1 1.2-.9 1.3-1.4.1-.3-.1-.5-.3-.6l-1.6-.8c-.2-.1-.5-.1-.7.2l-.4.5c-.9-.4-1.9-1.4-2.3-2.3l.5-.4c.3-.2.3-.5.2-.7l-.8-1.6c-.1-.2-.3-.4-.6-.3-.5.1-1.3.7-1.4 1.3z" /></svg>
    ),
  },
  {
    key: "bot",
    label: "בוט",
    href: "/business/bot",
    color: "clay",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4M8.5 13h.01M15.5 13h.01M2 12v3M22 12v3" /></svg>
    ),
  },
];

function IconGear() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>
  );
}

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

function IconSpark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4z" /><circle cx="18.6" cy="17.6" r="1.3" /><circle cx="6" cy="16" r="1" /></svg>
  );
}

function DayState({ dayState }: { dayState: HomeDayState | null }) {
  return (
    <section className="state anim d1">
      <div className="shead">
        <span className="st">מצב היום</span>
        {dayState ? <span className="sm">{dayState.updatedAtLabel}</span> : null}
      </div>

      {dayState ? (
        <>
          <div className="line">
            {dayState.headline.prefix}{" "}
            <em className={dayState.headline.tone === "neg" ? "neg" : ""}>
              {dayState.headline.amount}
            </em>{" "}
            {dayState.headline.suffix}
          </div>
          {dayState.sub ? <div className="sub">{dayState.sub}</div> : null}
          <div className="figs">
            <div className="fig">
              <div className="fl">
                <span className="dot" style={{ background: "var(--pos)" }} />
                נכנס היום
              </div>
              <div className="fv">{dayState.moneyIn}</div>
            </div>
            <span className="vr" />
            <div className="fig">
              <div className="fl">
                <span className="dot" style={{ background: "var(--neg)" }} />
                יצא היום
              </div>
              <div className="fv">{dayState.moneyOut}</div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="line">אוספת את התמונה של היום…</div>
          <div className="sub">
            כשיהיו הכנסות והוצאות מהיום, המצב המלא של העסק יופיע כאן.
          </div>
        </>
      )}
    </section>
  );
}

function Insights({ insights }: { insights: HomeInsights | null }) {
  const hasItems = !!insights && insights.items.length > 0;

  return (
    <div className="anim d3">
      <div className="sh">
        <span className="ttl">התובנות של דוביז</span>
        {hasItems ? (
          <Link href="/attention" className="lnk">
            הכול ›
          </Link>
        ) : null}
      </div>

      <div className="ins">
        <div className="ih">
          <span className="ic">
            <IconSpark />
          </span>
          <div className="iht">
            <b>{hasItems ? insights!.headline : "אין תובנות חדשות כרגע"}</b>
            <span>
              {hasItems
                ? insights!.basis
                : "אני עוקבת אחרי העסק — אעדכן אותך כשאזהה הזדמנות"}
            </span>
          </div>
          {hasItems && insights!.count != null ? (
            <span className="cnt">{insights!.count}</span>
          ) : null}
        </div>

        {hasItems ? (
          insights!.items.map((item) => (
            <div className="ir" key={item.id}>
              <span className={`ipin${item.tone === "amber" ? " amber" : ""}`} />
              <div className="it">
                {item.text}
                <small>{item.reason}</small>
              </div>
              {item.href ? (
                <Link
                  href={item.href}
                  className={`ib2${item.tone === "amber" ? "" : " go"}`}
                >
                  {item.ctaLabel}
                </Link>
              ) : (
                <button
                  type="button"
                  className={`ib2${item.tone === "amber" ? "" : " go"}`}
                >
                  {item.ctaLabel}
                </button>
              )}
            </div>
          ))
        ) : (
          <div className="ir">
            <span className="ipin" />
            <div className="it">
              לא מצאתי כרגע משהו — הכול זורם.
              <small>ברגע שתהיה הזדמנות ששווה את תשומת הלב שלך, היא תופיע כאן</small>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function HomeScreen({ view }: { view: HomeView }) {
  const { secretary, dayState, insights, notifications, settingsHref } = view;

  return (
    <main className="dzhome" dir="rtl">
      <style>{HOME_CSS}</style>
      <div className="wrap">
        {/* top icon row — settings + notifications (structure/CSS verbatim from the mockup) */}
        <div className="top anim d0">
          <Link href={settingsHref} className="ib" aria-label="הגדרות">
            <IconGear />
          </Link>
          <Link
            href={notifications.href}
            className={`ib bell${notifications.hasUnread ? " has-unread" : ""}`}
            aria-label="התראות"
          >
            <IconBell />
          </Link>
        </div>

        {/* secretary — borderless, embedded in the canvas */}
        <div className="seccard anim d0">
          <div className="srow">
            <span className="sav">
              <Image
                src="/secretary-avatar.jpg"
                alt="המזכירה של דוביז"
                width={56}
                height={56}
                priority
              />
            </span>
            <div className="stx">
              <div className="lb">{secretary.label}</div>
              <div className="hi">{secretary.greeting}</div>
            </div>
          </div>
          {secretary.message ? (
            <div className="smsg">{secretary.message}</div>
          ) : null}
          <div className="sfoot">
            <Link href={secretary.ctaHref} className="sbtn">
              {secretary.ctaLabel} <IconChevron />
            </Link>
          </div>
        </div>

        {/* מצב היום — one honest sentence, no chart, borderless */}
        <DayState dayState={dayState} />

        {/* tools — colorful round tiles, horizontal scroll (the only intended sideways scroll) */}
        <div className="anim d2">
          <div className="sh">
            <span className="ttl">הכלים שלך</span>
            <Link href="/tools" className="lnk">
              הכול ›
            </Link>
          </div>
          <div className="feats">
            {TOOLS.map((tool) => (
              <Link href={tool.href} className="ft" key={tool.key}>
                <span className={`fc c-${tool.color}`}>{tool.icon}</span>
                <span>{tool.label}</span>
              </Link>
            ))}
          </div>
        </div>

        {/* התובנות של דוביז — the single deep/dark surface */}
        <Insights insights={insights} />
      </div>
    </main>
  );
}

/**
 * Scoped copy of the mockup's CSS. Every selector is namespaced under `.dzhome`
 * so nothing leaks into the rest of the app, and the design-token custom
 * properties live on the root instead of `:root`. Values are copied verbatim
 * from `dubiz-home-brief.html` — colors, spacing, radii, shadows, font sizes.
 * Fonts come from the app's next/font vars (--font-heebo body, --font-rubik
 * numerals/headings) rather than a webfont @import.
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
  padding:6px 24px 18px;
  -webkit-font-smoothing:antialiased;
}
.dzhome .wrap{max-width:480px;margin:0 auto}

/* top bar */
.dzhome .top{display:flex;align-items:center;justify-content:space-between;padding:6px 0 14px}
.dzhome .ib{width:44px;height:44px;border-radius:15px;background:rgba(255,255,255,.8);border:1px solid rgba(120,98,64,.12);display:flex;align-items:center;justify-content:center;color:#5c5344;box-shadow:0 6px 14px -10px rgba(90,66,30,.5),var(--hl);cursor:pointer}
.dzhome .ib svg{width:21px;height:21px}
.dzhome .ib.bell{position:relative}
.dzhome .ib.bell.has-unread::after{content:"";position:absolute;top:10px;right:11px;width:8px;height:8px;border-radius:50%;background:var(--neg);border:2px solid #fff}

/* secretary — no card at all: sits directly on the canvas */
.dzhome .seccard{position:relative;padding:12px 8px 4px;margin-bottom:28px}
.dzhome .seccard::before{content:"";position:absolute;inset:-10px -14px -6px;z-index:0;background:radial-gradient(74% 116% at 76% 30%,rgba(46,124,110,.13),rgba(46,124,110,.04) 50%,transparent 74%);pointer-events:none}
.dzhome .seccard>*{position:relative;z-index:1}
.dzhome .seccard .srow{display:flex;align-items:center;gap:14px}
.dzhome .seccard .sav{width:56px;height:56px;border-radius:50%;overflow:hidden;flex:0 0 auto;box-shadow:0 8px 20px -14px rgba(27,74,69,.55)}
.dzhome .seccard .sav img{width:100%;height:100%;display:block;object-fit:cover}
.dzhome .seccard .stx .lb{font-size:12px;color:var(--brand);font-weight:700}
.dzhome .seccard .stx .hi{font-family:var(--font-rubik),'Rubik',sans-serif;font-weight:700;font-size:23px;letter-spacing:-.015em;line-height:1.1;margin-top:2px;color:var(--brand-d)}
.dzhome .seccard .smsg{font-size:13.5px;color:#67857F;line-height:1.55;margin-top:14px}
.dzhome .seccard .smsg b{color:var(--brand-d);font-weight:700}
.dzhome .seccard .sfoot{display:flex;justify-content:flex-end;margin-top:14px}
.dzhome .seccard .sbtn{display:inline-flex;align-items:center;gap:6px;background:none;color:var(--brand);border:none;font-family:inherit;font-weight:700;font-size:13.5px;padding:6px 2px;cursor:pointer;transition:opacity .14s;text-decoration:none}
.dzhome .seccard .sbtn:hover{opacity:.7}
.dzhome .seccard .sbtn svg{width:14px;height:14px}

/* מצב היום — one honest sentence, borderless */
.dzhome .state{position:relative;padding:12px 8px 6px;margin-bottom:30px}
.dzhome .state::before{content:"";position:absolute;inset:-10px -14px -6px;z-index:0;background:radial-gradient(76% 118% at 24% 34%,rgba(62,154,107,.15),rgba(62,154,107,.04) 48%,transparent 74%);pointer-events:none}
.dzhome .state>*{position:relative;z-index:1}
.dzhome .state .shead{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}
.dzhome .state .shead .st{font-size:15px;font-weight:700}
.dzhome .state .shead .sm{font-size:11.5px;color:var(--ink2);font-weight:500}
.dzhome .state .line{font-family:var(--font-rubik),'Rubik',sans-serif;font-weight:700;font-size:25px;line-height:1.32;letter-spacing:-.015em;color:var(--ink)}
.dzhome .state .line em{font-style:normal;color:var(--pos)}
.dzhome .state .line em.neg{color:var(--neg)}
.dzhome .state .sub{font-size:13px;color:#7a7466;margin-top:9px;line-height:1.5}
.dzhome .state .figs{display:flex;align-items:center;gap:0;margin-top:18px}
.dzhome .state .fig{flex:1;min-width:0}
.dzhome .state .fig .fl{font-size:11.5px;color:var(--ink2);font-weight:500;display:flex;align-items:center;gap:6px}
.dzhome .state .fig .fl .dot{width:8px;height:8px;border-radius:3px}
.dzhome .state .fig .fv{font-family:var(--font-rubik),'Rubik',sans-serif;font-weight:700;font-size:19px;letter-spacing:-.02em;margin-top:5px}
.dzhome .state .vr{width:1px;height:34px;background:#E3DFD2;margin:0 18px;flex:0 0 auto}

/* section head */
.dzhome .sh{display:flex;align-items:center;justify-content:space-between;margin:0 4px 12px}
.dzhome .sh .ttl{font-size:14.5px;font-weight:700}
.dzhome .sh .lnk{font-size:12px;color:var(--brand);font-weight:600;cursor:pointer;text-decoration:none}

/* tools — colorful round tiles, horizontal scroll */
.dzhome .feats{display:flex;gap:15px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;padding:2px 0 8px;margin-bottom:22px;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch}
.dzhome .feats::-webkit-scrollbar{display:none}
.dzhome .ft{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:9px;width:62px;cursor:pointer;scroll-snap-align:start;text-decoration:none}
.dzhome .ft .fc{width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 18px -12px rgba(80,60,30,.4),var(--hl)}
.dzhome .ft .fc svg{width:27px;height:27px}
.dzhome .ft span{font-size:11px;color:#6b6353;font-weight:600;text-align:center;white-space:nowrap}
.dzhome .c-teal{background:#E3F0EC;color:#2E7C6E}
.dzhome .c-sage{background:#E7EFE0;color:#4F7A52}
.dzhome .c-amber{background:#F8EBD2;color:#B8801F}
.dzhome .c-clay{background:#F8E7DE;color:#B0654A}
.dzhome .c-slate{background:#E7EDF1;color:#4E6C7E}

/* התובנות של דוביז — deep card, the only dark surface */
.dzhome .ins{position:relative;border-radius:26px;padding:19px 20px 17px;overflow:hidden;
  background:linear-gradient(155deg,#22544E 0%,#1A4340 55%,#153A3A 100%);
  box-shadow:0 22px 44px -22px rgba(18,52,52,.75),inset 0 1px 0 rgba(255,255,255,.09)}
.dzhome .ins::before{content:"";position:absolute;top:-70px;left:-50px;width:210px;height:210px;border-radius:50%;
  background:radial-gradient(circle,rgba(95,206,176,.26),transparent 68%);pointer-events:none}
.dzhome .ins::after{content:"";position:absolute;right:-40px;bottom:-80px;width:190px;height:190px;border-radius:50%;
  background:radial-gradient(circle,rgba(200,150,70,.12),transparent 70%);pointer-events:none}
.dzhome .ins>*{position:relative;z-index:1}
.dzhome .ins .ih{display:flex;align-items:center;gap:11px;margin-bottom:6px}
.dzhome .ins .ih .ic{width:36px;height:36px;border-radius:12px;background:linear-gradient(150deg,#5FCEB0,#2E9A85);
  display:flex;align-items:center;justify-content:center;flex:0 0 auto;
  box-shadow:0 8px 20px -6px rgba(46,154,133,.5),inset 0 1px 0 rgba(255,255,255,.4)}
.dzhome .ins .ih .ic svg{width:19px;height:19px;color:#0F3A34}
.dzhome .ins .ih .iht{flex:1;min-width:0}
.dzhome .ins .ih b{font-size:15px;font-weight:700;color:#EAF7F2;display:block;letter-spacing:-.01em}
.dzhome .ins .ih span{font-size:11px;color:#7FA9A4;display:block;margin-top:1px}
.dzhome .ins .ih .cnt{font-size:11px;font-weight:700;color:#7FDCC2;background:rgba(95,206,176,.12);
  border:1px solid rgba(95,206,176,.22);padding:4px 9px;border-radius:999px;flex:0 0 auto}
.dzhome .ins .ir{display:flex;align-items:center;gap:13px;padding:14px 0;border-bottom:1px solid rgba(255,255,255,.07)}
.dzhome .ins .ir:last-child{border-bottom:none;padding-bottom:3px}
.dzhome .ins .ir .ipin{width:6px;height:6px;border-radius:50%;background:#5FCEB0;flex:0 0 auto;
  box-shadow:0 0 0 4px rgba(95,206,176,.13)}
.dzhome .ins .ir .ipin.amber{background:#DCAA5E;box-shadow:0 0 0 4px rgba(200,150,70,.13)}
.dzhome .ins .ir .it{flex:1;min-width:0;font-size:13.5px;font-weight:600;color:#E4F1EC;line-height:1.4}
.dzhome .ins .ir .it small{display:block;font-weight:500;color:#7FA9A4;font-size:11.5px;margin-top:3px}
.dzhome .ins .ir .ib2{background:rgba(255,255,255,.1);color:#EAF7F2;border:1px solid rgba(255,255,255,.16);
  font-family:inherit;font-weight:700;font-size:12.5px;padding:9px 15px;border-radius:12px;cursor:pointer;flex:0 0 auto;
  transition:background .15s;text-decoration:none;display:inline-block}
.dzhome .ins .ir .ib2:hover{background:rgba(255,255,255,.17)}
.dzhome .ins .ir .ib2.go{background:linear-gradient(150deg,#5FCEB0,#2E9A85);color:#0F3A34;border:none;
  box-shadow:0 8px 18px -8px rgba(46,154,133,.6)}

/* entrance */
.dzhome .anim{opacity:0;animation:dzhome-rise .55s cubic-bezier(.2,.75,.25,1) forwards}
@keyframes dzhome-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.dzhome .d0{animation-delay:.05s}
.dzhome .d1{animation-delay:.14s}
.dzhome .d2{animation-delay:.23s}
.dzhome .d3{animation-delay:.32s}
@media (prefers-reduced-motion:reduce){.dzhome .anim{animation:none;opacity:1}}
`;
