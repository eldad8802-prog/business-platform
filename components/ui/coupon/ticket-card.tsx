"use client";

/**
 * TicketCard — the consumer coupon "ticket" (colored thema top · perforation
 * notches · scissors · benefit). Presentational only; no data, no capability.
 * Consumes `TOKEN.warm` (base) + `COUPON` (consumer thema). Faithful to
 * docs/coupon/coupon_screens_all.html `.ticket`.
 */

import { useState, type CSSProperties, type ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { COUPON, type CouponThema } from "@/lib/design/coupon-consumer";

const W = TOKEN.warm;

export function TicketCard({
  thema = "teal",
  categoryIcon,
  business,
  benefit,
  valid,
  /** DEMO-only distance chip — pass only where the value is real. */
  distance,
  /** Real city name — rendered as a location sub-label only when present. */
  city,
  /** Optional corner ribbon (e.g. "אוזל"). */
  ribbon,
  compact = false,
  onClick,
  style,
}: {
  thema?: CouponThema;
  categoryIcon?: ReactNode;
  business: string;
  benefit: string;
  valid?: string;
  distance?: string;
  city?: string;
  ribbon?: string;
  compact?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const benefitStyle: CSSProperties = {
    fontSize: compact ? 13 : 14,
    fontWeight: 600,
    letterSpacing: "-0.2px",
    lineHeight: 1.3,
    marginTop: 3,
    minHeight: compact ? 34 : 36,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  };

  return (
    <div
      onClick={onClick}
      onMouseEnter={onClick ? () => setHover(true) : undefined}
      onMouseLeave={onClick ? () => setHover(false) : undefined}
      style={{
        position: "relative",
        background: W.surface,
        border: `1px solid ${W.line}`,
        borderRadius: W.radius.card,
        boxShadow: onClick && hover ? W.shadowHover : W.shadow,
        transform: onClick && hover ? "translateY(-1px)" : "translateY(0)",
        transition: "box-shadow 160ms ease, transform 160ms ease",
        textAlign: "start",
        cursor: onClick ? "pointer" : "default",
        width: compact ? 156 : undefined,
        flex: compact ? "0 0 156px" : undefined,
        ...style,
      }}
    >
      {/* thema top */}
      <div
        style={{
          height: 72,
          borderRadius: "15px 15px 0 0",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          background: COUPON.thema[thema],
        }}
      >
        {categoryIcon}
        {ribbon ? (
          <span
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              fontSize: 9.5,
              fontWeight: 600,
              color: "#fff",
              background: "#B85C3F",
              borderRadius: W.radius.pill,
              padding: "2px 8px",
            }}
          >
            {ribbon}
          </span>
        ) : null}
        {distance ? (
          <span
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              fontSize: 10,
              fontWeight: 600,
              color: "#fff",
              background: "rgba(255,255,255,0.22)",
              borderRadius: W.radius.pill,
              padding: "2px 8px",
            }}
          >
            {distance}
          </span>
        ) : null}
      </div>

      {/* perforation: notches + dashed line + scissors */}
      <span aria-hidden style={notchStyle("left")} />
      <span aria-hidden style={notchStyle("right")} />
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 71,
          left: 24,
          right: 9,
          borderTop: `2px dashed ${W.line}`,
        }}
      />
      <ScissorsGlyph />

      {/* body */}
      <div style={{ padding: compact ? "12px 11px" : "13px 12px" }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: W.muted, display: "flex", alignItems: "center", gap: 4 }}>
          <span>{business}</span>
          {city ? <span style={{ color: W.muted2, fontWeight: 400 }}>· {city}</span> : null}
        </div>
        <div style={benefitStyle}>{benefit}</div>
        {valid ? (
          <div style={{ fontSize: 10.5, color: W.muted2, marginTop: 7 }}>
            {valid}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function notchStyle(side: "left" | "right"): CSSProperties {
  return {
    position: "absolute",
    top: 66,
    left: side === "left" ? -6 : undefined,
    right: side === "right" ? -6 : undefined,
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: W.canvas,
    border: `1px solid ${W.line}`,
  };
}

function ScissorsGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={13}
      height={13}
      fill="none"
      stroke={W.muted2}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        position: "absolute",
        top: 65,
        left: 5,
        background: W.surface,
        borderRadius: "50%",
      }}
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" />
    </svg>
  );
}
