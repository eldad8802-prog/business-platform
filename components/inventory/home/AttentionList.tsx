import { getStockTone } from "@/components/inventory/inventory-design";
import { ProductGlyph } from "@/components/inventory/home/home-icons";
import { getAttentionReadout } from "@/components/inventory/home/home-logic";
import type { InventoryItemDTO } from "@/lib/api/inventory";

/**
 * "דורש טיפול" list — one row per attention item: real product glyph, name,
 * "q / target" readout, and a quantity bar filled to the ratio and coloured by
 * severity. Rows link through to the item detail via `onSelect`.
 */
export function AttentionList({
  items,
  onSelect,
}: {
  items: InventoryItemDTO[];
  onSelect: (id: number) => void;
}) {
  return (
    <div className="inv-hm-rows inv-hm-rise" style={{ animationDelay: "0.24s" }}>
      {items.map((item) => {
        const tone = getStockTone(item); // "critical" | "low" (never "ok" here)
        const cls = tone === "critical" ? "crit" : "low";
        const { current, target, pct } = getAttentionReadout(item);
        return (
          <button
            key={item.id}
            type="button"
            className={`inv-hm-arow ${cls}`}
            onClick={() => onSelect(item.id)}
          >
            <span className="ci" aria-hidden>
              <ProductGlyph name={item.name} category={item.category?.name} />
            </span>
            <span className="nm">
              <span className="r1">
                <b dir="auto">{item.name}</b>
                <span className="q">
                  <bdi>{current} / {target}</bdi>
                </span>
              </span>
              <span className="pbar">
                <i style={{ width: `${pct}%` }} />
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
