"use client";

/**
 * Coupon world — the complete design package as ONE continuous experience.
 * Owner journey: Dubiz tools → "קופונים" tile → Marketing Center ⇄ creation
 * (launches from the center, returns to it, the new coupon appears in Active).
 * Public journey: marketplace → public page → personal coupon; its owner
 * shortcut crosses the inspiration→creation beat. Design layer only.
 */

import { useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { CouponWorld } from "@/components/coupon/screens/marketing-center";
import { CouponCreationFlow } from "@/components/coupon/screens/creation-screens";
import { ConsumerJourney, CouponStatesScreen, MarketplaceGrid } from "@/components/coupon/screens/consumer-screens";

const W = TOKEN.warm;

/** Public world: discovery, plus the owner shortcut that crosses the beat. */
function PublicWorld() {
  const [creating, setCreating] = useState(false);
  return creating ? (
    <CouponCreationFlow startAtBeat onExit={() => setCreating(false)} />
  ) : (
    <ConsumerJourney onCreate={() => setCreating(true)} />
  );
}

function Frame({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div style={{ width: 390 }}>
      <div style={{ marginBottom: 10, padding: "0 2px" }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
        <div style={{ fontSize: 12, color: W.muted, marginTop: 2 }}>{desc}</div>
      </div>
      {children}
    </div>
  );
}

function ZoneHeader({ name, desc }: { name: string; desc: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "26px 4px 20px", flexWrap: "wrap" }}>
      <span style={{ fontSize: 15, fontWeight: 600, color: W.tealDeep, background: "var(--dz-surface-muted)", border: `1px solid ${W.line}`, borderRadius: W.radius.pill, padding: "5px 14px" }}>{name}</span>
      <span style={{ fontSize: 12.5, color: W.muted }}>{desc}</span>
    </div>
  );
}

export default function CouponDesignGalleryPage() {
  return (
    <main style={{ minHeight: "100vh", background: "var(--dz-surface-muted)", padding: "34px 26px 60px", direction: "rtl", fontFamily: "'Heebo', system-ui, sans-serif", color: W.ink }}>
      <div style={{ textAlign: "center", fontWeight: 600, fontSize: 23, letterSpacing: "-0.4px" }}>עולם הקופונים — חבילת עיצוב שלמה</div>
      <div style={{ textAlign: "center", fontSize: 13, color: W.muted, margin: "4px 0 30px" }}>
        Dubiz → מרכז השיווק → יצירה → חזרה למרכז · לצד העולם הציבורי · מסע אחד רציף (אינטראקטיבי — לחצו לנווט)
      </div>

      <ZoneHeader name="עולם בעל העסק" desc="Dubiz · כרטיסיית קופונים → מרכז השיווק ⇄ יצירה (משוגרת מהמרכז וחוזרת אליו)" />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "40px 28px", alignItems: "flex-start" }}>
        <Frame title="המסע המלא של בעל העסק" desc="לחצו 'קופונים' → מרכז השיווק → 'צור קופון' → חזרה, והקופון החדש מופיע ב'פעיל'">
          <CouponWorld />
        </Frame>
      </div>

      <ZoneHeader name="העולם הציבורי" desc="Discovery + Redemption · כל אדם רואה" />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "40px 28px", alignItems: "flex-start" }}>
        <Frame title="מסע הלקוח" desc="מרקטפלייס → עמוד קופון → קופון אישי · thema נמשך per-עסק">
          <PublicWorld />
        </Frame>
        <Frame title="מרקטפלייס — תצוגת רשת (וריאציה)" desc="מהקובץ coupon_marketplace.html · רשת 'מומלצים' + סינון תחומים">
          <MarketplaceGrid />
        </Frame>
        <Frame title="מצבי קופון" desc="פג תוקף · אזל · מומש">
          <CouponStatesScreen />
        </Frame>
      </div>
    </main>
  );
}
