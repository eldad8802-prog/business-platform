"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag } from "@/lib/i18n/config";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  InventorySearch,
  InventoryOrderLine,
  MiniStepper,
  BottomActionBar,
  InventoryStatePanel,
  getStockTone,
} from "@/components/inventory/inventory-design";
import { getProductEmoji } from "@/lib/inventory/product-emoji";
import { createInventorySale, getInventoryItems, type InventoryItemDTO } from "@/lib/api/inventory";
import { observeUnitPrice } from "@/lib/services/inventory/sale-price";

const STOCK_BG: Record<"ok" | "low" | "critical", string> = {
  ok: "var(--inv-success-bg)",
  low: "var(--inv-warning-bg)",
  critical: "var(--inv-danger-bg)",
};

export default function CreateInventorySalePage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [chargedPrice, setChargedPrice] = useState<Record<number, string>>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saleAttempt = useRef<{ payload: string; key: string } | null>(null);

  const loadItems = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getInventoryItems();
      setItems(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      setError(err instanceof Error && err.message === "UNAUTHORIZED" ? t("customers.inventory.common.noAuth") : err instanceof Error ? err.message : t("customers.inventory.saleCreate.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    queueMicrotask(() => void loadItems());
  }, [loadItems]);

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter((item) => [item.name, item.sku, item.barcode].filter(Boolean).some((f) => String(f).toLowerCase().includes(q)))
      .slice(0, 8);
  }, [items, query]);

  const cartEntries = useMemo(
    () => Object.entries(cart).map(([id, qty]) => ({ item: itemById.get(Number(id)), qty })).filter((e) => e.item),
    [cart, itemById]
  );

  const totalUnits = cartEntries.reduce((sum, e) => sum + e.qty, 0);
  const chargedObservations = cartEntries.map((entry) => {
    const raw = (chargedPrice[entry.item!.id] ?? "").trim();
    if (!raw) return null;
    return observeUnitPrice(raw);
  });
  const chargedInvalid = chargedObservations.some((observed) => observed?.kind === "invalid");
  const chargedTotal = chargedObservations.reduce((sum, observed) => {
    if (observed?.kind !== "present") return sum;
    return sum + Number(observed.amount);
  }, 0);
  const anyChargedPrice = chargedObservations.some((observed) => observed?.kind === "present");

  function addToCart(item: InventoryItemDTO) {
    setCart((c) => ({ ...c, [item.id]: Math.min((c[item.id] ?? 0) + 1, item.currentQuantity || Infinity) }));
    setQuery("");
  }

  function setQty(itemId: number, qty: number) {
    setCart((c) => {
      if (qty <= 0) {
        const next = { ...c };
        delete next[itemId];
        return next;
      }
      return { ...c, [itemId]: qty };
    });
  }

  async function handleSubmit() {
    if (saving || cartEntries.length === 0 || chargedInvalid) return;
    try {
      setSaving(true);
      setError(null);
      const saleItems = cartEntries.map((entry) => {
        const raw = (chargedPrice[entry.item!.id] ?? "").trim();
        const observed = raw ? observeUnitPrice(raw) : null;
        return {
          itemId: entry.item!.id,
          quantity: entry.qty,
          ...(observed?.kind === "present" ? { unitPrice: observed.amount } : {}),
        };
      });
      const payload = JSON.stringify(saleItems);
      if (!saleAttempt.current || saleAttempt.current.payload !== payload) {
        saleAttempt.current = {
          payload,
          key: crypto.randomUUID(),
        };
      }
      await createInventorySale({
        items: saleItems,
        idempotencyKey: saleAttempt.current.key,
      });
      router.push("/inventory/sales");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("customers.inventory.saleCreate.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <InventorySubPage intent="standard" title={t("customers.inventory.saleCreate.title")} backHref="/inventory/sales" bottomNav="sales">
      <div className="inv-desk-workspace inv-sale-desk">
      <div style={{ position: "relative" }}>
        <InventorySearch value={query} onChange={setQuery} placeholder={t("customers.inventory.saleCreate.searchPlaceholder")} />
        {searchResults.length > 0 ? (
          <div className="inv-olines" style={{ paddingTop: 8 }}>
            {searchResults.map((item) => {
              const tone = getStockTone(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="inv-row"
                  style={{ marginBottom: 8 }}
                  onClick={() => addToCart(item)}
                >
                  <span className="inv-row__thumb" style={{ background: STOCK_BG[tone] }} aria-hidden>
                    {getProductEmoji(item.name, item.category?.name)}
                  </span>
                  <span className="inv-row__mid">
                    <span className="inv-row__nm">{item.name}</span>
                    <span className="inv-row__meta">{t("customers.inventory.saleCreate.stockQty", { quantity: item.currentQuantity })}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div>

      {error ? (
        <div className="inv-fwrap">
          <div className="inv-alert inv-alert--error" style={{ marginTop: 12 }}>{error}</div>
        </div>
      ) : null}

      {cartEntries.length === 0 && !loading ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title={t("customers.inventory.saleCreate.emptyTitle")}>{t("customers.inventory.saleCreate.emptyBody")}</InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-olines">
          {cartEntries.map(({ item, qty }) => {
            const tone = getStockTone(item!);
            const catalogPrice = item!.sellPricePerUnit ?? 0;
            return (
              <InventoryOrderLine
                key={item!.id}
                thumb={getProductEmoji(item!.name, item!.category?.name)}
                thumbBg={STOCK_BG[tone]}
                name={item!.name}
                sub={
                  <>
                    {t("customers.inventory.saleCreate.stock")} <bdi>{item!.currentQuantity}</bdi>
                    {catalogPrice > 0 ? <> · {t("customers.inventory.saleCreate.priceList")} <bdi>₪{catalogPrice}</bdi></> : null}
                    <input
                      value={chargedPrice[item!.id] ?? ""}
                      inputMode="decimal"
                      aria-label={t("customers.inventory.saleCreate.chargedAria", { name: item!.name })}
                      placeholder={t("customers.inventory.saleCreate.chargedPlaceholder")}
                      onChange={(event) => {
                        const value = event.target.value;
                        setChargedPrice((current) => ({ ...current, [item!.id]: value }));
                        saleAttempt.current = null;
                      }}
                      style={{
                        display: "block",
                        marginTop: 6,
                        width: "100%",
                        maxWidth: 160,
                        border: "1px solid var(--inv-border, #d6d3d1)",
                        borderRadius: 8,
                        padding: "6px 8px",
                        background: "#fff",
                      }}
                    />
                  </>
                }
                trailing={
                  <MiniStepper
                    value={qty}
                    min={0}
                    onDecrement={() => setQty(item!.id, qty - 1)}
                    onIncrement={() => setQty(item!.id, Math.min(qty + 1, item!.currentQuantity || qty + 1))}
                  />
                }
              />
            );
          })}
        </div>
      )}
      </div>
      </div>

      {cartEntries.length > 0 ? (
        <BottomActionBar
          label={t(totalUnits === 1 ? "customers.inventory.saleCreate.itemsOne" : "customers.inventory.saleCreate.itemsMany", { count: totalUnits })}
          value={
            chargedInvalid ? (
              t("customers.inventory.saleCreate.invalidPrice")
            ) : anyChargedPrice ? (
              <bdi>₪{chargedTotal.toLocaleString(intlTag(locale))}</bdi>
            ) : (
              t("customers.inventory.saleCreate.noChargedPrice")
            )
          }
          cta={saving ? t("customers.inventory.common.saving") : t("customers.inventory.saleCreate.submit")}
          ctaDisabled={saving || chargedInvalid}
          onCta={() => void handleSubmit()}
        />
      ) : null}
    </InventorySubPage>
  );
}
