"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import { IconScan } from "@/components/inventory/inventory-primitives";
import BarcodeScanner, {
  type BarcodeScannerStatus,
} from "@/components/inventory/barcode-scanner";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import {
  getInventoryItems,
  createInventoryMovement,
  type InventoryItemDTO,
} from "@/lib/api/inventory";
import {
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";
import { getProductEmoji } from "@/lib/inventory/product-emoji";

const UNIT_SHORT: Record<string, string> = {
  UNIT: "יח׳",
  BOX: "מארז",
  KG: "ק״ג",
  GRAM: "גרם",
  LITER: "ליטר",
  ML: "מ״ל",
};

/**
 * Stock count (ספירת מלאי).
 *
 * A scan-driven counting session: each scan of a known barcode adds 1 to that
 * product's counted quantity; the same product can be scanned repeatedly; an
 * unknown barcode is reported without stopping the session. On finish, only the
 * counted products are corrected — via the existing movements API with
 * ADJUSTMENT / INVENTORY_COUNT_CORRECTION (delta = counted − system). Products
 * that were never scanned are left untouched, so a partial count is safe.
 */
export default function InventoryCountPage() {
  const router = useRouter();
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scanStatus, setScanStatus] = useState<BarcodeScannerStatus | null>(null);
  // Counted quantities keyed by itemId.
  const [counts, setCounts] = useState<Record<number, number>>({});
  // Row currently being typed into — lets the field hold a temporary empty value
  // while editing without losing the committed count.
  const [draft, setDraft] = useState<{ id: number; value: string } | null>(null);

  const byBarcode = useMemo(() => {
    const map = new Map<string, InventoryItemDTO>();
    for (const it of items) {
      const code = (it.barcode || "").trim();
      if (code) map.set(code, it);
    }
    return map;
  }, [items]);

  const itemById = useMemo(() => {
    const map = new Map<number, InventoryItemDTO>();
    for (const it of items) map.set(it.id, it);
    return map;
  }, [items]);

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
      const data = await getInventoryItems();
      setItems(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : "לא הצלחנו לטעון את רשימת המוצרים");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadItems(), 0);
    return () => window.clearTimeout(timer);
  }, []);

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
      setScanStatus({ text: `נספר: ${item.name} (×${next})`, tone: "success" });
      return { ...prev, [item.id]: next };
    });
  }

  // + / − step the count; − stops at 0 (never removes — × is the only remove).
  function adjustCount(itemId: number, delta: number) {
    setCounts((prev) => ({
      ...prev,
      [itemId]: Math.max(0, (prev[itemId] ?? 0) + delta),
    }));
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

  const changedCount = useMemo(
    () => countedRows.filter((r) => r.counted !== r.item.currentQuantity).length,
    [countedRows]
  );

  async function handleFinish() {
    if (saving) return;
    const toApply = countedRows.filter((r) => r.counted !== r.item.currentQuantity);
    if (toApply.length === 0) {
      inventoryToast.info("אין הפרשים לשמירה");
      return;
    }
    setSaving(true);
    let ok = 0;
    let failed = 0;
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
      } catch {
        failed += 1;
      }
    }
    setSaving(false);
    if (failed === 0) {
      inventoryToast.success(`הספירה נשמרה · ${ok} מוצרים עודכנו`);
      router.push("/inventory");
    } else {
      inventoryToast.error(`חלק מהעדכונים נכשלו · ${ok} עודכנו, ${failed} נכשלו`);
      await loadItems();
      setCounts({});
    }
  }

  return (
    <InventorySubPage intent="standard" title="ספירת מלאי" backHref="/inventory" backText="חזרה">
      <div style={{ padding: "0 clamp(16px,3.5vw,28px)", display: "flex", flexDirection: "column", gap: 14 }}>
        <button
          type="button"
          onClick={() => { setScanStatus(null); setScannerOpen(true); }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            minHeight: 52,
            borderRadius: "var(--inv-radius-md)",
            border: "none",
            background: "var(--inv-primary)",
            color: "var(--inv-on-accent)",
            fontSize: 16,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <IconScan />
          סריקת מוצרים
        </button>

        <div style={{ fontSize: 13, color: "var(--inv-text-muted)", lineHeight: 1.5 }}>
          כל סריקה מוסיפה 1 לכמות שנספרה. מוצרים שלא נסרקו לא ישתנו.
        </div>

        {error ? (
          <div className="inv-alert inv-alert--error">{error}</div>
        ) : loading ? (
          <div style={{ fontSize: 14, color: "var(--inv-text-muted)", padding: "20px 0", textAlign: "center" }}>
            טוען מוצרים…
          </div>
        ) : countedRows.length === 0 ? (
          <div
            style={{
              padding: "22px 14px",
              textAlign: "center",
              color: "var(--inv-text-muted)",
              fontSize: 14,
              border: "1px solid var(--inv-border)",
              borderRadius: "var(--inv-radius-lg)",
              background: "var(--inv-card-bg)",
            }}
          >
            עדיין לא נספרו מוצרים · התחילו בסריקה
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {countedRows.map(({ item, counted }) => {
              const diff = counted - item.currentQuantity;
              const unit = UNIT_SHORT[item.unitType] ?? "";
              return (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    background: "var(--inv-card-bg)",
                    border: "1px solid var(--inv-border)",
                    borderRadius: "var(--inv-radius-md)",
                    boxShadow: "var(--inv-shadow)",
                    padding: "10px 12px",
                  }}
                >
                  <span aria-hidden style={{ fontSize: 24, flexShrink: 0 }}>
                    {getProductEmoji(item.name, item.category?.name)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, color: "var(--inv-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.name}
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--inv-text-muted)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                      במערכת {item.currentQuantity} {unit}
                      {diff !== 0 ? (
                        <span style={{ color: diff > 0 ? "var(--inv-success)" : "var(--inv-danger)", fontWeight: 600 }}>
                          {" "}· הפרש {diff > 0 ? "+" : ""}{diff}
                        </span>
                      ) : (
                        <span> · תואם</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <button type="button" aria-label="הפחתה" onClick={() => adjustCount(item.id, -1)} style={stepBtnStyle}>−</button>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label={`כמות שנספרה — ${item.name}`}
                      value={draft?.id === item.id ? draft.value : String(counted)}
                      onFocus={() => setDraft({ id: item.id, value: String(counted) })}
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
                      style={{
                        width: 46,
                        minHeight: 32,
                        textAlign: "center",
                        fontWeight: 700,
                        fontSize: 16,
                        fontVariantNumeric: "tabular-nums",
                        borderRadius: 8,
                        border: "1px solid var(--inv-border-hover)",
                        background: "var(--inv-card-bg)",
                        color: "var(--inv-text)",
                        padding: "2px 4px",
                        boxSizing: "border-box",
                      }}
                    />
                    <button type="button" aria-label="הוספה" onClick={() => adjustCount(item.id, 1)} style={stepBtnStyle}>+</button>
                    <button type="button" aria-label="הסרה" onClick={() => removeCount(item.id)} style={{ ...stepBtnStyle, color: "var(--inv-danger)" }}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {countedRows.length > 0 ? (
        <div
          style={{
            position: "sticky",
            bottom: 0,
            marginTop: 16,
            padding: "12px clamp(16px,3.5vw,28px) calc(12px + env(safe-area-inset-bottom, 0px))",
            background: "var(--inv-page-bg)",
            borderTop: "1px solid var(--inv-border)",
          }}
        >
          <button
            type="button"
            onClick={() => void handleFinish()}
            disabled={saving}
            style={{
              width: "100%",
              minHeight: 52,
              borderRadius: "var(--inv-radius-md)",
              border: "none",
              background: "var(--inv-success)",
              color: "var(--inv-on-accent)",
              fontSize: 16,
              fontWeight: 600,
              cursor: saving ? "not-allowed" : "pointer",
              opacity: saving ? 0.75 : 1,
            }}
          >
            {saving ? "שומר…" : changedCount > 0 ? `סיום ושמירה · ${changedCount} עדכונים` : "סיום ושמירה"}
          </button>
        </div>
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
    </InventorySubPage>
  );
}

const stepBtnStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  border: "1px solid var(--inv-border-hover)",
  background: "var(--inv-surface-2)",
  color: "var(--inv-text)",
  fontSize: 18,
  lineHeight: 1,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};
