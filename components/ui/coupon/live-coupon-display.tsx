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
  sentence,
  sub,
  thema = "teal",
  style,
}: {
  label?: string;
  /** Colored strip line (e.g. business name). */
  stripText: string;
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
            boxShadow: "0 0 0 3px rgba(61,156,154,0.18)",
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
            color: "#fff",
            padding: "11px 16px",
            fontSize: 12.5,
            fontWeight: 500,
          }}
        >
          {stripText}
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
