"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { IconBell, IconSettings } from "@/components/navigation/nav-icons";
import { greetingForHour } from "@/features/home/lib/home-model";
import { useMediaQuery } from "@/lib/ui/use-breakpoint";

import { CashflowCard, type CashflowVariant } from "./cashflow-card";
import { DesktopHome } from "./desktop-home";
import { SetupCard } from "./setup-card";
import {
  ActivityList,
  FeatureTiles,
  HOME_CSS,
  INK,
  InsightCard,
  LINE,
  CARD,
  MUTED,
  Note,
  SkeletonBlock,
  WaitingCard,
  WaitingHeading,
} from "./home-parts";
import {
  FAILED,
  LOADING,
  buildActivity,
  buildDaySeries,
  buildWaiting,
  formatLongDate,
  formatWhen,
  israelHour,
  ready,
  valueOf,
  type ActivityItem,
  type CashflowPeriod,
  type CashflowSeries,
  type Load,
  type WaitingModel,
} from "./home-v3-model";
import type { HomeData } from "./use-home-data";

/**
 * HOME v3 — one Home, three layouts (approved references):
 *   < 768      MobileHome   (mobile.html, 390)
 *   768–1279   TabletHome   (tablet.html, 1194)
 *   ≥ 1280     DesktopHome  (desktop.html, 1440)
 *
 * The view below is assembled ONCE from the single data read, and every
 * layout receives the same `HomeView`. Layouts decide arrangement only.
 */

export type HomeView = {
  now: Date;
  greeting: string;
  dateLine: string;
  businessName: string;
  ownerInitial: string;
  hasUnread: boolean;
  day: Load<CashflowSeries>;
  week: Load<CashflowSeries> | null;
  period: CashflowPeriod;
  onPeriodChange: (next: CashflowPeriod) => void;
  waiting: Load<WaitingModel>;
  /** Some waiting source failed — the list shown is what could be read. */
  waitingPartial: boolean;
  activity: Load<ActivityItem[]>;
  when: (iso: string) => string;
  data: HomeData;
};

export const DESKTOP_QUERY = "(min-width: 1280px)";
const TABLET_QUERY = "(min-width: 768px)";

function allSettled(...loads: Load<unknown>[]): "loading" | "failed" | "ready" {
  if (loads.some((l) => l.state === "loading")) return "loading";
  if (loads.every((l) => l.state === "failed")) return "failed";
  return "ready";
}

export function HomeV3({
  data,
  loadWeek,
  businessName,
  ownerName,
}: {
  data: HomeData;
  loadWeek: () => void;
  businessName: string;
  ownerName: string;
}) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const tablet = useMediaQuery(TABLET_QUERY);
  const [period, setPeriod] = useState<CashflowPeriod>("day");

  // One clock per render pass, so every "today" on the screen agrees.
  const [now] = useState(() => new Date());

  const view = useMemo<HomeView>(() => {
    const costToday = data.cost.state === "ready" ? data.cost.value.periods.today.cashOut : null;
    const day: Load<CashflowSeries> =
      data.dayIncome.state === "ready"
        ? data.cost.state === "loading"
          ? LOADING
          : ready(buildDaySeries({ hours: data.dayIncome.value.hours, incomeTotal: data.dayIncome.value.total, expenseToday: costToday, now }))
        : data.dayIncome;

    const waitingState = allSettled(data.briefing, data.status, data.collection);
    const waiting: Load<WaitingModel> =
      waitingState === "ready"
        ? ready(
            buildWaiting({
              briefing: valueOf(data.briefing),
              status: valueOf(data.status),
              collectionWaiting: valueOf(data.collection)?.waiting ?? null,
              now,
            }),
          )
        : waitingState === "loading"
          ? LOADING
          : FAILED;
    const waitingPartial =
      waitingState === "ready" && [data.briefing, data.status, data.collection].some((l) => l.state === "failed");

    const activityState = allSettled(data.collection, data.leads, data.documents);
    const activity: Load<ActivityItem[]> =
      activityState === "ready"
        ? ready(
            buildActivity({
              paid: valueOf(data.collection)?.paid ?? null,
              leads: valueOf(data.leads),
              documents: valueOf(data.documents)?.items ?? null,
              limit: 3,
            }),
          )
        : activityState === "loading"
          ? LOADING
          : FAILED;

    return {
      now,
      greeting: greetingForHour(israelHour(now)),
      dateLine: formatLongDate(now),
      businessName,
      ownerInitial: ownerName.trim().charAt(0) || businessName.trim().charAt(0),
      hasUnread: data.unread,
      day,
      week: data.week,
      // A week that could not be read hands the card back to the day (and the
      // week tab turns disabled — see PeriodSwitch).
      period: period === "week" && data.week?.state === "failed" ? "day" : period,
      onPeriodChange: (next) => {
        if (next === "week") loadWeek();
        setPeriod(next);
      },
      waiting,
      waitingPartial,
      activity,
      when: (iso) => formatWhen(iso, now),
      data,
    };
  }, [data, now, businessName, ownerName, period, loadWeek]);

  return (
    <div
      className="dzh-root"
      dir="rtl"
      style={{
        minHeight: "100vh",
        background: "#FEF8F2",
        color: INK,
        fontFamily: "var(--font-rubik), 'Heebo', system-ui, sans-serif",
        overflowX: "hidden",
        // The references use the browser default line height, not the app's 1.5.
        lineHeight: "normal",
      }}
    >
      <style>{HOME_CSS}</style>
      {desktop ? <DesktopHome view={view} /> : tablet ? <TabletHome view={view} /> : <MobileHome view={view} />}
    </div>
  );
}

/* --------------------------------------------------------------- shared -- */

function Cashflow({ view, variant }: { view: HomeView; variant: CashflowVariant }) {
  return <CashflowCard variant={variant} day={view.day} week={view.week} period={view.period} onPeriodChange={view.onPeriodChange} />;
}

function WaitingGrid({ view, tablet }: { view: HomeView; tablet?: boolean }) {
  const gap = tablet ? 12 : 8;
  const w = view.waiting;
  let body;
  if (w.state === "loading") {
    body = (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap }}>
        <SkeletonBlock h={176} r={tablet ? 20 : 18} />
        <SkeletonBlock h={176} r={tablet ? 20 : 18} />
        <SkeletonBlock h={176} r={tablet ? 20 : 18} />
      </div>
    );
  } else if (w.state === "failed") {
    body = <Note>לא הצלחתי לבדוק כרגע מה מחכה לך.</Note>;
  } else if (w.value.items.length === 0) {
    body = (
      <div style={{ borderRadius: tablet ? 20 : 18, padding: 16, background: CARD, border: `1px solid ${LINE}`, fontSize: 14, color: MUTED }} role="status">
        {w.value.total.exact ? "אין כרגע משהו שמחכה לך." : "לא נמצא כרגע משהו שמחכה לך."}
      </div>
    );
  } else {
    body = (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap }}>
        {w.value.items.slice(0, 3).map((item) => (
          <WaitingCard key={item.id} item={item} tablet={tablet} />
        ))}
      </div>
    );
  }
  return (
    <section aria-label="מה ממתין לך" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <WaitingHeading waiting={w} tablet={tablet} />
      {body}
      {view.waitingPartial ? <Note style={{ padding: 0 }}>חלק מהמקורות לא נטענו, אז ייתכן שיש עוד.</Note> : null}
    </section>
  );
}

function RoundIconLink({ href, label, children, dot }: { href: string; label: string; children: React.ReactNode; dot?: boolean }) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-label={dot ? `${label} — יש התראות שלא נקראו` : label}
      style={{
        width: 44,
        height: 44,
        borderRadius: 999,
        border: `1px solid ${LINE}`,
        background: CARD,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        color: INK,
        boxSizing: "border-box",
      }}
    >
      {children}
      {dot ? (
        <span style={{ position: "absolute", top: 10, left: 11, width: 8, height: 8, borderRadius: 999, background: "#D2553D", border: `2px solid ${CARD}` }} />
      ) : null}
    </Link>
  );
}

/* --------------------------------------------------------------- mobile -- */

function MobileHome({ view }: { view: HomeView }) {
  return (
    <main style={{ display: "flex", flexDirection: "column", paddingBottom: 24 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 20px 8px 20px", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: MUTED }}>
            {view.greeting} · {view.dateLine}
          </div>
          {/* TODO(future): business switcher — one business per user today. */}
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: -0.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {view.businessName}
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <RoundIconLink href="/notifications" label="התראות" dot={view.hasUnread}>
            <IconBell size={20} />
          </RoundIconLink>
          <RoundIconLink href="/settings" label="הגדרות">
            <IconSettings size={20} />
          </RoundIconLink>
        </div>
      </header>

      <SetupCard setup={view.data.setup} variant="mobile" style={{ margin: "12px 20px 0 20px" }} />

      <div style={{ margin: "12px 20px 0 20px" }}>
        <Cashflow view={view} variant="mobile" />
      </div>

      <div style={{ margin: "28px 20px 0 20px" }}>
        <WaitingGrid view={view} />
      </div>

      <div style={{ margin: "28px 20px 0 20px" }}>
        <FeatureTiles height={132} gap={8} />
      </div>

      <div style={{ margin: "28px 20px 0 20px" }}>
        <ActivityList activity={view.activity} variant="flat" when={view.when} />
      </div>

      <InsightCard insight={view.data.insight} style={{ margin: "24px 20px 0 20px" }} />
    </main>
  );
}

/* --------------------------------------------------------------- tablet -- */

function TabletHome({ view }: { view: HomeView }) {
  return (
    <main style={{ boxSizing: "border-box", padding: 28, display: "flex", flexDirection: "column", gap: 22 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: MUTED }}>
            {view.greeting} · {view.dateLine}
          </div>
          {/* TODO(future): business switcher — one business per user today. */}
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: -0.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {view.businessName}
          </h1>
        </div>
        <span dir="ltr" aria-hidden style={{ fontSize: 24, fontWeight: 600, color: "#246966", letterSpacing: -0.5 }}>
          dubiz
        </span>
      </header>

      <SetupCard setup={view.data.setup} variant="tablet" />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.45fr) minmax(0, 1fr)", gap: 22, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 22, minWidth: 0 }}>
          <Cashflow view={view} variant="tablet" />
          <WaitingGrid view={view} tablet />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22, minWidth: 0 }}>
          <FeatureTiles height={136} gap={10} />
          <InsightCard insight={view.data.insight} />
          <ActivityList activity={view.activity} variant="boxed" when={view.when} />
        </div>
      </div>
    </main>
  );
}
