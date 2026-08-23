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

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { ScreenModeProvider } from "@/components/ui/coupon/coupon-primitives";
import { ConsumerJourney } from "@/components/coupon/screens/consumer-screens";
import { CouponCreationFlow } from "@/components/coupon/screens/creation-screens";
import { MyCouponsScreen } from "@/components/coupon/screens/my-coupons-screen";
import type { PublicCoupon } from "@/components/coupon/coupon-model";
import { fetchActiveCoupons, fetchCouponCode, publishDraft, type GeoPoint } from "@/lib/coupon/api";

type View = "mine" | "browse" | "create";

function parseView(raw: string | null): View {
  return raw === "browse" || raw === "create" ? raw : "mine";
}

function CouponFeature() {
  const router = useRouter();
  const params = useSearchParams();
  const view = parseView(params.get("view"));

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
      <CouponCreationFlow
        startAtBeat={false}
        publish={publishDraft}
        onDirty={() => setDraftDirty(true)}
        onExit={(created) => leaveCreate(Boolean(created))}
      />
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
            color: "#777067",
            fontFamily: "'Heebo', system-ui, sans-serif",
            direction: "rtl",
          }}
        >
          טוען הטבות…
        </div>
      );
    }
    return (
      <ConsumerJourney
        coupons={coupons}
        getCode={fetchCouponCode}
        onCreate={() => go("create")}
        onExit={() => go("mine")}
        onNear={handleNear}
        nearActive={near !== null}
        locating={locating}
      />
    );
  }

  return (
    <MyCouponsScreen
      onCreate={() => go("create")}
      onBrowse={() => go("browse")}
      onExit={() => router.push("/app")}
    />
  );
}

function Loading() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#777067", fontFamily: "'Heebo', system-ui, sans-serif", direction: "rtl" }}>
      טוען…
    </div>
  );
}

export default function RevenuePage() {
  // Full-screen coupon journey with its own screen headers — hide the app's
  // fixed bottom nav so it doesn't clutter the flow.
  useHideShellChrome(true);
  return (
    <main style={{ minHeight: "100vh", background: "#FEF8F2", overflowX: "hidden" }}>
      <ScreenModeProvider mode="screen">
        {/* `useSearchParams` needs a Suspense boundary to prerender. */}
        <Suspense fallback={<Loading />}>
          <CouponFeature />
        </Suspense>
      </ScreenModeProvider>
    </main>
  );
}
