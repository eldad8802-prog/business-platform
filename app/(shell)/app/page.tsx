"use client";

import { useCallback, useEffect, useState } from "react";

import { PageContainer } from "@/components/ui/page-container";
import { DubizIntroOverlay } from "@/components/brand/dubiz-intro-overlay";
import {
  HomeScreen,
  buildGroupViews,
  type HomeCounter,
  type HomeView,
} from "@/features/home/components/home-screen";
import {
  buildTodayRows,
  buildVerdict,
  countObligationsDue,
  counterFrom,
  greetingForHour,
  groupStatus,
  type GroupStatus,
  type LoadState,
  type TodayRow,
  type VerdictView,
} from "@/features/home/lib/home-model";
import { HOME_ROUTES, TOOL_GROUPS } from "@/lib/navigation/home-routes";
import type { BusinessStatusItem } from "@/lib/business-status/types";
import type { BriefingApi } from "@/lib/obligations/secretary-client";

// The canonical shape, imported rather than re-declared. A local copy of this
// type had already drifted from the server contract once — it was missing a
// field the API was returning, and nothing caught it because the duplicate
// type-checked happily against itself.
import type { HomeResponse } from "@/features/home/types/home.types";

/**
 * Home (`/app`) — the session/auth boundary and the data orchestration for
 * HOME 2B. The screen itself is presentational; everything that decides what
 * is TRUE lives here and in `features/home/lib/home-model.ts`.
 *
 * Six independent read-only requests, none of which is new backend:
 *   /api/home                            owner + business name
 *   /api/notifications/unread-count      the bell
 *   /api/obligations/briefing            the verdict, and "היום שלך"
 *   /api/business-status                 the three group status labels
 *   /api/payments/collection-workspace   two of the four counters
 *   /api/documents/inbox?summaryOnly=1   the documents counter
 *
 * They are deliberately NOT one combined call and NOT all-or-nothing: each
 * settles on its own, and a source that fails leaves its own element saying so
 * rather than costing the owner the whole screen or, worse, being replaced by
 * a plausible-looking number.
 */

const HOME_FETCH_TIMEOUT_MS = 28_000;

/* ------------------------------------------------------------ wire types -- */

type CollectionWorkspaceSummary = {
  summary: {
    pending: { amount: string; count: number };
    collectedThisMonth: { amount: string; count: number };
    expired: { amount: string; count: number };
  };
};

type DocumentsInboxSummary = {
  financialPulse?: {
    inboxDocumentCounts?: {
      totalPendingReview?: number;
    };
  };
};

/**
 * Loading / ready / failed, kept apart so "failed" is never rendered as a zero
 * — and, since the real-data run, so "loading" is never rendered as "failed"
 * either. The type is shared with the view-model, which owns the mapping onto
 * what a counter may claim.
 */
type Loaded<T> = LoadState<T>;

const LOADING = { state: "loading" } as const;
const FAILED = { state: "failed" } as const;

function ready<T>(value: T): Loaded<T> {
  return { state: "ready", value };
}

/** For sections that only distinguish "have it" from "don't". */
function valueOrNull<T>(loaded: Loaded<T>): T | null {
  return loaded.state === "ready" ? loaded.value : null;
}

/** Transport only — no state, so it is safe to start from inside an effect. */
async function fetchBriefing(token: string): Promise<BriefingApi> {
  const res = await fetch("/api/obligations/briefing", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as BriefingApi;
}

/* ----------------------------------------------------------- auth states -- */

// The pre-session bootstrap paint. Rendered as the intro's cream ground (no
// text) so the brand entry never shows a "טוען…" flash — even for a frame,
// before the overlay/preboot takes over. On the rare no-token "stuck" path the
// fallback button below still appears over it.
function HomeAuthBootstrap() {
  return (
    <main
      aria-hidden="true"
      className="min-h-screen"
      style={{
        background:
          "radial-gradient(circle at 50% 38%, #FDFBF6 0%, #F5EFE2 58%, #EDE4D3 100%)",
      }}
    />
  );
}

/**
 * The first-paint skeleton. Its blocks are the size of the things they stand
 * in for — the secretary card, the 2×2 counters, the 2×2 feature tiles, two
 * "היום שלך" rows — and it uses the SAME width authority as the loaded Home
 * (content intent), so nothing jumps when the data lands.
 */
function HomeLoadingState() {
  return (
    <main className="min-h-screen bg-[#f8f6f1] text-[#1f2937]">
      <PageContainer
        intent="content"
        as="div"
        className="flex min-h-screen w-full flex-col pb-8 pt-4"
      >
        <div className="mb-4 h-11 animate-pulse rounded-2xl bg-white/80" />
        <div className="mb-5 h-14 w-3/5 animate-pulse rounded-2xl bg-white/80" />

        <div className="mb-7 h-52 animate-pulse rounded-[26px] bg-white/80" />

        <div className="mb-3 h-5 w-28 animate-pulse rounded-xl bg-white/80" />
        <div className="mb-6 grid grid-cols-2 gap-2.5">
          <div className="h-[88px] animate-pulse rounded-[18px] bg-white/80" />
          <div className="h-[88px] animate-pulse rounded-[18px] bg-white/80" />
          <div className="h-[88px] animate-pulse rounded-[18px] bg-white/80" />
          <div className="h-[88px] animate-pulse rounded-[18px] bg-white/80" />
        </div>

        <div className="mb-3 h-5 w-28 animate-pulse rounded-xl bg-white/80" />
        <div className="grid grid-cols-2 gap-2.5">
          <div className="h-[116px] animate-pulse rounded-[20px] bg-white/80" />
          <div className="h-[116px] animate-pulse rounded-[20px] bg-white/80" />
          <div className="h-[116px] animate-pulse rounded-[20px] bg-white/80" />
          <div className="h-[116px] animate-pulse rounded-[20px] bg-white/80" />
        </div>
      </PageContainer>
    </main>
  );
}

function HomeErrorState({
  onRetry,
  onReLogin,
}: {
  onRetry: () => void;
  onReLogin?: () => void;
}) {
  return (
    <main className="min-h-screen bg-[#f8f6f1] text-[#1f2937]">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-4 py-10 text-center sm:max-w-2xl sm:px-6 lg:max-w-4xl">
        <div className="w-full rounded-3xl bg-white p-6 shadow-sm">
          <div className="mb-3 text-4xl">⚠️</div>
          <h1 className="mb-2 text-xl font-bold">משהו השתבש</h1>
          <p className="mb-5 text-sm leading-6 text-gray-600">
            לא הצלחנו לטעון את דף הבית. אפשר לנסות שוב, או לחזור להתחברות.
          </p>

          <button
            type="button"
            onClick={onRetry}
            className="w-full rounded-2xl bg-[#1f7a5a] px-4 py-3 text-sm font-semibold text-white transition active:scale-[0.99]"
          >
            נסה שוב
          </button>

          {onReLogin ? (
            <button
              type="button"
              onClick={onReLogin}
              className="mt-3 w-full rounded-2xl border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-800 transition active:scale-[0.99]"
            >
              התחברות מחדש
            </button>
          ) : null}
        </div>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ page -- */

function HomePage() {
  const [data, setData] = useState<HomeResponse | null>(null);
  // Its own tiny request rather than a field on /api/home: the count changes
  // when the owner reads something, which has nothing to do with the home
  // payload, and a failure here must not cost them the whole screen.
  const [unreadCount, setUnreadCount] = useState(0);
  const [briefing, setBriefing] = useState<Loaded<BriefingApi>>(LOADING);
  const [status, setStatus] = useState<Loaded<BusinessStatusItem[]>>(LOADING);
  const [collection, setCollection] = useState<Loaded<CollectionWorkspaceSummary>>(LOADING);
  const [docsPending, setDocsPending] = useState<Loaded<number>>(LOADING);

  /** Start true so we never flash HomeErrorState before the first /api/home attempt (token path). */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  useEffect(() => {
    let t: string | null = null;
    let err: string | null = null;
    try {
      t = localStorage.getItem("token");
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      t = null;
    }
    setStorageError(err);
    setSessionToken(t);
    setSessionReady(true);
  }, []);

  // Read once the session exists. No polling: the badge is refreshed by the
  // centre itself after the owner reads something, and anything they have not
  // opened the app to see is what push is for, later.
  useEffect(() => {
    if (!sessionReady || !sessionToken) return;
    let cancelled = false;
    fetch("/api/notifications/unread-count", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${sessionToken}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json && typeof json.unreadCount === "number") {
          setUnreadCount(json.unreadCount);
        }
      })
      .catch(() => {
        /* The bell simply stays quiet. A failed count is not worth an error. */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionReady, sessionToken]);

  /**
   * The verdict can be retried on its own: a briefing that failed is a loading
   * failure, not a calm business, and the card says exactly that instead of
   * showing a state we did not derive.
   */
  const retryVerdict = useCallback(() => {
    if (!sessionToken) return;
    setBriefing(LOADING);
    fetchBriefing(sessionToken)
      .then((json) => setBriefing(ready(json)))
      .catch(() => setBriefing(FAILED));
  }, [sessionToken]);

  /** The four secondary sources. Independent; none can break the screen. */
  useEffect(() => {
    if (!sessionReady || !sessionToken) return;
    let cancelled = false;
    const auth = { Authorization: `Bearer ${sessionToken}` };

    fetchBriefing(sessionToken)
      .then((json) => {
        if (!cancelled) setBriefing(ready(json));
      })
      .catch(() => {
        if (!cancelled) setBriefing(FAILED);
      });

    fetch("/api/business-status", { cache: "no-store", headers: auth })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json: { items?: BusinessStatusItem[] }) => {
        if (!cancelled) setStatus(ready(json.items ?? []));
      })
      .catch(() => {
        if (!cancelled) setStatus(FAILED);
      });

    fetch("/api/payments/collection-workspace", { cache: "no-store", headers: auth })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json: CollectionWorkspaceSummary) => {
        if (!cancelled) setCollection(ready(json));
      })
      .catch(() => {
        if (!cancelled) setCollection(FAILED);
      });

    fetch("/api/documents/inbox?summaryOnly=1", { cache: "no-store", headers: auth })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json: DocumentsInboxSummary) => {
        const total = json.financialPulse?.inboxDocumentCounts?.totalPendingReview;
        if (cancelled) return;
        setDocsPending(typeof total === "number" ? ready(total) : FAILED);
      })
      .catch(() => {
        if (!cancelled) setDocsPending(FAILED);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionReady, sessionToken]);

  const loadHome = async () => {
    const ctrl = new AbortController();
    const timeoutId = window.setTimeout(() => ctrl.abort(), HOME_FETCH_TIMEOUT_MS);
    try {
      setLoading(true);
      setError("");

      let currentToken: string | null = null;
      try {
        currentToken =
          typeof window !== "undefined" ? localStorage.getItem("token") : null;
      } catch {
        window.location.href = `${window.location.origin}/login`;
        return;
      }

      if (!currentToken) {
        window.location.replace(`${window.location.origin}/login`);
        return;
      }

      const res = await fetch("/api/home", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${currentToken}`,
        },
        cache: "no-store",
        signal: ctrl.signal,
      });

      const json = await res.json();

      if (res.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        window.location.replace(`${window.location.origin}/login`);
        return;
      }

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load home");
      }

      setData(json);
    } catch (e) {
      const aborted =
        (typeof DOMException !== "undefined" &&
          e instanceof DOMException &&
          e.name === "AbortError") ||
        (e instanceof Error && e.name === "AbortError");
      const msg = aborted
        ? "פג הזמן לטעינת דף הבית (timeout)"
        : e instanceof Error
          ? e.message
          : "Failed to load home";
      setError(msg);
    } finally {
      window.clearTimeout(timeoutId);
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!sessionReady) {
      return;
    }

    const needsLogin = !sessionToken || storageError !== null;
    if (!needsLogin) {
      void loadHome();
      return;
    }

    setLoading(false);
    const id = window.setTimeout(() => {
      try {
        window.location.replace(`${window.location.origin}/login`);
      } catch {
        /* ignore */
      }
    }, 400);

    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionReady, sessionToken, storageError]);

  const showLoginGate = sessionReady && (!sessionToken || storageError !== null);

  const goLoginManual = () => {
    window.location.href = `${window.location.origin}/login`;
  };

  const goReLogin = () => {
    try {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
    } catch {
      /* ignore */
    }
    window.location.href = `${window.location.origin}/login`;
  };

  let body: React.ReactNode;

  if (!sessionReady) {
    body = (
      <>
        <HomeAuthBootstrap />
        <div
          className="pointer-events-auto fixed bottom-28 left-4 right-4 z-[99999] flex justify-center"
          style={{ pointerEvents: "auto" }}
        >
          <button
            type="button"
            onClick={goLoginManual}
            className="w-full max-w-xs rounded-2xl border border-gray-300 bg-white px-4 py-3 text-center text-sm font-semibold text-gray-800 shadow-md"
          >
            מעבר להתחברות (אם נתקעים כאן)
          </button>
        </div>
      </>
    );
  } else if (showLoginGate) {
    body = (
      <main className="min-h-screen bg-[#f8f6f1] text-[#1f2937]">
        <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-6 px-4 sm:max-w-2xl sm:px-6">
          <p className="text-center text-sm text-gray-600" dir="rtl">
            {storageError
              ? "לא ניתן לקרוא את פרטי ההתחברות מהדפדפן. אפשר לעבור ידנית להתחברות."
              : "מעבירים לדף ההתחברות… אם לא נפתח, לחץ על הכפתור."}
          </p>
          <button
            type="button"
            onClick={goLoginManual}
            className="z-[99999] w-full max-w-xs rounded-2xl bg-[#1f7a5a] px-4 py-3.5 text-center text-sm font-semibold text-white shadow-md"
            style={{ pointerEvents: "auto" }}
          >
            מעבר להתחברות
          </button>
        </div>
      </main>
    );
  } else if (loading) {
    body = <HomeLoadingState />;
  } else if (error || !data) {
    body = <HomeErrorState onRetry={loadHome} onReLogin={goReLogin} />;
  } else {
    body = (
      <HomeScreen
        view={buildHomeView({
          data,
          unreadCount,
          briefing,
          status,
          collection,
          docsPending,
        })}
        onRetryVerdict={retryVerdict}
      />
    );
  }

  // The brand intro overlay REPLACES the old skeleton on first authenticated
  // entry per session. It renders on top, plays in parallel with /api/home, and
  // fades out only once the animation has finished AND the page has settled
  // (appReady). It self-limits to once/session and respects reduced-motion.
  return (
    <>
      <DubizIntroOverlay appReady={sessionReady && !loading} />
      {body}
    </>
  );
}

/* ------------------------------------------------------------ view model -- */

/**
 * Assembles the home view-model. Every figure here traces to one of the six
 * requests above; a source still loading or failed passes `null` through, and
 * the screen renders that as "לא נטען" rather than as a number.
 */
function buildHomeView({
  data,
  unreadCount,
  briefing,
  status,
  collection,
  docsPending,
}: {
  data: HomeResponse;
  unreadCount: number;
  briefing: Loaded<BriefingApi>;
  status: Loaded<BusinessStatusItem[]>;
  collection: Loaded<CollectionWorkspaceSummary>;
  docsPending: Loaded<number>;
}): HomeView {
  const ownerFullName = data.businessSnapshot.ownerName?.trim() || "";
  const businessName = data.businessSnapshot.businessName?.trim() || "";
  const firstName =
    ownerFullName.split(/\s+/)[0] || businessName.split(/\s+/)[0] || "";
  const greeting = greetingForHour(new Date().getHours());

  const now = new Date();
  const briefingValue = valueOrNull(briefing);

  const verdict: VerdictView | null = briefingValue
    ? buildVerdict(briefingValue)
    : null;

  // A failed briefing is NOT an empty day. `today` stays null and the section
  // says it could not check, rather than claiming nothing is due.
  const today: TodayRow[] | null = briefingValue
    ? buildTodayRows(briefingValue, now)
    : null;

  const statusItems = valueOrNull(status);
  const groups = buildGroupViews((key) => {
    if (!statusItems) return null;
    const group = TOOL_GROUPS.find((g) => g.key === key);
    if (!group) return null;
    return groupStatus(statusItems, group.domains) satisfies GroupStatus;
  });

  // Each counter carries its source's load state, not a flattened number. A
  // request still in flight renders a skeleton; only a real failure says so.
  const counters: HomeCounter[] = [
    {
      key: "collected",
      // NOT "today": the only exact source for verified collection is
      // `sumPaidBetween` over the calendar month (`collectedThisMonth`). The
      // per-day figure would have to come from the capped, createdAt-ordered
      // history page, which can silently miss a payment collected today on an
      // older request — so the window is named instead of being guessed.
      label: "נגבה ואומת",
      note: "בחודש הנוכחי",
      value: counterFrom(collection, (c) => c.summary.collectedThisMonth.count),
      href: HOME_ROUTES.collectionCenter,
    },
    {
      key: "pending",
      label: "ממתינים לגבייה",
      value: counterFrom(collection, (c) => c.summary.pending.count),
      href: HOME_ROUTES.collectionCenter,
    },
    {
      key: "documents",
      label: "מסמכים לבדיקה",
      value: counterFrom(docsPending, (n) => n),
      href: HOME_ROUTES.documentsReview,
    },
    {
      key: "obligations",
      label: "תשלומים למועד",
      value: counterFrom(briefing, (b) => countObligationsDue(b, now)),
      href: HOME_ROUTES.secretaryToday,
    },
  ];

  return {
    greeting: firstName ? `${greeting}, ${firstName}` : greeting,
    subGreeting: "הנה מה שחשוב בעסק שלך היום",
    initial: (firstName || businessName).charAt(0),
    secretary: {
      label: "המזכירה שלך",
      verdict,
      failed: briefing.state === "failed",
    },
    counters,
    groups,
    today,
    todayFailed: briefing.state === "failed",
    notifications: {
      // The bell points at the notification centre — the history of what the
      // owner was actually told. The live exception engine is `/attention`,
      // which the secretary card above reaches in one tap, in every state.
      href: HOME_ROUTES.notifications,
      hasUnread: unreadCount > 0,
    },
  };
}

export default HomePage;
