"use client";

/**
 * "מבצעים וקופונים" — the Dubiz tools tile points here.
 * The NEW coupon experience wired to the EXISTING backend (Stage 1):
 *   - Marketplace ← GET /api/revenue/coupons/active (real cross-business list)
 *   - Public → Personal ← /code (real QR/token)
 *   - "צור קופון" flow → createOffer + issue (real publish); new coupon re-appears
 * No new backend/DB/API. Advanced capabilities (distance/quota/…) come later.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { ScreenModeProvider } from "@/components/ui/coupon/coupon-primitives";
import { ConsumerJourney } from "@/components/coupon/screens/consumer-screens";
import { CouponCreationFlow } from "@/components/coupon/screens/creation-screens";
import type { PublicCoupon } from "@/components/coupon/coupon-model";
import { fetchActiveCoupons, fetchCouponCode, publishDraft, type GeoPoint } from "@/lib/coupon/api";

function CouponFeature() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [coupons, setCoupons] = useState<PublicCoupon[] | null>(null);
  const [near, setNear] = useState<GeoPoint | null>(null);
  const [locating, setLocating] = useState(false);

  const load = (point: GeoPoint | null = near) => {
    fetchActiveCoupons(24, point).then(setCoupons);
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opt-in: only fires when the user taps "קרוב אליי" and grants the browser prompt.
  const handleNear = (point: GeoPoint) => {
    setNear(point);
    setLocating(true);
    fetchActiveCoupons(24, point).then((next) => {
      setCoupons(next);
      setLocating(false);
    });
  };

  if (creating) {
    return (
      <CouponCreationFlow
        startAtBeat={false}
        publish={publishDraft}
        onExit={() => {
          setCreating(false);
          load();
        }}
      />
    );
  }

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
      onCreate={() => setCreating(true)}
      onExit={() => router.push("/app")}
      onNear={handleNear}
      nearActive={near !== null}
      locating={locating}
    />
  );
}

export default function RevenuePage() {
  // Full-screen coupon journey with its own screen headers — hide the app's
  // fixed bottom nav so it doesn't clutter the flow.
  useHideShellChrome(true);
  return (
    <main style={{ minHeight: "100vh", background: "#FEF8F2", overflowX: "hidden" }}>
      <ScreenModeProvider mode="screen">
        <CouponFeature />
      </ScreenModeProvider>
    </main>
  );
}
