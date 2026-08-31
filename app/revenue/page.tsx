"use client";

/**
 * "מבצעים וקופונים" — the Dubiz tools tile points here.
 *
 * INFORMATION ARCHITECTURE (COUPON-09).
 * This route used to open straight onto the consumer marketplace ("הטבות קרוב
 * אליך"), so a business owner pressing "קופונים" landed in a discovery surface
 * with no way to reach his own coupons. The owner's management screen is now
 * the entry point; the marketplace is still here, one tap away, but it is no
 * longer the primary business flow.
 *
 * NAVIGATION / STATE (COUPON-10).
 * The view lives in the URL (`?view=mine|browse|create`), so browser Back moves
 * between steps instead of leaving the feature, and a refresh restores the
 * screen the owner was on rather than dropping him at the start. Leaving a
 * part-built draft asks first.
 */

import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { ScreenModeProvider } from "@/components/ui/coupon/coupon-primitives";
import { ConsumerJourney } from "@/components/coupon/screens/consumer-screens";
import { CouponCreationFlow } from "@/components/coupon/screens/creation-screens";
import { MyCouponsScreen } from "@/components/coupon/screens/my-coupons-screen";
import type { PublicCoupon } from "@/components/coupon/coupon-model";
import { fetchActiveCoupons, fetchCouponCode, publishDraft, type GeoPoint } from "@/lib/coupon/api";
import { useMediaQuery } from "@/lib/ui/use-breakpoint";
import { LAYOUT, type PageIntent, type PageSurfaceIntent } from "@/lib/design/tokens";
import { PageContainer } from "@/components/ui/page-container";

/** The shell's desktop tier — where its navigation becomes a sidebar. */
const SHELL_DESKTOP_MIN = `(min-width: ${LAYOUT.bp.expanded}px)`;

/**
 * `/revenue` hosts three surfaces of two different kinds, so the page cannot
 * declare one width intent for all of them. It declares `full` and each view
 * supplies its own — which is also where the Management / Consumer line is
 * drawn in code rather than only in a document.
 */
const SURFACE_INTENT: PageSurfaceIntent = "full";

/**
 * A Revenue MANAGEMENT surface.
 *
 * Two things happen here, and together they are the whole of R1's width work.
 *
 * `mode="app"` severs the width authority from the phone metaphor. Management
 * screens used to inherit a 480px cap from a `ScreenModeProvider mode="screen"`
 * wrapping the entire page, so at 1920 the owner ran the business — kill switch
 * included — inside a 480px column with ~1440px of dead canvas.
 *
 * The cap then comes from LAYOUT, per surface: a coupon list is `content`, an
 * authoring wizard is `focused`. No new primitive and no new breakpoint family.
 * This is a container, not the desktop workspace — that is R2's job.
 */
function ManagementSurface({
  intent,
  children,
}: {
  intent: Extract<PageIntent, "content" | "focused">;
  children: ReactNode;
}) {
  return (
    <ScreenModeProvider mode="app">
      {/* PageContainer, not a hand-rolled max-width: the cap has to come from the
          shared width authority, and the anti-drift ratchet counts page-level
          width literals for exactly this reason. `bleed` keeps the cap without
          adding gutters — these screens carry their own internal padding. */}
      <PageContainer as="div" intent={intent} bleed className="revenue-management">
        {children}
      </PageContainer>
    </ScreenModeProvider>
  );
}

type View = "mine" | "browse" | "create";

function parseView(raw: string | null): View {
  return raw === "browse" || raw === "create" ? raw : "mine";
}

function CouponFeature() {
  const router = useRouter();
  const params = useSearchParams();
  const view = parseView(params.get("view"));

  // The chrome policy is per VIEW, not per route, because the three views are
  // not the same kind of surface. `mine` and `create` are MANAGEMENT and gain
  // the shell's navigation from its desktop tier up. `browse` is the consumer
  // marketplace: it keeps the phone-shaped screen frame, and giving it the
  // owner's navigation would dress a consumer experience as a management one.
  // Below the desktop tier every view keeps the full viewport it has today.
  const isDesktop = useMediaQuery(SHELL_DESKTOP_MIN);
  useHideShellChrome(!isDesktop || view === "browse");

  const [coupons, setCoupons] = useState<PublicCoupon[] | null>(null);
  const [near, setNear] = useState<GeoPoint | null>(null);
  const [locating, setLocating] = useState(false);
  /** Set once the owner has made a real choice in the wizard — gates the exit prompt. */
  const [draftDirty, setDraftDirty] = useState(false);

  const go = useCallback(
    (next: View, replace = false) => {
      const url = next === "mine" ? "/revenue" : `/revenue?view=${next}`;
      if (replace) router.replace(url);
      else router.push(url);
    },
    [router]
  );

  const loadMarketplace = useCallback((point: GeoPoint | null) => {
    fetchActiveCoupons(24, point).then(setCoupons);
  }, []);

  // Only fetch the marketplace when it is actually being shown.
  useEffect(() => {
    if (view === "browse" && coupons === null) loadMarketplace(near);
  }, [view, coupons, near, loadMarketplace]);

  // Warn before a refresh/close throws away a part-built coupon (COUPON-10).
  useEffect(() => {
    if (view !== "create" || !draftDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [view, draftDirty]);

  const handleNear = (point: GeoPoint) => {
    setNear(point);
    setLocating(true);
    fetchActiveCoupons(24, point).then((next) => {
      setCoupons(next);
      setLocating(false);
    });
  };

  const leaveCreate = (published: boolean) => {
    if (!published && draftDirty && !window.confirm("לצאת מהיצירה? הקופון עדיין לא פורסם והפרטים יימחקו.")) {
      return;
    }
    setDraftDirty(false);
    go("mine", true);
  };

  if (view === "create") {
    return (
      <ManagementSurface intent="focused">
      <CouponCreationFlow
        startAtBeat={false}
        publish={publishDraft}
        onDirty={() => setDraftDirty(true)}
        onExit={(created) => leaveCreate(Boolean(created))}
      />
      </ManagementSurface>
    );
  }

  if (view === "browse") {
    if (coupons === null) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--dz-text-secondary)",
            fontFamily: "'Heebo', system-ui, sans-serif",
            direction: "rtl",
          }}
        >
          טוען הטבות…
        </div>
      );
    }
    return (
      <ScreenModeProvider mode="screen">
      <ConsumerJourney
        coupons={coupons}
        getCode={fetchCouponCode}
        onCreate={() => go("create")}
        onExit={() => go("mine")}
        onNear={handleNear}
        nearActive={near !== null}
        locating={locating}
      />
      </ScreenModeProvider>
    );
  }

  return (
    <ManagementSurface intent="content">
      <MyCouponsScreen
        onCreate={() => go("create")}
        onBrowse={() => go("browse")}
        onExit={() => router.push("/app")}
      />
    </ManagementSurface>
  );
}

function Loading() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--dz-text-secondary)", fontFamily: "'Heebo', system-ui, sans-serif", direction: "rtl" }}>
      טוען…
    </div>
  );
}

export default function RevenuePage() {
  // The chrome policy lives in `CouponFeature`, where the view is known — see
  // the note there. It cannot be decided here: this route serves a management
  // surface and a consumer one behind the same path.
  return (
    <main
      data-page-intent={SURFACE_INTENT}
      style={{ minHeight: "100vh", background: "var(--dz-background)", overflowX: "hidden" }}
    >
      {/* `useSearchParams` needs a Suspense boundary to prerender. */}
      <Suspense fallback={<Loading />}>
        <CouponFeature />
      </Suspense>
    </main>
  );
}
