"use client";

/**
 * Marketing Center — the business owner's permanent home in the marketing world.
 * NOT a coupon list / dashboard / end-screen: a living workspace (pulse · active ·
 * ended · create · manage · return). Capability-agnostic bones (activity states),
 * fully populated by coupons today — no empty tabs, no "coming soon". Warm palette
 * (owner tools). Entered from the Dubiz "קופונים" tile; creation launches from here
 * and returns here. Design layer only.
 */

import { useState, type ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { COUPON } from "@/lib/design/coupon-consumer";
import {
  PhoneFrame,
  ScreenBody,
  ScreenHeader,
  BackButton,
  StrokeIcon,
} from "@/components/ui/coupon/coupon-primitives";
import { CouponCreationFlow } from "@/components/coupon/screens/creation-screens";
import { PublicCouponContent } from "@/components/coupon/screens/consumer-screens";
import {
  type OwnerCoupon,
  type CouponView,
  MY_ACTIVE,
  MY_ENDED,
  MY_BUSINESS,
  draftToOwnerCoupon,
} from "@/components/coupon/coupon-model";

const W = TOKEN.warm;

/* ------------------------------------------------------ owner coupon card -- */

function ThemaDot({ thema, muted = false }: { thema: OwnerCoupon["thema"]; muted?: boolean }) {
  return <span style={{ width: 10, height: 10, borderRadius: 3, background: muted ? W.muted2 : COUPON.thema[thema], flexShrink: 0 }} />;
}
function Pill({ text, tone }: { text: string; tone: "active" | "ended" }) {
  const s = tone === "active" ? { color: W.tealDeep, bg: "rgba(36,105,102,0.10)" } : { color: W.muted, bg: W.surface2 };
  return <span style={{ fontSize: 11, fontWeight: 600, color: s.color, background: s.bg, borderRadius: W.radius.pill, padding: "2px 10px", whiteSpace: "nowrap" }}>{text}</span>;
}
function Action({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return <span onClick={onClick} style={{ fontSize: 12.5, fontWeight: 600, color: W.tealDeep, cursor: "pointer" }}>{children}</span>;
}

function ActiveCard({ c, onViewPublic }: { c: OwnerCoupon; onViewPublic?: () => void }) {
  return (
    <div style={{ background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.card, boxShadow: W.shadow, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <ThemaDot thema={c.thema} />
          <div style={{ fontSize: 15.5, fontWeight: 600, letterSpacing: "-0.2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.benefit}</div>
        </div>
        <Pill text="פעיל" tone="active" />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 12.5, color: W.muted, fontVariantNumeric: "tabular-nums" }}>
        <span>{c.metric}</span><span style={{ color: W.muted2 }}>·</span><span style={{ color: W.muted2 }}>{c.validityText}</span>
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 13, paddingTop: 13, borderTop: `1px solid ${W.line}` }}>
        <Action>שתף</Action>
        <Action onClick={onViewPublic}>עמוד ציבורי</Action>
        <Action>סיים</Action>
      </div>
    </div>
  );
}

function EndedCard({ c }: { c: OwnerCoupon }) {
  return (
    <div style={{ background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.card, padding: "14px 16px", opacity: 0.92 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <ThemaDot thema={c.thema} muted />
          <div style={{ fontSize: 14.5, fontWeight: 500, color: W.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.benefit}</div>
        </div>
        <Pill text="הסתיים" tone="ended" />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
        <span style={{ fontSize: 12.5, color: W.muted2, fontVariantNumeric: "tabular-nums" }}>{c.metric} · {c.validityText}</span>
        <Action>צור שוב ›</Action>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 600, color: W.ink, margin: "0 2px 12px" }}>{children}</div>;
}

/* ------------------------------------------------------ marketing center --- */

function MarketingCenter({ active, ended, onCreate, onBack, onViewPublic }: { active: OwnerCoupon[]; ended: OwnerCoupon[]; onCreate: () => void; onBack: () => void; onViewPublic?: (c: OwnerCoupon) => void }) {
  return (
    <PhoneFrame>
      <ScreenHeader title="מרכז השיווק" action={<BackButton onClick={onBack} />} />
      <ScreenBody>
        <div style={{ fontSize: 13, color: W.muted, margin: "-2px 2px 18px" }}>כאן חיות ההטבות שאתה מוציא ללקוחות שלך.</div>

        {/* pulse — living signal, decision-oriented */}
        <div style={{ background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.card, boxShadow: W.shadow, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: W.muted, marginBottom: 6 }}>הדופק שלך</div>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.2px", fontVariantNumeric: "tabular-nums" }}>
            {active.length} הטבות פעילות · 50 מומשו החודש
          </div>
          <div style={{ marginTop: 12, padding: "10px 12px", background: "rgba(36,105,102,0.06)", border: `1px solid rgba(36,105,102,0.12)`, borderRadius: W.radius.control, fontSize: 13, color: W.ink, lineHeight: 1.5 }}>
            ‘קפה + מאפה מתנה’ נגמרת מחר — <b style={{ fontWeight: 600, color: W.tealDeep }}>לחדש אותה?</b>
          </div>
        </div>

        {/* create — the standing invitation (the one door out to a new move) */}
        <button
          type="button"
          onClick={onCreate}
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, textAlign: "start", background: "rgba(36,105,102,0.05)", border: `1px solid ${W.teal}`, borderRadius: W.radius.card, padding: "16px 18px", fontFamily: "inherit", cursor: "pointer", marginBottom: 24 }}
        >
          <span style={{ width: 42, height: 42, borderRadius: 12, background: W.grad, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: W.glow }}>
            <StrokeIcon size={20} color="#fff" width={2.4}><path d="M12 5v14M5 12h14" /></StrokeIcon>
          </span>
          <span>
            <span style={{ display: "block", fontSize: 15.5, fontWeight: 600, color: W.tealDeep }}>צור קופון חדש</span>
            <span style={{ display: "block", fontSize: 12.5, color: W.muted, marginTop: 2 }}>הבא לקוחות עם הטבה חדשה</span>
          </span>
        </button>

        {/* active */}
        <SectionLabel>פעיל</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 26 }}>
          {active.map((c) => <ActiveCard key={c.id} c={c} onViewPublic={() => onViewPublic?.(c)} />)}
        </div>

        {/* ended */}
        <SectionLabel>הסתיים</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {ended.map((c) => <EndedCard key={c.id} c={c} />)}
        </div>
      </ScreenBody>
    </PhoneFrame>
  );
}

/* ------------------------------------------------------- marketing world --- */

/** The owner's marketing world: center ⇄ creation. Mount at the real feature
 *  route (/revenue) or inside the demo (CouponWorld). `onExit` leaves the world. */
export function MarketingWorld({ onExit }: { onExit?: () => void }) {
  const [active, setActive] = useState<OwnerCoupon[]>(MY_ACTIVE);
  const [mode, setMode] = useState<"center" | "create" | "public">("center");
  const [viewing, setViewing] = useState<OwnerCoupon | null>(null);

  if (mode === "create")
    return (
      <CouponCreationFlow
        startAtBeat={false}
        onExit={(created) => {
          if (created) setActive((a) => [draftToOwnerCoupon(created), ...a]);
          setMode("center");
        }}
      />
    );
  if (mode === "public" && viewing)
    return <PublicPreviewScreen coupon={viewing} onBack={() => setMode("center")} />;
  return (
    <MarketingCenter
      active={active}
      ended={MY_ENDED}
      onCreate={() => setMode("create")}
      onBack={() => onExit?.()}
      onViewPublic={(c) => { setViewing(c); setMode("public"); }}
    />
  );
}

/* ------------------------------------------ public preview (in-app) ------- */
/** How the customer sees this coupon — the SINGLE public entity, in-app. */
function PublicPreviewScreen({ coupon, onBack }: { coupon: OwnerCoupon; onBack: () => void }) {
  const view: CouponView = {
    business: MY_BUSINESS,
    benefit: coupon.benefit,
    description: "",
    valid: coupon.validityText,
    terms: "תנאי שימוש: קופון אחד ללקוח · בתיאום מראש · לא ניתן לכפל עם מבצעים אחרים.",
  };
  return (
    <PhoneFrame>
      <ScreenHeader title="תצוגה ציבורית" action={<BackButton onClick={onBack} />} />
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        <PublicCouponContent view={view} interactive={false} />
        <div style={{ padding: "16px 20px 20px", borderTop: `1px solid ${W.line}`, background: W.canvas }}>
          <div style={{ height: 50, borderRadius: 14, background: W.grad, color: "#fff", fontWeight: 600, fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: W.glow }}>קבל קופון</div>
          <div style={{ textAlign: "center", fontSize: 12, color: W.muted2, marginTop: 10 }}>כך הלקוח רואה את הקופון שלך</div>
        </div>
      </div>
    </PhoneFrame>
  );
}

/* ----------------------------------------------------- Dubiz home entry ---- */

const TOOLS: { key: string; label: string; icon: ReactNode; active?: boolean }[] = [
  { key: "coupons", label: "קופונים", active: true, icon: <><path d="M4 8h12l4 4-4 4H4z" /><path d="M9 8v8" strokeDasharray="2 2" /></> },
  { key: "docs", label: "מסמכים", icon: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></> },
  { key: "billing", label: "גבייה", icon: <><circle cx="12" cy="12" r="8" /><path d="M12 8v8M9.5 10a2.5 2 0 015 0c0 2-5 1-5 3a2.5 2 0 005 0" /></> },
  { key: "inventory", label: "מלאי", icon: <><path d="M4 8l8-4 8 4v8l-8 4-8-4z" /><path d="M4 8l8 4 8-4M12 12v8" /></> },
  { key: "secretary", label: "מזכירה", icon: <><path d="M4 5h16v11H9l-4 4z" /></> },
  { key: "content", label: "תוכן", icon: <><rect x="4" y="5" width="16" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M4 16l4-4 4 3 3-3 5 5" /></> },
];

function DubizHomeEntry({ onOpen }: { onOpen: () => void }) {
  return (
    <PhoneFrame>
      <ScreenHeader title="הכלים שלך" />
      <ScreenBody>
        <div style={{ fontSize: 13, color: W.muted, margin: "-2px 2px 18px" }}>מה תרצה לעשות בעסק היום?</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {TOOLS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={t.active ? onOpen : undefined}
              style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start", textAlign: "start", background: t.active ? "rgba(36,105,102,0.05)" : W.surface, border: `1px solid ${t.active ? W.teal : W.line}`, borderRadius: W.radius.card, padding: 16, minHeight: 104, boxShadow: W.shadow, fontFamily: "inherit", cursor: t.active ? "pointer" : "default" }}
            >
              <span style={{ width: 40, height: 40, borderRadius: 11, background: t.active ? W.grad : W.surface2, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <StrokeIcon size={20} color={t.active ? "#fff" : W.muted} width={1.8}>{t.icon}</StrokeIcon>
              </span>
              <span style={{ fontSize: 15, fontWeight: 600, color: t.active ? W.tealDeep : W.ink }}>{t.label}</span>
            </button>
          ))}
        </div>
      </ScreenBody>
    </PhoneFrame>
  );
}

/* ============================================================ WORLD ==== */
/** The owner's continuous journey: Dubiz tools → marketing center ⇄ creation. */
export function CouponWorld() {
  const [mode, setMode] = useState<"home" | "marketing">("home");
  return mode === "home" ? <DubizHomeEntry onOpen={() => setMode("marketing")} /> : <MarketingWorld onExit={() => setMode("home")} />;
}
