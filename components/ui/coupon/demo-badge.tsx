/**
 * DemoBadge — the honesty marker. Anything that is UI-only / not wired to a
 * real backend capability MUST carry this. `demo` = shown with placeholder
 * data; `soon` = a future capability not yet available.
 * Presentational only.
 */

import { type CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";

const W = TOKEN.warm;

export function DemoBadge({
  variant = "demo",
  style,
}: {
  variant?: "demo" | "soon";
  style?: CSSProperties;
}) {
  const label = variant === "soon" ? "בקרוב" : "הדגמה";
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 10,
        fontWeight: 600,
        color: W.brown,
        background: "#FBF3E7",
        border: `1px solid ${W.line}`,
        borderRadius: W.radius.pill,
        padding: "1px 8px",
        ...style,
      }}
    >
      {label}
    </span>
  );
}
