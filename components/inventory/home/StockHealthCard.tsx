import type { CSSProperties } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";

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
  const { t } = useI18n();
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
        <b>{t("customers.inventoryKit.home.healthTitle")}</b>
        <small>{t(total === 1 ? "customers.inventoryKit.home.productsOne" : "customers.inventoryKit.home.productsMany", { count: total })}</small>
      </div>
      <div className="inv-hm-hbar" role="presentation">
        <i className="ok" style={seg(okCount)} />
        <i className="low" style={seg(lowCount)} />
        <i className="crit" style={seg(criticalCount)} />
      </div>
      <div className="inv-hm-hleg">
        <button type="button" className="ok" onClick={onOk}>
          <span className="r"><span className="dot" />{t("customers.inventoryKit.home.healthOk")}</span>
          <span className="v"><bdi>{okCount}</bdi></span>
        </button>
        <button type="button" className="low" onClick={onLow}>
          <span className="r"><span className="dot" />{t("customers.inventoryKit.home.healthLow")}</span>
          <span className="v"><bdi>{lowCount}</bdi></span>
        </button>
        <button type="button" className="crit" onClick={onCritical}>
          <span className="r"><span className="dot" />{t("customers.inventoryKit.home.healthCritical")}</span>
          <span className="v"><bdi>{criticalCount}</bdi></span>
        </button>
      </div>
    </section>
  );
}
