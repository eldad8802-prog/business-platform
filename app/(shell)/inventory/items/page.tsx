"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import BarcodeScanner from "@/components/inventory/barcode-scanner";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import { useInventoryInboxCounts } from "@/components/inventory/use-inventory-inbox-counts";
import {
  getStockTone,
  getStockRatio,
  getStockStatusLabel,
  InventorySearch,
  FilterChipRow,
  InventoryProductRow,
  InventoryStatePanel,
  InventorySkeletonBlock,
  IconPlus,
} from "@/components/inventory/inventory-design";
import {
  getInventoryItems,
  type InventoryItemDTO,
} from "@/lib/api/inventory";
import {
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";
import { getProductEmoji } from "@/lib/inventory/product-emoji";

type StockTone = ReturnType<typeof getStockTone>;
type ToneFilter = "all" | StockTone;

const UNIT_SHORT: Record<string, MessageKey> = {
  UNIT: "customers.inventory.units.short.UNIT",
  BOX: "customers.inventory.units.short.BOX",
  KG: "customers.inventory.units.short.KG",
  GRAM: "customers.inventory.units.short.GRAM",
  LITER: "customers.inventory.units.short.LITER",
  ML: "customers.inventory.units.short.ML",
};

const TONE_DOTS: Record<StockTone, string> = {
  critical: "var(--inv-danger)",
  low: "var(--inv-warning)",
  ok: "var(--inv-success)",
};

function safeImage(imageUrl?: string | null) {
  return imageUrl && !imageUrl.includes("example.com") ? imageUrl : null;
}

function itemMeta(item: InventoryItemDTO) {
  return [item.category?.name, item.supplierName, item.sku]
    .filter((v): v is string => Boolean(v && String(v).trim()))
    .join(" · ");
}

/** Caption under the stock bar, mirroring the mockup's `.barcap` copy. */
function itemCaption(item: InventoryItemDTO, t: Translator): string | undefined {
  if (item.reorderPoint != null) {
    return t("customers.inventory.items.captionReorder", { current: item.currentQuantity, reorder: item.reorderPoint });
  }
  if (item.minimumQuantity > 0) {
    return t("customers.inventory.items.captionMinimum", { current: item.currentQuantity, minimum: item.minimumQuantity });
  }
  return undefined;
}

function InventoryItemsListPageContent() {
  const router = useRouter();
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const { counts: inboxCounts } = useInventoryInboxCounts();
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [query, setQuery] = useEntryState("query", () => searchParams.get("q") || "");
  const statusParam = searchParams.get("status") || "";
  const missingDataMode = statusParam === "missing-data";
  const [toneFilter, setToneFilter] = useEntryState<ToneFilter>("tone",
    statusParam === "low" ? "low" : "all"
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const unitShort = (unitType: string): string | undefined => {
    const key = UNIT_SHORT[unitType];
    return key ? t(key) : undefined;
  };

  const sortedItems = useMemo(() => {
    const toneOrder: Record<StockTone, number> = { critical: 0, low: 1, ok: 2 };
    return [...items].sort((a, b) => {
      const ta = toneOrder[getStockTone(a)];
      const tb = toneOrder[getStockTone(b)];
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name, "he");
    });
  }, [items]);

  const counts = useMemo(
    () =>
      sortedItems.reduce(
        (acc, item) => {
          acc[getStockTone(item)] += 1;
          return acc;
        },
        { critical: 0, low: 0, ok: 0 } as Record<StockTone, number>
      ),
    [sortedItems]
  );

  const filteredItems = useMemo(() => {
    const value = query.trim().toLowerCase();
    return sortedItems.filter((item) => {
      if (missingDataMode) {
        const hasCost = item.costPerUnit != null || item.lastPurchaseCost != null;
        if (hasCost && item.sellPricePerUnit != null) return false;
      } else if (toneFilter !== "all" && getStockTone(item) !== toneFilter) {
        return false;
      }
      if (!value) return true;
      return [item.name, item.barcode, item.sku, item.supplierName, item.category?.name]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(value));
    });
  }, [missingDataMode, query, sortedItems, toneFilter]);

  const attention = counts.critical + counts.low;

  async function loadItems() {
    const token = getClientAuthToken();
    if (!token) {
      setLoading(false);
      redirectToLogin();
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const itemsData = await getInventoryItems();
      setItems(Array.isArray(itemsData) ? itemsData : []);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : t("customers.inventory.common.loadItemsFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadItems(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time load, unchanged by i18n (the loader now reads `t` for its messages)
  }, []);

  function handleScanDetected(code: string) {
    const scanned = code.trim();
    setScannerOpen(false);
    if (!scanned) return;
    const matches = items.filter((it) => (it.barcode || "").trim() === scanned);
    if (matches.length === 1) {
      router.push(`/inventory/items/${matches[0].id}`);
      return;
    }
    if (matches.length === 0) {
      // Keep the existing text search untouched; just report no match.
      inventoryToast.error(t("customers.inventory.items.barcodeNotFound"));
      return;
    }
    // More than one match (rare) — fall back to filtering the list by the code.
    setQuery(scanned);
  }

  const sub = (
    <>
      {t(items.length === 1 ? "customers.inventory.items.productsCountOne" : "customers.inventory.items.productsCountMany", { count: items.length })}
      {attention > 0 ? <> · <b>{t("customers.inventory.items.needAttention", { count: attention })}</b></> : <> · {t("customers.inventory.items.allOk")}</>}
    </>
  );

  return (
    <InventorySubPage intent="data"
      title={t("customers.inventory.items.title")}
      variant="hub"
      sub={!loading && !error ? sub : undefined}
      headerAction={{
        icon: <IconPlus />,
        label: t("customers.inventory.common.newProduct"),
        href: "/inventory/items/create",
        accent: true,
      }}
      bottomNav="products"
    >
      <InventorySearch
        value={query}
        onChange={setQuery}
        placeholder={t("customers.inventory.items.searchPlaceholder")}
        onScan={() => setScannerOpen(true)}
      />

      <BarcodeScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleScanDetected}
        mode="single"
        title={t("customers.inventory.common.scanBarcode")}
        hint={t("customers.inventory.common.scanHint")}
      />

      {missingDataMode ? (
        <div className="inv-hd__sub" style={{ marginTop: 14 }}>
          {t("customers.inventory.items.missingData")}
        </div>
      ) : (
        <FilterChipRow<ToneFilter>
          value={toneFilter}
          onChange={setToneFilter}
          options={[
            { value: "all", label: t("customers.inventory.common.all") },
            { value: "critical", label: t("customers.inventory.common.critical"), dotColor: TONE_DOTS.critical },
            { value: "low", label: t("customers.inventory.common.low"), dotColor: TONE_DOTS.low },
            { value: "ok", label: t("customers.inventory.common.ok"), dotColor: TONE_DOTS.ok },
          ]}
        />
      )}

      {!loading && !error && inboxCounts.drafts > 0 ? (
        <div
          style={{
            width: "100%",
            maxWidth: "var(--inv-content-max, 720px)",
            margin: "12px auto 0",
            padding: "0 clamp(16px,3.5vw,28px)",
            boxSizing: "border-box",
          }}
        >
          <Link
            href="/inventory/drafts"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              textDecoration: "none",
              background: "var(--inv-card-bg)",
              border: "1px solid var(--inv-border)",
              borderRadius: "var(--inv-radius-md)",
              boxShadow: "var(--inv-shadow)",
              padding: "12px 14px",
              color: "var(--inv-text)",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            <span style={{ fontSize: 20 }} aria-hidden>🗂️</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <bdi>{inboxCounts.drafts}</bdi> {t("customers.inventory.items.draftsBanner")}
            </span>
            <span style={{ color: "var(--inv-accent)", fontWeight: 600, flexShrink: 0 }}>{t("customers.inventory.items.draftsBannerAction")}</span>
          </Link>
        </div>
      ) : null}

      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title={t("customers.inventory.common.somethingWrong")}
            action={
              <button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void loadItems()}>
                {t("customers.inventory.common.retry")}
              </button>
            }
          >
            {error}
          </InventoryStatePanel>
        </div>
      ) : loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={80} rows={5} />
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            title={items.length === 0 ? t("customers.inventory.items.emptyTitle") : t("customers.inventory.common.noProductsFound")}
          >
            {items.length === 0
              ? t("customers.inventory.items.emptyBody")
              : t("customers.inventory.items.noMatchBody")}
          </InventoryStatePanel>
        </div>
      ) : (
        <>
        <div className="inv-desk-table" aria-label={t("customers.inventory.items.tableAria")}>
          <table>
            <thead>
              <tr>
                <th>{t("customers.inventory.items.table.product")}</th>
                <th>{t("customers.inventory.items.table.details")}</th>
                <th className="inv-wide">{t("customers.inventory.items.table.minimum")}</th>
                <th className="inv-wide">{t("customers.inventory.items.table.reorder")}</th>
                <th className="inv-wide">{t("customers.inventory.items.table.cost")}</th>
                <th className="inv-wide">{t("customers.inventory.items.table.price")}</th>
                <th>{t("customers.inventory.items.table.quantity")}</th>
                <th>{t("customers.inventory.items.table.status")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => {
                const tone = getStockTone(item);
                const unit = unitShort(item.unitType);
                return (
                  <tr key={item.id} onClick={() => router.push(`/inventory/items/${item.id}`)}>
                    <td>
                      <Link href={`/inventory/items/${item.id}`}>{item.name}</Link>
                    </td>
                    <td>{itemMeta(item) || "—"}</td>
                    <td className="num inv-wide">{item.minimumQuantity}</td>
                    <td className="num inv-wide">{item.reorderPoint ?? "—"}</td>
                    <td className="num inv-wide">{item.costPerUnit != null ? `₪${item.costPerUnit}` : "—"}</td>
                    <td className="num inv-wide">{item.sellPricePerUnit != null ? `₪${item.sellPricePerUnit}` : "—"}</td>
                    <td className="num">
                      {item.currentQuantity}
                      {unit ? ` ${unit}` : ""}
                    </td>
                    <td>{getStockStatusLabel(tone)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="inv-rows inv-cards">
          {filteredItems.map((item) => {
            const tone = getStockTone(item);
            return (
              <InventoryProductRow
                key={item.id}
                tone={tone}
                imageUrl={safeImage(item.imageUrl)}
                thumbGlyph={
                  <span aria-hidden style={{ fontSize: 26, lineHeight: 1 }}>
                    {getProductEmoji(item.name, item.category?.name)}
                  </span>
                }
                name={item.name}
                meta={itemMeta(item) || undefined}
                ratio={getStockRatio(item)}
                caption={itemCaption(item, t)}
                statusLabel={getStockStatusLabel(tone)}
                quantity={item.currentQuantity}
                unitLabel={unitShort(item.unitType)}
                href={`/inventory/items/${item.id}`}
              />
            );
          })}
        </div>
        </>
      )}
    </InventorySubPage>
  );
}

// useSearchParams() requires a Suspense boundary for static prerender (Next).
export default function InventoryItemsListPage() {
  return (
    <Suspense fallback={null}>
      <InventoryItemsListPageContent />
    </Suspense>
  );
}
