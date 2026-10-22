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
import { useRouter } from "next/navigation";
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
import { SupplierField } from "@/components/inventory/supplier-field";
import { getProductEmoji } from "@/lib/inventory/product-emoji";
import { getAlertTypeLabel, getMovementReasonLabel, UNIT_LABEL_KEYS } from "@/lib/inventory/inventory-labels";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";



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

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}
function safeImage(imageUrl?: string | null) {
  return imageUrl && !imageUrl.includes("example.com") ? imageUrl : null;
}
function money(v: number | null | undefined, locale: Locale) {
  return v == null ? "—" : `₪${v.toLocaleString(intlTag(locale))}`;
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
  const { t, locale } = useI18n();
  const unitOptions = useMemo(
    () => Object.entries(UNIT_LABEL_KEYS).map(([value, key]) => ({ value, label: t(key) })),
    [t]
  );
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
        setError(t("customers.inventoryKit.product.invalidId"));
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
        const message = getErrorMessage(err, t("customers.inventoryKit.product.loadError"));
        if (message === "UNAUTHORIZED") setError(t("customers.inventoryKit.product.unauthorized"));
        else if (message === "NOT_FOUND") setError(t("customers.inventoryKit.image.notFound"));
        else setError(message);
      } finally {
        setLoading(false);
      }
    },
    [itemId, syncForm, t]
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
    if (!form.name.trim()) nextErrors.name = t("customers.inventoryKit.product.nameRequired");
    if (!Number.isFinite(minimumQuantity) || minimumQuantity < 0)
      nextErrors.minimumQuantity = t("customers.inventoryKit.product.minNonNegative");
    if (reorderProvided && (!Number.isFinite(reorderPoint as number) || (reorderPoint as number) < 0))
      nextErrors.reorderPoint = t("customers.inventoryKit.product.reorderNonNegative");
    else if (reorderPoint !== null && Number.isFinite(minimumQuantity) && reorderPoint < minimumQuantity)
      nextErrors.reorderPoint = t("customers.inventoryKit.product.reorderAboveMin");

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
      setSuccess(t("customers.inventoryKit.product.updated"));
      inventoryToast.success(t("customers.inventoryKit.product.updated"));
    } catch (err: unknown) {
      setError(getErrorMessage(err, t("customers.inventoryKit.product.updateError")));
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
      setError(getErrorMessage(err, t("customers.inventoryKit.product.resolveError")));
    } finally {
      setResolvingAlertId(null);
    }
  }

  const tone = item ? getStockTone(item) : "ok";
  const unitKey = item ? UNIT_LABEL_KEYS[item.unitType] : undefined;
  const unit = item ? (unitKey ? t(unitKey) : item.unitType) : "";

  const router = useRouter();
  const caption = useMemo(() => {
    if (!item) return "";
    if (tone === "critical") {
      return t("customers.inventoryKit.product.captionCritical", { min: item.minimumQuantity }) + (item.reorderPoint != null ? t("customers.inventoryKit.product.captionReorderSuffix", { reorder: item.reorderPoint }) : "");
    }
    if (tone === "low") {
      return item.reorderPoint != null ? t("customers.inventoryKit.product.captionLowWithValue", { reorder: item.reorderPoint }) : t("customers.inventoryKit.product.captionLow");
    }
    return t("customers.inventoryKit.product.captionOk", { qty: item.currentQuantity });
  }, [item, tone, t]);

  // ----- states -----
  let content: ReactNode;
  if (loading) {
    content = <div className="inv-olines"><InventoryStatePanel title={t("customers.inventoryKit.product.loading")} /></div>;
  } else if (error && !item) {
    content = (
      <div className="inv-page-content" style={{ padding: "16px clamp(16px,3.5vw,28px)" }}>
        <InventoryStatePanel
          tone="error"
          title={t("customers.inventoryKit.product.errorTitle")}
          action={<button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void loadItemData()}>{t("customers.inventoryKit.common.retry")}</button>}
        >
          {error}
        </InventoryStatePanel>
      </div>
    );
  } else if (!item) {
    content = (
      <div className="inv-page-content" style={{ padding: "16px clamp(16px,3.5vw,28px)" }}>
        <InventoryStatePanel title={t("customers.inventoryKit.product.noData")} />
      </div>
    );
  } else {
    const kvPairs = [
      { k: t("customers.inventoryKit.product.kv.currentQty"), v: `${item.currentQuantity} ${unit}` },
      { k: t("customers.inventoryKit.product.kv.minimum"), v: `${item.minimumQuantity} ${unit}` },
      { k: t("customers.inventoryKit.product.kv.reorder"), v: item.reorderPoint != null ? `${item.reorderPoint} ${unit}` : "—" },
      { k: t("customers.inventoryKit.product.kv.unitCost"), v: money(item.costPerUnit, locale) },
      { k: t("customers.inventoryKit.product.kv.sellPrice"), v: money(item.sellPricePerUnit, locale) },
      { k: t("customers.inventoryKit.product.kv.lastPurchase"), v: money(item.lastPurchaseCost, locale) },
      { k: t("customers.inventoryKit.product.kv.sku"), v: item.sku || "—" },
      { k: t("customers.inventoryKit.product.kv.barcode"), v: item.barcode || "—" },
    ];

    content = (
      <div className="inv-detail-body">
        {success ? <div className="inv-fwrap"><div className="inv-alert inv-alert--success" style={{ marginTop: 8 }}>{success}</div></div> : null}
        {error ? <div className="inv-fwrap"><div className="inv-alert inv-alert--error" style={{ marginTop: 8 }}>{error}</div></div> : null}

        <div className="inv-detail-desk">
        <div>
        <ProductHero imageUrl={safeImage(item.imageUrl)} tone={tone} placeholder={<span style={{ fontSize: 64 }}>{getProductEmoji(item.name, item.category?.name)}</span>} />
        <div className="inv-dname">{item.name}</div>
        <ProductTags tags={[item.category?.name, item.supplierName ? t("customers.inventoryKit.product.supplierTag", { name: item.supplierName }) : null, unit]} />

        <StockStatusBlock
          tone={tone}
          statusLabel={getStockStatusLabel(tone, t)}
          quantityLabel={<>{item.currentQuantity}<small> {t("customers.inventoryKit.product.unitInStock", { unit })}</small></>}
          ratio={getStockRatio(item)}
          caption={caption}
        />

        <DetailActions
          actions={[
            {
              label: t("customers.inventoryKit.product.orderFromSupplier"),
              primary: true,
              icon: (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M2 7h11v9H2zM13 10h4l3 3v3h-7" stroke="var(--inv-on-accent)" strokeWidth="1.8" strokeLinejoin="round" />
                  <circle cx="6" cy="18.5" r="1.6" stroke="var(--inv-on-accent)" strokeWidth="1.8" />
                  <circle cx="17" cy="18.5" r="1.6" stroke="var(--inv-on-accent)" strokeWidth="1.8" />
                </svg>
              ),
              // Client navigation (was a full reload): keeps the history trail,
              // so back from the order wizard returns to this product.
              onClick: () => router.push("/inventory/supplier-purchases/new"),
            },
            {
              label: t("customers.inventoryKit.product.add"),
              icon: (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              ),
              onClick: () => setMovementKind("IN"),
            },
            { label: t("customers.inventoryKit.reasons.countFix"), onClick: () => setMovementKind("ADJUSTMENT") },
          ]}
        />

        {item.alerts && item.alerts.length > 0 ? (
          <>
            <div className="inv-seclabel">{t("customers.inventoryKit.product.openAlerts")}</div>
            <div className="inv-olines" style={{ paddingTop: 0 }}>
              {item.alerts.map((alert) => (
                <div key={alert.id} className="inv-oline">
                  <span className="inv-oline__mid">
                    <span className="inv-oline__nm">{getAlertTypeLabel(alert.type, t)}</span>
                    {alert.message ? <span className="inv-oline__sub">{alert.message}</span> : null}
                  </span>
                  <button type="button" className="inv-dchip" style={{ flex: "0 0 auto", minWidth: 72 }} disabled={resolvingAlertId !== null} onClick={() => void handleResolveAlert(alert.id)}>
                    {resolvingAlertId === alert.id ? t("customers.inventoryKit.product.closing") : t("customers.inventoryKit.product.handled")}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        </div>
        <div>
        <div className="inv-seclabel">{t("customers.inventoryKit.product.details")}</div>
        <KeyValueGrid pairs={kvPairs} />

        <div className="inv-seclabel">{t("customers.inventoryKit.product.movementHistory")}</div>
        <div>
          {movements.length === 0 ? (
            <div className="inv-mv__s" style={{ padding: "0 clamp(16px,3.5vw,28px) 16px", maxWidth: 720, margin: "0 auto" }}>{t("customers.inventoryKit.product.noMovements")}</div>
          ) : (
            movements.map((mv) => {
              const up = mv.quantityDelta >= 0;
              return (
                <MovementRow
                  key={mv.id}
                  icon={<span>{REASON_EMOJI[mv.reason] || "•"}</span>}
                  iconBg={up ? "var(--inv-success-bg)" : "var(--inv-danger-bg)"}
                  title={getMovementReasonLabel(mv.reason, t)}
                  sub={<><bdi>{mv.quantityBefore}</bdi> {t("customers.inventoryKit.movement.arrow")} <bdi>{mv.quantityAfter}</bdi> · <bdi>{new Date(mv.createdAt).toLocaleDateString(intlTag(locale), { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</bdi></>}
                  delta={`${up ? "+" : "−"}${Math.abs(mv.quantityDelta)}`}
                  direction={up ? "up" : "down"}
                />
              );
            })
          )}
        </div>
        </div>
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
            title={t("customers.inventoryKit.product.editTitle")}
            who={item.name}
            onClose={() => { syncForm(item); setFieldErrors({}); setEditing(false); }}
            footer={<SheetActions confirmLabel={saving ? t("customers.inventoryKit.movement.saving") : t("customers.inventoryKit.product.saveProduct")} onCancel={() => { syncForm(item); setFieldErrors({}); setEditing(false); }} onConfirm={() => void handleSave()} confirmDisabled={saving} />}
          >
            <div style={{ margin: "0 0 14px" }}>
              <InventoryItemImageUploader itemId={item.id} imageUrl={safeImage(item.imageUrl)} onUpdated={(updated) => setItem((cur) => (cur ? { ...cur, ...updated } : cur))} />
            </div>
            <div className="inv-field">
              <div className="inv-field__lab">{t("customers.inventoryKit.product.fields.name")} <span>*</span></div>
              <input className={`inv-input${fieldErrors.name ? " inv-input--err" : ""}`} value={form.name} onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); if (fieldErrors.name) setFieldErrors((f) => ({ ...f, name: undefined })); }} aria-invalid={fieldErrors.name ? true : undefined} />
              {fieldErrors.name ? <div className="inv-field__err">{fieldErrors.name}</div> : null}
            </div>
            <div className="inv-field">
              <div className="inv-field__lab">{t("customers.inventoryKit.product.fields.category")}</div>
              <input className="inv-input" list="inv-edit-categories" value={form.categoryName} onChange={(e) => setForm((f) => ({ ...f, categoryName: e.target.value }))} placeholder={t("customers.inventoryKit.product.fields.categoryPlaceholder")} />
              <datalist id="inv-edit-categories">
                {categories.map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
            </div>
            <div className="inv-field">
              <div className="inv-field__lab">{t("customers.inventoryKit.product.fields.supplier")}</div>
              {/* The same field the create form uses. The orphan seed is this
                  item's OWN stored name: the card loads one item, not the
                  catalogue, so enumerating every snapshot name would mean
                  fetching all items just to fill a dropdown. What matters when
                  editing is that the value already on the item stays selectable. */}
              <SupplierField
                value={form.supplierName}
                onChange={(supplierName) => setForm((f) => ({ ...f, supplierName }))}
                orphanNames={item?.supplierName ? [item.supplierName] : []}
                idPrefix="inv-edit-supplier"
              />
            </div>
            <div className="inv-field"><div className="inv-field__lab">{t("customers.inventoryKit.product.fields.unit")}</div><SegmentedControl value={form.unitType} onChange={(v) => setForm((f) => ({ ...f, unitType: v }))} options={unitOptions} /></div>
            <div className="inv-two">
              <div className="inv-field">
                <div className="inv-field__lab">{t("customers.inventoryKit.product.kv.minimum")}</div>
                <input className={`inv-input${fieldErrors.minimumQuantity ? " inv-input--err" : ""}`} inputMode="numeric" value={form.minimumQuantity} onChange={(e) => { setForm((f) => ({ ...f, minimumQuantity: e.target.value })); if (fieldErrors.minimumQuantity || fieldErrors.reorderPoint) setFieldErrors((f) => ({ ...f, minimumQuantity: undefined, reorderPoint: undefined })); }} aria-invalid={fieldErrors.minimumQuantity ? true : undefined} />
                {fieldErrors.minimumQuantity ? <div className="inv-field__err">{fieldErrors.minimumQuantity}</div> : null}
              </div>
              <div className="inv-field">
                <div className="inv-field__lab">{t("customers.inventoryKit.product.kv.reorder")}</div>
                <input className={`inv-input${fieldErrors.reorderPoint ? " inv-input--err" : ""}`} inputMode="numeric" placeholder={t("customers.inventoryKit.product.fields.optional")} value={form.reorderPoint} onChange={(e) => { setForm((f) => ({ ...f, reorderPoint: e.target.value })); if (fieldErrors.reorderPoint) setFieldErrors((f) => ({ ...f, reorderPoint: undefined })); }} aria-invalid={fieldErrors.reorderPoint ? true : undefined} />
                {fieldErrors.reorderPoint ? <div className="inv-field__err">{fieldErrors.reorderPoint}</div> : null}
              </div>
            </div>
            <div className="inv-two">
              <div className="inv-field"><div className="inv-field__lab">{t("customers.inventoryKit.product.kv.unitCost")}</div><input className="inv-input" inputMode="decimal" placeholder={t("customers.inventoryKit.product.fields.optional")} value={form.costPerUnit} onChange={(e) => setForm((f) => ({ ...f, costPerUnit: e.target.value }))} /></div>
              <div className="inv-field"><div className="inv-field__lab">{t("customers.inventoryKit.product.kv.sellPrice")}</div><input className="inv-input" inputMode="decimal" placeholder={t("customers.inventoryKit.product.fields.optional")} value={form.sellPricePerUnit} onChange={(e) => setForm((f) => ({ ...f, sellPricePerUnit: e.target.value }))} /></div>
            </div>
            <div className="inv-field"><div className="inv-field__lab">{t("customers.inventoryKit.product.kv.sku")}</div><input className="inv-input" value={form.sku} onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))} /></div>
            <div className="inv-field"><div className="inv-field__lab">{t("customers.inventoryKit.product.kv.barcode")}</div><input className="inv-input" value={form.barcode} onChange={(e) => setForm((f) => ({ ...f, barcode: e.target.value }))} /></div>
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

  const editAction = item ? { icon: <IconEdit />, label: t("customers.inventoryKit.product.edit"), onClick: () => setEditing(true) } : null;

  if (chrome === "sheet") {
    return (
      <>
        <style>{inventoryPrimitivesCss}</style>
        <div className="inv-scrim" onClick={onCloseSheet} aria-hidden />
        <div className="inv-sheet" role="dialog" aria-modal="true" aria-label={t("customers.inventoryKit.product.title")} style={{ paddingInline: 0 }}>
          <button type="button" className="inv-sheet__grab" onClick={onCloseSheet} aria-label={t("customers.inventoryKit.common.close")} style={{ border: 0, cursor: "pointer", padding: 0 }} />
          <div className="inv-hd inv-hd--page" style={{ position: "static", borderBottom: "1px solid var(--inv-border)", background: "transparent", backdropFilter: "none" }}>
            <button type="button" className="inv-iconbtn" onClick={onCloseSheet} aria-label={t("customers.inventoryKit.common.close")}><IconChevronStart /></button>
            <h1 className="inv-hd__title-page">{t("customers.inventoryKit.product.title")}</h1>
            {editAction ? (
              <button type="button" className="inv-iconbtn" onClick={editAction.onClick} aria-label={t("customers.inventoryKit.product.edit")}><IconEdit /></button>
            ) : <span className="inv-iconbtn inv-iconbtn--ghost" aria-hidden />}
          </div>
          {content}
        </div>
      </>
    );
  }

  return (
    <InventorySubPage intent="standard" title={t("customers.inventoryKit.product.title")} backHref="/inventory/items" bottomNav="products" headerAction={editAction}>
      {content}
    </InventorySubPage>
  );
}
