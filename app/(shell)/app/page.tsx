"use client";

import {
  useEffect,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GlobalBusinessAvatar } from "@/components/business/GlobalBusinessAvatar";

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
};

type HomeResponse = {
  heroAction: HeroAction;
  quickActions: QuickAction[];
  businessSnapshot: BusinessSnapshot;
};

function getIcon(icon: string) {
  switch (icon) {
    case "chat":
      return "💬";
    case "video":
      return "🎥";
    case "tag":
      return "🏷️";
    case "users":
      return "🤝";
    case "bot":
      return "🤖";
    case "percent":
      return "📈";
    case "file":
      return "📄";
    case "spark":
      return "✨";
    case "secretary":
      return "\u{1F464}";
    default:
      return "🧩";
  }
}

function HomeAuthBootstrap() {
  return (
    <main className="pointer-events-none min-h-screen bg-[#f8f6f1] text-[#1f2937]">
      <div className="pointer-events-none mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-4 sm:max-w-2xl sm:px-6">
        <p
          className="pointer-events-auto text-center text-sm text-gray-500"
          dir="rtl"
        >
          טוען…
        </p>
      </div>
    </main>
  );
}

function HomeLoadingState() {
  return (
    <main className="min-h-screen bg-[#f8f6f1] text-[#1f2937]">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-8 pt-4 sm:max-w-2xl sm:px-6 lg:max-w-4xl">
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
      </div>
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

function HomeHeader({
  businessName,
  onOpenTools,
}: {
  businessName: string;
  onOpenTools: () => void;
}) {
  return (
    <header className="mb-5 rounded-3xl bg-white px-4 py-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onOpenTools}
          className="flex h-11 min-w-[44px] items-center justify-center rounded-2xl border border-gray-200 px-3 text-sm font-medium text-gray-700"
          aria-label="כל הכלים"
        >
          ☰
        </button>

        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
          <GlobalBusinessAvatar displayName={businessName || "העסק שלך"} />
          <div className="min-w-0 text-center">
            <p className="truncate text-base font-bold text-gray-900">
              {businessName || "העסק שלך"}
            </p>
            <p className="mt-1 text-xs text-gray-500">דף הבית</p>
          </div>
        </div>

        <Link
          href="/settings"
          className="flex h-11 min-w-[44px] items-center justify-center rounded-2xl border border-gray-200 px-3 text-sm text-gray-600"
          aria-label="הגדרות מערכת"
        >
          ⚙️
        </Link>
      </div>
    </header>
  );
}

function HeroCard({
  heroAction,
  onPrimaryClick,
}: {
  heroAction: HeroAction;
  onPrimaryClick: () => void;
}) {
  return (
    <section className="mb-5 rounded-[28px] bg-white p-5 shadow-sm">
      <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eef7f2] text-2xl">
        ✨
      </div>

      <h1 className="mb-2 text-2xl font-bold leading-tight text-gray-900">
        {heroAction.title}
      </h1>

      <p className="mb-5 text-sm leading-6 text-gray-600">
        {heroAction.description}
      </p>

      <button
        onClick={onPrimaryClick}
        className="w-full rounded-2xl bg-[#1f7a5a] px-4 py-3.5 text-sm font-semibold text-white transition active:scale-[0.99]"
      >
        {heroAction.ctaLabel}
      </button>
    </section>
  );
}

function QuickActionCard({
  action,
  onClick,
}: {
  action: QuickAction;
  onClick: () => void;
}) {
  const isSoon = action.status === "soon";

  return (
    <button
      onClick={onClick}
      className="relative min-h-[132px] rounded-[24px] bg-white p-4 text-right shadow-sm transition active:scale-[0.99]"
    >
      {isSoon && (
        <span className="absolute left-3 top-3 rounded-full bg-[#f4ead0] px-2.5 py-1 text-[10px] font-semibold text-[#7a5a1f]">
          בקרוב
        </span>
      )}

      <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[#f8f6f1] text-2xl">
        {getIcon(action.icon)}
      </div>

      <div className="text-sm font-bold text-gray-900">{action.title}</div>

      <p className="mt-2 text-xs leading-5 text-gray-500">
        {isSoon ? "יכולת שנמצאת בתכנון המערכת" : "כניסה מהירה לפעולה"}
      </p>
    </button>
  );
}

function AllToolsEntry({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mb-5 flex w-full items-center justify-between rounded-[24px] bg-white px-4 py-4 text-right shadow-sm transition active:scale-[0.99]"
    >
      <div>
        <p className="text-sm font-bold text-gray-900">כל הכלים</p>
        <p className="mt-1 text-xs text-gray-500">
          מעבר לכל 8 הפיצ׳רים של המערכת
        </p>
      </div>

      <div className="text-xl text-gray-500">←</div>
    </button>
  );
}

/**
 * TEMPORARY — QA shortcut to the new Collection Workspace (/payments).
 * Matches the home card design language (white · rounded-[24px] · shadow-sm ·
 * RTL · icon tile · arrow). NOT a server-driven quick action; no new logic, no
 * backend. Remove or relocate after Collection QA is approved.
 */
function TempCollectionQaCard() {
  return (
    <Link
      href="/payments"
      className="mb-5 flex items-center justify-between rounded-[24px] bg-white px-4 py-4 text-right shadow-sm transition active:scale-[0.99]"
    >
      <div className="flex items-center gap-3">
        <div className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[#f8f6f1] text-2xl">
          💰
        </div>
        <div>
          <p className="text-sm font-bold text-gray-900">גבייה</p>
          <p className="mt-1 text-xs text-gray-500">מרכז הגבייה — זמני לבדיקות QA</p>
        </div>
      </div>
      <div className="text-xl text-gray-500">←</div>
    </Link>
  );
}

function BusinessSnapshotCard({
  businessSnapshot,
}: {
  businessSnapshot: BusinessSnapshot;
}) {
  return (
    <section className="rounded-[24px] bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold text-gray-500">העסק שלך</p>
      <p className="mt-2 text-lg font-bold text-gray-900">
        {businessSnapshot.businessName}
      </p>

      {businessSnapshot.greeting ? (
        <p className="mt-2 text-sm leading-6 text-gray-600">
          {businessSnapshot.greeting}
        </p>
      ) : (
        <p className="mt-2 text-sm leading-6 text-gray-600">
          מקום אחד שמרכז עבורך את הפעולות החשובות של העסק.
        </p>
      )}
    </section>
  );
}

const HOME_FETCH_TIMEOUT_MS = 28_000;

function HomePage() {
  const router = useRouter();

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

  const handleHeroClick = () => {
    if (!data?.heroAction?.ctaHref) return;
    router.push(data.heroAction.ctaHref);
  };

  const handleQuickActionClick = (action: QuickAction) => {
    if (!action.href) return;
    router.push(action.href);
  };

  const handleOpenTools = () => {
    router.push("/tools");
  };

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
    body = (
      <main className="min-h-screen bg-[#f8f6f1] text-[#1f2937]">
        <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-8 pt-4 sm:max-w-2xl sm:px-6 lg:max-w-4xl">
          <HomeHeader
            businessName={data.businessSnapshot.businessName}
            onOpenTools={handleOpenTools}
          />

          <HeroCard
            heroAction={data.heroAction}
            onPrimaryClick={handleHeroClick}
          />

          <TempCollectionQaCard />

          <section className="mb-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-900">גישה מהירה</h2>
              <span className="text-xs text-gray-500">3–4 כלים חשובים עכשיו</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {data.quickActions.map((action) => (
                <QuickActionCard
                  key={action.key}
                  action={action}
                  onClick={() => handleQuickActionClick(action)}
                />
              ))}
            </div>
          </section>

          <AllToolsEntry onClick={handleOpenTools} />

          <BusinessSnapshotCard businessSnapshot={data.businessSnapshot} />
        </div>
      </main>
    );
  }

  return body;
}

export default HomePage;