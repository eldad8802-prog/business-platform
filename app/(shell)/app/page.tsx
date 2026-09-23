"use client";

import { useCallback, useEffect, useState } from "react";

import { PageContainer } from "@/components/ui/page-container";
import { DubizIntroOverlay } from "@/components/brand/dubiz-intro-overlay";
import {
  HomeScreen,
  type HomeIdentity,
  type HomeOverdueView,
  type HomeView,
} from "@/features/home/components/home-screen";
import { buildAttentionObjects } from "@/features/home/lib/home-attention";
import {
  collectionViewFrom,
  type CollectionView,
  type CollectionWire,
  type HomePeriodKey,
} from "@/features/home/lib/home-collection-view";
import type { LoadState } from "@/features/home/lib/home-model";
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
 * Five independent read-only requests, all of them parallel:
 *   /api/home                            owner + business name
 *   /api/home/collection                 the period, the one before it, the month
 *   /api/obligations/briefing            the obligations that need the owner
 *   /api/business-status                 the open exceptions, each with its
 *                                        own true destination
 *   /api/billing/invoice-profile         the business logo, if one exists
 *
 * Past-due invoices ride along with the collection read the screen already
 * needs (`/api/billing/collection/awaiting`), making six in total — one fewer
 * than the layout would have cost as separate domain calls, and the same number
 * the old counter Home made for less.
 *
 * They are deliberately NOT one combined call and NOT all-or-nothing: each
 * settles on its own, and a source that fails leaves its own element saying so
 * rather than costing the owner the whole screen or, worse, being replaced by
 * a plausible-looking number.
 */

const HOME_FETCH_TIMEOUT_MS = 28_000;

/* ------------------------------------------------------------ wire types -- */

type AwaitingPaymentWire = {
  totalOutstanding?: string;
  customerCount?: number;
};

type InvoiceProfileWire = {
  profile?: { billingLogoDataUrl?: string | null } | null;
};

/** Which identity the owner chose to see, remembered per device. */
const IDENTITY_KEY = "dubiz.home.identity.v1";

function readIdentity(): HomeIdentity {
  try {
    return localStorage.getItem(IDENTITY_KEY) === "dubiz" ? "dubiz" : "business";
  } catch {
    return "business";
  }
}

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
  const [briefing, setBriefing] = useState<Loaded<BriefingApi>>(LOADING);
  const [status, setStatus] = useState<Loaded<BusinessStatusItem[]>>(LOADING);
  const [overdue, setOverdue] = useState<HomeOverdueView>({ state: "loading" });
  const [businessLogo, setBusinessLogo] = useState<string | null>(null);
  const [identity, setIdentity] = useState<HomeIdentity>("business");

  /** Which framing of collection the owner is looking at. */
  const [period, setPeriod] = useState<HomePeriodKey>("today");
  const [collection, setCollection] = useState<CollectionView>({ state: "loading" });

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
    // The identity preference is a per-device view choice, read from this
    // browser rather than from the business record — see the identity sheet.
    setIdentity(readIdentity());
  }, []);

  const chooseIdentity = useCallback((next: HomeIdentity) => {
    setIdentity(next);
    try {
      localStorage.setItem(IDENTITY_KEY, next);
    } catch {
      /* A browser that refuses storage still gets the choice for this visit. */
    }
  }, []);

  /** The secondary sources. Independent; none can break the screen. */
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

    // Past-due invoices: ISSUED tax invoices past the business's own payment
    // terms, with a balance left after receipts and credit notes. NOT total
    // receivables — invoices not yet due are excluded — which is why the screen
    // says "בחשבוניות באיחור" and never "חייבים לך".
    fetch("/api/billing/collection/awaiting", { cache: "no-store", headers: auth })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json: AwaitingPaymentWire) => {
        if (cancelled) return;
        setOverdue({
          state: "ready",
          amount: Number(json.totalOutstanding ?? 0),
          customers: json.customerCount ?? 0,
        });
      })
      .catch(() => {
        if (!cancelled) setOverdue({ state: "failed" });
      });

    // The logo the business already uploaded for its invoices. Absent is a
    // perfectly good answer — the header then carries the Dubiz mark.
    fetch("/api/billing/invoice-profile", { cache: "no-store", headers: auth })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: InvoiceProfileWire | null) => {
        if (cancelled) return;
        const logo = json?.profile?.billingLogoDataUrl;
        setBusinessLogo(typeof logo === "string" && logo.length > 0 ? logo : null);
      })
      .catch(() => {
        /* No logo is not an error; it is the Dubiz mark. */
      });

    return () => {
      cancelled = true;
    };
  }, [sessionReady, sessionToken]);

  /**
   * The selected period. Each framing is its own read, because each one is a
   * different window AND a different window to compare against — the server is
   * the only place that can cut both at the same point.
   */
  useEffect(() => {
    if (!sessionReady || !sessionToken) return;
    let cancelled = false;

    fetch(`/api/home/collection?period=${period}`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${sessionToken}` },
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json: CollectionWire) => {
        if (!cancelled) setCollection(collectionViewFrom(json));
      })
      .catch(() => {
        // Never ₪0: a period we could not read is a period we cannot report.
        if (!cancelled) setCollection({ state: "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [sessionReady, sessionToken, period]);

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
          briefing,
          status,
          collection,
          period,
          setPeriod,
          overdue,
          businessLogo,
        })}
        identity={identity}
        onIdentityChange={chooseIdentity}
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
 * Assembles the Home view-model.
 *
 * Every figure traces to one of the requests above, and every one of them
 * carries its own load state the whole way to the screen: a source still in
 * flight is a skeleton, a source that failed says so, and a legitimate zero is
 * rendered as a zero. Nothing here invents a value to fill a space.
 */
function buildHomeView({
  data,
  briefing,
  status,
  collection,
  period,
  setPeriod,
  overdue,
  businessLogo,
}: {
  data: HomeResponse;
  briefing: Loaded<BriefingApi>;
  status: Loaded<BusinessStatusItem[]>;
  collection: CollectionView;
  period: HomePeriodKey;
  setPeriod: (next: HomePeriodKey) => void;
  overdue: HomeOverdueView;
  businessLogo: string | null;
}): HomeView {
  const ownerFullName = data.businessSnapshot.ownerName?.trim() || "";
  const businessName = data.businessSnapshot.businessName?.trim() || ownerFullName;
  const briefingValue = valueOrNull(briefing);
  const statusItems = valueOrNull(status);

  // Either source failing means the Secretary cannot claim the day is clear.
  const objectsFailed = briefing.state === "failed" || status.state === "failed";
  const objects = objectsFailed
    ? null
    : buildAttentionObjects(briefingValue, statusItems, new Date());

  return {
    businessName,
    businessLogoDataUrl: businessLogo,
    collection,
    period,
    onPeriodChange: setPeriod,
    overdue,
    objects,
    objectsFailed,
    loading: objects === null && !objectsFailed,
  };
}

export default HomePage;
