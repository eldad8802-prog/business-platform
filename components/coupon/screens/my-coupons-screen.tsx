"use client";

/**
 * "הקופונים שלי" — the business owner's management surface (COUPON-02/09).
 *
 * This screen did not exist. Pressing "קופונים" landed the owner on the
 * consumer marketplace ("הטבות קרוב אליך"), so there was no way to see what he
 * had created, what state it was in, or to stop it. This is now the first thing
 * he sees; the marketplace is one tap away but is no longer the entry point.
 *
 * Every value shown is real and comes from `GET /api/revenue/coupons/mine`.
 * Where the model has nothing to show (redemption counts beyond 0/1, quotas,
 * "נותרו X מתוך N") nothing is shown — those are deferred by
 * `coupon-c5-quota-semantics-decision-v1.md` §0 and inventing them here would
 * put fiction back on the owner's dashboard.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LAYOUT, TOKEN } from "@/lib/design/tokens";
import {
  PhoneFrame,
  ScreenBody,
  ScreenHeader,
  BackButton,
  StrokeIcon,
  PrimaryButton,
  SecondaryButton,
} from "@/components/ui/coupon/coupon-primitives";
import {
  disableCoupon,
  enableCoupon,
  fetchMyCoupons,
  type MyCoupon,
} from "@/lib/coupon/api";
import { LIFECYCLE_LABEL, type CouponLifecycleState } from "@/lib/revenue/coupon-lifecycle";

const W = TOKEN.warm;

const STATE_TONE: Record<CouponLifecycleState, { color: string; bg: string }> = {
  ACTIVE: { color: W.tealDeep, bg: "rgba(36,105,102,0.10)" },
  REDEEMED: { color: "#5B4A87", bg: "rgba(91,74,135,0.10)" },
  EXPIRED: { color: W.muted, bg: W.surface2 },
  DISABLED: { color: "#A3372F", bg: "rgba(163,55,47,0.08)" },
};

function StatePill({ state }: { state: CouponLifecycleState }) {
  const tone = STATE_TONE[state];
  return (
    <span style={{ fontSize: 11.5, fontWeight: 600, color: tone.color, background: tone.bg, borderRadius: W.radius.pill, padding: "3px 10px", whiteSpace: "nowrap" }}>
      {LIFECYCLE_LABEL[state]}
    </span>
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" });
}

function Meta({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div style={{ display: "flex", gap: 6, fontSize: 12.5, color: W.muted, fontVariantNumeric: "tabular-nums" }}>
      <span style={{ color: W.muted2 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function CouponCard({
  coupon,
  onChanged,
  notice,
  onNotice,
}: {
  coupon: MyCoupon;
  onChanged: () => void;
  /** Message for THIS coupon, owned by the screen so it survives re-sectioning. */
  notice: string | null;
  onNotice: (publicId: string, message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  /**
   * F-2: apply the server's truth immediately.
   *
   * Measured before this change: while the owner sat on this screen, another
   * business redeemed the coupon. The card kept showing "פעיל" with a working
   * "השבת קופון" button. Pressing it was safely refused — but the card then
   * displayed that refusal NEXT TO the stale "פעיל" pill, i.e. the client had
   * been told the real state by the server and declined to apply it.
   *
   * A refusal is proof our snapshot is out of date, so we re-read the list.
   * A network failure is not (the request never arrived), and re-reading would
   * only blank the screen — hence the `serverResponded` distinction.
   */
  const run = async (action: typeof disableCoupon) => {
    setBusy(true);
    onNotice(coupon.publicId, null);
    const outcome = await action(coupon.publicId);
    setBusy(false);

    if (!outcome.ok) {
      onNotice(coupon.publicId, outcome.message);
      if (outcome.serverResponded) onChanged();
      return;
    }

    onChanged();
  };

  const error = notice;

  const dimmed = coupon.state === "EXPIRED" || coupon.state === "REDEEMED";

  return (
    <div style={{ background: W.surface, border: `1px solid ${W.line}`, borderRadius: W.radius.card, boxShadow: dimmed ? "none" : W.shadow, padding: 16, opacity: dimmed ? 0.92 : 1 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontSize: 15.5, fontWeight: 600, letterSpacing: "-0.2px", lineHeight: 1.35, minWidth: 0 }}>
          {coupon.benefit}
        </div>
        <StatePill state={coupon.state} />
      </div>

      {coupon.description ? (
        <div style={{ fontSize: 12.5, color: W.muted, marginTop: 7, lineHeight: 1.5 }}>{coupon.description}</div>
      ) : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 12 }}>
        <Meta label="פורסם" value={shortDate(coupon.issuedAt)} />
        <Meta label="בתוקף עד" value={shortDate(coupon.expiresAt)} />
        <Meta label="מומש" value={coupon.redemptionCount > 0 ? shortDate(coupon.redeemedAt ?? "") : "טרם"} />
      </div>

      {error ? (
        <div role="alert" style={{ marginTop: 11, fontSize: 12.5, fontWeight: 500, color: "#A3372F" }}>{error}</div>
      ) : null}

      {/*
        The only mutation v1 offers is stop/resume. Editing a live coupon's
        economics is deliberately absent: the token may already be in a
        customer's hands, so changing what it is worth after the fact would
        break a promise already made (see `canEditEconomics`).
      */}
      <div style={{ display: "flex", gap: 10, marginTop: 14, paddingTop: 13, borderTop: `1px solid ${W.line}` }}>
        {coupon.state === "ACTIVE" ? (
          <SecondaryButton onClick={busy ? undefined : () => run(disableCoupon)} disabled={busy} style={{ flex: 1 }}>
            {busy ? "עוצר…" : "השבת קופון"}
          </SecondaryButton>
        ) : null}
        {coupon.state === "DISABLED" ? (
          <SecondaryButton onClick={busy ? undefined : () => run(enableCoupon)} disabled={busy} style={{ flex: 1 }}>
            {busy ? "מפעיל…" : "הפעל מחדש"}
          </SecondaryButton>
        ) : null}
        <a href={`/revenue/coupons/${coupon.publicId}`}
          style={{ flex: 1, height: 44, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: W.radius.control, border: `1px solid ${W.line}`, background: W.surface, fontSize: 14, fontWeight: 600, color: W.ink, textDecoration: "none" }}>
          עמוד הקופון
        </a>
      </div>

      {coupon.state === "DISABLED" ? (
        <div style={{ fontSize: 12, color: W.muted2, marginTop: 10, lineHeight: 1.5 }}>
          מושבת — לא ניתן לממש אותו והוא לא מופיע ללקוחות. אפשר להפעיל מחדש כל עוד לא פג התוקף.
        </div>
      ) : null}
    </div>
  );
}

/**
 * Desktop composition for the owner's coupon collection.
 *
 * This surface is not a master–detail workspace, and a detail pane was
 * deliberately not built: `MyCoupon` carries benefit, description, issued,
 * expires, redemption and state, and the card already shows every one of them.
 * A second region would either be empty or repeat the card, and inventing
 * something to fill it would add capability this wave is not allowed to add.
 *
 * What the width genuinely buys is *how many coupons the owner can compare at
 * once*, so the same cards flow into a grid. One column stays the mobile
 * composition; two from the shell's tablet tier; three from the workspace tier,
 * where the container itself widens to the data measure (see ManagementSurface).
 *
 * Pure CSS: the card, its props, its actions and the kill switch are identical
 * at every width, so nothing remounts and no effect re-runs when the viewport
 * crosses a tier — the lesson recorded in the Billing production closure §9.
 */
const COLLECTION_CSS = `
.rv-coupon-collection { display: grid; grid-template-columns: 1fr; align-items: start; }
@media (min-width: ${LAYOUT.bp.medium}px) {
  .rv-coupon-collection { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (min-width: ${LAYOUT.bp.wide}px) {
  .rv-coupon-collection { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
`;

function Centered({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "40px 12px", textAlign: "center", color: W.muted, fontSize: 14, lineHeight: 1.6 }}>
      {children}
    </div>
  );
}

export function MyCouponsScreen({
  onCreate,
  onBrowse,
  onExit,
}: {
  onCreate: () => void;
  onBrowse: () => void;
  onExit?: () => void;
}) {
  const [coupons, setCoupons] = useState<MyCoupon[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Per-coupon action messages live here, not inside the card. When a refusal
   * corrects the state the card can move from "פעיל" to "הסתיים" — a different
   * container — which unmounts it and would take a card-local message with it,
   * losing the explanation at the exact moment the status changes.
   */
  const [notices, setNotices] = useState<Record<string, string | null>>({});

  const setNotice = useCallback((publicId: string, message: string | null) => {
    setNotices((prev) => ({ ...prev, [publicId]: message }));
  }, []);

  const load = useCallback(() => {
    fetchMyCoupons().then((outcome) => {
      if (!outcome.ok) {
        setError(outcome.message);
        setCoupons([]);
        return;
      }
      setError(null);
      setCoupons(outcome.coupons);
    });
  }, []);

  useEffect(load, [load]);

  const live = (coupons ?? []).filter((c) => c.state === "ACTIVE" || c.state === "DISABLED");
  const past = (coupons ?? []).filter((c) => c.state === "EXPIRED" || c.state === "REDEEMED");

  return (
    <PhoneFrame>
      <style>{COLLECTION_CSS}</style>
      <ScreenHeader title="הקופונים שלי" action={<BackButton onClick={onExit} />} />
      <ScreenBody>
        <div style={{ fontSize: 13, color: W.muted, margin: "-2px 2px 18px" }}>
          כאן חיות ההטבות שאתה מוציא ללקוחות שלך.
        </div>

        <PrimaryButton onClick={onCreate} style={{ marginBottom: 20 }}>
          צור קופון חדש
        </PrimaryButton>

        {coupons === null ? (
          <Centered>טוען את הקופונים שלך…</Centered>
        ) : error ? (
          // A load failure is never rendered as "you have no coupons" — the two
          // are different facts and the owner is told which one this is.
          <Centered>
            <div style={{ color: "#A3372F", fontWeight: 600, marginBottom: 10 }}>{error}</div>
            <SecondaryButton onClick={() => { setCoupons(null); void load(); }}>נסה שוב</SecondaryButton>
          </Centered>
        ) : coupons.length === 0 ? (
          <Centered>
            <div style={{ width: 46, height: 46, borderRadius: 14, background: W.surface2, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
              <StrokeIcon size={22} color={W.muted2} width={2}><path d="M12 3l1.8 4.4L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9z" /></StrokeIcon>
            </div>
            עדיין לא יצרת קופון.<br />ההטבה הראשונה שלך תופיע כאן.
          </Centered>
        ) : (
          <>
            {live.length > 0 ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, margin: "0 2px 12px" }}>פעיל</div>
                <div className="rv-coupon-collection" style={{ gap: 12, marginBottom: 26 }}>
                  {live.map((c) => <CouponCard key={c.publicId} coupon={c} onChanged={load} notice={notices[c.publicId] ?? null} onNotice={setNotice} />)}
                </div>
              </>
            ) : null}

            {past.length > 0 ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, margin: "0 2px 12px" }}>הסתיים</div>
                <div className="rv-coupon-collection" style={{ gap: 10 }}>
                  {past.map((c) => <CouponCard key={c.publicId} coupon={c} onChanged={load} notice={notices[c.publicId] ?? null} onNotice={setNotice} />)}
                </div>
              </>
            ) : null}
          </>
        )}

        {/*
          Redemption entry point (COUPON-03). The redeem flow already existed and
          worked, but was only reachable by scanning a QR — there was no way into
          it from the product. Redemption is business-to-business: you scan a
          coupon another business issued.
        */}
        <div style={{ marginTop: 28, paddingTop: 18, borderTop: `1px solid ${W.line}`, display: "flex", flexDirection: "column", gap: 10 }}>
          <a href="/revenue/redeem"
            style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: W.radius.control, border: `1px solid ${W.line}`, background: W.surface, fontSize: 14, fontWeight: 600, color: W.ink, textDecoration: "none" }}>
            סרוק ומַמֵּש קופון
          </a>
          <SecondaryButton onClick={onBrowse}>ראה מה עסקים אחרים מציעים</SecondaryButton>
        </div>
      </ScreenBody>
    </PhoneFrame>
  );
}
