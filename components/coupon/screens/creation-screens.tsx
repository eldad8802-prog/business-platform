"use client";

/**
 * Coupon creation — ONE continuous flow (business owner). A single draft object
 * threads through every step: transition-beat → goal → direction → builder →
 * terms → published. Direction guides the Builder's starting point (not locks);
 * the Builder's only task is defining the benefit; terms+validity are the next
 * light moment; "published" previews the SINGLE public-coupon entity. No backend.
 */

import { useState, type ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { COUPON } from "@/lib/design/coupon-consumer";
import {
  PhoneFrame,
  ScreenBody,
  ScreenHeader,
  BackButton,
  CloseButton,
  FlowIntro,
  ChoiceCard,
  StrokeIcon,
  Spring,
  PrimaryButton,
  SecondaryButton,
  WaButton,
  GhostLink,
} from "@/components/ui/coupon/coupon-primitives";
import { LiveCouponDisplay } from "@/components/ui/coupon/live-coupon-display";
import { PublicCouponContent } from "@/components/coupon/screens/consumer-screens";
import {
  type CouponDraft,
  type BenefitType,
  type Direction,
  GOALS,
  GOAL_ECHO,
  DIRECTION_LABEL,
  DIRECTIONS_6,
  directionDefault,
  orderedTypesFor,
  segmentText,
  benefitSentence,
  couponTitle,
  draftToView,
  initialDraft,
  SCOPES,
  MORE_OPTS,
  CONDITIONS,
  VALIDITIES,
} from "@/components/coupon/coupon-model";
import type { PublishResult } from "@/lib/coupon/api";

const W = TOKEN.warm;

const GOAL_ICON: Record<string, ReactNode> = {
  new: <><circle cx="10" cy="8" r="3.4" /><path d="M4 20a6 6 0 0112 0" /><path d="M19 7v6M16 10h6" /></>,
  return: <><path d="M9 14l-4-4 4-4" /><path d="M5 10h9a5 5 0 015 5v1" /></>,
  basket: <><path d="M6 9h12l-1 10a1 1 0 01-1 1H8a1 1 0 01-1-1z" /><path d="M9 9V7a3 3 0 016 0v2" /><path d="M12 17v-4M10 15l2-2 2 2" /></>,
  promote: <path d="M12 3l1.8 4.4L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9z" />,
  reward: <path d="M12 20s-7-4.4-7-9a3.9 3.9 0 017-2.5A3.9 3.9 0 0119 11c0 4.6-7 9-7 9z" />,
};

type Step = "intro" | "goal" | "direction" | "builder" | "terms" | "published";

/* ============================================================== FLOW ==== */

export function CouponCreationFlow({
  onExit,
  startAtBeat = true,
  publish,
}: {
  /** Called on abandon (no arg) or on finish (the created draft). */
  onExit?: (created?: CouponDraft) => void;
  /** Show the inspiration→creation beat first (only when entered from the public marketplace). */
  startAtBeat?: boolean;
  /** Persist via the real backend (createOffer → issue). Demo (no save) when absent. */
  publish?: (draft: CouponDraft) => Promise<PublishResult>;
}) {
  const [step, setStep] = useState<Step>(startAtBeat ? "intro" : "goal");
  const [draft, setDraft] = useState<CouponDraft>(initialDraft);
  const patch = (p: Partial<CouponDraft>) => setDraft((d) => ({ ...d, ...p }));
  const [dirShowAll, setDirShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishResult>(null);

  const doCreate = async () => {
    if (publish) {
      setBusy(true);
      setResult(await publish(draft));
      setBusy(false);
    }
    setStep("published");
  };

  const header = (back: Step | null, close = false) => (
    <ScreenHeader
      title={close ? undefined : "קופון חדש"}
      action={close ? <CloseButton onClick={onExit} /> : back ? <BackButton onClick={() => setStep(back)} /> : undefined}
    />
  );

  if (step === "intro") return <TransitionBeat onStart={() => setStep("goal")} onExit={onExit} />;

  if (step === "goal")
    return (
      <PhoneFrame>
        {header(null, false)}
        <ScreenBody>
          <FlowIntro eye="בוא נחשוב על זה יחד" q="מה תרצה שהקופון יעזור לך לעשות?" />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {GOALS.map((g) => (
              <ChoiceCard
                key={g.key}
                icon={<StrokeIcon>{GOAL_ICON[g.key]}</StrokeIcon>}
                title={g.label}
                selected={draft.goal === g.key}
                onClick={() => { patch({ goal: g.key }); setStep("direction"); }}
              />
            ))}
          </div>
        </ScreenBody>
      </PhoneFrame>
    );

  if (step === "direction") {
    const pick = (key: Direction) => {
      const def = directionDefault(key);
      patch({ direction: key, benefitType: def.type, value: def.value });
      setStep("builder");
    };
    const card = (d: { key: Direction; label: string; why: string }) => (
      <ChoiceCard key={d.key} title={d.label} why={d.why} selected={draft.direction === d.key} onClick={() => pick(d.key)} />
    );
    const mains = DIRECTIONS_6.filter((d) => !d.extra);
    const extras = DIRECTIONS_6.filter((d) => d.extra);
    return (
      <PhoneFrame>
        {header("goal")}
        <ScreenBody>
          <FlowIntro eye={GOAL_ECHO[draft.goal || "new"]} q="איזו הטבה בדרך כלל עוזרת לזה?" />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {mains.map(card)}
            {dirShowAll ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 2px" }}>
                  <div style={{ flex: 1, height: 1, background: W.line }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: W.muted2 }}>עוד דרכים</span>
                  <div style={{ flex: 1, height: 1, background: W.line }} />
                </div>
                {extras.map(card)}
              </>
            ) : null}
          </div>
          {!dirShowAll ? (
            <div onClick={() => setDirShowAll(true)} style={{ marginTop: 14, textAlign: "center", fontSize: 13, fontWeight: 500, color: W.muted, cursor: "pointer" }}>
              הראה עוד דרכים ›
            </div>
          ) : null}
        </ScreenBody>
      </PhoneFrame>
    );
  }

  if (step === "builder")
    return <BuilderStep draft={draft} patch={patch} header={header("direction")} onNext={() => setStep("terms")} />;

  if (step === "terms")
    return <TermsStep draft={draft} patch={patch} header={header("builder")} onCreate={doCreate} busy={busy} />;

  return <PublishedStep draft={draft} result={result} header={header(null, true)} onDone={() => onExit?.(draft)} />;
}

/* ==================================================== TRANSITION BEAT ==== */
/* The inspiration → creation bridge. Not a form — one calm story moment. */

function TransitionBeat({ onStart, onExit }: { onStart: () => void; onExit?: () => void }) {
  return (
    <PhoneFrame>
      <ScreenHeader action={<CloseButton onClick={onExit} />} />
      <ScreenBody style={{ justifyContent: "center", textAlign: "center", padding: "8px 28px 32px" }}>
        <Spring />
        <div style={{ width: 64, height: 64, borderRadius: 20, background: COUPON.thema.teal, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 22px", boxShadow: W.glow }}>
          <StrokeIcon size={30} color="#fff" width={1.9}><path d="M12 3l1.8 4.4L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9z" /></StrokeIcon>
        </div>
        <div style={{ fontSize: 13, fontWeight: 500, color: W.muted2, marginBottom: 10 }}>ראית מה עסקים אחרים מציעים</div>
        <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.35, letterSpacing: "-0.4px" }}>
          עכשיו תורך ליצור הטבה<br />שהלקוחות שלך יראו
        </div>
        <div style={{ fontSize: 14.5, color: W.muted, marginTop: 12, lineHeight: 1.55 }}>נבנה אותה יחד, צעד־צעד. אתה מחליט — אני עוזר.</div>
        <Spring />
        <PrimaryButton onClick={onStart}>בוא נתחיל</PrimaryButton>
      </ScreenBody>
    </PhoneFrame>
  );
}

/* =========================================================== BUILDER ==== */

function BuilderChip({ children, selected = false, onClick }: { children: ReactNode; selected?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ height: 42, display: "inline-flex", alignItems: "center", gap: 7, border: `1px solid ${selected ? W.teal : W.line}`, background: selected ? "rgba(36,105,102,0.06)" : W.surface, borderRadius: W.radius.control, padding: "0 15px", fontSize: 14, fontWeight: 600, color: selected ? W.tealDeep : W.ink, fontFamily: "inherit", cursor: "pointer" }}>
      {children}
    </button>
  );
}
function SectionHead({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div style={{ margin: "0 2px 12px" }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: W.ink }}>{children}</span>
      {hint ? <div style={{ fontSize: 11.5, color: W.muted2, marginTop: 3 }}>{hint}</div> : null}
    </div>
  );
}

function BuilderStep({ draft, patch, header, onNext }: { draft: CouponDraft; patch: (p: Partial<CouponDraft>) => void; header: ReactNode; onNext: () => void }) {
  const [showDesc, setShowDesc] = useState(!!draft.description);
  const t = draft.benefitType;
  const isNumber = t === "pct" || t === "amt" || t === "price";
  const unit = t === "pct" ? "%" : "₪";
  const revealLabel =
    t === "pct" ? "כמה אחוז?" : t === "amt" || t === "price" ? "כמה ₪?" :
    t === "giftProduct" ? "מה מקבלים במתנה?" : t === "giftService" ? "איזה שירות במתנה?" :
    t === "more" ? "איזו תמורה?" : "מה ההטבה?";

  const pickType = (key: BenefitType) => {
    const val = key === "pct" ? "20" : key === "more" ? "1+1" : "";
    patch({ benefitType: key, value: val });
  };

  return (
    <PhoneFrame>
      {header}
      <ScreenBody>
        <LiveCouponDisplay
          label="כך הלקוח יראה · מתעדכן חי"
          stripText={draft.business.name}
          sentence={benefitSentence(draft)}
          sub={`תקף ${draft.validity}`}
          style={{ margin: "6px 0 24px" }}
        />

        <div style={{ marginBottom: 22 }}>
          <SectionHead hint={draft.direction ? `התחלנו מ${DIRECTION_LABEL[draft.direction]} — אפשר לבחור אחרת` : undefined}>
            מה הלקוח מקבל?
          </SectionHead>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            {orderedTypesFor(draft.direction).map((bt) => (
              <BuilderChip key={bt.key} selected={t === bt.key} onClick={() => pickType(bt.key)}>{bt.label}</BuilderChip>
            ))}
          </div>
          <div style={{ marginTop: 12, padding: 14, background: W.surface2, borderRadius: W.radius.control, border: `1px solid ${W.line}` }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: W.muted, marginBottom: 9 }}>{revealLabel}</div>
            {t === "more" ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
                {MORE_OPTS.map((o) => <BuilderChip key={o} selected={draft.value === o} onClick={() => patch({ value: o })}>{o}</BuilderChip>)}
              </div>
            ) : isNumber ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input inputMode="numeric" value={draft.value} onChange={(e) => patch({ value: e.target.value.replace(/[^\d]/g, "") })}
                  style={{ flex: 1, height: 52, background: W.canvas, border: `1px solid ${W.line}`, borderRadius: W.radius.control, textAlign: "center", fontSize: 24, fontWeight: 600, color: W.ink, fontFamily: "inherit", outline: "none" }} />
                <span style={{ fontSize: 18, fontWeight: 600, color: W.muted }}>{unit}</span>
              </div>
            ) : (
              <input value={draft.value} onChange={(e) => patch({ value: e.target.value })} placeholder="הקלד כאן"
                style={{ width: "100%", minHeight: 52, background: W.canvas, border: `1px solid ${W.line}`, borderRadius: W.radius.control, padding: 14, fontSize: 15, color: W.ink, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
            )}
          </div>
        </div>

        <div style={{ marginBottom: 22 }}>
          <SectionHead>על מה זה חל?</SectionHead>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            {SCOPES.map((sc) => <BuilderChip key={sc} selected={draft.scope === sc} onClick={() => patch({ scope: sc })}>{sc}</BuilderChip>)}
          </div>
        </div>

        <div style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 2px 8px" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>איך זה ייקרא ללקוח</div>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: W.tealDeep, background: "rgba(36,105,102,0.08)", borderRadius: W.radius.pill, padding: "2px 9px" }}>נכתב אוטומטית · ניתן לשינוי</span>
          </div>
          <input value={couponTitle(draft)} onChange={(e) => patch({ titleEdited: true, title: e.target.value })}
            style={{ width: "100%", minHeight: 52, background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.control, padding: 14, fontSize: 15, fontWeight: 500, color: W.ink, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
          {showDesc ? (
            <textarea value={draft.description} onChange={(e) => patch({ description: e.target.value })} placeholder="תיאור קצר (לא חובה)" rows={3}
              style={{ width: "100%", marginTop: 10, background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.control, padding: 14, fontSize: 14, color: W.ink, fontFamily: "inherit", outline: "none", boxSizing: "border-box", resize: "vertical" }} />
          ) : (
            <div onClick={() => setShowDesc(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 11, fontSize: 13, fontWeight: 600, color: W.muted, cursor: "pointer" }}>
              <StrokeIcon size={14} color={W.muted} width={2}><path d="M12 5v14M5 12h14" /></StrokeIcon>
              הוסף תיאור קצר <span style={{ color: W.muted2, fontWeight: 400 }}>· אפשרות מתקדמת</span>
            </div>
          )}
        </div>

        <PrimaryButton onClick={onNext} style={{ marginTop: 2 }}>המשך</PrimaryButton>
      </ScreenBody>
    </PhoneFrame>
  );
}

/* ============================================================= TERMS ==== */
/* The light "next moment" — validity + conditions only. Smart defaults. */

function TermsStep({ draft, patch, header, onCreate, busy }: { draft: CouponDraft; patch: (p: Partial<CouponDraft>) => void; header: ReactNode; onCreate: () => void; busy?: boolean }) {
  const toggle = (c: string) => patch({ conditions: draft.conditions.includes(c) ? draft.conditions.filter((x) => x !== c) : [...draft.conditions, c] });
  return (
    <PhoneFrame>
      {header}
      <ScreenBody>
        <FlowIntro eye="כמעט מוכן" q="עוד שני דברים קטנים — מתי, ולמי?" />

        <div style={{ marginBottom: 26 }}>
          <SectionHead>כמה זמן ההטבה תקפה?</SectionHead>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            {VALIDITIES.map((v) => <BuilderChip key={v} selected={draft.validity === v} onClick={() => patch({ validity: v })}>{v}</BuilderChip>)}
          </div>
        </div>

        <div style={{ marginBottom: 26 }}>
          <SectionHead hint="בחר רק את מה שחשוב — הכול ברירת־מחדל סבירה">תנאים</SectionHead>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            {CONDITIONS.map((c) => <BuilderChip key={c} selected={draft.conditions.includes(c)} onClick={() => toggle(c)}>{c}</BuilderChip>)}
          </div>
        </div>

        <Spring />
        <PrimaryButton onClick={busy ? undefined : onCreate} style={busy ? { opacity: 0.6 } : undefined}>
          {busy ? "יוצר…" : "צור את הקופון"}
        </PrimaryButton>
      </ScreenBody>
    </PhoneFrame>
  );
}

/* ========================================================= PUBLISHED ==== */

function PublishedStep({ draft, result, header, onDone }: { draft: CouponDraft; result?: PublishResult; header: ReactNode; onDone?: () => void }) {
  const link = result?.publicId && typeof window !== "undefined" ? `${window.location.origin}/revenue/coupons/${result.publicId}` : "";
  const copy = () => { if (link) navigator.clipboard?.writeText(link).catch(() => {}); };
  const share = () => {
    if (!link) return;
    window.location.href = `https://wa.me/?text=${encodeURIComponent(`${couponTitle(draft)}\n${link}`)}`;
  };
  return (
    <PhoneFrame>
      {header}
      <ScreenBody>
        <div style={{ textAlign: "center", padding: "6px 0 18px" }}>
          <div style={{ width: 50, height: 50, borderRadius: "50%", background: "rgba(36,105,102,0.1)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
            <StrokeIcon size={25} color={W.tealDeep} width={2.4}><path d="M5 13l4 4L19 7" /></StrokeIcon>
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.2px" }}>הקופון שלך פורסם 🎉</div>
          <div style={{ fontSize: 13.5, color: W.muted, marginTop: 6 }}>כך הלקוחות שלך רואים אותו:</div>
        </div>

        {/* the SINGLE public-coupon entity, previewed */}
        <div style={{ border: `1px solid ${W.line}`, borderRadius: 16, overflow: "hidden", boxShadow: W.shadow }}>
          <PublicCouponContent view={draftToView(draft)} interactive={false} />
          <div style={{ padding: "0 16px 16px", background: W.canvas }}>
            <div style={{ height: 46, borderRadius: 14, background: W.grad, color: "#fff", fontWeight: 600, fontSize: 14.5, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: W.glow }}>קבל קופון</div>
          </div>
        </div>

        <div style={{ marginTop: 20, paddingTop: 18, borderTop: `1px solid ${W.line}`, display: "flex", flexDirection: "column", gap: 10 }}>
          <WaButton onClick={share}>שתף את הקופון</WaButton>
          <SecondaryButton onClick={copy}>העתק קישור</SecondaryButton>
          <GhostLink onClick={onDone}>לקופונים שלי ›</GhostLink>
        </div>
      </ScreenBody>
    </PhoneFrame>
  );
}
