"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import BarcodeScanner from "@/components/inventory/barcode-scanner";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import { createInventorySale, getInventoryItems, type InventoryItemDTO } from "@/lib/api/inventory";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { observeUnitPrice } from "@/lib/services/inventory/sale-price";
import { chargedSaleTotal } from "@/lib/inventory/sale-total";
import { qtyWithUnit } from "@/lib/inventory/unit-words";
import {
  I2,
  InvButton,
  InvError,
  InvLoading,
  InvNote,
  InvPage,
  InvQty,
  InvRow,
  InvSearch,
  InvState,
  ProductThumb,
  formatMoney,
} from "@/components/inventory/v2/kit";

/** Server messages a person can act on, in Hebrew; anything else gets a calm generic line. */
function saleErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : "";
  if (/negative inventory/i.test(raw)) return "אין מספיק מלאי לאחד המוצרים";
  if (raw === "UNAUTHORIZED") return "פג תוקף ההתחברות. התחברו מחדש ונסו שוב.";
  return "לא הצלחנו לרשום את המכירה. בדקו את החיבור ונסו שוב.";
}

/**
 * Manual sale (מכירה חדשה) — redesign, owner-approved mockup "מכירה חדשה".
 * Same payload as before: one POST /api/inventory/sales with the lines (itemId,
 * quantity and — only when typed — unitPrice) and an idempotency key that is kept
 * while the payload is unchanged (a retry of the same sale never records twice).
 * The charged price is PER UNIT; the total comes from chargedSaleTotal (#926).
 */
export default function CreateInventorySalePage() {
  const router = useRouter();
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [chargedPrice, setChargedPrice] = useState<Record<number, string>>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const saleAttempt = useRef<{ payload: string; key: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadItems = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(false);
      const data = await getInventoryItems();
      setItems(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

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
    () =>
      Object.entries(cart)
        .map(([id, qty]) => ({ item: itemById.get(Number(id)), qty }))
        .filter((e): e is { item: InventoryItemDTO; qty: number } => Boolean(e.item)),
    [cart, itemById]
  );

  // Charged price is per unit: each line contributes quantity × unit price.
  const charged = chargedSaleTotal(cartEntries.map((entry) => ({ quantity: entry.qty, rawPrice: chargedPrice[entry.item.id] })));
  const chargedInvalid = charged.kind === "invalid";

  function addToCart(item: InventoryItemDTO) {
    // Capped at the stock on hand; a product with 0 stock is not capped here
    // (the server refuses a sale that would make stock negative).
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

  function removeLine(itemId: number) {
    setQty(itemId, 0);
  }

  function handleScan(code: string) {
    setScannerOpen(false);
    const scanned = code.trim();
    if (!scanned) return;
    const item = items.find((it) => (it.barcode || "").trim() === scanned);
    if (!item) {
      setScanMessage(`ברקוד לא מזוהה: ${scanned}`);
      return;
    }
    setScanMessage(null);
    addToCart(item);
  }

  async function handleSubmit() {
    if (saving || cartEntries.length === 0 || chargedInvalid) return;
    try {
      setSaving(true);
      setError(null);
      const saleItems = cartEntries.map((entry) => {
        const raw = (chargedPrice[entry.item.id] ?? "").trim();
        const observed = raw ? observeUnitPrice(raw) : null;
        return {
          itemId: entry.item.id,
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
      inventoryToast.success("המכירה נרשמה והמלאי עודכן");
      router.replace("/inventory/sales");
    } catch (err: unknown) {
      setError(saleErrorText(err));
    } finally {
      setSaving(false);
    }
  }

  const totalText =
    charged.kind === "invalid" ? "מחיר לא תקין" : charged.kind === "total" ? formatMoney(charged.cents / 100) : "ללא מחיר";

  const footer =
    !loading && !loadError && cartEntries.length > 0 ? (
      <>
        {error ? <InvNote tone="danger">{error}</InvNote> : null}
        <div className="i2-footer__sum" aria-live="polite">
          <span>סה״כ מכירה</span>
          <b className="i2-num" style={charged.kind === "invalid" ? { color: "var(--i2-danger)", fontSize: 16 } : undefined}>
            <bdi>{totalText}</bdi>
          </b>
        </div>
        <InvButton block onClick={() => void handleSubmit()} disabled={saving || chargedInvalid}>
          {saving ? "רושם…" : "רישום מכירה"}
        </InvButton>
        <p className="i2-footer__note">רישום המכירה יפחית את הכמויות מהמלאי</p>
      </>
    ) : null;

  return (
    <InvPage title="מכירה חדשה" backFallback="/inventory/sales" wide footer={footer}>
      {loading ? (
        <InvLoading rows={3} />
      ) : loadError ? (
        <InvError onRetry={() => void loadItems()} />
      ) : (
        <>
          <div style={{ marginTop: 12 }}>
            <InvSearch
              value={query}
              onChange={setQuery}
              placeholder="חיפוש מוצר או ברקוד"
              inputRef={searchRef}
              onScan={() => {
                setScanMessage(null);
                setScannerOpen(true);
              }}
              scanLabel="סריקת ברקוד להוספה למכירה"
            />
          </div>
          {scanMessage ? <InvNote tone="warn">{scanMessage}</InvNote> : null}
          {query.trim() ? (
            searchResults.length === 0 ? (
              <p className="i2-muted" style={{ margin: "0 0 12px" }}>
                לא נמצאו מוצרים מתאימים לחיפוש.
              </p>
            ) : (
              <ul className="i2-results" aria-label="תוצאות חיפוש">
                {searchResults.map((item) => (
                  <InvRow
                    key={item.id}
                    onClick={() => addToCart(item)}
                    thumb={<ProductThumb src={item.imageUrl} name={item.name} size={48} />}
                    title={item.name}
                    sub={`${qtyWithUnit(item.currentQuantity, item.unitType)} במלאי`}
                    ariaLabel={`הוספת ${item.name} למכירה`}
                  />
                ))}
              </ul>
            )
          ) : null}

          {items.length === 0 ? (
            <InvState
              title="אין מוצרים במלאי"
              body="כדי לרשום מכירה צריך קודם להוסיף מוצרים."
              action={<InvButton href="/inventory/items/create">הוספת מוצר</InvButton>}
            />
          ) : cartEntries.length === 0 ? (
            <InvState title="עוד לא נוספו מוצרים למכירה" body="חפשו מוצר או סרקו ברקוד כדי להוסיף אותו." />
          ) : (
            <table className="i2-table" style={{ marginTop: 8 }} aria-label="מוצרים במכירה">
              <thead>
                <tr>
                  <th scope="col">מוצר</th>
                  <th scope="col">מחיר ליחידה שנגבה</th>
                  <th scope="col">סה״כ</th>
                </tr>
              </thead>
              <tbody>
                {cartEntries.map(({ item, qty }) => {
                  const raw = chargedPrice[item.id] ?? "";
                  const invalid = raw.trim() !== "" && observeUnitPrice(raw).kind === "invalid";
                  const line = chargedSaleTotal([{ quantity: qty, rawPrice: raw }]);
                  const catalogPrice = item.sellPricePerUnit ?? 0;
                  const priceId = `sale-price-${item.id}`;
                  return (
                    <tr key={item.id}>
                      <td style={{ paddingInline: "4px 8px" }}>
                        <div className="i2-cellprod" style={{ alignItems: "flex-start" }}>
                          <ProductThumb src={item.imageUrl} name={item.name} size={48} />
                          <span style={{ minWidth: 0 }}>
                            <span className="i2-clamp2" style={{ fontWeight: 600 }}>
                              {item.name}
                            </span>
                            <span className="i2-row__sub" style={{ display: "block" }}>
                              {qtyWithUnit(item.currentQuantity, item.unitType)} במלאי
                              {catalogPrice > 0 ? <> · מחירון <bdi>{formatMoney(catalogPrice)}</bdi></> : null}
                            </span>
                          </span>
                        </div>
                        <div style={{ marginTop: 8 }}>
                          <InvQty
                            size="sm"
                            value={qty}
                            min={0}
                            max={item.currentQuantity || undefined}
                            onChange={(v) => setQty(item.id, v)}
                            label={`כמות עבור ${item.name}`}
                          />
                        </div>
                      </td>
                      <td style={{ paddingInline: 6, minWidth: 96 }}>
                        <span className="i2-affix" style={{ display: "block" }}>
                          <input
                            id={priceId}
                            className="i2-input i2-num"
                            value={raw}
                            inputMode="decimal"
                            aria-label={`מחיר ליחידה שנגבה עבור ${item.name}`}
                            aria-invalid={invalid || undefined}
                            placeholder="מחיר ליחידה"
                            onChange={(event) => {
                              const value = event.target.value;
                              setChargedPrice((current) => ({ ...current, [item.id]: value }));
                              saleAttempt.current = null;
                            }}
                            style={{ fontSize: 15, paddingInline: "8px 26px" }}
                          />
                          <span aria-hidden>₪</span>
                        </span>
                        {invalid ? (
                          <span className="i2-field__err" role="alert" style={{ display: "block", marginTop: 4 }}>
                            מחיר לא תקין
                          </span>
                        ) : null}
                      </td>
                      <td style={{ paddingInline: "6px 0", whiteSpace: "nowrap" }}>
                        <span className="i2-num" style={{ fontWeight: 600 }}>
                          <bdi>{line.kind === "total" ? formatMoney(line.cents / 100) : "—"}</bdi>
                        </span>
                        <div>
                          <button type="button" className="i2-iconbtn" onClick={() => removeLine(item.id)} aria-label={`הסרת ${item.name} מהמכירה`}>
                            {I2.close(20)}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {items.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <InvButton
                kind="soft"
                block
                onClick={() => {
                  searchRef.current?.focus();
                  searchRef.current?.scrollIntoView({ block: "center" });
                }}
              >
                {I2.plus(20)} הוספת מוצר
              </InvButton>
            </div>
          ) : null}
        </>
      )}

      <BarcodeScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleScan}
        mode="single"
        title="סריקת מוצר למכירה"
        hint="כוונו את המצלמה לברקוד של המוצר"
      />
    </InvPage>
  );
}
