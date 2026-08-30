"use client";

/**
 * Coupon consumer world — ONE continuous journey (marketplace → public page →
 * personal coupon). A tapped coupon threads through with its business identity
 * (thema) and data. `PublicCouponContent` is the SINGLE public-page entity,
 * reused by the owner's "published" preview. Design layer only.
 */

import { useState, type ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { COUPON, type CouponThema } from "@/lib/design/coupon-consumer";
import {
  PhoneFrame,
  ScreenBody,
  ScreenHeader,
  BackButton,
  BackText,
  CloseButton,
  StrokeIcon,
  Spring,
  PrimaryButton,
  SecondaryButton,
  WaButton,
} from "@/components/ui/coupon/coupon-primitives";
import { TicketCard } from "@/components/ui/coupon/ticket-card";
import { HScrollRow } from "@/components/ui/coupon/h-scroll-row";
import { QRCodeCanvas } from "qrcode.react";
import {
  type CatKey,
  type CatFamily,
  type CouponView,
  type PublicCoupon,
  publicToView,
  ROW_NEAR,
  ROW_POPULAR,
  ROW_SOON,
} from "@/components/coupon/coupon-model";
import { shortCode } from "@/lib/coupon/api";

const W = TOKEN.warm;

/* ------------------------------------------------------- category icons -- */

function catIcon(paths: ReactNode): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width={25} height={25} fill="none" stroke="#fff" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.95 }} aria-hidden>
      {paths}
    </svg>
  );
}
const CAT: Record<CatKey, ReactNode> = {
  coffee: catIcon(<><path d="M4 8h13v6a4 4 0 01-4 4H8a4 4 0 01-4-4z" /><path d="M17 9h2a2 2 0 010 4h-2" /><path d="M7 4v2M11 4v2" /></>),
  pizza: catIcon(<><circle cx="12" cy="12" r="8" /><path d="M12 4l3 8-3 8-3-8z" /></>),
  gem: catIcon(<><path d="M4 12l8-8 8 8-8 8z" /><circle cx="9" cy="9" r="1.3" /></>),
  spark: catIcon(<path d="M12 3l1.8 4.4L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9z" />),
  glass: catIcon(<><rect x="4" y="9" width="16" height="11" rx="1" /><path d="M4 13h16M12 9v11M12 9c-1-3-5-3-5 0M12 9c1-3 5-3 5 0" /></>),
  activity: catIcon(<path d="M4 12h4l2 5 4-10 2 5h4" />),
  wrench: catIcon(<><path d="M14 7l3 3-7 7-3-3z" /><path d="M17 10l2-2a2.8 2.8 0 00-4-4l-2 2" /></>),
};

/* ================================================= PUBLIC COUPON ENTITY == */
/* The single source of truth for "the page the customer sees". Used full (as a
   screen) AND as the owner's published preview — never two designs. */

export function PublicCouponContent({
  view,
  interactive = true,
  topInset = 0,
}: {
  view: CouponView;
  interactive?: boolean;
  /** Extra top padding on the hero — used when an absolute back button sits over it. */
  topInset?: number;
}) {
  const thema: CouponThema = view.business.thema;
  const fact = (icon: ReactNode, text: ReactNode, color: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 0", borderTop: `1px solid ${W.line}`, fontSize: 13.5 }}>
      <StrokeIcon size={17} color={color} width={1.8}>{icon}</StrokeIcon>
      <div>{text}</div>
    </div>
  );
  return (
    <div style={{ pointerEvents: interactive ? "auto" : "none", display: "flex", flexDirection: "column", flex: 1 }}>
      {/* hero — business identity (thema) */}
      <div style={{ background: COUPON.thema[thema], color: "#fff", padding: `${topInset || 18}px 18px 18px`, display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ width: 52, height: 52, borderRadius: 14, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600, fontSize: 19, flexShrink: 0 }}>{view.business.logo}</div>
        <div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{view.business.name}</div>
          {view.business.city ? (
            <div style={{ fontSize: 12.5, opacity: 0.9, marginTop: 2, display: "flex", alignItems: "center", gap: 5 }}>
              <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="#fff" strokeWidth={2} aria-hidden><path d="M12 21s7-6 7-11a7 7 0 00-14 0c0 5 7 11 7 11z" /><circle cx="12" cy="10" r="2.2" /></svg>
              {view.business.city}
            </div>
          ) : null}
        </div>
      </div>
      {/* body */}
      <div style={{ padding: "20px 20px 0", flex: 1 }}>
        <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.3px", lineHeight: 1.3 }}>{view.benefit}</div>
        {view.description ? <div style={{ fontSize: 14, color: W.muted, marginTop: 8, lineHeight: 1.55 }}>{view.description}</div> : null}
        <div style={{ margin: "18px 0 0", borderBottom: `1px solid ${W.line}` }}>
          {view.valid ? fact(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>, view.valid, W.tealDeep) : null}
          {view.business.address ? fact(<><path d="M12 21s7-6 7-11a7 7 0 00-14 0c0 5 7 11 7 11z" /><circle cx="12" cy="10" r="2.4" /></>, view.business.address, COUPON.accent.coral) : null}
          {view.business.hours ? fact(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, view.business.hours, COUPON.accent.amber) : null}
          {view.business.phone ? fact(<path d="M12 2a10 10 0 00-8.6 15l-1.4 5 5.1-1.3A10 10 0 1012 2z" />, "שלח הודעה בוואטסאפ", COUPON.accent.whatsapp) : null}
        </div>
        {view.remaining ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, fontSize: 12.5, color: W.muted }}>
            <span>נותרו <b style={{ color: W.brown, fontWeight: 600 }}>{view.remaining.left}</b> מתוך {view.remaining.total}</span>
            <div style={{ flex: 1, height: 6, borderRadius: 4, background: W.surface2, overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${Math.round((view.remaining.left / view.remaining.total) * 100)}%`, background: W.brown }} />
            </div>
          </div>
        ) : null}
        {view.terms ? <div style={{ fontSize: 12, color: W.muted2, marginTop: 16, lineHeight: 1.5 }}>{view.terms}</div> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------- full public screen -- */

function PublicCouponScreen({ coupon, onGet, onBack, notice, busy }: { coupon: PublicCoupon; onGet: () => void; onBack: () => void; notice?: string | null; busy?: boolean }) {
  const [copied, setCopied] = useState(false);

  // The coupon's real public page. `coupon.id` IS the opaque publicId.
  const link = typeof window !== "undefined" ? `${window.location.origin}/revenue/coupons/${coupon.id}` : "";

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("העתק את הקישור:", link);
    }
  };

  const share = () => {
    if (!link) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(`${coupon.benefit}\n${link}`)}`, "_blank", "noopener,noreferrer");
  };

  return (
    <PhoneFrame>
      <ScreenHeader absolute action={<BackText light onClick={onBack} />} />
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        <PublicCouponContent view={publicToView(coupon)} topInset={58} />
        <div style={{ padding: "16px 20px 20px", borderTop: `1px solid ${W.line}`, background: W.canvas }}>
          {notice ? (
            <div role="alert" style={{ marginBottom: 12, padding: 12, borderRadius: W.radius.control, background: W.surface2, border: `1px solid ${W.line}`, fontSize: 13, lineHeight: 1.55, color: W.ink }}>
              {notice}
              {coupon.business.phone ? (
                <a href={`tel:${coupon.business.phone}`} style={{ display: "block", marginTop: 6, fontWeight: 600, color: W.tealDeep, textDecoration: "none" }}>
                  התקשר ל{coupon.business.name ?? "בית העסק"} ›
                </a>
              ) : null}
            </div>
          ) : null}
          <PrimaryButton onClick={busy ? undefined : onGet} disabled={busy}>
            {busy ? "בודק…" : "קבל קופון"}
          </PrimaryButton>
          {/* These were inert buttons with no handler at all. Both now act on the
              coupon's real public URL. */}
          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <SecondaryButton onClick={share} style={{ flex: 1 }}>שתף</SecondaryButton>
            <SecondaryButton onClick={copy} style={{ flex: 1 }}>{copied ? "הועתק ✓" : "העתק קישור"}</SecondaryButton>
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

/* ----------------------------------------------------- personal coupon --- */

/** Reached only with a genuine token — `code` is required, not optional. */
function PersonalCouponScreen({ coupon, code, onBack }: { coupon: PublicCoupon; code: { token: string; qrValue: string }; onBack: () => void }) {
  const thema = coupon.business.thema;
  return (
    <PhoneFrame>
      <ScreenHeader title="הקופון שלך" action={<CloseButton onClick={onBack} />} />
      <ScreenBody>
        <div style={{ textAlign: "center", padding: "6px 0 18px" }}>
          <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.2px" }}>הקופון מוכן 🎉</div>
          <div style={{ fontSize: 13, color: W.muted, marginTop: 5 }}>הצג אותו בבית העסק כדי לממש.</div>
        </div>
        <div style={{ background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.card, boxShadow: W.shadow, overflow: "hidden" }}>
          <div style={{ padding: "16px 18px", color: "#fff", textAlign: "center", background: COUPON.thema[thema] }}>
            <div style={{ fontSize: 13, fontWeight: 500, opacity: 0.92 }}>{coupon.business.name}</div>
            <div style={{ fontSize: 17, fontWeight: 600, marginTop: 2 }}>{coupon.benefit}</div>
          </div>
          {/*
            A QR and a backup code are shown ONLY when a real token backed them.
            The placeholder `<QrBox />` and the hardcoded "8F2K · 9QX4" that used
            to fill in here were indistinguishable from a working coupon.
          */}
          <div style={{ padding: "22px 18px 10px" }}>
            <div style={{ width: 168, height: 168, margin: "0 auto", background: "#fff", border: `1px solid ${W.line}`, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <QRCodeCanvas value={code.qrValue} size={140} />
            </div>
          </div>
          <div style={{ textAlign: "center", fontSize: 15, fontWeight: 600, letterSpacing: "2px", color: W.ink, padding: "2px 0 4px" }}>
            <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: 0, color: W.muted2, display: "block", marginBottom: 3 }}>קוד לגיבוי</span>
            {shortCode(code.token)}
          </div>
          {/* "קופון אחד ללקוח" was hardcoded here too — a term no business set
              and the system cannot enforce. Only the real expiry is stated. */}
          <div style={{ textAlign: "center", fontSize: 12, color: W.muted, padding: "6px 0 18px" }}>{coupon.valid} · לשימוש חד-פעמי</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, margin: "18px 0 4px", fontSize: 14.5, fontWeight: 600, color: W.tealDeep }}>
          <StrokeIcon size={18} color={W.tealDeep} width={2}><path d="M5 12h14M13 6l6 6-6 6" /></StrokeIcon>
          הצג את הקופון בבית העסק
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <WaButton>שתף</WaButton>
          <SecondaryButton>שמור לתמונות</SecondaryButton>
        </div>
      </ScreenBody>
    </PhoneFrame>
  );
}

/* ---------------------------------------------------------- marketplace -- */

function Dot({ color }: { color: string }) {
  return <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />;
}
function FilterChip({ children, on = false, onClick }: { children: ReactNode; on?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 34, padding: "0 12px", flexShrink: 0, border: `1px solid ${on ? W.teal : W.line}`, borderRadius: W.radius.pill, background: on ? "rgba(36,105,102,0.06)" : W.surface, fontSize: 12.5, fontWeight: 600, color: on ? W.tealDeep : W.ink, fontFamily: "inherit", cursor: "pointer" }}>
      {children}
    </button>
  );
}
function Eyebrow({ dot, children }: { dot: string; children: ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 600, color: W.muted, letterSpacing: "0.2px", margin: "0 2px 14px" }}>
      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: dot, marginLeft: 7, verticalAlign: "middle" }} />
      {children}
    </div>
  );
}
function Row({ dot, title, coupons, onOpen }: { dot: string; title: string; coupons: PublicCoupon[]; onOpen: (c: PublicCoupon) => void }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <Eyebrow dot={dot}>{title}</Eyebrow>
      <HScrollRow style={{ margin: "0 -20px", padding: "2px 20px" }}>
        {coupons.map((c) => (
          <TicketCard key={c.id} compact thema={c.business.thema} categoryIcon={CAT[c.category]} business={c.business.name ?? ""} benefit={c.benefit} valid={c.valid} city={c.business.city ?? undefined} distance={c.distance} ribbon={c.ribbon} onClick={() => onOpen(c)} />
        ))}
      </HScrollRow>
    </div>
  );
}

function Marketplace({ onOpen, onCreate, onExit, coupons, onNear, nearActive = false, locating = false }: { onOpen: (c: PublicCoupon) => void; onCreate?: () => void; onExit?: () => void; coupons?: PublicCoupon[]; onNear?: (c: { lat: number; lng: number }) => void; nearActive?: boolean; locating?: boolean }) {
  const [q, setQ] = useState("");
  const [fam, setFam] = useState<CatFamily | null>(null);
  const [cityFilter, setCityFilter] = useState<string | null>(null);
  const toggleFam = (f: CatFamily) => setFam((cur) => (cur === f ? null : f));
  const toggleCity = (c: string) => setCityFilter((cur) => (cur === c ? null : c));

  // City filter is built only from REAL city values present in the data.
  const cities = [...new Set((coupons ?? []).map((c) => c.business.city).filter((v): v is string => !!v && v.trim().length > 0))];

  const list = (coupons ?? []).filter((c) => {
    if (fam && (c.catFamily ?? "other") !== fam) return false;
    if (cityFilter && c.business.city !== cityFilter) return false;
    const query = q.trim().toLowerCase();
    if (query && !`${c.business.name} ${c.benefit}`.toLowerCase().includes(query)) return false;
    return true;
  });
  const filtering = q.trim().length > 0 || fam !== null || cityFilter !== null;
  const expMs = (c: PublicCoupon) => (c.expiresAt ? new Date(c.expiresAt).getTime() : Number.POSITIVE_INFINITY);
  const byPopular = [...(coupons ?? [])].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  const bySoon = [...(coupons ?? [])].sort((a, b) => expMs(a) - expMs(b));

  // "קרוב אליך" appears only with a real reference point AND real per-business geo.
  const byNear = (coupons ?? []).filter((c) => typeof c.distanceKm === "number").sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  const showNear = nearActive && byNear.length > 0;

  const handleLocate = () => {
    if (!onNear || typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => onNear({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {}, // opt-in only — silently ignore denial, no aggressive retry
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  };
  const cityTitle = cityFilter && q.trim().length === 0 && fam === null ? `הטבות ב${cityFilter}` : "תוצאות";
  return (
    <PhoneFrame>
      {onExit ? (
        <div style={{ display: "flex", padding: "16px 20px 0" }}>
          <BackText onClick={onExit} />
        </div>
      ) : null}
      <div style={{ padding: "18px 20px 4px" }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: W.muted2, marginBottom: 3 }}>גלה הטבות סביבך</div>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.4px", margin: 0 }}>הטבות קרוב אליך</h2>
      </div>
      <ScreenBody style={{ paddingTop: 0, paddingBottom: 110 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, height: 46, background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.control, padding: "0 14px", margin: "12px 0" }}>
          <StrokeIcon size={17} color={W.muted2} width={1.9}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></StrokeIcon>
          {/* Borderless field inside a 46px pill: it collapsed to its own 21px
              content box — below A-7's 24x24 gating target — and clicking the
              pill's padding did not focus it. Stretching it to the pill's height
              makes the visual control and the hit area the same thing.
              Presentation only: same value, same handler, same placeholder. */}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש הטבה, עסק או תחום" style={{ flex: 1, alignSelf: "stretch", border: "none", background: "transparent", outline: "none", fontFamily: "inherit", fontSize: 14, color: W.ink }} />
        </div>
        <HScrollRow style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", gap: 9 }}>
            {onNear ? (
              <FilterChip on={nearActive} onClick={handleLocate}>
                <StrokeIcon size={13} color={nearActive ? W.tealDeep : W.muted2} width={1.9}><path d="M12 21s7-6 7-11a7 7 0 00-14 0c0 5 7 11 7 11z" /><circle cx="12" cy="10" r="2.4" /></StrokeIcon>
                {locating ? "מאתר…" : "קרוב אליי"}
              </FilterChip>
            ) : null}
            {cities.map((city) => (
              <FilterChip key={city} on={cityFilter === city} onClick={() => toggleCity(city)}>
                <StrokeIcon size={13} color={cityFilter === city ? W.tealDeep : W.muted2} width={1.9}><path d="M12 21s7-6 7-11a7 7 0 00-14 0c0 5 7 11 7 11z" /><circle cx="12" cy="10" r="2.4" /></StrokeIcon>
                {city}
              </FilterChip>
            ))}
            <FilterChip on={fam === "food"} onClick={() => toggleFam("food")}><Dot color={COUPON.accent.coral} />אוכל</FilterChip>
            <FilterChip on={fam === "beauty"} onClick={() => toggleFam("beauty")}><Dot color={COUPON.accent.violet} />יופי</FilterChip>
            <FilterChip on={fam === "health"} onClick={() => toggleFam("health")}><Dot color={W.teal} />בריאות</FilterChip>
          </div>
        </HScrollRow>
        {coupons === undefined ? (
          <>
            <Row dot={COUPON.accent.coral} title="קרוב אליך" coupons={ROW_NEAR} onOpen={onOpen} />
            <Row dot={COUPON.accent.violet} title="הכי מבוקשים" coupons={ROW_POPULAR} onOpen={onOpen} />
            <Row dot={COUPON.accent.clay} title="אוזלים במהרה" coupons={ROW_SOON} onOpen={onOpen} />
          </>
        ) : coupons.length === 0 ? (
          <div style={{ padding: "24px 4px", textAlign: "center", color: W.muted, fontSize: 14, lineHeight: 1.6 }}>
            אין כרגע הטבות פעילות להצגה.
            <div style={{ fontSize: 12.5, color: W.muted2, marginTop: 4 }}>צרו את ההטבה הראשונה שלכם עם הכפתור למטה.</div>
          </div>
        ) : filtering ? (
          list.length === 0 ? (
            <div style={{ padding: "24px 4px", textAlign: "center", color: W.muted, fontSize: 14 }}>לא נמצאו הטבות שמתאימות לחיפוש.</div>
          ) : (
            <>
              <Eyebrow dot={COUPON.accent.violet}>{cityTitle}</Eyebrow>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px 12px" }}>
                {list.map((c) => (
                  <TicketCard key={c.id} thema={c.business.thema} categoryIcon={CAT[c.category]} business={c.business.name ?? ""} benefit={c.benefit} valid={c.valid} city={c.business.city ?? undefined} distance={c.distance} onClick={() => onOpen(c)} />
                ))}
              </div>
            </>
          )
        ) : (
          <>
            {showNear ? <Row dot={COUPON.accent.coral} title="קרוב אליך" coupons={byNear} onOpen={onOpen} /> : null}
            <Row dot={COUPON.accent.violet} title="הכי מבוקשים" coupons={byPopular} onOpen={onOpen} />
            <Row dot={COUPON.accent.clay} title="מסתיימים בקרוב" coupons={bySoon} onOpen={onOpen} />
          </>
        )}
      </ScreenBody>
      <button type="button" onClick={onCreate} style={{ position: "absolute", bottom: 24, left: 20, height: 50, padding: "0 20px 0 16px", border: "none", borderRadius: W.radius.pill, background: W.grad, color: "#fff", fontFamily: "inherit", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 9, boxShadow: W.glow, cursor: "pointer" }}>
        <span style={{ position: "absolute", top: -9, right: 8, fontSize: 9, fontWeight: 600, color: W.brown, background: "#FBF3E7", border: `1px solid ${W.line}`, borderRadius: W.radius.pill, padding: "1px 7px" }}>בעלי עסק</span>
        <StrokeIcon size={18} color="#fff" width={2.2}><path d="M12 5v14M5 12h14" /></StrokeIcon>
        צור קופון
      </button>
    </PhoneFrame>
  );
}

/* ================================================= CONSUMER JOURNEY ===== */

export function ConsumerJourney({
  onCreate,
  onExit,
  coupons,
  getCode,
  onNear,
  nearActive,
  locating,
}: {
  onCreate?: () => void;
  onExit?: () => void;
  coupons?: PublicCoupon[];
  getCode?: (publicId: string) => Promise<{ token: string; qrValue: string } | null>;
  onNear?: (c: { lat: number; lng: number }) => void;
  nearActive?: boolean;
  locating?: boolean;
}) {
  const [stage, setStage] = useState<"market" | "public" | "personal">("market");
  const [sel, setSel] = useState<PublicCoupon | null>(null);
  const [code, setCode] = useState<{ token: string; qrValue: string } | null>(null);

  const [claimError, setClaimError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  /**
   * Claiming a coupon (COUPON-01, consumer half).
   *
   * This used to `setStage("personal")` unconditionally — the same defect the
   * creation flow had. `getCode` is issuer-only by deliberate security design
   * (W1-01), so for anyone browsing the marketplace it returns null, and the
   * personal screen then rendered "הקופון מוכן 🎉" over a placeholder QR and a
   * hardcoded backup code. That sent a real person to a real business holding a
   * fabricated code that could never be redeemed.
   *
   * The personal screen is now reachable only with a genuine token.
   */
  const handleGet = async () => {
    if (!sel) return;
    setClaimError(null);

    if (!getCode) {
      // Demo mode (the /coupon-design gallery) — no backend behind it. The
      // sample token is explicit rather than a null that renders as a
      // real-looking coupon.
      setCode({ token: "DEMO-0000-0000", qrValue: "https://dubiz.example/demo" });
      setStage("personal");
      return;
    }

    setClaiming(true);
    const real = await getCode(sel.id);
    setClaiming(false);

    if (!real?.qrValue) {
      setClaimError(
        "הקופון הזה מוצג לתצוגה בלבד. כדי לממש אותו יש לפנות ישירות לבית העסק."
      );
      return;
    }

    setCode(real);
    setStage("personal");
  };

  if (stage === "public" && sel)
    return (
      <PublicCouponScreen
        coupon={sel}
        onGet={handleGet}
        onBack={() => { setClaimError(null); setStage("market"); }}
        notice={claimError}
        busy={claiming}
      />
    );
  // `code` in the guard is load-bearing: without a real token there is no
  // personal coupon to show, so the screen is unreachable rather than faked.
  if (stage === "personal" && sel && code)
    return <PersonalCouponScreen coupon={sel} code={code} onBack={() => setStage("market")} />;
  return <Marketplace coupons={coupons} onOpen={(c) => { setSel(c); setCode(null); setStage("public"); }} onCreate={onCreate} onExit={onExit} onNear={onNear} nearActive={nearActive} locating={locating} />;
}

/* ============================================ MARKETPLACE (grid variant) == */
/* Faithful to docs/coupon/coupon_marketplace.html — a 2-col grid of full
   tickets ("מומלצים קרוב אליך") with dropdown-style filters. */

function GridFilterChip({ children, on = false, chevron = false }: { children: ReactNode; on?: boolean; chevron?: boolean }) {
  return (
    <button type="button" style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 36, padding: "0 13px", flexShrink: 0, border: `1px solid ${on ? W.teal : W.line}`, borderRadius: W.radius.pill, background: on ? "rgba(36,105,102,0.06)" : W.surface, fontSize: 13, fontWeight: 600, color: on ? W.tealDeep : W.ink, fontFamily: "inherit", cursor: "pointer", whiteSpace: "nowrap" }}>
      {children}
      {chevron ? <StrokeIcon size={12} color={W.muted2} width={1.9}><path d="M6 9l6 6 6-6" /></StrokeIcon> : null}
    </button>
  );
}

export function MarketplaceGrid({ onOpenCoupon, onCreate }: { onOpenCoupon?: () => void; onCreate?: () => void }) {
  const flowerIcon = catIcon(<><circle cx="12" cy="9" r="3" /><path d="M12 12v9M9 16l-3-2M15 16l3-2M12 6c0-2 1.5-3 3-3M12 6c0-2-1.5-3-3-3" /></>);
  const items: { thema: CouponThema; icon: ReactNode; biz: string; benefit: string; valid: string; dist: string }[] = [
    { thema: "teal", icon: CAT.coffee, biz: "קפה נחמה", benefit: "קפה + מאפה מתנה", valid: "תקף עד 20.7", dist: "0.4 ק״מ" },
    { thema: "orange", icon: CAT.spark, biz: "מספרת דנה", benefit: "20% על תספורת ראשונה", valid: "תקף שבועיים", dist: "1.1 ק״מ" },
    { thema: "purple", icon: CAT.pizza, biz: "פיצה רומא", benefit: "1+1 על משפחתית", valid: "תקף עד 15.7", dist: "0.8 ק״מ" },
    { thema: "pink", icon: CAT.activity, biz: "קליניקת ריאה", benefit: "ייעוץ ראשון ללא עלות", valid: "תקף חודש", dist: "2.3 ק״מ" },
    { thema: "teal", icon: flowerIcon, biz: "חנות הפרחים", benefit: "זר קטן מתנה בקנייה", valid: "תקף שבוע", dist: "1.5 ק״מ" },
    { thema: "orange", icon: CAT.wrench, biz: "מוסך אבי", benefit: "בדיקת חורף ללא עלות", valid: "תקף עד 31.7", dist: "3.0 ק״מ" },
  ];
  return (
    <PhoneFrame>
      <div style={{ padding: "22px 20px 6px" }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: W.muted2, marginBottom: 3 }}>גלה הטבות סביבך</div>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.4px", margin: 0 }}>הטבות קרוב אליך</h2>
      </div>
      <ScreenBody style={{ paddingTop: 12, paddingBottom: 120 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, height: 48, background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.control, padding: "0 14px", marginBottom: 14 }}>
          <StrokeIcon size={18} color={W.muted2} width={1.9}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></StrokeIcon>
          <span style={{ fontSize: 14.5, color: W.muted2 }}>חיפוש הטבה, עסק או תחום</span>
        </div>
        <div style={{ display: "flex", gap: 9, marginBottom: 26, overflowX: "auto", paddingBottom: 2 }}>
          <GridFilterChip on chevron><StrokeIcon size={14} color={W.tealDeep} width={1.9}><path d="M12 21s7-6 7-11a7 7 0 00-14 0c0 5 7 11 7 11z" /><circle cx="12" cy="10" r="2.4" /></StrokeIcon>תל אביב</GridFilterChip>
          <GridFilterChip chevron>כל התחומים</GridFilterChip>
          <GridFilterChip>אוכל</GridFilterChip>
          <GridFilterChip>יופי</GridFilterChip>
          <GridFilterChip>בריאות</GridFilterChip>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: W.muted, letterSpacing: "0.2px", margin: "0 2px 16px" }}>מומלצים קרוב אליך</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px 12px" }}>
          {items.map((t, i) => (
            <TicketCard key={i} thema={t.thema} categoryIcon={t.icon} business={t.biz} benefit={t.benefit} valid={t.valid} distance={t.dist} onClick={onOpenCoupon} />
          ))}
        </div>
      </ScreenBody>
      <button type="button" onClick={onCreate} style={{ position: "absolute", bottom: 26, left: 20, height: 52, padding: "0 22px 0 18px", border: "none", borderRadius: W.radius.pill, background: W.grad, color: "#fff", fontFamily: "inherit", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 9, boxShadow: W.glow, cursor: "pointer" }}>
        <span style={{ position: "absolute", top: -9, right: 8, fontSize: 9, fontWeight: 600, color: W.brown, background: "#FBF3E7", border: `1px solid ${W.line}`, borderRadius: W.radius.pill, padding: "1px 7px" }}>בעלי עסק</span>
        <StrokeIcon size={19} color="#fff" width={2.2}><path d="M12 5v14M5 12h14" /></StrokeIcon>
        צור קופון
      </button>
    </PhoneFrame>
  );
}

/* ====================================================== COUPON STATES ==== */

function StateCard({ tone, icon, title, sub }: { tone: "exp" | "out" | "red"; icon: ReactNode; title: string; sub: string }) {
  const map = {
    exp: { bg: W.surface2, stroke: W.muted },
    out: { bg: "rgba(184,135,85,0.12)", stroke: W.brown },
    red: { bg: "rgba(36,105,102,0.1)", stroke: W.tealDeep },
  }[tone];
  return (
    <div style={{ background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.card, padding: "20px 16px", boxShadow: W.shadow, textAlign: "center", marginBottom: 14 }}>
      <div style={{ width: 46, height: 46, borderRadius: "50%", background: map.bg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
        <StrokeIcon size={22} color={map.stroke} width={2}>{icon}</StrokeIcon>
      </div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: W.muted, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

export function CouponStatesScreen() {
  return (
    <PhoneFrame>
      <ScreenHeader title="מצבים" action={<BackButton />} />
      <ScreenBody>
        <StateCard tone="exp" icon={<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>} title="ההטבה הסתיימה" sub="התוקף עבר — לא ניתן לקבל קופון." />
        <StateCard tone="out" icon={<path d="M20 6L9 17l-5-5" />} title="כל הקופונים מומשו" sub="נותרו 0 מתוך 50 — ההטבה אזלה." />
        <StateCard tone="red" icon={<><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></>} title="הקופון מומש" sub="כבר השתמשת בקופון הזה — אין שימוש חוזר." />
      </ScreenBody>
    </PhoneFrame>
  );
}
