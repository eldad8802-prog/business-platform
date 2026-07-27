"use client";

import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { WarmCard, WarmPill } from "@/components/ui/warm/warm-primitives";
import { money, toneFor, type CollectionItem } from "@/components/payments/collection-format";

const W = TOKEN.warm;

/**
 * One collection row — description + amount + status pill. Markup preserved
 * verbatim from the original workspace (hit target, keyboard, navigation).
 * `selected` adds only a subtle teal ring for the desktop Master–Detail; it adds
 * NO new data and never turns the row into a large card.
 */
export function CollectionRow({
  item,
  onClick,
  muted = false,
  selected = false,
}: {
  item: CollectionItem;
  onClick: () => void;
  muted?: boolean;
  selected?: boolean;
}) {
  const selectedStyle: CSSProperties | undefined = selected
    ? { border: `1.5px solid ${W.tealDeep}`, background: "rgba(36, 105, 102, 0.045)" }
    : undefined;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={{ cursor: "pointer", marginBottom: 10 }}
    >
      <WarmCard interactive padding={14} style={selectedStyle}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: muted ? TOKEN.weight.medium : TOKEN.weight.semibold,
                color: muted ? "#5A544C" : W.ink,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item.description || "גבייה"}
            </div>
          </div>
          <div style={{ textAlign: "left", flexShrink: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: muted ? TOKEN.weight.medium : TOKEN.weight.semibold,
                color: muted ? "#5A544C" : W.ink,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {money(item.amount, item.currency)}
            </div>
            <div style={{ marginTop: 6, display: "flex", justifyContent: "flex-end" }}>
              <WarmPill tone={toneFor(item.state)}>{item.stateLabel}</WarmPill>
            </div>
          </div>
        </div>
      </WarmCard>
    </div>
  );
}
