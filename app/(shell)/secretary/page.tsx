"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";
import {
  completeObligation,
  createObligation,
  fetchBriefing,
  fetchObligations,
  releaseObligation,
  snoozeObligation,
  updateObligation,
  type AttentionReason,
  type BriefingApi,
  type CreateObligationInput,
  type ObligationApi,
  type RecurrenceCadence,
  type UpdateObligationInput,
} from "@/lib/obligations/secretary-client";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import {
  SecretaryErrorBoundary,
  SecretaryFlowScreen,
  SecretaryHomeScreen,
  SecretaryHomeSkeleton,
  TodayScreen,
  type SecretaryHomeModel,
  type SecretaryLoopMode,
  type SecretaryScreenName,
  type TodayModel,
} from "./secretary-ui";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      briefing: BriefingApi;
      obligations: ObligationApi[];
      obligationsLimit: number;
      obligationsHasMore: boolean;
      obligationsLoading: boolean;
    };

// Load the full working set up front so summary counts/totals on the list
// screens match the briefing (home) exactly — a small page size truncated the
// "all obligations" summary and made it disagree with the home screen.
const INITIAL_OBLIGATION_LIMIT = 100;
const OBLIGATION_PAGE_SIZE = 100;

const RECURRENCE_LABEL: Record<RecurrenceCadence, string> = {
  NONE: "חד-פעמי",
  WEEKLY: "שבועי",
  MONTHLY: "חודשי",
  YEARLY: "שנתי",
};

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** A trustworthy display name — never surface an empty or junk obligee name. */
function displayObligeeName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length >= 2 ? trimmed : "התחייבות ללא שם";
}

function formatDueDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("he-IL", {
    day: "numeric",
    month: "long",
    weekday: "long",
  });
}

export default function SecretaryPage() {
  // useSearchParams() bails out of static prerendering unless wrapped in a
  // Suspense boundary — wrap the inner client screen so `next build` can
  // prerender the route (the skeleton is the natural fallback).
  return (
    <Suspense fallback={<SecretaryHomeSkeleton />}>
      <SecretaryPageInner />
    </Suspense>
  );
}

function SecretaryPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeKey = searchParams.toString();
  const tokenRef = useRef<string | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [flash, setFlash] = useState<string | null>(null);

  function currentRouteState() {
    const screen = parseSecretaryScreen(searchParams.get("screen"));
    const selectedId = parseOptionalNumber(searchParams.get("id"));
    const loopMode = parseLoopMode(searchParams.get("loopMode"));
    const showToday = searchParams.has("today");
    const prefillName = searchParams.get("name")?.trim() || undefined;
    return { screen, selectedId, loopMode, showToday, prefillName };
  }

  function flashMessage(msg: string) {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 3200);
  }

  async function fetchObligationWindow(tok: string, limit: number) {
    const payload = await fetchObligations(tok, true, limit + 1);
    return {
      obligations: payload.obligations.slice(0, limit),
      hasMore: payload.obligations.length > limit,
    };
  }

  async function loadObligationPage(limit: number) {
    const token = tokenRef.current;
    if (!token) return;
    setState((prev) =>
      prev.status === "ready" ? { ...prev, obligationsLoading: true } : prev
    );
    try {
      const loaded = await fetchObligationWindow(token, limit);
      setState((prev) =>
        prev.status === "ready"
          ? {
              ...prev,
              obligations: loaded.obligations,
              obligationsLimit: limit,
              obligationsHasMore: loaded.hasMore,
              obligationsLoading: false,
            }
          : prev
      );
    } catch (e) {
      setState((prev) =>
        prev.status === "ready" ? { ...prev, obligationsLoading: false } : prev
      );
      flashMessage(errorMessage(e, "לא הצלחתי לטעון את ההתחייבויות"));
    }
  }

  async function refreshAfterMutation(token: string) {
    const briefing = await fetchBriefing(token);
    const route = currentRouteState();
    if (!route.screen) {
      setState({
        status: "ready",
        briefing,
        obligations: [],
        obligationsLimit: 0,
        obligationsHasMore: false,
        obligationsLoading: false,
      });
      return;
    }

    const limit =
      state.status === "ready" && state.obligationsLimit > 0
        ? state.obligationsLimit
        : INITIAL_OBLIGATION_LIMIT;
    const loaded = await fetchObligationWindow(token, limit);
    setState({
      status: "ready",
      briefing,
      obligations: loaded.obligations,
      obligationsLimit: limit,
      obligationsHasMore: loaded.hasMore,
      obligationsLoading: false,
    });
  }

  useEffect(() => {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) {
      router.replace("/login");
      return;
    }

    tokenRef.current = token;
    let cancelled = false;
    (async () => {
      try {
        const briefing = await fetchBriefing(token);
        if (!cancelled) {
          setState({
            status: "ready",
            briefing,
            obligations: [],
            obligationsLimit: 0,
            obligationsHasMore: false,
            obligationsLoading: false,
          });
        }
      } catch (e) {
        if (!cancelled) {
          setState({
            status: "error",
            message: errorMessage(e, "שגיאה בטעינת המזכירה"),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    const route = currentRouteState();
    if (!route.screen || state.status !== "ready") return;
    if (state.obligationsLimit > 0 || state.obligationsLoading) return;
    void loadObligationPage(INITIAL_OBLIGATION_LIMIT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, state]);

  async function onCreateFlow(input: CreateObligationInput): Promise<ObligationApi | void> {
    const token = tokenRef.current;
    if (!token) return undefined;
    const saved = await createObligation(token, input);
    await refreshAfterMutation(token);
    return saved;
  }

  async function onUpdateFlow(id: number, input: UpdateObligationInput): Promise<void> {
    const token = tokenRef.current;
    if (!token) return;
    await updateObligation(token, id, input);
    await refreshAfterMutation(token);
  }

  async function onCreateManyFlow(inputs: CreateObligationInput[]): Promise<ObligationApi[]> {
    const token = tokenRef.current;
    if (!token) return [];
    const created: ObligationApi[] = [];
    for (const input of inputs) {
      created.push(await createObligation(token, input));
    }
    await refreshAfterMutation(token);
    return created;
  }

  async function onCompleteFlow(id: number) {
    const token = tokenRef.current;
    if (!token) return;
    await completeObligation(token, id);
    await refreshAfterMutation(token);
    router.push("/secretary?screen=loops&id=" + id + "&loopMode=met");
  }

  async function onSnoozeFlow(id: number, followUpAt: string) {
    const token = tokenRef.current;
    if (!token) return;
    await snoozeObligation(token, id, followUpAt);
    await refreshAfterMutation(token);
  }

  async function onReleaseFlow(id: number) {
    const token = tokenRef.current;
    if (!token) return;
    await releaseObligation(token, id);
    await refreshAfterMutation(token);
    router.push("/secretary?screen=loops&id=" + id + "&loopMode=release");
  }

  const route = currentRouteState();
  // Hide the app's fixed bottom nav + FAB while a secretary sub-screen or the
  // "today" surface is open. Those screens have their own back navigation, and
  // the fixed bottom bar (a sibling stacking context) otherwise floats over
  // their bottom CTAs (e.g. "מסור למזכירה"). The home screen keeps the nav so
  // the user can move to other sections of the app.
  useHideShellChrome(Boolean(route.screen) || route.showToday);

  if (state.status === "ready") {
    const focus = state.briefing.attention[0]?.obligation ?? null;

    if (route.screen) {
      return (
        <SecretaryErrorBoundary>
          <SecretaryFlowScreen
            screen={route.screen}
            obligations={state.obligations}
            selectedId={route.selectedId}
            loopMode={route.loopMode}
            prefillName={route.prefillName}
            obligationsLoading={state.obligationsLoading}
            obligationsHasMore={state.obligationsHasMore}
            onLoadMore={() =>
              void loadObligationPage(state.obligationsLimit + OBLIGATION_PAGE_SIZE)
            }
            onCreate={onCreateFlow}
            onCreateMany={onCreateManyFlow}
            onUpdate={onUpdateFlow}
            onComplete={onCompleteFlow}
            onSnooze={onSnoozeFlow}
            onRelease={onReleaseFlow}
          />
          {flash ? <div aria-live="polite" style={flashStyle}>{flash}</div> : null}
        </SecretaryErrorBoundary>
      );
    }

    if (route.showToday) {
      return (
        <SecretaryErrorBoundary>
          <TodayScreen
            model={todayModelFromBriefing(state.briefing)}
            onComplete={focus ? () => onCompleteFlow(focus.id) : undefined}
            onSnooze={focus ? () => router.push("/secretary?screen=remind&id=" + focus.id) : undefined}
            onRelease={focus ? () => onReleaseFlow(focus.id) : undefined}
          />
          {flash ? <div aria-live="polite" style={flashStyle}>{flash}</div> : null}
        </SecretaryErrorBoundary>
      );
    }

    return (
      <SecretaryErrorBoundary>
        <SecretaryHomeScreen model={homeModelFromBriefing(state.briefing)} />
        {flash ? <div aria-live="polite" style={flashStyle}>{flash}</div> : null}
      </SecretaryErrorBoundary>
    );
  }

  if (state.status === "loading") {
    // Instant, calm skeleton of the home shell — entry never shows a blank
    // screen or a blocking "checking…" page while the briefing is in flight.
    return <SecretaryHomeSkeleton />;
  }

  return (
    <main dir="rtl" style={errorPageStyle}>
      <section style={errorCardStyle}>
        <h1 style={{ margin: 0, fontSize: 22 }}>רגע, משהו בבדיקה נתקע.</h1>
        <p style={{ margin: "10px 0 0", color: TOKEN.ink.muted, lineHeight: 1.6 }}>
          {state.message}
        </p>
        <button
          type="button"
          onClick={() => {
            const token = tokenRef.current;
            if (token) void refreshAfterMutation(token);
          }}
          style={retryButtonStyle}
        >
          לנסות שוב
        </button>
      </section>
    </main>
  );
}

const flashStyle = {
  position: "fixed" as const,
  zIndex: 80,
  right: 18,
  bottom: 92,
  maxWidth: 360,
  borderRadius: 16,
  padding: "12px 14px",
  background: TOKEN.semantic.success.bgSoft,
  color: TOKEN.semantic.success.ink,
  boxShadow: TOKEN.shadow.floating,
  fontWeight: 800,
};

const errorPageStyle = {
  minHeight: "100dvh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: TOKEN.surface.page,
  padding: 20,
  boxSizing: "border-box" as const,
};

const errorCardStyle = {
  width: "min(100%, 520px)",
  borderRadius: 24,
  background: TOKEN.surface.card,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  padding: 22,
  boxShadow: TOKEN.shadow.floating,
};

const retryButtonStyle = {
  marginTop: 16,
  minHeight: 48,
  border: 0,
  borderRadius: 16,
  padding: "0 18px",
  background: TOKEN.brand.gradient,
  color: TOKEN.ink.inverse,
  font: "inherit",
  fontWeight: 800,
  cursor: "pointer",
};

function homeModelFromBriefing(briefing: BriefingApi): SecretaryHomeModel {
  const focus = briefing.attention[0] ?? null;
  const openItems = uniqueBriefingObligations([
    ...briefing.attention.map((item) => item.obligation),
    ...briefing.watching,
  ]);
  const currency = focus?.obligation.currency ?? openItems[0]?.currency ?? "ILS";
  const allAmount = formatHomeAmount(String(sumObligationAmounts(openItems)), currency);
  const hasToday =
    briefing.state === "CRITICAL" ||
    briefing.attention.some((item) => item.reason === "OVERDUE" || item.reason === "DUE_TODAY");

  if (briefing.counts.open === 0) {
    return {
      state: "new",
      title: "שלום, אני\nהמזכירה שלך.",
      subtitle: "מסור לי את התשלומים שהעסק צריך להוציא - ואני אזכור אותם בשבילך.",
      todayHref: "/secretary?today=1",
      allHref: "/secretary?screen=all",
      addHref: "/secretary?screen=bank",
      today: { label: "בוא נתחיל", body: "מסור לי את ההתחייבות הראשונה" },
    };
  }

  if (focus) {
    return {
      state: "due",
      title: hasToday ? "יש דבר אחד שצריך\nלסגור היום." : "יש כמה דברים שכדאי\nלסגור השבוע.",
      subtitle: hasToday ? "כל השאר שמור אצלי - אזכיר לך בזמן." : "נתחיל מהקרוב, ואת השאר אשמור לך בזמן.",
      todayHref: "/secretary?today=1",
      allHref: "/secretary?screen=all",
      addHref: "/secretary?screen=bank",
      today: {
        label: "היום שלי",
        badge: dueBadge(focus.reason),
        body: displayObligeeName(focus.obligation.obligeeName),
        amount: formatHomeAmount(focus.obligation.amount, focus.obligation.currency),
      },
      all: {
        line: briefing.counts.open.toLocaleString("he-IL") + " במעקב",
        amount: allAmount,
        suffix: "להוצאה",
      },
    };
  }

  return {
    state: "calm",
    title: "הכל רגוע.\nאין מה שדורש אותך.",
    subtitle: "אני שומרת " + briefing.counts.open.toLocaleString("he-IL") + " התחייבויות ואזכיר לך כשמשהו יתקרב.",
    todayHref: "/secretary?today=1",
    allHref: "/secretary?screen=all",
    addHref: "/secretary?screen=bank",
    today: { label: "היום שלי", body: "אין תשלום שדורש אותך היום" },
    all: {
      line: briefing.counts.open.toLocaleString("he-IL") + " במעקב",
      amount: allAmount,
      suffix: "להוצאה",
    },
  };
}

function todayModelFromBriefing(briefing: BriefingApi): TodayModel {
  const focus = briefing.attention[0] ?? null;
  if (!focus) {
    return {
      state: "calm",
      status: "הכול תחת מעקב",
      title: "אין משהו שדורש אותך עכשיו.",
      subtitle: "עברתי על הכול. אני ממשיכה לעקוב, וברגע שמשהו יתקרב - אגיד לך.",
      watching: {
        line: "אני שומרת " + briefing.counts.open.toLocaleString("he-IL") + " התחייבויות",
        subline: "הכול רגוע - אזכיר כשמשהו יתקרב.",
      },
    };
  }
  const urgent = focus.reason === "OVERDUE" || focus.reason === "DUE_TODAY";
  return {
    state: urgent ? "critical" : "busy",
    status: urgent ? "בדקתי את היום שלך" : "עברתי על השבוע שלך",
    title: urgent ? "יש דבר אחד שכדאי לסגור היום." : "יש כמה דברים השבוע. בוא נתחיל מהחשוב.",
    subtitle: urgent ? "בוא נטפל בו קודם - אני כבר שומרת את כל השאר." : "נסגור אחד-אחד. אני כאן לאורך כל הדרך.",
    focus: {
      id: focus.obligation.id,
      tone: urgent ? "urgent" : "soon",
      tag: dueBadge(focus.reason),
      name: displayObligeeName(focus.obligation.obligeeName),
      amount: formatHomeAmount(focus.obligation.amount, focus.obligation.currency),
      meta: formatDueDate(focus.obligation.dueAt),
      chip: RECURRENCE_LABEL[focus.obligation.recurrence],
      note: focus.obligation.note ?? undefined,
    },
    watching: {
      line: "אני שומרת עוד " + briefing.counts.watching.toLocaleString("he-IL") + " דברים במעקב",
      subline: "אין מה לעשות בהם עכשיו - אזכיר בזמן.",
    },
  };
}

function uniqueBriefingObligations(items: ObligationApi[]): ObligationApi[] {
  const seen = new Set<number>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function sumObligationAmounts(items: ObligationApi[]): number {
  return items.reduce((sum, item) => {
    const amount = Number(item.amount);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
}

function formatHomeAmount(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: currency || "ILS",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return n.toLocaleString("he-IL", { maximumFractionDigits: 0 }) + " " + currency;
  }
}

function dueBadge(reason: AttentionReason): string {
  switch (reason) {
    case "OVERDUE":
      return "באיחור";
    case "DUE_TODAY":
      return "להיום";
    case "DUE_SOON":
    default:
      return "מתקרב";
  }
}

function parseOptionalNumber(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseSecretaryScreen(value: string | null): SecretaryScreenName | null {
  const screens: SecretaryScreenName[] = [
    "bank",
    "all",
    "detail",
    "update",
    "capture",
    "loops",
    "remind",
    "watching",
    "notify",
  ];
  return screens.includes(value as SecretaryScreenName)
    ? (value as SecretaryScreenName)
    : null;
}

function parseLoopMode(value: string | null): SecretaryLoopMode | null {
  const modes: SecretaryLoopMode[] = ["met", "snooze", "release", "created"];
  return modes.includes(value as SecretaryLoopMode)
    ? (value as SecretaryLoopMode)
    : null;
}