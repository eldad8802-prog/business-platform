"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { InventoryItemRow } from "@/components/inventory/inventory-item-row";
import { getStockTone } from "@/components/inventory/inventory-design";
import type { InventoryItemDTO } from "@/lib/api/inventory";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

type StockFilter = "all" | "critical" | "low" | "ok";
type EconomicsFilter = "all" | "missing-cost" | "missing-price";
type InventoryItemDisplayDTO = InventoryItemDTO & {
  costPerUnit?: number | null;
  lastPurchaseCost?: number | null;
  sellPricePerUnit?: number | null;
};

function IconSearch() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path
        d="M20 20l-3-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function isValidCost(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

function hasDisplayCost(item: InventoryItemDisplayDTO) {
  return (
    isValidCost(item.lastPurchaseCost) || isValidCost(item.costPerUnit)
  );
}

function hasSellPrice(item: InventoryItemDisplayDTO) {
  return isValidCost(item.sellPricePerUnit);
}

function normalizeQuery(q: string) {
  return q.trim().toLowerCase();
}

function itemMatchesSearch(item: InventoryItemDTO, query: string) {
  if (!query) return true;
  const haystack = [
    item.name,
    item.barcode ?? "",
    item.sku ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function countByTone(items: InventoryItemDTO[]) {
  let critical = 0;
  let low = 0;
  let ok = 0;
  for (const item of items) {
    const tone = getStockTone(item);
    if (tone === "critical") critical += 1;
    else if (tone === "low") low += 1;
    else ok += 1;
  }
  return { critical, low, ok };
}

export function InventoryItemsListView({
  items,
  loading,
}: {
  items: InventoryItemDTO[];
  loading: boolean;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [economicsFilter, setEconomicsFilter] =
    useState<EconomicsFilter>("all");
  const [categoryId, setCategoryId] = useState<number | "all">("all");

  const query = normalizeQuery(search);

  const categories = useMemo(() => {
    const map = new Map<number, string>();
    for (const item of items) {
      if (item.categoryId != null && item.category?.name) {
        map.set(item.categoryId, item.category.name);
      }
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "he"));
  }, [items]);

  const toneCounts = useMemo(() => countByTone(items), [items]);

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (!itemMatchesSearch(item, query)) return false;

      if (stockFilter !== "all" && getStockTone(item) !== stockFilter) {
        return false;
      }

      if (economicsFilter === "missing-cost" && hasDisplayCost(item)) {
        return false;
      }
      if (economicsFilter === "missing-price" && hasSellPrice(item)) {
        return false;
      }

      if (
        categoryId !== "all" &&
        (item.categoryId == null || item.categoryId !== categoryId)
      ) {
        return false;
      }

      return true;
    });
  }, [items, query, stockFilter, economicsFilter, categoryId]);

  const hasActiveFilters =
    query.length > 0 ||
    stockFilter !== "all" ||
    economicsFilter !== "all" ||
    categoryId !== "all";

  return (
    <div data-inventory-items-list>
      <header className="inv-items-list__header">
        <div className="inv-items-list__title-block">
          <p className="inv-items-list__counts">
            {loading
              ? t("customers.inventoryKit.itemsList.loading")
              : t("customers.inventoryKit.itemsList.counts", { total: items.length, critical: toneCounts.critical, low: toneCounts.low, ok: toneCounts.ok })}
          </p>
        </div>
        <button
          type="button"
          className="inv-items-list__add-btn"
          onClick={() => router.push("/inventory/items/create")}
        >
          {t("customers.inventoryKit.itemsList.addItem")}
        </button>
      </header>

      <div className="inv-items-list__search-wrap">
        <span className="inv-items-list__search-icon" aria-hidden>
          <IconSearch />
        </span>
        <input
          type="search"
          className="inv-items-list__search"
          placeholder={t("customers.inventoryKit.itemsList.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t("customers.inventoryKit.itemsList.searchAria")}
        />
      </div>

      <div className="inv-items-list__filters">
        <div className="inv-items-list__filter-row">
          <span className="inv-items-list__filter-label">{t("customers.inventoryKit.itemsList.stockLabel")}</span>
          {(
            [
              ["all", "customers.inventoryKit.itemsList.all"],
              ["critical", "customers.inventoryKit.itemsList.critical"],
              ["low", "customers.inventoryKit.itemsList.low"],
              ["ok", "customers.inventoryKit.itemsList.ok"],
            ] as const satisfies ReadonlyArray<readonly [string, MessageKey]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`inv-items-list__chip${id === "critical" ? " inv-items-list__chip--critical" : id === "low" ? " inv-items-list__chip--low" : ""}`}
              data-active={stockFilter === id}
              onClick={() => setStockFilter(id)}
            >
              {t(label)}
            </button>
          ))}
        </div>

        <div className="inv-items-list__filter-row">
          <span className="inv-items-list__filter-label">{t("customers.inventoryKit.itemsList.dataLabel")}</span>
          {(
            [
              ["all", "customers.inventoryKit.itemsList.all"],
              ["missing-cost", "customers.inventoryKit.itemsList.missingCost"],
              ["missing-price", "customers.inventoryKit.itemsList.missingPrice"],
            ] as const satisfies ReadonlyArray<readonly [string, MessageKey]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="inv-items-list__chip"
              data-active={economicsFilter === id}
              onClick={() => setEconomicsFilter(id)}
            >
              {t(label)}
            </button>
          ))}
        </div>

        {categories.length > 0 ? (
          <div className="inv-items-list__filter-row">
            <span className="inv-items-list__filter-label">{t("customers.inventoryKit.itemsList.categoryLabel")}</span>
            <button
              type="button"
              className="inv-items-list__chip"
              data-active={categoryId === "all"}
              onClick={() => setCategoryId("all")}
            >
              {t("customers.inventoryKit.itemsList.all")}
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className="inv-items-list__chip"
                data-active={categoryId === cat.id}
                onClick={() => setCategoryId(cat.id)}
              >
                {cat.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {!loading ? (
        <p className="inv-items-list__results">
          {hasActiveFilters
            ? t("customers.inventoryKit.itemsList.showingOf", { shown: filtered.length, total: items.length })
            : t(filtered.length === 1 ? "customers.inventoryKit.itemsList.itemsOne" : "customers.inventoryKit.itemsList.itemsMany", { count: filtered.length })}
        </p>
      ) : null}

      <section className="inv-items-list__panel" aria-label={t("customers.inventoryKit.itemsList.listAria")}>
        {loading ? (
          <ul className="inv-items-list__list" aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <li
                key={i}
                className="inv-items-list__row inv-items-list__row--skeleton"
              />
            ))}
          </ul>
        ) : filtered.length === 0 ? (
          <div className="inv-items-list__empty">
            <p className="inv-items-list__empty-title">
              {items.length === 0
                ? t("customers.inventoryKit.itemsList.emptyTitle")
                : t("customers.inventoryKit.itemsList.noMatchTitle")}
            </p>
            <p className="inv-items-list__empty-hint">
              {items.length === 0
                ? t("customers.inventoryKit.itemsList.emptyHint")
                : t("customers.inventoryKit.itemsList.noMatchHint")}
            </p>
            {items.length === 0 ? (
              <button
                type="button"
                className="inv-items-list__empty-btn"
                onClick={() => router.push("/inventory/items/create")}
              >
                {t("customers.inventoryKit.itemsList.addFirst")}
              </button>
            ) : null}
          </div>
        ) : (
          <ul className="inv-items-list__list">
            {filtered.map((item) => (
              <li key={item.id}>
                <InventoryItemRow item={item} classPrefix="inv-items-list" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
