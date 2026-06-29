"use client";

/**
 * Shared product-detail body (mockup s1). Rendered by BOTH the canonical Page
 * (app/(shell)/inventory/items/[id]/page.tsx) and the ADR-01 intercepting Sheet
 * (app/(shell)/inventory/@sheet/(.)items/[id]/page.tsx) so they stay in parity.
 * `chrome="page"` wraps in InventorySubPage; `chrome="sheet"` wraps in a bottom
 * sheet that closes via onCloseSheet (router.back()).
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  createInventoryCategory,
  getInventoryCategories,
  getInventoryItemById,
  getInventoryMovementsByItemId,
  resolveInventoryAlert,
  updateInventoryItem,
  type InventoryCategoryDTO,
  type InventoryItemDTO,
  type InventoryMovementDTO,
} from "@/lib/api/inventory";
import { inventoryTextKey, normalizeInventoryText } from "@/lib/inventory/normalize";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import InventoryItemImageUploader from "@/components/inventory/inventory-item-image-uploader";
import MovementSheet from "@/components/inventory/movement-sheet";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  getStockTone,
  getStockRatio,
  getStockStatusLabel,
  ProductHero,
  ProductTags,
  StockStatusBlock,
  KeyValueGrid,
  MovementRow,
  DetailActions,
  BottomSheet,
  SegmentedControl,
  SheetActions,
  InventoryStatePanel,
  IconEdit,
  IconChevronStart,
} from "@/components/inventory/inventory-design";
import { inventoryPrimitivesCss } from "@/components/inventory/inventory-primitives.css";
import { getProductEmoji } from "@/lib/inventory/product-emoji";
import { getMovementReasonLabel } from "@/lib/inventory/inventory-labels";

const UNIT_LABELS: Record<string, string> = { UNIT: "יחידה", ML: 'מ"ל', GRAM: "גרם", KG: "ק״ג", LITER: "ליטר", BOX: "מארז" };
const UNIT_OPTIONS = Object.entries(UNIT_LABELS).map(([value, label]) => ({ value, label }));

const REASON_EMOJI: Record<string, string> = {
  SALE: "🛒",
  SUPPLIER_PURCHASE: "📦",
  INVENTORY_COUNT_CORRECTION: "📝",
  INITIAL_STOCK: "🏁",
  MANUAL_ADD: "➕",
  MANUAL_REMOVE: "➖",
  RETURN: "↩️",
  DAMAGE: "⚠️",
};

const ALERT_LABELS: Record<string, string> = {
  LOW_STOCK: "מלאי נמוך",
  CRITICAL_STOCK: "מלאי קריטי",
  UNMATCHED_POS_PRODUCT: "מכירת POS לא מזוהה",
  SUSPICIOUS_CORRECTION: "תיקון חשוד",
};

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}
function safeImage(imageUrl?: string | null) {
  return imageUrl && !imageUrl.includes("example.com") ? imageUrl : null;
}
function money(v: number | null | undefined) {
  return v == null ? "—" : `₪${v.toLocaleString("he-IL")}`;
}

export default function ProductDetailView({
  itemId,
  chrome,
  onCloseSheet,
}: {
  itemId: number;
  chrome: "page" | "sheet";
  onCloseSheet?: () => void;
}) {
  const [item, setItem] = useState<InventoryItemDTO | null>(null);
  const [movements, setMovements] = useState<InventoryMovementDTO[]>([]);
  const [categories, setCategories] = useState<InventoryCategoryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [resolvingAlertId, setResolvingAlertId] = useState<number | null>(null);
  const [movementKind, setMovementKind] = useState<"IN" | "OUT" | "ADJUSTMENT" | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<"name" | "minimumQuantity" | "reorderPoint", string>>
  >({});
  const [form, setForm] = useState({
    name: "",
    sku: "",
    barcode: "",
    unitType: "UNIT",
    minimumQuantity: "0",
    reorderPoint: "",
    costPerUnit: "",
    sellPricePerUnit: "",
    supplierName: "",
    categoryName: "",
  });

  const syncForm = useCallback((it: InventoryItemDTO) => {
    setForm({
      name: it.name || "",
      sku: it.sku || "",
      barcode: it.barcode || "",
      unitType: it.unitType || "UNIT",
      minimumQuantity: String(it.minimumQuantity ?? 0),
      reorderPoint: it.reorderPoint == null ? "" : String(it.reorderPoint),
      costPerUnit: it.costPerUnit == null ? "" : String(it.costPerUnit),
      sellPricePerUnit: it.sellPricePerUnit == null ? "" : String(it.sellPricePerUnit),
      supplierName: it.supplierName || "",
      categoryName: it.category?.name || "",
    });
  }, []);

  const loadItemData = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!itemId || Number.isNaN(itemId)) {
        setError("מזהה מוצר לא תקין");
        setLoading(false);
        return;
      }
      try {
        if (!options?.silent) setLoading(true);
        setError(null);
        const [itemData, movementsData, categoriesData] = await Promise.all([
          getInventoryItemById(itemId),
          getInventoryMovementsByItemId(itemId),
          getInventoryCategories().catch(() => []),
        ]);
        setItem(itemData);
        syncForm(itemData);
        setMovements(Array.isArray(movementsData) ? movementsData : []);
        setCategories(Array.isArray(categoriesData) ? categoriesData : []);
      } catch (err: unknown) {
        const message = getErrorMessage(err, "שגיאה בטעינת פרטי המוצר");
        if (message === "UNAUTHORIZED") setError("אין הרשאה. צריך להתחבר מחדש.");
        else if (message === "NOT_FOUND") setError("המוצר לא נמצא");
        else setError(message);
      } finally {
        setLoading(false);
      }
    },
    [itemId, syncForm]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadItemData(), 0);
    return () => window.clearTimeout(timer);
  }, [loadItemData]);

  async function resolveCategoryId(): Promise<number | null> {
    const normalized = normalizeInventoryText(form.categoryName);
    if (!normalized) return null;
    const key = normalized.toLowerCase();
    const existing = categories.find((c) => inventoryTextKey(c.name) === key);
    if (existing) return existing.id;
    const created = await createInventoryCategory({ name: normalized });
    setCategories((cur) => [...cur, created]);
    return created.id;
  }

  async function handleSave() {
    if (!item || saving) return;

    const minimumQuantity = Number(form.minimumQuantity);
    const reorderProvided = form.reorderPoint.trim() !== "";
    const reorderPoint = reorderProvided ? Number(form.reorderPoint) : null;

    const nextErrors: Partial<Record<"name" | "minimumQuantity" | "reorderPoint", string>> = {};
    if (!form.name.trim()) nextErrors.name = "צריך להזין שם מוצר";
    if (!Number.isFinite(minimumQuantity) || minimumQuantity < 0)
      nextErrors.minimumQuantity = "מינימום חייב להיות 0 או יותר";
    if (reorderProvided && (!Number.isFinite(reorderPoint as number) || (reorderPoint as number) < 0))
      nextErrors.reorderPoint = "סף ההזמנה חייב להיות 0 או יותר";
    else if (reorderPoint !== null && Number.isFinite(minimumQuantity) && reorderPoint < minimumQuantity)
      nextErrors.reorderPoint = "סף ההזמנה חייב להיות שווה או גבוה מהסף הקריטי";

    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setError(null);
      return;
    }

    try {
      setSaving(true);
      setError(null);
      const categoryId = await resolveCategoryId();
      const normalizedSupplier = normalizeInventoryText(form.supplierName);
      const updated = await updateInventoryItem(item.id, {
        name: form.name.trim(),
        sku: form.sku.trim() || null,
        barcode: form.barcode.trim() || null,
        unitType: form.unitType,
        minimumQuantity,
        reorderPoint,
        costPerUnit: form.costPerUnit.trim() ? Number(form.costPerUnit) : null,
        sellPricePerUnit: form.sellPricePerUnit.trim() ? Number(form.sellPricePerUnit) : null,
        supplierName: normalizedSupplier ? normalizedSupplier : null,
        categoryId,
      });
      setItem(updated);
      syncForm(updated);
      setEditing(false);
      setSuccess("פרטי המוצר עודכנו");
      inventoryToast.success("פרטי המוצר עודכנו");
    } catch (err: unknown) {
      setError(getErrorMessage(err, "שגיאה בעדכון המוצר"));
    } finally {
      setSaving(false);
    }
  }

  async function handleResolveAlert(alertId: number) {
    if (resolvingAlertId) return;
    try {
      setResolvingAlertId(alertId);
      setError(null);
      await resolveInventoryAlert(alertId);
      await loadItemData({ silent: true });
    } catch (err: unknown) {
      setError(getErrorMessage(err, "שגיאה בסגירת ההתראה"));
    } finally {
      setResolvingAlertId(null);
    }
  }

  const tone = item ? getStockTone(item) : "ok";
  const unit = item ? UNIT_LABELS[item.unitType] || item.unitType : "";

  const caption = useMemo(() => {
    if (!item) return "";
    if (tone === "critical") {
      return `בסף הקריטי או מתחתיו (${item.minimumQuantity})${item.reorderPoint != null ? ` · סף הזמנה מחדש ${item.reorderPoint}` : ""}`;
    }
    if (tone === "low") {
      return `בסף ההזמנה או מתחתיו${item.reorderPoint != null ? ` (${item.reorderPoint})` : ""}`;
    }
    return `מעל הספים · ${item.currentQuantity} במלאי`;
  }, [item, tone]);

  // ----- states -----
  let content: ReactNode;
  if (loading) {
    content = <div className="inv-olines"><InventoryStatePanel title="טוען פרטי מוצר…" /></div>;
  } else if (error && !item) {
    content = (
      <div className="inv-page-content" style={{ padding: "16px clamp(16px,3.5vw,28px)" }}>
        <InventoryStatePanel
          tone="error"
          title="משהו השתבש"
          action={<button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void loadItemData()}>נסה שוב</button>}
        >
          {error}
        </InventoryStatePanel>
      </div>
    );
  } else if (!item) {
    content = (
      <div className="inv-page-content" style={{ padding: "16px clamp(16px,3.5vw,28px)" }}>
        <InventoryStatePanel title="לא נמצאו נתוני מוצר" />
      </div>
    );
  } else {
    const kvPairs = [
      { k: "כמות נוכחית", v: `${item.currentQuantity} ${unit}` },
      { k: "סף מינימום", v: `${item.minimumQuantity} ${unit}` },
      { k: "סף הזמנה מחדש", v: item.reorderPoint != null ? `${item.reorderPoint} ${unit}` : "—" },
      { k: "עלות ליחידה", v: money(item.costPerUnit) },
      { k: "מחיר מכירה", v: money(item.sellPricePerUnit) },
      { k: "רכישה אחרונה", v: money(item.lastPurchaseCost) },
      { k: "מק״ט", v: item.sku || "—" },
      { k: "ברקוד", v: item.barcode || "—" },
    ];

    content = (
      <div className="inv-detail-body">
        {success ? <div className="inv-fwrap"><div className="inv-alert inv-alert--success" style={{ marginTop: 8 }}>{success}</div></div> : null}
        {error ? <div className="inv-fwrap"><div className="inv-alert inv-alert--error" style={{ marginTop: 8 }}>{error}</div></div> : null}

        <ProductHero imageUrl={safeImage(item.imageUrl)} tone={tone} placeholder={<span style={{ fontSize: 64 }}>{getProductEmoji(item.name, item.category?.name)}</span>} />
        <div className="inv-dname">{item.name}</div>
        <ProductTags tags={[item.category?.name, item.supplierName ? `ספק: ${item.supplierName}` : null, unit]} />

        <StockStatusBlock
          tone={tone}
          statusLabel={getStockStatusLabel(tone)}
          quantityLabel={<>{item.currentQuantity}<small> {unit} במלאי</small></>}
          ratio={getStockRatio(item)}
          caption={caption}
        />

        <DetailActions
          actions={[
            {
              label: "הזמן מספק",
              primary: true,
              icon: (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M2 7h11v9H2zM13 10h4l3 3v3h-7" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
                  <circle cx="6" cy="18.5" r="1.6" stroke="#fff" strokeWidth="1.8" />
                  <circle cx="17" cy="18.5" r="1.6" stroke="#fff" strokeWidth="1.8" />
                </svg>
              ),
              onClick: () => (window.location.href = "/inventory/supplier-purchases/new"),
            },
            {
              label: "הוסף",
              icon: (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              ),
              onClick: () => setMovementKind("IN"),
            },
            { label: "תיקון ספירה", onClick: () => setMovementKind("ADJUSTMENT") },
          ]}
        />

        {item.alerts && item.alerts.length > 0 ? (
          <>
            <div className="inv-seclabel">התראות פתוחות</div>
            <div className="inv-olines" style={{ paddingTop: 0 }}>
              {item.alerts.map((alert) => (
                <div key={alert.id} className="inv-oline">
                  <span className="inv-oline__mid">
                    <span className="inv-oline__nm">{ALERT_LABELS[alert.type] || alert.type}</span>
                    {alert.message ? <span className="inv-oline__sub">{alert.message}</span> : null}
                  </span>
                  <button type="button" className="inv-dchip" style={{ flex: "0 0 auto", minWidth: 72 }} disabled={resolvingAlertId !== null} onClick={() => void handleResolveAlert(alert.id)}>
                    {resolvingAlertId === alert.id ? "סוגר…" : "טופל"}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div className="inv-seclabel">פרטים</div>
        <KeyValueGrid pairs={kvPairs} />

        <div className="inv-seclabel">היסטוריית תנועות</div>
        <div>
          {movements.length === 0 ? (
            <div className="inv-mv__s" style={{ padding: "0 clamp(16px,3.5vw,28px) 16px", maxWidth: 720, margin: "0 auto" }}>עדיין אין תנועות לפריט זה.</div>
          ) : (
            movements.map((mv) => {
              const up = mv.quantityDelta >= 0;
              return (
                <MovementRow
                  key={mv.id}
                  icon={<span>{REASON_EMOJI[mv.reason] || "•"}</span>}
                  iconBg={up ? "#dcfce7" : "#fee2e2"}
                  title={getMovementReasonLabel(mv.reason)}
                  sub={<><bdi>{mv.quantityBefore}</bdi> ← <bdi>{mv.quantityAfter}</bdi> · <bdi>{new Date(mv.createdAt).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</bdi></>}
                  delta={`${up ? "+" : "−"}${Math.abs(mv.quantityDelta)}`}
                  direction={up ? "up" : "down"}
                />
              );
            })
          )}
        </div>

        {/* Portal the edit sheet to <body>: the shell wraps page content in a
            z-index:1 stacking context and the fixed BottomBar (z-100) is its
            sibling, so it paints over the sheet footer and intercepts taps on
            "שמור מוצר"/"ביטול" (click-through to a nav target). Portaling escapes
            that trap; the data-inventory-module wrapper preserves --inv-* styles. */}
        {editing && typeof document !== "undefined" ? (
          createPortal(
            <div data-inventory-module>
          <BottomSheet
            title="עריכת מוצר"
            who={item.name}
            onClose={() => { syncForm(item); setFieldErrors({}); setEditing(false); }}
            footer={<SheetActions confirmLabel={saving ? "שומר…" : "שמור מוצר"} onCancel={() => { syncForm(item); setFieldErrors({}); setEditing(false); }} onConfirm={() => void handleSave()} confirmDisabled={saving} />}
          >
            <div style={{ margin: "0 0 14px" }}>
              <InventoryItemImageUploader itemId={item.id} imageUrl={safeImage(item.imageUrl)} onUpdated={(updated) => setItem((cur) => (cur ? { ...cur, ...updated } : cur))} />
            </div>
            <div className="inv-field">
              <div className="inv-field__lab">שם מוצר <span>*</span></div>
              <input className={`inv-input${fieldErrors.name ? " inv-input--err" : ""}`} value={form.name} onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); if (fieldErrors.name) setFieldErrors((f) => ({ ...f, name: undefined })); }} aria-invalid={fieldErrors.name ? true : undefined} />
              {fieldErrors.name ? <div className="inv-field__err">{fieldErrors.name}</div> : null}
            </div>
            <div className="inv-field">
              <div className="inv-field__lab">קטגוריה</div>
              <input className="inv-input" list="inv-edit-categories" value={form.categoryName} onChange={(e) => setForm((f) => ({ ...f, categoryName: e.target.value }))} placeholder="בחר או צור קטגוריה" />
              <datalist id="inv-edit-categories">
                {categories.map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
            </div>
            <div className="inv-field">
              <div className="inv-field__lab">ספק</div>
              <input className="inv-input" value={form.supplierName} onChange={(e) => setForm((f) => ({ ...f, supplierName: e.target.value }))} placeholder="שם הספק" />
            </div>
            <div className="inv-field"><div className="inv-field__lab">יחידת מידה</div><SegmentedControl value={form.unitType} onChange={(v) => setForm((f) => ({ ...f, unitType: v }))} options={UNIT_OPTIONS} /></div>
            <div className="inv-two">
              <div className="inv-field">
                <div className="inv-field__lab">סף מינימום</div>
                <input className={`inv-input${fieldErrors.minimumQuantity ? " inv-input--err" : ""}`} inputMode="numeric" value={form.minimumQuantity} onChange={(e) => { setForm((f) => ({ ...f, minimumQuantity: e.target.value })); if (fieldErrors.minimumQuantity || fieldErrors.reorderPoint) setFieldErrors((f) => ({ ...f, minimumQuantity: undefined, reorderPoint: undefined })); }} aria-invalid={fieldErrors.minimumQuantity ? true : undefined} />
                {fieldErrors.minimumQuantity ? <div className="inv-field__err">{fieldErrors.minimumQuantity}</div> : null}
              </div>
              <div className="inv-field">
                <div className="inv-field__lab">סף הזמנה מחדש</div>
                <input className={`inv-input${fieldErrors.reorderPoint ? " inv-input--err" : ""}`} inputMode="numeric" placeholder="לא חובה" value={form.reorderPoint} onChange={(e) => { setForm((f) => ({ ...f, reorderPoint: e.target.value })); if (fieldErrors.reorderPoint) setFieldErrors((f) => ({ ...f, reorderPoint: undefined })); }} aria-invalid={fieldErrors.reorderPoint ? true : undefined} />
                {fieldErrors.reorderPoint ? <div className="inv-field__err">{fieldErrors.reorderPoint}</div> : null}
              </div>
            </div>
            <div className="inv-two">
              <div className="inv-field"><div className="inv-field__lab">עלות ליחידה</div><input className="inv-input" inputMode="decimal" placeholder="לא חובה" value={form.costPerUnit} onChange={(e) => setForm((f) => ({ ...f, costPerUnit: e.target.value }))} /></div>
              <div className="inv-field"><div className="inv-field__lab">מחיר מכירה</div><input className="inv-input" inputMode="decimal" placeholder="לא חובה" value={form.sellPricePerUnit} onChange={(e) => setForm((f) => ({ ...f, sellPricePerUnit: e.target.value }))} /></div>
            </div>
            <div className="inv-field"><div className="inv-field__lab">מק״ט</div><input className="inv-input" value={form.sku} onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))} /></div>
            <div className="inv-field"><div className="inv-field__lab">ברקוד</div><input className="inv-input" value={form.barcode} onChange={(e) => setForm((f) => ({ ...f, barcode: e.target.value }))} /></div>
          </BottomSheet>
            </div>,
            document.body
          )
        ) : null}

        {movementKind ? (
          <MovementSheet
            itemId={item.id}
            itemName={item.name}
            currentQuantity={item.currentQuantity}
            unitLabel={unit}
            initialType={movementKind}
            onClose={() => setMovementKind(null)}
            onSuccess={() => loadItemData({ silent: true })}
          />
        ) : null}
      </div>
    );
  }

  const editAction = item ? { icon: <IconEdit />, label: "עריכה", onClick: () => setEditing(true) } : null;

  if (chrome === "sheet") {
    return (
      <>
        <style>{inventoryPrimitivesCss}</style>
        <div className="inv-scrim" onClick={onCloseSheet} aria-hidden />
        <div className="inv-sheet" role="dialog" aria-modal="true" aria-label="פרטי מוצר" style={{ paddingInline: 0 }}>
          <button type="button" className="inv-sheet__grab" onClick={onCloseSheet} aria-label="סגירה" style={{ border: 0, cursor: "pointer", padding: 0 }} />
          <div className="inv-hd inv-hd--page" style={{ position: "static", borderBottom: "1px solid var(--inv-border)", background: "transparent", backdropFilter: "none" }}>
            <button type="button" className="inv-iconbtn" onClick={onCloseSheet} aria-label="סגירה"><IconChevronStart /></button>
            <h1 className="inv-hd__title-page">פרטי מוצר</h1>
            {editAction ? (
              <button type="button" className="inv-iconbtn" onClick={editAction.onClick} aria-label="עריכה"><IconEdit /></button>
            ) : <span className="inv-iconbtn inv-iconbtn--ghost" aria-hidden />}
          </div>
          {content}
        </div>
      </>
    );
  }

  return (
    <InventorySubPage title="פרטי מוצר" backHref="/inventory/items" bottomNav="products" headerAction={editAction}>
      {content}
    </InventorySubPage>
  );
}
