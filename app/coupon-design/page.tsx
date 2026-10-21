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
import { useI18n } from "@/components/i18n/I18nProvider";
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
  const { t } = useI18n();
  return (
    <main style={{ minHeight: "100vh", background: "var(--dz-surface-muted)", padding: "34px 26px 60px", fontFamily: "'Heebo', system-ui, sans-serif", color: W.ink }}>
      <div style={{ textAlign: "center", fontWeight: 600, fontSize: 23, letterSpacing: "-0.4px" }}>{t("content.commerce.coupon.gallery.title")}</div>
      <div style={{ textAlign: "center", fontSize: 13, color: W.muted, margin: "4px 0 30px" }}>
        {t("content.commerce.coupon.gallery.subtitle")}
      </div>

      <ZoneHeader name={t("content.commerce.coupon.gallery.ownerZone")} desc={t("content.commerce.coupon.gallery.ownerZoneDesc")} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "40px 28px", alignItems: "flex-start" }}>
        <Frame title={t("content.commerce.coupon.gallery.ownerJourney")} desc={t("content.commerce.coupon.gallery.ownerJourneyDesc")}>
          <CouponWorld />
        </Frame>
      </div>

      <ZoneHeader name={t("content.commerce.coupon.gallery.publicZone")} desc={t("content.commerce.coupon.gallery.publicZoneDesc")} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "40px 28px", alignItems: "flex-start" }}>
        <Frame title={t("content.commerce.coupon.gallery.customerJourney")} desc={t("content.commerce.coupon.gallery.customerJourneyDesc")}>
          <PublicWorld />
        </Frame>
        <Frame title={t("content.commerce.coupon.gallery.gridTitle")} desc={t("content.commerce.coupon.gallery.gridDesc")}>
          <MarketplaceGrid />
        </Frame>
        <Frame title={t("content.commerce.coupon.gallery.statesTitle")} desc={t("content.commerce.coupon.gallery.statesDesc")}>
          <CouponStatesScreen />
        </Frame>
      </div>
    </main>
  );
}
