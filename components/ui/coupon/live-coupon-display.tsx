"use client";

/**
 * LiveCouponDisplay — the "how the customer will see it" live card used at the
 * top of the Benefit Builder. Updates in real time as the owner builds the
 * sentence (caller passes derived text). Presentational only — no data.
 * Faithful to `.live` in docs/coupon/coupon_screens_all.html.
 */

import { type CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { COUPON, type CouponThema } from "@/lib/design/coupon-consumer";

const W = TOKEN.warm;

export function LiveCouponDisplay({
  label = "כך הלקוח יראה את זה",
  stripText,
  stripLoading = false,
  sentence,
  sub,
  thema = "teal",
  style,
}: {
  label?: string;
  /** Colored strip line (e.g. business name). */
  stripText: string;
  /** Show a skeleton in place of `stripText` while the identity is loading. */
  stripLoading?: boolean;
  /** The composed benefit sentence (the live `customerBenefitText`). */
  sentence: string;
  /** Sub-line: validity + conditions readout. */
  sub?: string;
  thema?: CouponThema;
  style?: CSSProperties;
}) {
  return (
    <div style={style}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontSize: 12,
          fontWeight: 600,
          color: W.muted,
          marginBottom: 10,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: W.teal,
            boxShadow: "0 0 0 3px rgba(36, 105, 102,0.18)",
          }}
        />
        {label}
      </div>

      <div
        style={{
          border: `1px solid ${W.line}`,
          borderRadius: W.radius.card,
          overflow: "hidden",
          boxShadow: W.shadow,
          background: W.surface,
        }}
      >
        <div
          style={{
            background: COUPON.thema[thema],
            color: "var(--dz-text-on-brand)",
            padding: "11px 16px",
            fontSize: 12.5,
            fontWeight: 500,
            minHeight: 38,
            display: "flex",
            alignItems: "center",
          }}
        >
          {/*
            F-1: while the real business identity is still loading this strip
            was simply blank, under a label promising "כך הלקוח יראה". A blank
            name reads as "my coupon has no business name on it". A skeleton
            reads as "still loading", which is what is actually true.
          */}
          {stripLoading ? (
            <span
              aria-label="טוען את פרטי העסק"
              style={{
                display: "inline-block",
                width: 132,
                height: 11,
                borderRadius: 6,
                background: "rgba(255,255,255,0.35)",
                animation: "dubizCouponStripPulse 1.2s ease-in-out infinite",
              }}
            />
          ) : (
            stripText
          )}
          <style>{`@keyframes dubizCouponStripPulse{0%,100%{opacity:.45}50%{opacity:.85}}`}</style>
        </div>
        <div style={{ padding: 16 }}>
          <div
            style={{
              fontSize: 19,
              fontWeight: 600,
              letterSpacing: "-0.3px",
              lineHeight: 1.35,
            }}
          >
            {sentence}
          </div>
          {sub ? (
            <div style={{ fontSize: 12.5, color: W.muted, marginTop: 9 }}>
              {sub}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
