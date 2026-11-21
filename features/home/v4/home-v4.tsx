"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import { DAY_CALENDAR_FALLBACK } from "@/components/navigation/use-nav-href";
import { greetingForHour } from "@/features/home/lib/home-model";
import type { MessageKey } from "@/lib/i18n/translate";

import {
  COLLECTION_WAITING_CAP,
  FAILED,
  LOADING,
  buildActivity,
  buildWaiting,
  israelDateKey,
  israelHour,
  leadsWaitingClaim,
  ready,
  stockAlertsClaim,
  valueOf,
  type ActivityItem,
  type CountClaim,
  type Load,
  type WaitingModel,
} from "../v3/home-v3-model";
import type { HomeAccess } from "./home-access";
import {
  IconArrowForward,
  IconBars,
  IconBellLine,
  IconBulb,
  IconCalendar,
  IconCalendarCheck,
  IconChevronDown,
  IconChevronForward,
  IconClipboard,
  IconCoins,
  IconLayers,
  IconMore,
  IconRetry,
  IconSliders,
  IconSparkle,
  IconUser,
  IconUsers,
  IconWallet,
  IconFile,
  IconWrench,
  SecretaryMascot,
} from "./home-v4-icons";
import { useHomePref } from "./home-prefs";
import {
  FOR_YOU_TYPES,
  METRICS,
  buildForYou,
  cappedText,
  pruneDismissals,
  buildSecretary,
  buildToday,
  countMetric,
  metricLabelKey,
  metricOrder,
  moneyMetric,
  restOfDayLine,
  type ForYouPrefs,
  type ForYouType,
  type MetricKey,
  type MetricValue,
  type SecretaryDismissals,
  type Source,
  type TodayView,
} from "./home-v4-model";
import type { HomeV4Data } from "./use-home-v4-data";

/* ================================================================ styles == */

export const HOME_V4_CSS = `
.h4 {
  --h4-bg:#F6F3EC; --h4-card:#FFFDF8; --h4-teal:#2F615C; --h4-teal-deep:#1F4A46; --h4-sage:#D3E6DC; --h4-sage-2:#B8D6C7;
  --h4-sky:#DFEAF4; --h4-mustard:#F1CC76; --h4-ink:#23302B; --h4-muted:#566159; --h4-line:#E3E5DD;
  --h4-shadow:0 1px 2px rgba(35,48,43,.04), 0 12px 28px -20px rgba(35,48,43,.28);
  position:relative; min-height:100vh; background:var(--h4-bg); color:var(--h4-ink); overflow-x:hidden;
  font-family:var(--font-rubik),'Heebo',system-ui,sans-serif; line-height:1.35;
}
.h4 *, .h4 *::before, .h4 *::after { box-sizing:border-box; }
.h4-blob { position:absolute; pointer-events:none; border-radius:50%; filter:blur(2px); }
.h4-col { position:relative; max-width:600px; margin:0 auto; padding:14px 14px 8px; display:flex; flex-direction:column; gap:12px; }
/* FREE_LIMITED status line (owner decision 3): one quiet line under the greeting, inside the header area. */
.h4-status { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; padding:8px 8px 8px 14px; border-radius:16px; background:#FBF7EF; border:1px solid #E6D7BE; color:#815A32; font-size:14px; }
.h4-status a { display:inline-flex; align-items:center; min-height:40px; padding:0 8px; color:var(--h4-teal-deep); font-weight:600; text-decoration:none; white-space:nowrap; }
.h4-header { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:6px 4px 2px; }
.h4-head { display:flex; flex-direction:column; }
.h4-hello { min-width:0; flex:1 1 auto; }
.h4-greet { font-size:17px; color:var(--h4-ink); display:flex; align-items:center; gap:6px; }
.h4-name { margin:2px 0 0; font-size:28px; font-weight:700; letter-spacing:-.3px; line-height:1.15; overflow-wrap:anywhere; }
.h4-hbtns { display:flex; gap:10px; flex-shrink:0; }
.h4-round { position:relative; width:48px; height:48px; border-radius:999px; display:flex; align-items:center; justify-content:center; color:var(--h4-ink); text-decoration:none; }
.h4-round--profile { background:var(--h4-card); box-shadow:var(--h4-shadow); }
.h4-round--bell { background:rgba(255,253,248,.55); }
.h4-dot { position:absolute; top:4px; inset-inline-end:4px; width:11px; height:11px; border-radius:999px; border:2px solid var(--h4-bg); }
.h4-card { position:relative; overflow:hidden; background:var(--h4-card); border:1px solid rgba(227,229,221,.75); border-radius:24px; box-shadow:var(--h4-shadow); padding:12px 16px 14px; }
.h4-chead { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:40px; }
.h4-ctitle { display:flex; align-items:center; gap:8px; margin:0; font-size:17px; font-weight:700; color:var(--h4-ink); }
.h4-ctitle svg { color:var(--h4-teal); flex-shrink:0; }
.h4-iconbtn { width:42px; height:42px; border-radius:999px; border:0; background:#EFEDE6; color:var(--h4-ink); display:flex; align-items:center; justify-content:center; cursor:pointer; padding:0; flex-shrink:0; }
.h4-iconbtn--ghost { background:transparent; }
.h4-tiles { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:10px; margin-top:8px; }
.h4-tiles--one { grid-template-columns:minmax(0,1fr); }
.h4-tile { position:relative; overflow:hidden; display:flex; flex-direction:column; justify-content:space-between; gap:4px; min-height:80px; padding:10px 14px; border-radius:18px; color:var(--h4-ink); text-decoration:none; box-shadow:0 6px 16px -14px rgba(35,48,43,.45); }
.h4-tile--a { background:linear-gradient(160deg,#EDF4EF 0%, #E2EEE6 100%); }
.h4-tile--b { background:linear-gradient(160deg,#EEF4FA 0%, var(--h4-sky) 100%); }
.h4-tile::after { content:""; position:absolute; inset-inline-end:-30px; bottom:-46px; width:120px; height:90px; border-radius:50%; background:rgba(255,255,255,.45); }
.h4-tile-label { position:relative; z-index:1; display:flex; align-items:center; gap:6px; font-size:14px; color:var(--h4-ink); }
.h4-tile-label svg { color:var(--h4-teal); flex-shrink:0; }
.h4-tile-value { position:relative; z-index:1; font-size:clamp(24px, 7.6vw, 32px); font-weight:700; letter-spacing:-.5px; line-height:1.1; text-align:end; direction:ltr; unicode-bidi:isolate; white-space:nowrap; }
.h4-tile-value--long { font-size:clamp(20px, 6.2vw, 26px); }
.h4-tile-note { position:relative; z-index:1; font-size:12px; color:var(--h4-muted); text-align:end; }
.h4-more { display:flex; align-items:center; justify-content:center; gap:6px; width:100%; min-height:40px; margin-top:4px; margin-bottom:-6px; border:0; background:transparent; color:var(--h4-ink); font:inherit; font-size:15px; cursor:pointer; }
.h4-more svg { transition:transform .2s ease; }
.h4-more[aria-expanded="true"] svg { transform:rotate(180deg); }
.h4-mlist { list-style:none; margin:2px 0 0; padding:0; display:flex; flex-direction:column; }
.h4-mrow { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:56px; padding:8px 4px; border-top:1px solid var(--h4-line); color:inherit; text-decoration:none; }
.h4-mrow-text { min-width:0; }
.h4-mrow-label { font-size:15px; font-weight:600; }
.h4-mrow-meaning { font-size:12.5px; color:var(--h4-muted); }
.h4-mrow-value { font-size:18px; font-weight:700; direction:ltr; unicode-bidi:isolate; white-space:nowrap; }
.h4-sec { background:linear-gradient(150deg,#E4EFE8 0%, var(--h4-sage) 55%, #CBE1D5 100%); border-color:rgba(184,214,199,.6); }
.h4-sec::before { content:""; position:absolute; inset-inline-end:-60px; top:-80px; width:220px; height:200px; border-radius:50%; background:rgba(255,255,255,.28); }
.h4-chip { display:inline-flex; align-items:center; gap:7px; min-height:32px; padding:4px 12px; border-radius:999px; background:rgba(255,253,248,.85); color:var(--h4-ink); font-size:14px; font-weight:600; text-decoration:none; white-space:nowrap; }
.h4-chip-dot { width:9px; height:9px; border-radius:999px; background:var(--h4-mustard); }
.h4-sec-body { position:relative; z-index:1; display:flex; align-items:center; gap:4px; margin-top:2px; }
.h4-sec-text { flex:1 1 auto; min-width:0; }
.h4-sec-title { margin:0; font-size:19px; font-weight:700; line-height:1.3; overflow-wrap:anywhere; }
.h4-sec-desc { margin:4px 0 0; font-size:14px; color:var(--h4-muted); line-height:1.45; }
.h4-sec-actions { display:flex; flex-wrap:wrap; align-items:center; gap:2px 12px; margin-top:10px; }
.h4-btn { display:inline-flex; align-items:center; justify-content:center; gap:10px; min-height:44px; padding:8px 22px; border-radius:999px; border:0; background:var(--h4-teal); color:#FFFFFF; font:inherit; font-size:15px; font-weight:600; text-decoration:none; cursor:pointer; box-shadow:0 8px 18px -12px rgba(31,74,70,.8); }
.h4-btn:active { background:var(--h4-teal-deep); }
.h4-textbtn { min-height:44px; padding:0 4px; border:0; background:transparent; color:var(--h4-muted); font:inherit; font-size:14px; cursor:pointer; text-decoration:underline; text-underline-offset:3px; }
.h4-mascot-wrap { flex-shrink:0; order:2; width:clamp(84px, 24vw, 116px); margin-inline-end:-6px; }
.h4-mascot-wrap svg { width:100%; height:auto; display:block; }
.h4-next { display:flex; align-items:center; gap:12px; margin-top:6px; padding:10px 12px; border-radius:18px; background:#F3F0E8; color:inherit; text-decoration:none; }
.h4-time { flex-shrink:0; min-width:72px; padding:8px 12px; border-radius:999px; background:var(--h4-sky); color:var(--h4-teal-deep); font-size:18px; font-weight:700; text-align:center; direction:ltr; }
.h4-time--day { font-size:14px; }
.h4-next-text { flex:1 1 auto; min-width:0; }
.h4-next-title { font-size:16px; font-weight:700; overflow-wrap:anywhere; }
.h4-next-sub { font-size:13px; color:var(--h4-muted); }
.h4-next svg.h4-fwd, .h4-btn svg.h4-fwd, .h4-link svg.h4-fwd { flex-shrink:0; }
[dir="ltr"] .h4 svg.h4-fwd { transform:scaleX(-1); }
.h4-rest { display:flex; align-items:center; gap:8px; margin-top:10px; font-size:14px; color:var(--h4-ink); }
.h4-rest svg { color:var(--h4-teal); flex-shrink:0; }
.h4-quiet { display:flex; align-items:center; gap:10px; margin-top:8px; padding:10px 12px; border-radius:16px; background:#F3F0E8; font-size:14px; color:var(--h4-muted); }
.h4-quiet strong { color:var(--h4-ink); font-weight:600; }
.h4-fy { display:flex; align-items:center; gap:14px; margin-top:2px; }
.h4-fy-text { flex:1 1 auto; min-width:0; }
.h4-fy-eyebrow { font-size:12.5px; color:var(--h4-teal); font-weight:600; }
.h4-fy-title { margin:2px 0 0; font-size:17px; font-weight:700; line-height:1.3; overflow-wrap:anywhere; }
.h4-fy-desc { margin:4px 0 0; font-size:14px; color:var(--h4-muted); line-height:1.45; }
.h4-fy-side { display:flex; align-items:center; gap:14px; flex-shrink:0; }
.h4-fy-rule { width:1px; height:64px; background:var(--h4-line); }
.h4-bulb { width:56px; height:56px; border-radius:999px; background:#F8E3AE; color:var(--h4-ink); display:flex; align-items:center; justify-content:center; }
.h4-link { display:inline-flex; align-items:center; gap:8px; min-height:44px; margin-top:0; color:var(--h4-teal); font-size:15px; font-weight:700; text-decoration:none; }
.h4-menu { position:absolute; z-index:5; inset-inline-end:12px; top:54px; min-width:200px; padding:6px; border-radius:16px; background:var(--h4-card); border:1px solid var(--h4-line); box-shadow:0 14px 34px -14px rgba(35,48,43,.35); display:flex; flex-direction:column; }
.h4-menu button { min-height:44px; padding:0 12px; border:0; background:transparent; font:inherit; font-size:15px; color:var(--h4-ink); text-align:start; border-radius:10px; cursor:pointer; }
.h4-menu button:hover { background:#F3F0E8; }
.h4-note { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px; padding:10px 12px; border-radius:14px; background:#F8F1EE; color:#7A3E2E; font-size:14px; }
.h4-note button { display:inline-flex; align-items:center; gap:6px; min-height:40px; border:0; background:transparent; color:var(--h4-teal-deep); font:inherit; font-size:14px; font-weight:600; cursor:pointer; }
.h4-partial { margin-top:8px; font-size:12.5px; color:var(--h4-muted); }
.h4-sk { border-radius:16px; background:linear-gradient(90deg,#EFEBE2 0%,#F6F2EA 50%,#EFEBE2 100%); background-size:200% 100%; animation:h4-sk 1.4s ease-in-out infinite; }
@keyframes h4-sk { 0% { background-position:100% 0; } 100% { background-position:-100% 0; } }
.h4-sheet { padding:4px 4px 8px; color:var(--h4-ink); font-family:var(--font-rubik),'Heebo',system-ui,sans-serif; }
.h4-sheet h2 { margin:0 0 4px; font-size:18px; font-weight:700; }
.h4-sheet p { margin:0 0 12px; font-size:14px; color:var(--h4-muted); }
.h4-opt { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; min-height:52px; padding:8px 12px; margin-bottom:8px; border-radius:14px; border:1px solid var(--h4-line); background:#FFFFFF; font:inherit; font-size:15px; color:var(--h4-ink); text-align:start; cursor:pointer; }
.h4-opt[aria-pressed="true"], .h4-opt[aria-checked="true"] { border-color:var(--h4-teal); background:#EEF5F1; }
.h4-badge { font-size:12px; font-weight:600; padding:3px 10px; border-radius:999px; background:var(--h4-teal); color:#FFFFFF; }
.h4-sheet-foot { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:8px; }
.h4 a:focus-visible, .h4 button:focus-visible, .h4-sheet button:focus-visible { outline:2px solid var(--h4-teal); outline-offset:2px; }
@media (min-width: 768px) { .h4-col { padding-top:28px; gap:16px; } .h4-card { padding:20px; } }
/* Wider screens (owner 11-19): the SAME four areas and order, arranged — never more of them. Phones (<768) keep the
   approved single column above. Areas: the header, תמונת מצב, המזכירה שלי, היום שלי, בשבילך (absent when it has
   nothing true to show — the grid then closes the gap). Scoped to .h4-home: the tools screens share .h4-col. The shell supplies the navigation: rail 768–1279, sidebar 1280+. */
.h4-head { grid-area:head; } .h4-a-snap { grid-area:snap; } .h4-sec { grid-area:sec; } .h4-a-today { grid-area:today; } .h4-a-fy { grid-area:fy; }
@media (min-width: 768px) {
  /* Narrow tablet (portrait, beside the rail): one wider column — two would squeeze the secretary under ~300px. */
  .h4-home { max-width:680px; padding-inline:24px; display:grid; grid-template-columns:minmax(0,1fr);
    grid-template-areas:"head" "snap" "sec" "today" "fy"; }
}
@media (min-width: 900px) {
  /* Tablet with room (landscape, large portrait): two columns — the secretary and the day side by side, בשבילך below. */
  .h4-home { max-width:1040px; grid-template-columns:repeat(2, minmax(0,1fr)); grid-template-areas:"head head" "snap snap" "sec today" "fy fy"; }
}
@media (min-width: 1280px) {
  /* Desktop: three columns. The main pair holds תמונת מצב over המזכירה שלי (the secretary stays the visual lead, at a
     readable width); the side column holds היום שלי over בשבילך. Without בשבילך the day runs the full side column. */
  .h4-home { max-width:1480px; padding:36px 36px 28px; gap:20px; grid-template-columns:repeat(3, minmax(0,1fr));
    grid-template-areas:"head head head" "snap snap today" "sec sec fy"; }
  .h4-home:not(:has(.h4-a-fy)) { grid-template-areas:"head head head" "snap snap today" "sec sec today"; }
  .h4-home:not(:has(.h4-a-fy)) .h4-a-today { align-self:start; } /* its own height, not an empty tall card */
  .h4-card { padding:22px 24px; }
  .h4-name { font-size:32px; }
}
/* The tools screens ("הכלים שלי", "יכולות נוספות") on wide screens: a wider column, so the tile grid (auto-fill) gains
   columns instead of leaving a phone strip; the search stays at a readable width. */
@media (min-width: 1024px) { .h4-wide { max-width:1180px; padding-inline:32px; } .h4-wide .mt-search { max-width:520px; } }
@media (prefers-reduced-motion: reduce) { .h4-sk { animation:none; } .h4-more svg { transition:none; } }
`;

/* =============================================================== screen == */

export function HomeV4({ data, retry, businessName }: { data: HomeV4Data; retry: () => void; businessName: string }) {
  const { t, locale } = useI18n();
  const [now] = useState(() => new Date());
  const access = data.access;
  const businessId = access.state === "ready" ? access.value.businessId : null;

  return (
    <div className="h4">
      <style>{HOME_V4_CSS}</style>
      {/* The soft background shapes of the reference. */}
      <div className="h4-blob" aria-hidden style={{ width: 420, height: 300, top: -150, insetInlineEnd: -120, background: "radial-gradient(closest-side, rgba(211,230,220,.85), rgba(211,230,220,0))" }} />
      <div className="h4-blob" aria-hidden style={{ width: 300, height: 240, top: 30, insetInlineStart: -150, background: "radial-gradient(closest-side, rgba(223,234,244,.6), rgba(223,234,244,0))" }} />
      <main className="h4-col h4-home">
        <div className="h4-head">
        <header className="h4-header">
          <div className="h4-hello">
            <div className="h4-greet">
              <span>{greetingForHour(israelHour(now), t)}</span>
              <span aria-hidden>👋</span>
            </div>
            <h1 className="h4-name">{businessName}</h1>
          </div>
          <div className="h4-hbtns">
            <Link href="/notifications" prefetch={false} className="h4-round h4-round--bell" aria-label={data.unread ? t("home.v4.header.withUnread", { label: t("home.v4.header.updates") }) : t("home.v4.header.updates")}>
              <IconBellLine size={24} />
              {data.unread ? <span className="h4-dot" style={{ background: "var(--h4-mustard)" }} aria-hidden /> : null}
            </Link>
            <Link href="/profile" prefetch={false} className="h4-round h4-round--profile" aria-label={t("home.v4.header.profile")}>
              <IconUser size={24} />
            </Link>
          </div>
        </header>
        {/* FREE_LIMITED (owner decision 3): ONE status line — the first of the only two upgrade mentions. Never drawn
            while the subscription is not FREE_LIMITED (always, until the subscription mechanism exists). */}
        {access.state === "ready" && access.value.subscription === "FREE_LIMITED" ? (
          <div className="h4-status" role="status">
            <span>{t("home.v4.plan.statusLine")}</span>
            {access.value.planHref ? (
              <Link href={access.value.planHref} prefetch={false}>{t("home.v4.plan.statusLink")}</Link>
            ) : null}
          </div>
        ) : null}
        </div>

        <SnapshotCard data={data} businessId={businessId} retry={retry} locale={locale} />
        <SecretaryCard data={data} businessId={businessId} retry={retry} now={now} />
        <TodayCard data={data} retry={retry} now={now} />
        <ForYouCard data={data} businessId={businessId} now={now} />
      </main>
    </div>
  );
}

/* ============================================================ helpers == */

function Skeleton({ h, r = 16 }: { h: number; r?: number }) {
  return <div className="h4-sk" style={{ height: h, borderRadius: r }} aria-hidden />;
}

function FailedNote({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="h4-note" role="status">
      <span>{text}</span>
      <button type="button" onClick={onRetry}>
        <IconRetry size={16} />
        {t("home.v4.snapshot.retry")}
      </button>
    </div>
  );
}

/** A module source the area may draw from: "off" never reaches here for a metric (it is not in the order). */
function fromSource<T>(s: Source<T>): Load<T> {
  return s.state === "off" ? FAILED : s;
}

function waitingOf(data: HomeV4Data, now: Date, t: ReturnType<typeof useI18n>["t"], locale: ReturnType<typeof useI18n>["locale"]): { waiting: Load<WaitingModel>; partial: boolean } {
  const collection: Load<{ waiting: unknown[] } | null> = data.collection.state === "off" ? ready(null) : data.collection;
  const loads: Load<unknown>[] = [data.briefing, data.status, collection];
  if (loads.some((l) => l.state === "loading")) return { waiting: LOADING, partial: false };
  if (loads.every((l) => l.state === "failed")) return { waiting: FAILED, partial: false };
  const coll = valueOf(data.collection.state === "off" ? FAILED : data.collection);
  return {
    waiting: ready(
      buildWaiting({
        briefing: valueOf(data.briefing),
        status: valueOf(data.status),
        // A business without billing has no collection list: treated as known-empty, never as "failed".
        collectionWaiting: data.collection.state === "off" ? [] : coll?.waiting ?? null,
        now,
        t,
        locale,
      }),
    ),
    partial: loads.some((l) => l.state === "failed"),
  };
}

/* ============================================================ snapshot == */

const METRIC_ICON: Record<MetricKey, (p: { size?: number }) => React.ReactElement> = {
  receiptsMonth: IconCoins,
  receiptsToday: IconCoins,
  openService: IconWrench,
  todayTasks: IconClipboard,
  waitingLeads: IconUsers,
  toCollect: IconWallet,
  docsReview: IconFile,
  todayAppointments: IconCalendar,
  lowStock: IconLayers,
  readyForPickup: IconCalendarCheck,
};

function metricValue(key: MetricKey, data: HomeV4Data, now: Date, locale: ReturnType<typeof useI18n>["locale"]): MetricValue {
  switch (key) {
    case "receiptsMonth":
      return moneyMetric(data.receipts.state === "ready" ? ready(data.receipts.value.month) : data.receipts, locale);
    case "receiptsToday":
      return moneyMetric(data.receipts.state === "ready" ? ready(data.receipts.value.today) : data.receipts, locale);
    case "openService": {
      const s = fromSource(data.serviceCases);
      return countMetric(s.state === "ready" ? ready(s.value.open) : s);
    }
    case "readyForPickup": {
      const s = fromSource(data.serviceCases);
      return countMetric(s.state === "ready" ? ready(s.value.ready) : s);
    }
    case "lowStock":
      return countMetric(data.status.state === "ready" ? ready(stockAlertsClaim(data.status.value)) : data.status);
    case "todayTasks": {
      const a = fromSource(data.agenda);
      return countMetric(a.state === "ready" ? ready(a.value.count) : a);
    }
    case "waitingLeads":
      return countMetric(data.status.state === "ready" ? ready(leadsWaitingClaim(data.status.value)) : data.status);
    case "toCollect": {
      const c = fromSource(data.collection);
      return countMetric(c.state === "ready" ? ready<CountClaim>({ n: c.value.waiting.length, exact: c.value.waiting.length < COLLECTION_WAITING_CAP }) : c);
    }
    case "docsReview": {
      const d = fromSource(data.documents);
      return countMetric(d.state === "ready" ? ready<CountClaim>({ n: d.value.totalPendingReview, exact: true }) : d);
    }
    case "todayAppointments": {
      const a = fromSource(data.appointments);
      if (a.state !== "ready") return countMetric(a);
      const today = israelDateKey(now);
      const n = a.value.filter((x) => x.startsAt && (x.status === "PROPOSED" || x.status === "CONFIRMED") && x.kind !== "BLOCK" && israelDateKey(new Date(x.startsAt)) === today).length;
      return countMetric(ready({ n, exact: true }));
    }
  }
}

function SnapshotCard({ data, businessId, retry, locale }: { data: HomeV4Data; businessId: number | null; retry: () => void; locale: ReturnType<typeof useI18n>["locale"] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [chosen, setChosen] = useHomePref<string[] | null>(businessId, "metrics.primary", null);
  const [now] = useState(() => new Date());
  const listId = useId();

  const access = data.access;
  const order = access.state === "ready" ? metricOrder(access.value, chosen) : [];
  const primary = order.slice(0, 2);
  const secondary = order.slice(2);
  const label = (k: MetricKey) => t(metricLabelKey(k, access.state === "ready" ? access.value : null) as MessageKey);
  const meaning = (k: MetricKey) => t(`home.v4.snapshot.metric.${k}.meaning` as MessageKey);

  return (
    <section className="h4-card h4-a-snap" aria-labelledby="h4-snapshot-title">
      <div className="h4-chead">
        <h2 className="h4-ctitle" id="h4-snapshot-title">
          <IconBars size={22} />
          {t("home.v4.snapshot.title")}
        </h2>
        {access.state === "ready" && order.length > 2 ? (
          <button type="button" className="h4-iconbtn" aria-label={t("home.v4.snapshot.customize")} onClick={() => setCustomizing(true)}>
            <IconSliders size={20} />
          </button>
        ) : null}
      </div>

      {access.state === "loading" ? (
        <div className="h4-tiles">
          <Skeleton h={92} r={18} />
          <Skeleton h={92} r={18} />
        </div>
      ) : access.state === "failed" ? (
        <FailedNote text={t("home.v4.snapshot.failed")} onRetry={retry} />
      ) : (
        <>
          <div className={`h4-tiles${primary.length === 1 ? " h4-tiles--one" : ""}`}>
            {primary.map((k, i) => (
              <MetricTile key={k} k={k} tone={i === 0 ? "a" : "b"} value={metricValue(k, data, now, locale)} label={label(k)} meaning={meaning(k)} onRetry={retry} />
            ))}
          </div>
          {secondary.length > 0 ? (
            <>
              <button type="button" className="h4-more" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded((v) => !v)}>
                {expanded ? t("home.v4.snapshot.less") : t("home.v4.snapshot.more")}
                <IconChevronDown size={18} />
              </button>
              {expanded ? (
                <ul className="h4-mlist" id={listId}>
                  {secondary.map((k) => {
                    const v = metricValue(k, data, now, locale);
                    return (
                      <li key={k}>
                        <Link href={METRICS[k].href} prefetch={false} className="h4-mrow">
                          <span className="h4-mrow-text">
                            <span className="h4-mrow-label">{label(k)}</span>
                            <br />
                            <span className="h4-mrow-meaning">{meaning(k)}</span>
                          </span>
                          <span className="h4-mrow-value">{v.state === "ready" ? v.text : v.state === "loading" ? "…" : t("home.v4.snapshot.failed")}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </>
          ) : null}
          <MetricCustomizer
            open={customizing}
            onClose={() => setCustomizing(false)}
            order={order}
            primary={primary}
            label={label}
            onChange={setChosen}
          />
        </>
      )}
    </section>
  );
}

function MetricTile({ k, tone, value, label, meaning, onRetry }: { k: MetricKey; tone: "a" | "b"; value: MetricValue; label: string; meaning: string; onRetry: () => void }) {
  const { t } = useI18n();
  const Icon = METRIC_ICON[k];
  if (value.state === "loading") return <Skeleton h={92} r={18} />;
  if (value.state === "failed") {
    return (
      <div className={`h4-tile h4-tile--${tone}`} role="group" aria-label={`${label}: ${t("home.v4.snapshot.failed")}`}>
        <span className="h4-tile-label">
          <Icon size={20} />
          {label}
        </span>
        <button type="button" onClick={onRetry} className="h4-textbtn" style={{ position: "relative", zIndex: 1, alignSelf: "flex-end", minHeight: 36 }}>
          {t("home.v4.snapshot.failed")} · {t("home.v4.snapshot.retry")}
        </button>
      </div>
    );
  }
  const note = value.zero ? t(`home.v4.snapshot.metric.${k}.zero` as MessageKey) : value.mixed ? t("home.v4.snapshot.mixedCurrency") : null;
  return (
    <Link href={METRICS[k].href} prefetch={false} className={`h4-tile h4-tile--${tone}`} aria-label={`${label}: ${value.exact ? value.text : t("home.v4.snapshot.capped", { n: value.text.replace("+", "") })}. ${meaning}`}>
      <span className="h4-tile-label">
        <Icon size={20} />
        {label}
      </span>
      <span>
        {/* Long amounts (₪148,230) step down a size instead of breaking across lines. */}
        <span className={`h4-tile-value${value.text.length > 7 ? " h4-tile-value--long" : ""}`} style={{ display: "block" }}>{value.text}</span>
        {note ? <span className="h4-tile-note" style={{ display: "block" }}>{note}</span> : null}
      </span>
    </Link>
  );
}

function MetricCustomizer({ open, onClose, order, primary, label, onChange }: {
  open: boolean;
  onClose: () => void;
  order: MetricKey[];
  primary: MetricKey[];
  label: (k: MetricKey) => string;
  onChange: (next: string[] | null) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const toggle = (k: MetricKey) => {
    if (primary.includes(k)) {
      // Two main metrics always: un-choosing one promotes the next in line.
      const rest = primary.filter((p) => p !== k);
      const next = order.find((o) => o !== k && !rest.includes(o));
      onChange(next ? [...rest, next] : rest);
    } else {
      onChange([primary[1] ?? primary[0], k].filter(Boolean) as string[]);
    }
  };
  return (
    <AdaptiveOverlay open={open} onClose={onClose} variant="form" labelledBy={titleId}>
      <div className="h4 h4-sheet" style={{ minHeight: 0, background: "transparent" }}>
        <h2 id={titleId}>{t("home.v4.snapshot.customizeTitle")}</h2>
        <p>{t("home.v4.snapshot.customizeHint")}</p>
        <p style={{ fontSize: 12.5 }}>{t("home.v4.deviceNote")}</p>
        {order.map((k) => (
          <button key={k} type="button" className="h4-opt" aria-pressed={primary.includes(k)} onClick={() => toggle(k)}>
            <span>{label(k)}</span>
            {primary.includes(k) ? <span className="h4-badge">{t("home.v4.snapshot.primaryBadge")}</span> : null}
          </button>
        ))}
        <div className="h4-sheet-foot">
          <button type="button" className="h4-textbtn" onClick={() => onChange(null)}>
            {t("home.v4.snapshot.reset")}
          </button>
          <button type="button" className="h4-btn" onClick={onClose}>
            {t("home.v4.snapshot.done")}
          </button>
        </div>
      </div>
    </AdaptiveOverlay>
  );
}

/* =========================================================== secretary == */

/** READY service cases for the secretary (drawn only with activity packs — buildSecretary decides). */
function serviceReadyOf(data: HomeV4Data): { ids: number[]; exact: boolean } | null {
  return data.serviceCases.state === "ready" ? { ids: data.serviceCases.value.readyIds, exact: data.serviceCases.value.ready.exact } : null;
}

function SecretaryCard({ data, businessId, retry, now }: { data: HomeV4Data; businessId: number | null; retry: () => void; now: Date }) {
  const { t, locale } = useI18n();
  const [dismissals, setDismissals] = useHomePref<SecretaryDismissals>(businessId, "secretary.dismissals", {});
  const view = useMemo(() => {
    if (data.access.state !== "ready") return data.access.state === "failed" ? FAILED : LOADING;
    const { waiting, partial } = waitingOf(data, now, t, locale);
    return buildSecretary({ waiting, partial, access: data.access.value, history: valueOf(data.history), dismissals, now, t, serviceReady: serviceReadyOf(data) });
  }, [data, now, t, locale, dismissals]);

  const chip =
    view.state === "ready" ? (
      <Link href="/attention" prefetch={false} className="h4-chip" aria-label={`${t("home.v4.secretary.allUpdates")} — ${view.updates.n === 1 && view.updates.exact ? t("home.v4.secretary.updatesOne") : t("home.v4.secretary.updatesMany", { count: view.updates.exact ? view.updates.n : cappedText(view.updates.n) })}`}>
        <span className="h4-chip-dot" aria-hidden />
        {view.updates.n === 1 && view.updates.exact ? t("home.v4.secretary.updatesOne") : t("home.v4.secretary.updatesMany", { count: view.updates.exact ? view.updates.n : cappedText(view.updates.n) })}
      </Link>
    ) : null;

  let body: React.ReactNode;
  if (view.state === "loading") {
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
        <Skeleton h={22} r={8} />
        <Skeleton h={16} r={8} />
        <Skeleton h={44} r={999} />
      </div>
    );
  } else if (view.state === "failed") {
    body = (
      <SecretaryBody title={t("home.v4.secretary.failedTitle")} desc={t("home.v4.secretary.failedBody")}>
        <button type="button" className="h4-btn" onClick={retry}>
          <IconRetry size={18} />
          {t("home.v4.secretary.retry")}
        </button>
      </SecretaryBody>
    );
  } else if (view.state === "first") {
    body = (
      <SecretaryBody title={t("home.v4.secretary.first.title")} desc={t("home.v4.secretary.first.body")}>
        <Link href="/customers?new=1" prefetch={false} className="h4-btn">
          {t("home.v4.secretary.first.cta")}
          <IconArrowForward size={18} />
        </Link>
      </SecretaryBody>
    );
  } else if (view.state === "calm") {
    body = (
      <SecretaryBody
        title={view.exact ? t("home.v4.secretary.calmTitle") : t("home.v4.secretary.unsureTitle")}
        desc={view.exact ? t("home.v4.secretary.calmBody") : t("home.v4.secretary.unsureBody")}
      />
    );
  } else {
    const today = israelDateKey(now);
    body = (
      <SecretaryBody title={view.title} desc={view.body}>
        <Link href={view.href} prefetch={false} className="h4-btn">
          {view.cta}
          <IconArrowForward size={18} />
        </Link>
        <button
          type="button"
          className="h4-textbtn"
          onClick={() => setDismissals(pruneDismissals({ ...dismissals, [view.groupKey]: view.dismissMode === "later" ? { mode: "later", day: today } : { mode: "dismiss" } }, today))}
        >
          {view.dismissMode === "later" ? t("home.v4.secretary.later") : t("home.v4.secretary.dismiss")}
        </button>
      </SecretaryBody>
    );
  }

  return (
    <section className="h4-card h4-sec" aria-labelledby="h4-sec-title" aria-live="polite">
      <div className="h4-chead" style={{ position: "relative", zIndex: 1 }}>
        <h2 className="h4-ctitle" id="h4-sec-title">
          <IconSparkle size={24} />
          {t("home.v4.secretary.title")}
        </h2>
        {chip}
      </div>
      {body}
    </section>
  );
}

function SecretaryBody({ title, desc, children }: { title: string; desc: string; children?: React.ReactNode }) {
  return (
    <div className="h4-sec-body">
      <div className="h4-mascot-wrap">
        <SecretaryMascot />
      </div>
      <div className="h4-sec-text">
        <p className="h4-sec-title">{title}</p>
        <p className="h4-sec-desc">{desc}</p>
        {children ? <div className="h4-sec-actions">{children}</div> : null}
      </div>
    </div>
  );
}

/* =============================================================== today == */

function TodayCard({ data, retry, now }: { data: HomeV4Data; retry: () => void; now: Date }) {
  const { t } = useI18n();
  const view: TodayView = useMemo(() => {
    if (data.access.state === "loading") return { state: "loading" };
    if (data.access.state === "failed") return { state: "failed" };
    const agenda = data.agenda;
    return buildToday({
      appointments: data.appointments,
      tasks: agenda.state === "ready" ? ready(agenda.value.tasks) : agenda,
      now,
      t,
    });
  }, [data, now, t]);

  // Neither a calendar nor tasks are active (owner decision 18.11): the area keeps its place and leads to the
  // Secretary calendar — tasks, payments and due dates every business has. It claims nothing about the day itself.
  let body: React.ReactNode;
  if (view.state === "calendarOnly") {
    body = (
      <Link href={DAY_CALENDAR_FALLBACK} prefetch={false} className="h4-quiet" style={{ textDecoration: "none" }}>
        <IconCalendarCheck size={20} />
        <span style={{ flex: 1 }}>
          <strong>{t("home.v4.today.calendarOnly")}</strong> · {t("home.v4.today.calendarOnlyBody")}
        </span>
        <IconChevronForward size={20} />
      </Link>
    );
  } else if (view.state === "loading") body = <div style={{ marginTop: 10 }}><Skeleton h={68} r={18} /></div>;
  else if (view.state === "failed") body = <FailedNote text={t("home.v4.today.failed")} onRetry={retry} />;
  else if (!view.next) {
    body = (
      <div className="h4-quiet" role="status">
        <IconCalendarCheck size={20} />
        <span>
          <strong>{t("home.v4.today.empty")}</strong> · {t("home.v4.today.emptyBody")}
        </span>
      </div>
    );
  } else {
    const rest = restOfDayLine(view.restMeetings, view.restTasks, t);
    body = (
      <>
        <Link href={view.next.href} prefetch={false} className="h4-next">
          <span className={`h4-time${view.next.time ? "" : " h4-time--day"}`}>{view.next.time ?? t("home.v4.today.duringDay")}</span>
          <span className="h4-next-text">
            <span className="h4-next-title" style={{ display: "block" }}>{view.next.title}</span>
            <span className="h4-next-sub" style={{ display: "block" }}>
              {view.next.subtitle ? `${view.next.subtitle} · ` : ""}
              {t("home.v4.today.next")}
            </span>
          </span>
          <IconChevronForward size={22} />
        </Link>
        <div className="h4-rest">
          <IconCalendarCheck size={20} />
          <span>{rest ?? t("home.v4.today.restNone")}</span>
        </div>
      </>
    );
  }

  return (
    <section className="h4-card h4-a-today" aria-labelledby="h4-today-title">
      <div className="h4-chead">
        <h2 className="h4-ctitle" id="h4-today-title">
          <IconCalendar size={22} />
          {t("home.v4.today.title")}
        </h2>
      </div>
      {body}
      {view.state === "ready" && view.partial ? <p className="h4-partial">{t("home.v4.today.partial")}</p> : null}
    </section>
  );
}

/* ============================================================= for you == */

function activityOf(data: HomeV4Data, t: ReturnType<typeof useI18n>["t"], locale: ReturnType<typeof useI18n>["locale"]): Load<ActivityItem[]> {
  const paid = data.collection.state === "off" ? ready({ paid: [] }) : data.collection;
  const docs = data.documents.state === "off" ? ready({ items: [] }) : data.documents;
  const loads: Load<unknown>[] = [paid, data.leads, docs];
  if (loads.some((l) => l.state === "loading")) return LOADING;
  if (loads.every((l) => l.state === "failed")) return FAILED;
  return ready(
    buildActivity({
      paid: valueOf(paid as Load<{ paid: never[] }>)?.paid ?? null,
      leads: valueOf(data.leads),
      documents: (valueOf(docs as Load<{ items: never[] }>)?.items ?? null) as never,
      limit: 3,
      t,
      locale,
    }),
  );
}

function ForYouCard({ data, businessId, now }: { data: HomeV4Data; businessId: number | null; now: Date }) {
  const { t, locale } = useI18n();
  const [prefs, setPrefs] = useHomePref<ForYouPrefs>(businessId, "forYou", { hiddenTypes: [], dismissedIds: [] });
  const [secDismissals] = useHomePref<SecretaryDismissals>(businessId, "secretary.dismissals", {});
  const [menuOpen, setMenuOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const titleId = useId();

  const view = useMemo(() => {
    if (data.access.state !== "ready") return data.access.state === "failed" ? ({ state: "none" } as const) : ({ state: "loading" } as const);
    const access: HomeAccess = data.access.value;
    const { waiting, partial } = waitingOf(data, now, t, locale);
    const sec = buildSecretary({ waiting, partial, access, history: valueOf(data.history), dismissals: secDismissals, now, t, serviceReady: serviceReadyOf(data) });
    const today = buildToday({ appointments: data.appointments, tasks: { state: "off" }, now, t });
    return buildForYou({
      access,
      quotes: data.quotes,
      recommendation: data.recommendation,
      insight: data.insight,
      activity: activityOf(data, t, locale),
      history: data.history,
      secretaryKind: sec.state === "ready" ? sec.kind : null,
      hasAppointmentsToday: today.state === "ready" && today.next !== null,
      prefs,
      now,
      t,
    });
  }, [data, now, t, locale, prefs, secDismissals]);

  // Nothing true to offer: the area stays out of the way rather than filling a card.
  if (view.state === "none") return null;

  // FREE_LIMITED (owner decision 3): the area is one plan card — the second and last upgrade mention on the Home.
  if (view.state === "plan") {
    const planHref = data.access.state === "ready" ? data.access.value.planHref ?? null : null;
    return (
      <section className="h4-card h4-a-fy" aria-labelledby="h4-fy-title">
        <div className="h4-chead">
          <h2 className="h4-ctitle" id="h4-fy-title">
            <IconLayers size={22} />
            {t("home.v4.forYou.title")}
          </h2>
        </div>
        <div className="h4-fy">
          <div className="h4-fy-text">
            <div className="h4-fy-eyebrow">{t("home.v4.plan.eyebrow")}</div>
            <p className="h4-fy-title">{t("home.v4.plan.title")}</p>
            <p className="h4-fy-desc">{t("home.v4.plan.body")}</p>
            {planHref ? (
              <div className="h4-sec-actions">
                <Link href={planHref} prefetch={false} className="h4-btn">
                  {t("home.v4.plan.cta")}
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="h4-card h4-a-fy" aria-labelledby="h4-fy-title">
      <div className="h4-chead">
        <h2 className="h4-ctitle" id="h4-fy-title">
          <IconLayers size={22} />
          {t("home.v4.forYou.title")}
        </h2>
        {view.state === "ready" ? (
          <button type="button" className="h4-iconbtn h4-iconbtn--ghost" aria-label={t("home.v4.forYou.menu")} aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            <IconMore size={22} />
          </button>
        ) : null}
      </div>
      {menuOpen && view.state === "ready" ? (
        <div className="h4-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setPrefs({ ...prefs, dismissedIds: [...prefs.dismissedIds, view.item.id].slice(-50) }); setMenuOpen(false); }}>
            {t("home.v4.forYou.notRelevant")}
          </button>
          <button type="button" role="menuitem" onClick={() => { setPrefs({ ...prefs, hiddenTypes: [...new Set([...prefs.hiddenTypes, view.item.type])] }); setMenuOpen(false); }}>
            {t("home.v4.forYou.lessOfType")}
          </button>
          <button type="button" role="menuitem" onClick={() => { setCustomizing(true); setMenuOpen(false); }}>
            {t("home.v4.forYou.customizeTitle")}
          </button>
        </div>
      ) : null}
      {view.state === "loading" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          <Skeleton h={20} r={8} />
          <Skeleton h={16} r={8} />
        </div>
      ) : (
        <div className="h4-fy">
          <div className="h4-fy-text">
            {view.item.eyebrow ? <div className="h4-fy-eyebrow">{view.item.eyebrow}</div> : null}
            <p className="h4-fy-title">{view.item.title}</p>
            {view.item.body ? <p className="h4-fy-desc">{view.item.body}</p> : null}
            <Link href={view.item.href} prefetch={false} className="h4-link">
              {view.item.cta}
              <IconArrowForward size={18} />
            </Link>
          </div>
          <div className="h4-fy-side" aria-hidden>
            <span className="h4-fy-rule" />
            <span className="h4-bulb">
              <IconBulb size={28} />
            </span>
          </div>
        </div>
      )}
      <AdaptiveOverlay open={customizing} onClose={() => setCustomizing(false)} variant="form" labelledBy={titleId}>
        <div className="h4 h4-sheet" style={{ minHeight: 0, background: "transparent" }}>
          <h2 id={titleId}>{t("home.v4.forYou.customizeTitle")}</h2>
          <p style={{ fontSize: 12.5 }}>{t("home.v4.deviceNote")}</p>
          <div role="group" aria-labelledby={titleId} style={{ marginTop: 10 }}>
            {FOR_YOU_TYPES.map((type: ForYouType) => {
              const on = !prefs.hiddenTypes.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className="h4-opt"
                  onClick={() => setPrefs({ ...prefs, hiddenTypes: on ? [...prefs.hiddenTypes, type] : prefs.hiddenTypes.filter((x) => x !== type) })}
                >
                  <span>{t(`home.v4.forYou.type.${type}` as MessageKey)}</span>
                  <span aria-hidden>{on ? "✓" : ""}</span>
                </button>
              );
            })}
          </div>
          <div className="h4-sheet-foot">
            <span />
            <button type="button" className="h4-btn" onClick={() => setCustomizing(false)}>
              {t("home.v4.forYou.done")}
            </button>
          </div>
        </div>
      </AdaptiveOverlay>
    </section>
  );
}
