"use client";

/**
 * Coupon creation — ONE continuous flow (business owner). A single draft object
 * threads through every step: transition-beat → goal → direction → builder →
 * terms → published. Direction guides the Builder's starting point (not locks);
 * the Builder's only task is defining the benefit; terms+validity are the next
 * light moment; "published" previews the SINGLE public-coupon entity. No backend.
 */

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
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
  benefitSentence,
  couponTitle,
  titleInputValue,
  draftToView,
  initialDraft,
  businessFromIdentity,
  dateInDays,
  MORE_OPTS,
  VALIDITY_PRESETS,
  SCOPE_WHOLE_BUSINESS,
} from "@/components/coupon/coupon-model";
import { validateBenefit, type FieldError } from "@/lib/revenue/coupon-benefit";
import { maxValidUntilDate, validateTerms } from "@/lib/revenue/coupon-terms";
import { fetchMyBusiness, type PublishOutcome, type PublishedCoupon } from "@/lib/coupon/api";

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
  onDirty,
}: {
  /** Called on abandon (no arg) or on finish (the created draft). */
  onExit?: (created?: CouponDraft) => void;
  /** Show the inspiration→creation beat first (only when entered from the public marketplace). */
  startAtBeat?: boolean;
  /** Persist via the real backend. Demo (no save) when absent. */
  publish?: (draft: CouponDraft) => Promise<PublishOutcome>;
  /** Fires once the owner has invested real input — lets the host guard the exit. */
  onDirty?: () => void;
}) {
  const [step, setStep] = useState<Step>(startAtBeat ? "intro" : "goal");
  const [draft, setDraft] = useState<CouponDraft>(initialDraft);
  const patch = (p: Partial<CouponDraft>) => {
    // Business identity arrives from the API, not from the owner — loading it
    // must not count as unsaved work.
    if (!("business" in p)) onDirty?.();
    setDraft((d) => ({ ...d, ...p }));
  };
  const [dirShowAll, setDirShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<PublishedCoupon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);

  /**
   * Real business identity for the live preview (COUPON-04 / F-1).
   *
   * The status is tracked, not just the value. Previously a failed fetch left
   * `business` null forever and the preview strip simply stayed blank under a
   * label reading "כך הלקוח יראה" — no spinner, no error, no retry, so the
   * owner had no way to tell "still loading" from "my coupon has no business
   * name". Publishing is unaffected either way: the server derives the identity
   * from Business/BusinessProfile, so this is display only.
   */
  const [identityStatus, setIdentityStatus] = useState<"loading" | "ready" | "error">("loading");

  // Only kicks off the request; state is set from the callback. The initial
  // status is already "loading", so the effect body itself sets nothing
  // synchronously (which would cascade renders).
  const fetchIdentity = useCallback(() => {
    fetchMyBusiness().then((identity) => {
      if (identity) {
        setDraft((d) => ({ ...d, business: businessFromIdentity(identity) }));
        setIdentityStatus("ready");
      } else {
        setIdentityStatus("error");
      }
    });
  }, []);

  useEffect(fetchIdentity, [fetchIdentity]);

  /** Retry is an event handler, so it may flip back to the loading state. */
  const retryIdentity = useCallback(() => {
    setIdentityStatus("loading");
    fetchIdentity();
  }, [fetchIdentity]);

  /**
   * Publish (COUPON-01).
   *
   * The success screen is reachable from exactly one place: a server response
   * that actually created the coupon. The old flow ran `setStep("published")`
   * unconditionally, outside the `if (publish)` block, so a 500 still produced
   * "הקופון שלך פורסם 🎉". On failure we now stay on the terms step with the
   * whole draft intact, show what went wrong, and let the owner retry.
   */
  const doCreate = async () => {
    setError(null);
    setFieldErrors([]);

    if (!publish) {
      // Demo mode (the /coupon-design gallery) — no backend, no claim of saving.
      setStep("published");
      return;
    }

    setBusy(true);
    const outcome = await publish(draft);
    setBusy(false);

    if (!outcome.ok) {
      setError(outcome.message);
      setFieldErrors(
        (outcome.fields ?? []).filter((f): f is FieldError =>
          f.field === "value" || f.field === "scope" || f.field === "benefitType"
        )
      );
      return;
    }

    setPublished(outcome.coupon);
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
            <button type="button" onClick={() => setDirShowAll(true)} aria-expanded={false}
              style={{ marginTop: 14, width: "100%", textAlign: "center", fontSize: 13, fontWeight: 500, color: W.muted, cursor: "pointer", background: "none", border: "none", padding: 8, fontFamily: "inherit" }}>
              הראה עוד דרכים ›
            </button>
          ) : null}
        </ScreenBody>
      </PhoneFrame>
    );
  }

  if (step === "builder")
    return (
      <BuilderStep
        draft={draft}
        patch={patch}
        header={header("direction")}
        onNext={() => setStep("terms")}
        serverErrors={fieldErrors}
        identityStatus={identityStatus}
        onRetryIdentity={retryIdentity}
      />
    );

  if (step === "terms")
    return (
      <TermsStep
        draft={draft}
        patch={patch}
        header={header("builder")}
        onCreate={doCreate}
        busy={busy}
        error={error}
        onBackToBuilder={() => setStep("builder")}
      />
    );

  return (
    <PublishedStep
      draft={draft}
      published={published}
      header={header(null, true)}
      onDone={() => onExit?.(draft)}
    />
  );
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
          <StrokeIcon size={30} color="var(--dz-text-on-brand)" width={1.9}><path d="M12 3l1.8 4.4L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9z" /></StrokeIcon>
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

/** Toggle chip. `aria-pressed` makes the selected state audible to a screen reader. */
function BuilderChip({ children, selected = false, onClick }: { children: ReactNode; selected?: boolean; onClick?: () => void }) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} style={{ height: 42, display: "inline-flex", alignItems: "center", gap: 7, border: `1px solid ${selected ? W.teal : W.line}`, background: selected ? "rgba(36,105,102,0.06)" : W.surface, borderRadius: W.radius.control, padding: "0 15px", fontSize: 14, fontWeight: 600, color: selected ? W.tealDeep : W.ink, fontFamily: "inherit", cursor: "pointer" }}>
      {children}
    </button>
  );
}

function SectionHead({ children, hint, htmlFor }: { children: ReactNode; hint?: string; htmlFor?: string }) {
  const Tag = htmlFor ? "label" : "span";
  return (
    <div style={{ margin: "0 2px 12px" }}>
      <Tag {...(htmlFor ? { htmlFor } : {})} style={{ fontSize: 13, fontWeight: 600, color: W.ink, display: "inline-block" }}>{children}</Tag>
      {hint ? <div style={{ fontSize: 11.5, color: W.muted2, marginTop: 3 }}>{hint}</div> : null}
    </div>
  );
}

/** Inline, next to the field it belongs to — not a detached toast (COUPON-07). */
function FieldNote({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <div id={id} role="alert" style={{ marginTop: 8, fontSize: 12.5, fontWeight: 500, color: "var(--dz-danger)" }}>
      {message}
    </div>
  );
}

function ErrorBanner({ message, onRetry, retrying }: { message: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <div role="alert" style={{ margin: "0 0 18px", padding: 14, borderRadius: W.radius.control, background: "rgba(155, 70, 52,0.06)", border: "1px solid rgba(155, 70, 52,0.28)" }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--dz-danger)" }}>הקופון לא פורסם</div>
      <div style={{ fontSize: 13, color: W.ink, marginTop: 5, lineHeight: 1.5 }}>{message}</div>
      {onRetry ? (
        <button type="button" onClick={retrying ? undefined : onRetry} disabled={retrying}
          style={{ marginTop: 11, height: 38, padding: "0 16px", borderRadius: W.radius.control, border: `1px solid ${W.line}`, background: W.surface, fontSize: 13.5, fontWeight: 600, color: W.ink, fontFamily: "inherit", cursor: retrying ? "default" : "pointer" }}>
          {retrying ? "מנסה שוב…" : "נסה שוב"}
        </button>
      ) : null}
    </div>
  );
}

function messageFor(errors: FieldError[], field: FieldError["field"]): string | undefined {
  return errors.find((e) => e.field === field)?.message;
}

function BuilderStep({ draft, patch, header, onNext, serverErrors, identityStatus, onRetryIdentity }: { draft: CouponDraft; patch: (p: Partial<CouponDraft>) => void; header: ReactNode; onNext: () => void; serverErrors: FieldError[]; identityStatus: "loading" | "ready" | "error"; onRetryIdentity: () => void }) {
  const [showDesc, setShowDesc] = useState(!!draft.description);
  const [touched, setTouched] = useState(false);
  const uid = useId();
  const valueId = `${uid}-value`;
  const scopeId = `${uid}-scope`;
  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;

  const t = draft.benefitType;
  const isNumber = t === "pct" || t === "amt" || t === "price";
  const isMoney = t === "amt" || t === "price";
  const unit = t === "pct" ? "%" : "₪";
  const revealLabel =
    t === "pct" ? "כמה אחוז?" : t === "amt" || t === "price" ? "כמה ₪?" :
    t === "giftProduct" ? "מה מקבלים במתנה?" : t === "giftService" ? "איזה שירות במתנה?" :
    t === "more" ? "איזו תמורה?" : "מה ההטבה?";

  // Same module the API validates with, so the button can never enable a draft
  // the server would reject (COUPON-07).
  const errors = validateBenefit({ benefitType: t, value: draft.value, scope: draft.scope });
  const shown = touched ? errors : serverErrors;
  const valueError = messageFor(shown, "value");
  const scopeError = messageFor(shown, "scope");

  const wholeBusiness = draft.scope === SCOPE_WHOLE_BUSINESS;

  const pickType = (key: BenefitType) => {
    const val = key === "pct" ? "20" : key === "more" ? "1+1" : "";
    patch({ benefitType: key, value: val });
  };

  /**
   * Numeric input keeps only what the type can mean: percent is whole numbers,
   * money allows one decimal point. Nothing else is silently rewritten — the
   * owner's text is never reformatted under the cursor.
   */
  const onNumberChange = (raw: string) => {
    const cleaned = isMoney
      ? raw.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 9)
      : raw.replace(/[^\d]/g, "").slice(0, 3);
    patch({ value: cleaned });
  };

  const submit = () => {
    setTouched(true);
    if (errors.length === 0) onNext();
  };

  return (
    <PhoneFrame>
      {header}
      <ScreenBody>
        <LiveCouponDisplay
          label="כך הלקוח יראה · מתעדכן חי"
          stripText={draft.business?.name ?? ""}
          stripLoading={identityStatus === "loading"}
          sentence={benefitSentence(draft)}
          sub={draftToView(draft).valid}
          style={{ margin: "6px 0 24px" }}
        />

        {/*
          F-1: a failed identity fetch is now stated, not silent. Publishing is
          still allowed — the server fills in the business details itself, so
          the coupon a customer receives is correct regardless of what this
          screen managed to load.
        */}
        {identityStatus === "error" ? (
          <div role="status" style={{ margin: "-14px 0 22px", padding: 12, borderRadius: W.radius.control, background: W.surface2, border: `1px solid ${W.line}` }}>
            <div style={{ fontSize: 12.5, color: W.ink, lineHeight: 1.55 }}>
              לא הצלחנו לטעון את פרטי העסק לתצוגה המקדימה. אפשר להמשיך — הפרטים יופיעו ללקוח מהפרופיל של העסק.
            </div>
            <button type="button" onClick={onRetryIdentity}
              style={{ marginTop: 8, height: 34, padding: "0 14px", borderRadius: W.radius.control, border: `1px solid ${W.line}`, background: W.surface, fontSize: 13, fontWeight: 600, color: W.tealDeep, fontFamily: "inherit", cursor: "pointer" }}>
              נסה שוב
            </button>
          </div>
        ) : null}

        <div style={{ marginBottom: 22 }}>
          <SectionHead hint={draft.direction ? `התחלנו מ${DIRECTION_LABEL[draft.direction]} — אפשר לבחור אחרת` : undefined}>
            מה הלקוח מקבל?
          </SectionHead>
          <div role="group" aria-label="סוג ההטבה" style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            {orderedTypesFor(draft.direction).map((bt) => (
              <BuilderChip key={bt.key} selected={t === bt.key} onClick={() => pickType(bt.key)}>{bt.label}</BuilderChip>
            ))}
          </div>
          <div style={{ marginTop: 12, padding: 14, background: W.surface2, borderRadius: W.radius.control, border: `1px solid ${W.line}` }}>
            <label htmlFor={t === "more" ? undefined : valueId} style={{ display: "block", fontSize: 12, fontWeight: 600, color: W.muted, marginBottom: 9 }}>{revealLabel}</label>
            {t === "more" ? (
              <div role="group" aria-label={revealLabel} style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
                {MORE_OPTS.map((o) => <BuilderChip key={o} selected={draft.value === o} onClick={() => patch({ value: o })}>{o}</BuilderChip>)}
              </div>
            ) : isNumber ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input id={valueId} inputMode="decimal" value={draft.value}
                  aria-invalid={valueError ? true : undefined}
                  aria-describedby={valueError ? `${valueId}-err` : undefined}
                  onBlur={() => setTouched(true)}
                  onChange={(e) => onNumberChange(e.target.value)}
                  style={{ flex: 1, height: 52, background: W.canvas, border: `1px solid ${valueError ? "var(--dz-danger-border)" : W.line}`, borderRadius: W.radius.control, textAlign: "center", fontSize: 24, fontWeight: 600, color: W.ink, fontFamily: "inherit", outline: "none" }} />
                <span aria-hidden="true" style={{ fontSize: 18, fontWeight: 600, color: W.muted }}>{unit}</span>
              </div>
            ) : (
              <input id={valueId} value={draft.value} onChange={(e) => patch({ value: e.target.value })} placeholder="הקלד כאן"
                aria-invalid={valueError ? true : undefined}
                aria-describedby={valueError ? `${valueId}-err` : undefined}
                onBlur={() => setTouched(true)}
                style={{ width: "100%", minHeight: 52, background: W.canvas, border: `1px solid ${valueError ? "var(--dz-danger-border)" : W.line}`, borderRadius: W.radius.control, padding: 14, fontSize: 15, color: W.ink, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
            )}
            <FieldNote id={`${valueId}-err`} message={valueError} />
          </div>
        </div>

        {/*
          Scope (COUPON-05). The old chips offered "מוצר מסוים" / "קטגוריה" /
          "שירות מסוים" and opened no selector at all, so a coupon could be
          published saying "50₪ על קטגוריה" with no category behind it. There is
          no inventory/category link to wire in v1, so the owner names the thing
          instead — free text is fully representable in the stored sentence.
        */}
        <div style={{ marginBottom: 22 }}>
          <SectionHead hint="אפשר על כל העסק, או על מוצר/שירות מסוים שתנקוב בשמו">על מה זה חל?</SectionHead>
          <div role="group" aria-label="היקף ההטבה" style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            <BuilderChip selected={wholeBusiness} onClick={() => patch({ scope: SCOPE_WHOLE_BUSINESS })}>{SCOPE_WHOLE_BUSINESS}</BuilderChip>
            <BuilderChip selected={!wholeBusiness} onClick={() => patch({ scope: wholeBusiness ? "" : draft.scope })}>מוצר או שירות מסוים</BuilderChip>
          </div>
          {!wholeBusiness ? (
            <div style={{ marginTop: 12 }}>
              <label htmlFor={scopeId} style={{ display: "block", fontSize: 12, fontWeight: 600, color: W.muted, marginBottom: 9 }}>על מה בדיוק?</label>
              <input id={scopeId} value={draft.scope} onChange={(e) => patch({ scope: e.target.value })}
                placeholder="למשל: קפה הפוך, טיפול פנים"
                aria-invalid={scopeError ? true : undefined}
                aria-describedby={scopeError ? `${scopeId}-err` : undefined}
                onBlur={() => setTouched(true)}
                style={{ width: "100%", minHeight: 52, background: W.surface, border: `1px solid ${scopeError ? "var(--dz-danger-border)" : W.line}`, borderRadius: W.radius.control, padding: 14, fontSize: 15, color: W.ink, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
              <FieldNote id={`${scopeId}-err`} message={scopeError} />
            </div>
          ) : null}
        </div>

        <div style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 2px 8px" }}>
            <label htmlFor={titleId} style={{ fontSize: 13, fontWeight: 600 }}>איך זה ייקרא ללקוח</label>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: W.tealDeep, background: "rgba(36,105,102,0.08)", borderRadius: W.radius.pill, padding: "2px 9px" }}>נכתב אוטומטית · ניתן לשינוי</span>
          </div>
          {/*
            Auto-copy follows the draft until the owner types; after that the
            field is theirs and is never rewritten — including when they clear
            it, which stays cleared (COUPON-12). Publishing an empty title lets
            the server compose the canonical sentence instead.
          */}
          <input id={titleId} value={titleInputValue(draft)} onChange={(e) => patch({ titleEdited: true, title: e.target.value })}
            style={{ width: "100%", minHeight: 52, background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.control, padding: 14, fontSize: 15, fontWeight: 500, color: W.ink, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
          {showDesc ? (
            <textarea id={descId} aria-label="תיאור קצר" value={draft.description} onChange={(e) => patch({ description: e.target.value })} placeholder="תיאור קצר (לא חובה)" rows={3} maxLength={200}
              style={{ width: "100%", marginTop: 10, background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.control, padding: 14, fontSize: 14, color: W.ink, fontFamily: "inherit", outline: "none", boxSizing: "border-box", resize: "vertical" }} />
          ) : (
            <button type="button" onClick={() => setShowDesc(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 11, fontSize: 13, fontWeight: 600, color: W.muted, cursor: "pointer", background: "none", border: "none", padding: 0, fontFamily: "inherit" }}>
              <StrokeIcon size={14} color={W.muted} width={2}><path d="M12 5v14M5 12h14" /></StrokeIcon>
              הוסף תיאור קצר <span style={{ color: W.muted2, fontWeight: 400 }}>· אפשרות מתקדמת</span>
            </button>
          )}
        </div>

        <PrimaryButton onClick={submit} disabled={touched && errors.length > 0} style={{ marginTop: 2 }}>המשך</PrimaryButton>
      </ScreenBody>
    </PhoneFrame>
  );
}

/* ============================================================= TERMS ==== */
/* The light "next moment" — validity + conditions only. Smart defaults. */

function TermsStep({ draft, patch, header, onCreate, busy, error, onBackToBuilder }: { draft: CouponDraft; patch: (p: Partial<CouponDraft>) => void; header: ReactNode; onCreate: () => void; busy?: boolean; error?: string | null; onBackToBuilder?: () => void }) {
  const uid = useId();
  const dateId = `${uid}-until`;
  const minId = `${uid}-min`;
  const [touched, setTouched] = useState(false);

  const today = dateInDays(0);
  const maxDate = maxValidUntilDate();

  const { errors: termErrors } = validateTerms({
    minPurchaseEnabled: draft.minPurchaseEnabled,
    minPurchaseRaw: draft.minPurchase,
  });
  const dateInvalid = !draft.validUntilDate || draft.validUntilDate < today;
  const minError = touched ? termErrors.find((e) => e.field === "minPurchase")?.message : undefined;
  const dateError = touched && dateInvalid ? "תאריך הסיום חייב להיות בעתיד" : undefined;
  const blocked = dateInvalid || termErrors.length > 0;

  const submit = () => {
    setTouched(true);
    if (!blocked) onCreate();
  };

  return (
    <PhoneFrame>
      {header}
      <ScreenBody>
        <FlowIntro eye="כמעט מוכן" q="עוד שני דברים קטנים — מתי, ולמי?" />

        {error ? <ErrorBanner message={error} onRetry={submit} retrying={busy} /> : null}

        {/*
          Validity (COUPON-08). Three presets were the only way to set a date and
          there was no end date at all. The presets survive as shortcuts — they
          now write into a real date the owner can also pick directly. There is
          no start date because `Offer` has no `startsAt` column: a published
          coupon is live immediately.
        */}
        <div style={{ marginBottom: 26 }}>
          <SectionHead htmlFor={dateId} hint="הקופון מתחיל לפעול מרגע הפרסום">עד מתי ההטבה תקפה?</SectionHead>
          <div role="group" aria-label="קיצורי דרך לתאריך סיום" style={{ display: "flex", flexWrap: "wrap", gap: 9, marginBottom: 12 }}>
            {VALIDITY_PRESETS.map((p) => (
              <BuilderChip key={p.label} selected={draft.validUntilDate === dateInDays(p.days)} onClick={() => patch({ validUntilDate: dateInDays(p.days) })}>
                {p.label}
              </BuilderChip>
            ))}
          </div>
          <input id={dateId} type="date" value={draft.validUntilDate} min={today} max={maxDate}
            aria-invalid={dateError ? true : undefined}
            aria-describedby={dateError ? `${dateId}-err` : undefined}
            onBlur={() => setTouched(true)}
            onChange={(e) => patch({ validUntilDate: e.target.value })}
            style={{ width: "100%", height: 52, background: W.surface, border: `1px solid ${dateError ? "var(--dz-danger-border)" : W.line}`, borderRadius: W.radius.control, padding: "0 14px", fontSize: 15, fontWeight: 500, color: W.ink, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
          <FieldNote id={`${dateId}-err`} message={dateError} />
        </div>

        {/*
          Terms (COUPON-06). "פעם אחת ללקוח" and "סניף מסוים" were removed — the
          first needs consumer identity the model does not have, the second needs
          a branch entity that does not exist. What is left is what a person at
          the counter can genuinely apply, and "מינימום רכישה" now requires the
          amount it was previously shipping without.
        */}
        <div style={{ marginBottom: 26 }}>
          <SectionHead hint="רק מה שתוכל באמת לעמוד מאחוריו בקופה">תנאים</SectionHead>
          <div role="group" aria-label="תנאי הקופון" style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            <BuilderChip selected={draft.minPurchaseEnabled} onClick={() => patch({ minPurchaseEnabled: !draft.minPurchaseEnabled })}>מינימום רכישה</BuilderChip>
            <BuilderChip selected={draft.newCustomersOnly} onClick={() => patch({ newCustomersOnly: !draft.newCustomersOnly })}>לקוחות חדשים</BuilderChip>
          </div>
          {draft.minPurchaseEnabled ? (
            <div style={{ marginTop: 12 }}>
              <label htmlFor={minId} style={{ display: "block", fontSize: 12, fontWeight: 600, color: W.muted, marginBottom: 9 }}>מעל איזה סכום?</label>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input id={minId} inputMode="decimal" value={draft.minPurchase}
                  aria-invalid={minError ? true : undefined}
                  aria-describedby={minError ? `${minId}-err` : undefined}
                  onBlur={() => setTouched(true)}
                  onChange={(e) => patch({ minPurchase: e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 9) })}
                  style={{ flex: 1, height: 52, background: W.surface, border: `1px solid ${minError ? "var(--dz-danger-border)" : W.line}`, borderRadius: W.radius.control, textAlign: "center", fontSize: 20, fontWeight: 600, color: W.ink, fontFamily: "inherit", outline: "none" }} />
                <span aria-hidden="true" style={{ fontSize: 18, fontWeight: 600, color: W.muted }}>₪</span>
              </div>
              <FieldNote id={`${minId}-err`} message={minError} />
            </div>
          ) : null}
        </div>

        <Spring />
        {error && onBackToBuilder ? (
          <SecondaryButton onClick={onBackToBuilder} style={{ marginBottom: 10 }}>חזור וערוך את ההטבה</SecondaryButton>
        ) : null}
        <PrimaryButton onClick={busy ? undefined : submit} disabled={busy || (touched && blocked)}>
          {busy ? "יוצר…" : error ? "נסה לפרסם שוב" : "צור את הקופון"}
        </PrimaryButton>
      </ScreenBody>
    </PhoneFrame>
  );
}

/* ========================================================= PUBLISHED ==== */

/**
 * Reached only after a confirmed server-side create, so every claim on it is
 * true: the coupon exists, the link resolves, and the benefit text shown is the
 * one the server actually stored (COUPON-01/11).
 */
function PublishedStep({ draft, published, header, onDone }: { draft: CouponDraft; published: PublishedCoupon | null; header: ReactNode; onDone?: () => void }) {
  const [copied, setCopied] = useState(false);

  const link = published && typeof window !== "undefined"
    ? `${window.location.origin}/revenue/coupons/${published.publicId}`
    : "";

  // Show what was persisted, not what the local draft happens to hold.
  const view = draftToView(draft);
  if (published) view.benefit = published.benefit;

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (insecure context / permission). Say so rather than
      // showing "הועתק" over a clipboard that never received anything.
      setCopied(false);
      window.prompt("העתק את הקישור:", link);
    }
  };

  const share = () => {
    if (!link) return;
    const text = `${published?.benefit ?? couponTitle(draft)}\n${link}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
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
          <PublicCouponContent view={view} interactive={false} />
          <div style={{ padding: "0 16px 16px", background: W.canvas }}>
            <div aria-hidden="true" style={{ height: 46, borderRadius: 14, background: W.grad, color: "var(--dz-text-on-brand)", fontWeight: 600, fontSize: 14.5, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: W.glow }}>קבל קופון</div>
          </div>
        </div>

        {/* Share/copy appear only when there is a real link to hand out. */}
        <div style={{ marginTop: 20, paddingTop: 18, borderTop: `1px solid ${W.line}`, display: "flex", flexDirection: "column", gap: 10 }}>
          {link ? (
            <>
              <WaButton onClick={share}>שתף את הקופון</WaButton>
              <SecondaryButton onClick={copy}>{copied ? "הקישור הועתק ✓" : "העתק קישור"}</SecondaryButton>
              <div aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
                {copied ? "הקישור הועתק" : ""}
              </div>
            </>
          ) : null}
          <GhostLink onClick={onDone}>לקופונים שלי ›</GhostLink>
        </div>
      </ScreenBody>
    </PhoneFrame>
  );
}
