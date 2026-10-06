"use client";

import { useEffect, useState } from "react";

import { IconInfo } from "@/components/navigation/nav-icons";
import { DESKTOP_QUERY, HomeV3 } from "@/features/home/v3/home-v3";
import { useHomeData } from "@/features/home/v3/use-home-data";
import { useMediaQuery } from "@/lib/ui/use-breakpoint";

// The canonical shape, imported rather than re-declared. A local copy of this
// type had already drifted from the server contract once — it was missing a
// field the API was returning, and nothing caught it because the duplicate
// type-checked happily against itself.
import type { HomeResponse } from "@/features/home/types/home.types";

/**
 * Home (`/app`) — the session/auth boundary for HOME v3.
 *
 * `/api/home` is the gate: it proves the session and names the owner and the
 * business. Once it answers, `useHomeData` makes the one shared read every
 * layout draws from (see features/home/v3/use-home-data.ts) — each source
 * independent, none able to break the screen, none replaced by a plausible
 * number when it fails.
 */

const HOME_FETCH_TIMEOUT_MS = 28_000;

/* ----------------------------------------------------------- auth states -- */

// The pre-session bootstrap paint: the Home canvas with no text, so the frame
// before the session read never flashes a "טוען…" word or a colour change into
// the loading state below. On the rare no-token "stuck" path the fallback
// button below still appears over it.
function HomeAuthBootstrap() {
  return <main aria-hidden="true" className="min-h-screen" style={{ background: "#FEF8F2" }} />;
}

/** First paint while `/api/home` answers — the Home canvas, quiet blocks. */
function HomeLoadingState() {
  const block = (h: number, r = 20) => (
    <div aria-hidden className="animate-pulse" style={{ height: h, borderRadius: r, background: "#F6EDE2" }} />
  );
  return (
    <main style={{ minHeight: "100vh", background: "#FEF8F2", padding: "20px", display: "flex", flexDirection: "column", gap: 20 }}>
      {block(48, 16)}
      {block(360, 24)}
      {block(180, 18)}
      {block(132, 20)}
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
    <main style={{ minHeight: "100vh", background: "#FEF8F2", color: "#1E2B2A" }}>
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-4 py-10 text-center">
        <div className="w-full p-6" style={{ borderRadius: 24, background: "#FFFDFA", border: "1px solid #F0E3D3" }}>
          <div className="mb-3 flex justify-center" style={{ color: "#B4432F" }}>
            <IconInfo size={32} strokeWidth={1.8} />
          </div>
          <h1 className="mb-2 text-xl" style={{ fontWeight: 600 }}>משהו השתבש</h1>
          <p className="mb-5 text-sm leading-6" style={{ color: "#5E6B69" }}>
            לא הצלחנו לטעון את דף הבית. אפשר לנסות שוב, או לחזור להתחברות.
          </p>

          <button
            type="button"
            onClick={onRetry}
            className="w-full px-4 py-3 text-sm text-white transition active:scale-[0.99]"
            style={{ borderRadius: 14, background: "#246966", fontWeight: 600 }}
          >
            נסה שוב
          </button>

          {onReLogin ? (
            <button
              type="button"
              onClick={onReLogin}
              className="mt-3 w-full px-4 py-3 text-sm transition active:scale-[0.99]"
              style={{ borderRadius: 14, border: "1px solid #F0E3D3", background: "#FFFFFF", color: "#1E2B2A", fontWeight: 600 }}
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

  /** Start true so we never flash HomeErrorState before the first /api/home attempt (token path). */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  const desktop = useMediaQuery(DESKTOP_QUERY);
  const { data: homeData, loadWeek } = useHomeData(data !== null, desktop);

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
      <main className="min-h-screen" style={{ background: "#FEF8F2", color: "#1E2B2A" }}>
        <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-6 px-4 sm:max-w-2xl sm:px-6">
          <p className="text-center text-sm" style={{ color: "#5E6B69" }} dir="rtl">
            {storageError
              ? "לא ניתן לקרוא את פרטי ההתחברות מהדפדפן. אפשר לעבור ידנית להתחברות."
              : "מעבירים לדף ההתחברות… אם לא נפתח, לחץ על הכפתור."}
          </p>
          <button
            type="button"
            onClick={goLoginManual}
            className="z-[99999] w-full max-w-xs px-4 py-3.5 text-center text-sm text-white shadow-md"
            style={{ pointerEvents: "auto", borderRadius: 14, background: "#246966", fontWeight: 600 }}
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
    const ownerName = data.businessSnapshot.ownerName?.trim() || "";
    const businessName = data.businessSnapshot.businessName?.trim() || ownerName;
    body = <HomeV3 data={homeData} loadWeek={loadWeek} businessName={businessName} ownerName={ownerName} />;
  }

  return body;
}

export default HomePage;
