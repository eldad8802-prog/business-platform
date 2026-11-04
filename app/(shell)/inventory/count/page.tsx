"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useGoBack } from "@/components/ui/back-button";
import BarcodeScanner, { type BarcodeScannerStatus } from "@/components/inventory/barcode-scanner";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import { getInventoryItems, createInventoryMovement, type InventoryItemDTO } from "@/lib/api/inventory";
import { getClientAuthToken, isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { qtyWithUnit } from "@/lib/inventory/unit-words";
import {
  I2,
  InvButton,
  InvConfirm,
  InvError,
  InvLoading,
  InvNote,
  InvPage,
  InvRow,
  InvSearch,
  InvSheet,
  InvState,
  ProductThumb,
  formatQty,
} from "@/components/inventory/v2/kit";

const PAGE = 50;

/**
 * Stock count (ספירת מלאי) — redesign, owner-approved mockup "ספירת מלאי".
 *
 * A counting session: each scan of a known barcode adds 1 to that product's
 * counted quantity (the same product can be scanned repeatedly); an unknown
 * barcode is reported without stopping the session. Products can also be added
 * from a search (so products without a barcode can be counted); a newly added
 * product starts at 1, exactly like a first scan. On approval only the products
 * whose count differs are corrected — one POST /api/inventory/movements per row,
 * ADJUSTMENT / INVENTORY_COUNT_CORRECTION, delta = counted − the loaded quantity.
 * Products never counted are left untouched, so a partial count is safe. The
 * count is not persisted anywhere.
 */
export default function InventoryCountPage() {
  const router = useRouter();
  const goBack = useGoBack("/inventory");
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanStatus, setScanStatus] = useState<BarcodeScannerStatus | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchLimit, setSearchLimit] = useState(PAGE);
  const [listLimit, setListLimit] = useState(PAGE);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<"count" | "review">("count");
  const [confirm, setConfirm] = useState<null | "submit" | "exit">(null);
  // Counted quantities keyed by itemId.
  const [counts, setCounts] = useState<Record<number, number>>({});
  // Rows whose correction failed on the last approval.
  const [failed, setFailed] = useState<Set<number>>(() => new Set());
  // Row currently being typed into — holds a temporary empty value while editing.
  const [draft, setDraft] = useState<{ id: number; value: string } | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const inputRefs = useRef(new Map<number, HTMLInputElement>());

  const byBarcode = useMemo(() => {
    const map = new Map<string, InventoryItemDTO>();
    for (const it of items) {
      const code = (it.barcode || "").trim();
      if (code) map.set(code, it);
    }
    return map;
  }, [items]);

  const itemById = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);

  const loadItems = useCallback(async (silent = false) => {
    const token = getClientAuthToken();
    if (!token) {
      setLoading(false);
      redirectToLogin();
      return;
    }
    try {
      if (!silent) {
        setLoading(true);
        setError(false);
      }
      const data = await getInventoryItems();
      setItems(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      if (!silent) setError(true);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadItems(), 0);
    return () => window.clearTimeout(timer);
  }, [loadItems]);

  // Focus the input of a product just added from the search.
  useEffect(() => {
    if (focusId == null || searchOpen) return;
    const el = inputRefs.current.get(focusId);
    if (!el) return;
    const timer = window.setTimeout(() => {
      el.focus();
      el.scrollIntoView({ block: "center" });
      setFocusId(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusId, searchOpen, counts]);

  function handleScanDetected(code: string) {
    const scanned = code.trim();
    if (!scanned) return;
    const item = byBarcode.get(scanned);
    if (!item) {
      // Unknown barcode — report and keep the session going.
      setScanStatus({ text: `ברקוד לא מזוהה: ${scanned}`, tone: "error" });
      return;
    }
    setCounts((prev) => {
      const next = (prev[item.id] ?? 0) + 1;
      setScanStatus({ text: `${item.name} · נספרו ${formatQty(next)}`, tone: "success" });
      return { ...prev, [item.id]: next };
    });
  }

  function closeSearch() {
    setSearchOpen(false);
    setQuery("");
    setSearchLimit(PAGE);
  }

  function addFromSearch(item: InventoryItemDTO) {
    // Same starting value as the first scan of a new product (0 + 1); a product
    // already in the list keeps its count and just gets focus.
    setCounts((prev) => (item.id in prev ? prev : { ...prev, [item.id]: 1 }));
    closeSearch();
    setFocusId(item.id);
  }

  // Direct set from the editable field. 0 is a valid counted value and is kept.
  function setCountTo(itemId: number, value: number) {
    const clamped = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    setCounts((prev) => ({ ...prev, [itemId]: clamped }));
  }

  function commitDraft() {
    if (!draft) return;
    const parsed = draft.value.trim() === "" ? 0 : Number(draft.value);
    setCountTo(draft.id, parsed);
    setDraft(null);
  }

  function removeCount(itemId: number) {
    setCounts((prev) => {
      const rest = { ...prev };
      delete rest[itemId];
      return rest;
    });
    setFailed((prev) => {
      if (!prev.has(itemId)) return prev;
      const next = new Set(prev);
      next.delete(itemId);
      return next;
    });
    setDraft((d) => (d?.id === itemId ? null : d));
  }

  const countedRows = useMemo(
    () =>
      Object.entries(counts)
        .map(([id, counted]) => ({ item: itemById.get(Number(id)), counted }))
        .filter((r): r is { item: InventoryItemDTO; counted: number } => Boolean(r.item))
        .sort((a, b) => a.item.name.localeCompare(b.item.name, "he")),
    [counts, itemById]
  );

  const diffRows = useMemo(() => countedRows.filter((r) => r.counted !== r.item.currentQuantity), [countedRows]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? items.filter((it) => [it.name, it.sku, it.barcode].filter(Boolean).some((f) => String(f).toLowerCase().includes(q)))
      : items;
    return [...list].sort((a, b) => a.name.localeCompare(b.name, "he"));
  }, [items, query]);

  async function handleFinish() {
    if (saving) return;
    const toApply = countedRows.filter((r) => r.counted !== r.item.currentQuantity);
    if (toApply.length === 0) {
      setConfirm(null);
      inventoryToast.info("אין הפרשים לשמירה");
      return;
    }
    setSaving(true);
    let ok = 0;
    const okIds: number[] = [];
    const failedIds: number[] = [];
    for (const row of toApply) {
      const delta = row.counted - row.item.currentQuantity;
      try {
        await createInventoryMovement({
          itemId: row.item.id,
          quantityDelta: delta,
          movementType: "ADJUSTMENT",
          reason: "INVENTORY_COUNT_CORRECTION",
          note: "ספירת מלאי",
        });
        ok += 1;
        okIds.push(row.item.id);
      } catch {
        failedIds.push(row.item.id);
      }
    }
    setSaving(false);
    setConfirm(null);
    if (failedIds.length === 0) {
      inventoryToast.success(ok === 1 ? "הספירה נשמרה · מוצר אחד עודכן" : `הספירה נשמרה · ${ok} מוצרים עודכנו`);
      router.replace("/inventory");
      return;
    }
    // Partial failure: corrected rows leave the list; failed rows stay, marked.
    inventoryToast.error(`חלק מהעדכונים נכשלו · ${ok} עודכנו, ${failedIds.length} נכשלו`);
    setCounts((prev) => {
      const next = { ...prev };
      for (const id of okIds) delete next[id];
      return next;
    });
    setFailed(new Set(failedIds));
    setView("count");
    // Reload so the next attempt's delta is computed against the current quantity.
    await loadItems(true);
  }

  const hasRows = countedRows.length > 0;
  const summary = `${countedRows.length.toLocaleString("he-IL")} ${countedRows.length === 1 ? "מוצר נספר" : "מוצרים נספרו"} · ${diffRows.length.toLocaleString("he-IL")} ${diffRows.length === 1 ? "פער" : "פערים"}`;

  const onBack = view === "review" ? () => setView("count") : hasRows ? () => setConfirm("exit") : undefined;

  const footer =
    loading || error ? null : view === "count" ? (
      <>
        {hasRows ? (
          <div className="i2-footer__sum">
            <span>{summary}</span>
          </div>
        ) : null}
        <div className="i2-footer__row">
          <InvButton onClick={() => setView("review")} disabled={!hasRows || saving}>
            סקירת הספירה
          </InvButton>
          <InvButton kind="secondary" onClick={() => (hasRows ? setConfirm("exit") : goBack())}>
            יציאה
          </InvButton>
        </div>
      </>
    ) : (
      <div className="i2-footer__row">
        <InvButton onClick={() => setConfirm("submit")} disabled={saving || diffRows.length === 0}>
          {saving ? "שומר…" : "אישור הספירה"}
        </InvButton>
        <InvButton kind="secondary" onClick={() => setView("count")} disabled={saving}>
          חזרה לספירה
        </InvButton>
      </div>
    );

  return (
    <InvPage title={view === "review" ? "סקירת הספירה" : "ספירת מלאי"} backFallback="/inventory" onBack={onBack} wide footer={footer}>
      {loading ? (
        <InvLoading rows={4} />
      ) : error ? (
        <InvError onRetry={() => void loadItems()} />
      ) : view === "review" ? (
        <>
          <p className="i2-muted" style={{ margin: "12px 0 4px" }}>{summary}</p>
          {diffRows.length === 0 ? (
            <InvState title="לא נמצאו פערים" body="הכמויות שנספרו תואמות את המלאי. אין מה לעדכן." />
          ) : (
            <ul className="i2-list" aria-label="מוצרים עם פער">
              {diffRows.map(({ item, counted }) => {
                const delta = counted - item.currentQuantity;
                return (
                  <InvRow
                    key={item.id}
                    thumb={<ProductThumb src={item.imageUrl} name={item.name} />}
                    title={item.name}
                    sub={`במערכת ${qtyWithUnit(item.currentQuantity, item.unitType)} → נספר ${qtyWithUnit(counted, item.unitType)}`}
                    trail={
                      <span
                        className={`i2-delta ${delta > 0 ? "i2-delta--up" : "i2-delta--down"}`}
                        aria-label={`${delta > 0 ? "עודף" : "חוסר"} של ${formatQty(Math.abs(delta))}`}
                      >
                        {delta > 0 ? "+" : "−"}
                        {formatQty(Math.abs(delta))}
                      </span>
                    }
                  />
                );
              })}
            </ul>
          )}
          <InvNote>רק המוצרים שמופיעים כאן יעודכנו. מוצרים שלא נספרו לא משתנים.</InvNote>
        </>
      ) : (
        <>
          <p className="i2-muted" style={{ margin: "12px 0 10px", textAlign: "center" }}>
            סרקו ברקוד או הוסיפו מוצר
          </p>
          <div className="i2-actions" style={{ marginTop: 0 }}>
            <button
              type="button"
              className="i2-scanbtn i2-scanbtn--wide"
              onClick={() => {
                setScanStatus(null);
                setScannerOpen(true);
              }}
            >
              {I2.scan(22)}
              <span>סריקת ברקוד</span>
            </button>
            <button type="button" className="i2-scanbtn" onClick={() => setSearchOpen(true)}>
              {I2.search(20)}
              <span>חיפוש מוצר</span>
            </button>
          </div>

          {failed.size > 0 ? (
            <InvNote tone="danger">חלק מהעדכונים לא נשמרו. המוצרים המסומנים ״לא נשמר״ נשארו ברשימה — אפשר לנסות שוב.</InvNote>
          ) : null}

          {!hasRows ? (
            <InvState
              title="עוד לא נספרו מוצרים"
              body={items.length === 0 ? "אין מוצרים במלאי לספירה." : "סרקו את המוצרים בזה אחר זה, או חפשו מוצר והקלידו את הכמות שנספרה."}
              action={
                items.length === 0 ? (
                  <InvButton href="/inventory/items/create">הוספת מוצר</InvButton>
                ) : (
                  <InvButton kind="secondary" onClick={() => setSearchOpen(true)}>
                    חיפוש מוצר
                  </InvButton>
                )
              }
            />
          ) : (
            <>
              <table className="i2-table" style={{ marginTop: 16 }} aria-label="מוצרים שנספרו">
                <thead>
                  <tr>
                    <th scope="col">מוצר</th>
                    <th scope="col">במערכת</th>
                    <th scope="col">נספר</th>
                    <th scope="col">
                      <span className="i2-sr">הסרה</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {countedRows.slice(0, listLimit).map(({ item, counted }) => {
                    const isFailed = failed.has(item.id);
                    return (
                      <tr key={item.id}>
                        <td style={{ paddingInline: "4px 8px" }}>
                          <div className="i2-cellprod">
                            <ProductThumb src={item.imageUrl} name={item.name} size={48} />
                            <span style={{ minWidth: 0 }}>
                              <span className="i2-clamp2" style={{ fontWeight: 600 }}>
                                {item.name}
                              </span>
                              {isFailed ? (
                                <span className="i2-row__sub i2-row__sub--danger" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  {I2.warn(16)} לא נשמר
                                </span>
                              ) : null}
                            </span>
                          </div>
                        </td>
                        <td className="i2-num" style={{ paddingInline: 8 }}>
                          {qtyWithUnit(item.currentQuantity, item.unitType)}
                        </td>
                        <td style={{ paddingInline: 8 }}>
                          <input
                            ref={(el) => {
                              if (el) inputRefs.current.set(item.id, el);
                              else inputRefs.current.delete(item.id);
                            }}
                            className="i2-input i2-num"
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            aria-label={`כמות שנספרה עבור ${item.name}`}
                            aria-invalid={isFailed || undefined}
                            value={draft?.id === item.id ? draft.value : String(counted)}
                            onFocus={(e) => {
                              setDraft({ id: item.id, value: String(counted) });
                              e.target.select();
                            }}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (/^\d*$/.test(v)) setDraft({ id: item.id, value: v });
                            }}
                            onBlur={commitDraft}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                            style={{ width: 68, textAlign: "center", fontWeight: 600, padding: "10px 6px" }}
                          />
                        </td>
                        <td style={{ paddingInline: 0, width: 44 }}>
                          <button type="button" className="i2-iconbtn" onClick={() => removeCount(item.id)} aria-label={`הסרת ${item.name} מהספירה`}>
                            {I2.close(20)}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {countedRows.length > listLimit ? (
                <div style={{ textAlign: "center", marginTop: 8 }}>
                  <InvButton kind="soft" small onClick={() => setListLimit((n) => n + PAGE)}>
                    הצגת עוד
                  </InvButton>
                </div>
              ) : null}
            </>
          )}
        </>
      )}

      {searchOpen ? (
        <InvSheet title="חיפוש מוצר" onClose={closeSearch}>
          <InvSearch
            value={query}
            onChange={(v) => {
              setQuery(v);
              setSearchLimit(PAGE);
            }}
            placeholder="חיפוש לפי שם, מק״ט או ברקוד"
          />
          {searchResults.length === 0 ? (
            <p className="i2-muted" style={{ textAlign: "center", padding: "16px 0" }}>
              {items.length === 0 ? "אין מוצרים במלאי." : "לא נמצאו מוצרים מתאימים לחיפוש."}
            </p>
          ) : (
            <>
              <ul className="i2-list">
                {searchResults.slice(0, searchLimit).map((item) => (
                  <InvRow
                    key={item.id}
                    onClick={() => addFromSearch(item)}
                    thumb={<ProductThumb src={item.imageUrl} name={item.name} />}
                    title={item.name}
                    sub={`${qtyWithUnit(item.currentQuantity, item.unitType)} במערכת${item.id in counts ? " · כבר בספירה" : ""}`}
                    ariaLabel={`הוספת ${item.name} לספירה`}
                  />
                ))}
              </ul>
              {searchResults.length > searchLimit ? (
                <div style={{ textAlign: "center", marginTop: 8 }}>
                  <InvButton kind="soft" small onClick={() => setSearchLimit((n) => n + PAGE)}>
                    הצגת עוד
                  </InvButton>
                </div>
              ) : null}
            </>
          )}
        </InvSheet>
      ) : null}

      {confirm === "submit" ? (
        <InvConfirm
          title="לעדכן את המלאי לפי הספירה? לא ניתן לבטל."
          body={diffRows.length === 1 ? "מוצר אחד יעודכן." : `${diffRows.length.toLocaleString("he-IL")} מוצרים יעודכנו.`}
          confirmLabel={saving ? "שומר…" : "עדכון המלאי"}
          busy={saving}
          onConfirm={() => void handleFinish()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm === "exit" ? (
        <InvConfirm
          title="לצאת? הספירה לא נשמרת."
          confirmLabel="יציאה"
          cancelLabel="המשך ספירה"
          danger
          onConfirm={() => {
            setConfirm(null);
            goBack();
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}

      <BarcodeScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleScanDetected}
        mode="continuous"
        title="ספירת מלאי"
        hint="סרקו את המוצרים בזה אחר זה"
        status={scanStatus}
      />
    </InvPage>
  );
}
