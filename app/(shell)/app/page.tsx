"use client";
import { PageContainer } from "@/components/ui/page-container";

import {
  useEffect,
  useState,
} from "react";
import { DubizIntroOverlay } from "@/components/brand/dubiz-intro-overlay";
import {
  HomeScreen,
  type HomeView,
} from "@/features/home/components/home-screen";

type HeroAction = {
  actionKey: string;
  title: string;
  description: string;
  ctaLabel: string;
  ctaHref: string;
  reason?: string;
};

type QuickAction = {
  key: string;
  title: string;
  icon: string;
  href: string;
  status?: "active" | "soon";
};

type BusinessSnapshot = {
  businessName: string;
  greeting?: string;
  ownerName?: string;
};

type HomeResponse = {
  heroAction: HeroAction;
  quickActions: QuickAction[];
  businessSnapshot: BusinessSnapshot;
};

/**
 * Time-of-day greeting, computed client-side from the user's own clock (a
 * server hour would be the wrong timezone). Feeds "בוקר טוב, {name}".
 */
function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "בוקר טוב";
  if (hour >= 12 && hour < 17) return "צהריים טובים";
  if (hour >= 17 && hour < 22) return "ערב טוב";
  return "לילה טוב";
}

/**
 * Builds the home view-model from the authenticated /api/home payload. Only the
 * data we genuinely have is wired (owner/business name, greeting, navigation);
 * the engine-backed sections (day-state, insights) are passed as null so the
 * HomeScreen renders its honest empty states rather than fabricated numbers.
 */
function buildHomeView(data: HomeResponse): HomeView {
  const ownerName =
    data.businessSnapshot.ownerName?.trim().split(/\s+/)[0] ||
    data.businessSnapshot.businessName?.trim().split(/\s+/)[0] ||
    "";
  const greeting = greetingForHour(new Date().getHours());

  return {
    secretary: {
      label: "המזכירה שלך",
      greeting: ownerName ? `${greeting}, ${ownerName}` : greeting,
      message:
        "אני עוקבת אחרי העסק בשבילך. כשיצוץ משהו שדורש תשומת לב — הוא יחכה לך כאן.",
      ctaLabel: "למזכירה שלך",
      ctaHref: "/secretary",
    },
    // No approved day-state / insights engine yet → honest empty states.
    dayState: null,
    insights: null,
    notifications: { href: "/attention", hasUnread: false },
    settingsHref: "/settings",
  };
}

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

function HomeLoadingState() {
  return (
    <main className="min-h-screen bg-[#f8f6f1] text-[#1f2937]">
      {/*
        The skeleton uses the SAME width authority as the loaded Home
        (content intent) so there is no width jump when the data lands.
        It replaces a 448/672/896 Tailwind ladder — one of the three
        competing ladders the audit found.
      */}
      <PageContainer
        intent="content"
        as="div"
        className="flex min-h-screen w-full flex-col pb-8 pt-4"
      >
        <div className="mb-6 h-16 animate-pulse rounded-2xl bg-white/80" />

        <div className="mb-4 h-48 animate-pulse rounded-3xl bg-white/80" />

        <div className="mb-3 h-6 w-32 animate-pulse rounded-xl bg-white/80" />

        <div className="grid grid-cols-2 gap-3">
          <div className="h-32 animate-pulse rounded-3xl bg-white/80" />
          <div className="h-32 animate-pulse rounded-3xl bg-white/80" />
          <div className="h-32 animate-pulse rounded-3xl bg-white/80" />
          <div className="h-32 animate-pulse rounded-3xl bg-white/80" />
        </div>

        <div className="mt-4 h-20 animate-pulse rounded-3xl bg-white/80" />
        <div className="mt-4 h-20 animate-pulse rounded-3xl bg-white/80" />
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

const HOME_FETCH_TIMEOUT_MS = 28_000;

function HomePage() {
  const [data, setData] = useState<HomeResponse | null>(null);
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

  const showLoginGate =
    sessionReady && (!sessionToken || storageError !== null);

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
    body = (
      <HomeErrorState onRetry={loadHome} onReLogin={goReLogin} />
    );
  } else {
    body = <HomeScreen view={buildHomeView(data)} />;
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

export default HomePage;