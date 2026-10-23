import { formatStockValue } from "@/components/inventory/home/home-logic";
import { useI18n } from "@/components/i18n/I18nProvider";

/**
 * Teal hero — on-hand stock value + active product count.
 *
 * The mockup's trend badge ("▲ 4% החודש") and sparkline are intentionally NOT
 * rendered: both require stock-value history over time, which the items payload
 * does not provide. Only real, present data is shown (mirrors how Documents
 * dropped its delta when the datum was absent). Adding history is a separate
 * future data task.
 */
export function InventoryHero({
  stockValue,
  activeCount,
  empty = false,
}: {
  stockValue: number;
  activeCount: number;
  empty?: boolean;
}) {
  const { t } = useI18n();
  return (
    <section className="inv-hm-hero inv-hm-rise" style={{ animationDelay: "0.06s" }}>
      <div className="inv-hm-hero-top">
        <span className="inv-hm-hero-lbl">{t("customers.inventoryKit.home.stockValue")}</span>
      </div>
      <div className="inv-hm-hero-big">
        <span className="inv-hm-hero-cur">₪</span>
        <bdi>{formatStockValue(stockValue)}</bdi>
      </div>
      <div className="inv-hm-hero-foot">
        {empty ? t("customers.inventoryKit.home.noProductsYet") : t(activeCount === 1 ? "customers.inventoryKit.home.activeOne" : "customers.inventoryKit.home.activeMany", { count: activeCount })}
      </div>
    </section>
  );
}
