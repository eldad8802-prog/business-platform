"use client";

import { LeadsBriefingCard } from "@/components/leads/LeadsBriefingCard";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  completeObligation,
  createObligation,
  fetchBriefing,
  fetchObligations,
  releaseObligation,
  snoozeObligation,
  updateObligation,
  type BriefingApi,
  type CreateObligationInput,
  type ObligationApi,
  type UpdateObligationInput,
} from "@/lib/obligations/secretary-client";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { consumeFlowEntries } from "@/lib/navigation/back-nav/trail-runtime";
import { recordPayment } from "@/lib/payables/payables-client";
import { ErrorState, hebrewErrorMessage, useToast } from "@/components/finance-ui";
import { PaidQuestionSheet, type PaidDetails } from "./paid-question";
import { SecretaryToday } from "@/features/tasks/secretary-today";
import { useFeatureState } from "@/lib/ui/use-feature-enabled";
import {
  SecretaryErrorBoundary,
  SecretaryFlowScreen,
  TodayScreen,
  type SecretaryLoopMode,
  type SecretaryScreenName,
  type TodayModel,
} from "./secretary-ui";
import { SecretaryHome, SecretaryHomeLoading } from "./secretary-home";
import { buildSecretaryHome, cadenceText, displayObligeeName, rowFromObligation } from "./secretary-home-model";

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

function errorMessage(e: unknown, fallback: string): string {
  return hebrewErrorMessage(e, fallback);
}

function formatDueDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("he-IL", {
    timeZone: "Asia/Jerusalem",
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
    <Suspense fallback={<SecretaryHomeLoading />}>
      <SecretaryPageInner />
    </Suspense>
  );
}

function SecretaryPageInner() {
  const router = useRouter();
  // Daily Tasks: with daily_tasks ON, "היום שלי" reads the shared agenda; OFF (or unknown) keeps today's screen.
  const sharedToday = useFeatureState("daily_tasks");
  const searchParams = useSearchParams();
  const routeKey = searchParams.toString();
  const tokenRef = useRef<string | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [toast, showToast] = useToast();
  // "שילמת?" — open while the owner decides; resolves the pending complete.
  const [paidPrompt, setPaidPrompt] = useState<{
    obligation: ObligationApi;
    step: "ask" | "details";
    resolve: () => void;
  } | null>(null);

  function currentRouteState() {
    const screen = parseSecretaryScreen(searchParams.get("screen"));
    const selectedId = parseOptionalNumber(searchParams.get("id"));
    const loopMode = parseLoopMode(searchParams.get("loopMode"));
    const showToday = searchParams.has("today");
    const prefillName = searchParams.get("name")?.trim() || undefined;
    const paidRecorded = searchParams.get("paid") === "1";
    return { screen, selectedId, loopMode, showToday, prefillName, paidRecorded };
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
      showToast(errorMessage(e, "לא הצלחתי לטעון את ההתחייבויות"), "danger");
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

  /** The retry on the error screen. */
  async function loadBriefing(token: string) {
    try {
      const briefing = await fetchBriefing(token);
      setState({
        status: "ready",
        briefing,
        obligations: [],
        obligationsLimit: 0,
        obligationsHasMore: false,
        obligationsLoading: false,
      });
    } catch (e) {
      setState({ status: "error", message: errorMessage(e, "לא הצלחנו לטעון את המזכירה.") });
    }
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
        if (!cancelled) setState({ status: "error", message: errorMessage(e, "לא הצלחנו לטעון את המזכירה.") });
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

  // "כל ההתחייבויות" lives in Payables when the Secretary reads the payables
  // ledger (owner decision 1). Verified from the data itself: a ledger-backed
  // item carries its commitment link. Legacy-mode businesses keep the
  // Secretary's own list, so nothing they recorded disappears from view.
  const ledgerBacked =
    state.status === "ready" &&
    [...state.briefing.attention.map((a) => a.obligation), ...state.briefing.watching, ...state.obligations].some((o) => Boolean(o.ledger));
  const redirectAll = currentRouteState().screen === "all" && ledgerBacked;
  useEffect(() => {
    if (redirectAll) router.replace("/payables");
  }, [redirectAll, router]);

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

  /**
   * Opens the result of a COMPLETED action (met / released). When the action
   * was taken on that item's own screen (detail / update), the result REPLACES
   * it: that screen offers the same action again (a second payment) for an
   * item that has already left the open list, so back must not return into
   * it. From the home or "Today" the result is a normal step (push), and back
   * returns there.
   */
  function showResult(url: string, actedOnId: number) {
    const sp = new URLSearchParams(window.location.search);
    const onItemScreen =
      (sp.get("screen") === "detail" || sp.get("screen") === "update") && sp.get("id") === String(actedOnId);
    if (onItemScreen) {
      router.replace(url);
      // The item's other screens below (detail ← update) are consumed too.
      consumeFlowEntries((u) => {
        const q = new URL(u, window.location.origin).searchParams;
        return (q.get("screen") === "detail" || q.get("screen") === "update") && q.get("id") === String(actedOnId);
      });
    } else router.push(url);
  }

  async function finishComplete(token: string, id: number, paid = false) {
    await completeObligation(token, id);
    await refreshAfterMutation(token);
    showResult("/secretary?screen=loops&id=" + id + "&loopMode=met" + (paid ? "&paid=1" : ""), id);
  }

  function findObligation(id: number): ObligationApi | null {
    if (state.status !== "ready") return null;
    return (
      state.obligations.find((o) => o.id === id) ??
      state.briefing.attention.find((a) => a.obligation.id === id)?.obligation ??
      state.briefing.watching.find((o) => o.id === id) ??
      null
    );
  }

  /**
   * "טופל". handled ≠ paid: on a ledger-backed item that still has something
   * unpaid, ask "שילמת?" first — a yes goes through the real payment flow, a no
   * only closes the reminder. Legacy items (no ledger link) close as before.
   * The returned promise settles when the owner has answered, so callers keep
   * their busy state exactly as they did.
   */
  async function onCompleteFlow(id: number) {
    const token = tokenRef.current;
    if (!token) return;
    const obligation = findObligation(id);
    const ledger = obligation?.ledger ?? null;
    if (!obligation || !ledger || Number(ledger.remaining) <= 0) {
      await finishComplete(token, id);
      return;
    }
    await new Promise<void>((resolve) => setPaidPrompt({ obligation, step: "ask", resolve }));
  }

  /** "שילמתי" — straight to the payment details of the existing payment path. */
  function onRecordPaymentFlow(id: number) {
    const obligation = findObligation(id);
    if (!obligation?.ledger || Number(obligation.ledger.remaining) <= 0) return;
    setPaidPrompt({ obligation, step: "details", resolve: () => undefined });
  }

  /** Home-row "טופל": the same flow, with failures said out loud. */
  async function onHandledFromHome(id: number) {
    try {
      await onCompleteFlow(id);
    } catch (e) {
      showToast(errorMessage(e, "לא הצלחנו לסמן שטופל. שום דבר לא השתנה, ואפשר לנסות שוב."), "danger");
    }
  }

  function closePaidPrompt() {
    setPaidPrompt((current) => {
      current?.resolve();
      return null;
    });
  }

  async function onPaidAnswer(details: PaidDetails) {
    const token = tokenRef.current;
    const pending = paidPrompt;
    if (!token || !pending?.obligation.ledger) return;
    const { commitmentId, installmentId } = pending.obligation.ledger;
    await recordPayment({
      commitmentId,
      installmentIds: [installmentId],
      amount: details.amount,
      paidAt: new Date(details.paidAt + "T12:00:00+03:00").toISOString(),
      method: details.method,
      // One press, one payment: a retried request must not pay twice.
      idempotencyKey: "secretary:" + installmentId + ":" + details.paidAt + ":" + details.amount,
    });
    await finishComplete(token, pending.obligation.id, true);
    closePaidPrompt();
  }

  async function onHandledOnlyAnswer() {
    const token = tokenRef.current;
    const pending = paidPrompt;
    if (!token || !pending) return;
    await finishComplete(token, pending.obligation.id);
    closePaidPrompt();
  }

  const paidSheet = paidPrompt ? (
    <PaidQuestionSheet
      key={paidPrompt.obligation.id + paidPrompt.step}
      obligation={paidPrompt.obligation}
      initialStep={paidPrompt.step}
      onPaid={onPaidAnswer}
      onHandledOnly={onHandledOnlyAnswer}
      onCancel={closePaidPrompt}
    />
  ) : null;

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
    showResult("/secretary?screen=loops&id=" + id + "&loopMode=release", id);
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
      if (redirectAll) return <SecretaryHomeLoading />;
      return (
        <SecretaryErrorBoundary>
          <SecretaryFlowScreen
            screen={route.screen}
            obligations={state.obligations}
            selectedId={route.selectedId}
            loopMode={route.loopMode}
            paidRecorded={route.paidRecorded}
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
          {paidSheet}
          {toast}
        </SecretaryErrorBoundary>
      );
    }

    if (route.showToday && sharedToday === null) return <SecretaryHomeLoading />;

    if (route.showToday && sharedToday) {
      return (
        <SecretaryErrorBoundary>
          <SecretaryToday onPaymentHandled={(id) => onCompleteFlow(id)} aside={<LeadsBriefingCard />} />
          {paidSheet}
          {toast}
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
          {paidSheet}
          {toast}
        </SecretaryErrorBoundary>
      );
    }

    return (
      <SecretaryErrorBoundary>
        <SecretaryHome
          view={buildSecretaryHome(state.briefing)}
          actions={{
            onRecordPayment: onRecordPaymentFlow,
            onHandled: onHandledFromHome,
            onRelease: onReleaseFlow,
          }}
        />
        {paidSheet}
        {toast}
      </SecretaryErrorBoundary>
    );
  }

  if (state.status === "loading") {
    // Instant, calm skeleton of the home — entry never shows a blank screen or
    // a blocking "checking…" page while the briefing is in flight.
    return <SecretaryHomeLoading />;
  }

  return (
    <main dir="rtl" style={{ maxWidth: 560, margin: "0 auto", padding: "48px 16px" }}>
      <ErrorState
        title="לא הצלחנו לטעון את המזכירה"
        body={state.message}
        onRetry={async () => {
          const token = tokenRef.current;
          if (token) await loadBriefing(token);
        }}
      />
    </main>
  );
}

/**
 * "היום שלי" (daily_tasks OFF): the first item in focus, then every other item
 * that needs the owner — never "עוד 1 דברים במעקב" while two overdue items are
 * hidden. All counts are the server's.
 */
function todayModelFromBriefing(briefing: BriefingApi): TodayModel {
  const focus = briefing.attention[0] ?? null;
  const quiet = briefing.counts.watching;
  const watching = {
    line: quiet === 1 ? "התחייבות אחת במעקב שקט" : `${quiet.toLocaleString("he-IL")} התחייבויות במעקב שקט`,
    subline: "כל אחת תופיע כאן שבוע לפני המועד שלה.",
  };
  if (!focus) {
    return {
      state: "calm",
      status: "הכול תחת מעקב",
      title: "אין משהו שדורש אותך עכשיו.",
      subtitle: "כשתשלום יתקרב לשבוע לפני המועד, הוא יופיע כאן.",
      watching,
    };
  }
  const urgent = focus.reason === "OVERDUE" || focus.reason === "DUE_TODAY";
  const total = briefing.attention.length;
  const focusRow = rowFromObligation(focus.obligation, focus.reason);
  return {
    state: urgent ? "critical" : "busy",
    status: urgent ? "בדקתי את היום שלך" : "עברתי על השבוע שלך",
    title:
      total === 1
        ? urgent
          ? "תשלום אחד דורש טיפול היום."
          : "תשלום אחד מתקרב השבוע."
        : `${total.toLocaleString("he-IL")} תשלומים דורשים טיפול. נתחיל מהראשון.`,
    subtitle: total === 1 ? "זה הדבר היחיד שדורש אותך עכשיו." : "השאר מופיעים מתחת, לפי הסדר.",
    focus: {
      id: focus.obligation.id,
      tone: urgent ? "urgent" : "soon",
      tag: focus.reason === "OVERDUE" ? "באיחור" : focus.reason === "DUE_TODAY" ? "להיום" : "מתקרב",
      name: displayObligeeName(focus.obligation.obligeeName),
      amount: focusRow.amount,
      amountCaption: focusRow.amountCaption ?? undefined,
      currency: focus.obligation.currency,
      meta: formatDueDate(focus.obligation.dueAt),
      chip: cadenceText(focus.obligation.recurrence),
      note: focus.obligation.note ?? undefined,
    },
    others: briefing.attention.slice(1).map((item) => rowFromObligation(item.obligation, item.reason)),
    watching,
  };
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
