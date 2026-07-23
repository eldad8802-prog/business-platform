import type { CSSProperties } from "react";

/**
 * Stock-health card: a proportional distribution bar (ok / low / critical) plus
 * a clickable legend. Proportions and counts are derived client-side from the
 * items list. Critical + low navigate to the alerts screen; ok opens the full
 * product list.
 */
export function StockHealthCard({
  okCount,
  lowCount,
  criticalCount,
  total,
  onOk,
  onLow,
  onCritical,
}: {
  okCount: number;
  lowCount: number;
  criticalCount: number;
  total: number;
  onOk: () => void;
  onLow: () => void;
  onCritical: () => void;
}) {
  const seg = (count: number): CSSProperties => ({
    flexGrow: count,
    flexBasis: 0,
    // A non-zero segment always keeps a minimum sliver so it stays visible even
    // when it is a tiny share of the total; zero collapses fully.
    minWidth: count > 0 ? 6 : 0,
    display: count > 0 ? "block" : "none",
  });

  return (
    <section className="inv-hm-health inv-hm-rise" style={{ animationDelay: "0.12s" }}>
      <div className="inv-hm-health-hh">
        <b>בריאות המלאי</b>
        <small>{total} מוצרים</small>
      </div>
      <div className="inv-hm-hbar" role="presentation">
        <i className="ok" style={seg(okCount)} />
        <i className="low" style={seg(lowCount)} />
        <i className="crit" style={seg(criticalCount)} />
      </div>
      <div className="inv-hm-hleg">
        <button type="button" className="ok" onClick={onOk}>
          <span className="r"><span className="dot" />תקין</span>
          <span className="v"><bdi>{okCount}</bdi></span>
        </button>
        <button type="button" className="low" onClick={onLow}>
          <span className="r"><span className="dot" />נמוך</span>
          <span className="v"><bdi>{lowCount}</bdi></span>
        </button>
        <button type="button" className="crit" onClick={onCritical}>
          <span className="r"><span className="dot" />קריטי</span>
          <span className="v"><bdi>{criticalCount}</bdi></span>
        </button>
      </div>
    </section>
  );
}
