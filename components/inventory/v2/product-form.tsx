"use client";

/**
 * Product form — owner-approved redesign mockup "מוצר חדש" (2026-11-03).
 * One form for create (/inventory/items/create) and edit (/inventory/items/[id]/edit).
 *
 * Data logic is carried over unchanged from the previous create page and the
 * previous edit sheet:
 *  - create: categories + items load together; a typed category is matched or
 *    created implicitly; the item is created, THEN its image is uploaded;
 *  - edit: the category goes through decideCategoryOnSave (#926), the PATCH
 *    payload is the one the edit sheet sent, and a picked image uploads at once
 *    (uploadInventoryItemImage). Description and "featured" are create-only
 *    (the update API does not take them); there is no remove-image capability.
 * Validation per mode is exactly what each screen enforced before.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import { SupplierField } from "@/components/inventory/supplier-field";
import BarcodeScanner from "@/components/inventory/barcode-scanner";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import {
  createInventoryCategory,
  createInventoryItem,
  getInventoryCategories,
  getInventoryItemById,
  getInventoryItems,
  updateInventoryItem,
  uploadInventoryItemImage,
  type InventoryCategoryDTO,
  type InventoryItemDTO,
} from "@/lib/api/inventory";
import { inventoryTextKey, normalizeInventoryText } from "@/lib/inventory/normalize";
import { decideCategoryOnSave } from "@/lib/inventory/category-edit";
import { qtyWithUnit, unitWord, UNIT_OPTIONS } from "@/lib/inventory/unit-words";
import {
  I2,
  InvButton,
  InvError,
  InvField,
  InvLoading,
  InvNote,
  InvPage,
  InvSectionBox,
  InvState,
  ProductThumb,
} from "@/components/inventory/v2/kit";

type Mode = "create" | "edit";
type FieldKey = "name" | "initialQuantity" | "minimumQuantity" | "reorderPoint";
type FieldErrors = Partial<Record<FieldKey, string>>;
const FIELD_ORDER: FieldKey[] = ["name", "initialQuantity", "minimumQuantity", "reorderPoint"];

const IMAGE_SAVED_UPLOAD_FAILED = "המוצר נשמר, אבל העלאת התמונה נכשלה";

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}
/** Optional number as the create page parsed it: empty or not-a-number → null. */
function optionalNumber(raw: string): number | null {
  if (!raw.trim()) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

type FormState = {
  name: string;
  unitType: string;
  initialQuantity: string;
  minimumQuantity: string;
  reorderPoint: string;
  costPerUnit: string;
  sellPricePerUnit: string;
  categoryName: string;
  supplierName: string;
  barcode: string;
  sku: string;
  description: string;
  featuredByOwner: boolean;
};

const EMPTY_FORM: FormState = {
  name: "",
  unitType: "UNIT",
  initialQuantity: "",
  minimumQuantity: "0",
  reorderPoint: "",
  costPerUnit: "",
  sellPricePerUnit: "",
  categoryName: "",
  supplierName: "",
  barcode: "",
  sku: "",
  description: "",
  featuredByOwner: false,
};

function formFromItem(it: InventoryItemDTO): FormState {
  return {
    ...EMPTY_FORM,
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
  };
}

export default function ProductForm({ mode, itemId }: { mode: Mode; itemId?: number }) {
  const router = useRouter();
  const { t } = useI18n();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fid = (k: string) => `pf-${uid}-${k}`;

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [item, setItem] = useState<InventoryItemDTO | null>(null);
  const [categories, setCategories] = useState<InventoryCategoryDTO[]>([]);
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [supplierOptions, setSupplierOptions] = useState<string[]>([]);
  const [booting, setBooting] = useState(mode === "edit");
  const [bootError, setBootError] = useState<{ kind: "not-found" } | { kind: "other"; message: string } | null>(null);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [duplicateItem, setDuplicateItem] = useState<InventoryItemDTO | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageDone, setImageDone] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  /** Set once the item exists, so a second tap can never create a duplicate. */
  const createdIdRef = useRef<number | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const clearErr = (...keys: FieldKey[]) =>
    setFieldErrors((f) => {
      if (!keys.some((k) => f[k])) return f;
      const next = { ...f };
      for (const k of keys) delete next[k];
      return next;
    });

  // ---------------------------------------------------------------- load
  const load = useCallback(async () => {
    if (mode === "create") {
      try {
        const [result, loadedItems] = await Promise.all([
          getInventoryCategories(),
          // Supplier names already on items. Since the picker searches the
          // canonical Suppliers, these are only the SECONDARY choices — snapshot
          // values with no supplier record behind them, kept so nothing already
          // in use becomes unreachable. Also powers the duplicate-barcode check.
          getInventoryItems().catch(() => []),
        ]);
        setCategories(result);
        const list = Array.isArray(loadedItems) ? loadedItems : [];
        setItems(list);
        const uniqueSuppliers = new Map<string, string>();
        for (const it of list) {
          const normalized = normalizeInventoryText(it.supplierName);
          if (normalized) uniqueSuppliers.set(normalized.toLowerCase(), normalized);
        }
        setSupplierOptions(Array.from(uniqueSuppliers.values()).sort((a, b) => a.localeCompare(b, "he")));
      } catch (err: unknown) {
        const message = getErrorMessage(err, t("customers.inventory.create.loadCategoriesFailed"));
        setError(message === "UNAUTHORIZED" ? t("customers.inventory.common.noAuth") : message);
      }
      return;
    }
    if (!itemId || Number.isNaN(itemId)) {
      setBootError({ kind: "not-found" });
      setBooting(false);
      return;
    }
    try {
      setBooting(true);
      setBootError(null);
      const [itemData, categoriesData, loadedItems] = await Promise.all([
        getInventoryItemById(itemId),
        getInventoryCategories().catch(() => []),
        // Only for the duplicate-barcode warning when scanning.
        getInventoryItems().catch(() => []),
      ]);
      setItem(itemData);
      setForm(formFromItem(itemData));
      setCategories(Array.isArray(categoriesData) ? categoriesData : []);
      setItems(Array.isArray(loadedItems) ? loadedItems : []);
    } catch (err: unknown) {
      const message = getErrorMessage(err, t("customers.inventoryKit.product.loadError"));
      if (message === "NOT_FOUND") setBootError({ kind: "not-found" });
      else if (message === "UNAUTHORIZED") setBootError({ kind: "other", message: t("customers.inventoryKit.product.unauthorized") });
      else setBootError({ kind: "other", message });
    } finally {
      setBooting(false);
    }
  }, [mode, itemId, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // ---------------------------------------------------------------- image
  function resetFileInput() {
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] || null;
    setImageError(null);
    setImageDone(false);
    if (mode === "create") {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (!file) {
        setSelectedFile(null);
        setPreviewUrl(null);
        return;
      }
      if (!file.type.startsWith("image/")) {
        setSelectedFile(null);
        setPreviewUrl(null);
        setImageError(t("customers.inventory.create.imageOnly"));
        resetFileInput();
        return;
      }
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      return;
    }
    // edit: upload at once (the existing image endpoint), then show the new image.
    if (!file || !item || imageBusy) return;
    if (!file.type.startsWith("image/")) {
      setImageError(t("customers.inventoryKit.image.imagesOnly"));
      resetFileInput();
      return;
    }
    setImageBusy(true);
    try {
      const updated = await uploadInventoryItemImage(item.id, file);
      setItem((cur) => (cur ? { ...cur, imageUrl: updated?.imageUrl ?? cur.imageUrl } : cur));
      setImageDone(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : null;
      setImageError(message === "UNAUTHORIZED" ? t("customers.inventoryKit.image.unauthorizedUpload") : message || t("customers.inventoryKit.image.uploadFailed"));
    } finally {
      setImageBusy(false);
      resetFileInput();
    }
  }

  function clearPickedImage() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSelectedFile(null);
    setImageError(null);
    resetFileInput();
  }

  // ---------------------------------------------------------------- scan
  function handleScanDetected(code: string) {
    const scanned = code.trim();
    setScannerOpen(false);
    if (!scanned) return;
    const existing = items.find((it) => (it.barcode || "").trim() === scanned && it.id !== item?.id);
    if (existing) {
      // Duplicate barcode — don't autofill; surface the existing item instead.
      setDuplicateItem(existing);
      return;
    }
    setDuplicateItem(null);
    set("barcode", scanned);
    inventoryToast.success(t("customers.inventory.create.barcodeAdded"));
  }

  // ---------------------------------------------------------------- validate
  function validateCreate(): FieldErrors {
    const e: FieldErrors = {};
    const initial = Number(form.initialQuantity);
    const parsedInitial = Number.isNaN(initial) ? null : initial;
    const min = Number(form.minimumQuantity);
    const parsedMin = Number.isNaN(min) ? null : min;
    const reorder = optionalNumber(form.reorderPoint);
    if (!form.name.trim()) e.name = t("customers.inventory.create.nameRequired");
    if (parsedInitial === null || parsedInitial < 0) e.initialQuantity = t("customers.inventory.create.initialQtyInvalid");
    if (parsedMin === null || parsedMin < 0) e.minimumQuantity = t("customers.inventory.create.minQtyInvalid");
    if (reorder !== null && parsedMin !== null && reorder < parsedMin) e.reorderPoint = t("customers.inventory.create.reorderBelowMin");
    return e;
  }

  function validateEdit(): FieldErrors {
    const e: FieldErrors = {};
    const minimumQuantity = Number(form.minimumQuantity);
    const reorderProvided = form.reorderPoint.trim() !== "";
    const reorderPoint = reorderProvided ? Number(form.reorderPoint) : null;
    if (!form.name.trim()) e.name = t("customers.inventoryKit.product.nameRequired");
    if (!Number.isFinite(minimumQuantity) || minimumQuantity < 0) e.minimumQuantity = t("customers.inventoryKit.product.minNonNegative");
    if (reorderProvided && (!Number.isFinite(reorderPoint as number) || (reorderPoint as number) < 0))
      e.reorderPoint = t("customers.inventoryKit.product.reorderNonNegative");
    else if (reorderPoint !== null && Number.isFinite(minimumQuantity) && reorderPoint < minimumQuantity)
      e.reorderPoint = t("customers.inventoryKit.product.reorderAboveMin");
    return e;
  }

  function focusFirstInvalid(errors: FieldErrors) {
    const first = FIELD_ORDER.find((k) => errors[k]);
    if (!first) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(fid(first));
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.focus({ preventScroll: true });
      }
    });
  }

  // ---------------------------------------------------------------- save
  async function resolveCreateCategoryId(): Promise<number | null> {
    const normalized = normalizeInventoryText(form.categoryName);
    if (!normalized) return null;
    const key = normalized.toLowerCase();
    const existing = categories.find((c) => inventoryTextKey(c.name) === key);
    if (existing) return existing.id;
    const created = await createInventoryCategory({ name: normalized });
    return created.id;
  }

  async function resolveEditCategoryId(current: InventoryItemDTO): Promise<number | null> {
    const decision = decideCategoryOnSave(form.categoryName, current, categories);
    if (decision.kind === "clear") return null;
    if (decision.kind === "keep" || decision.kind === "existing") return decision.id;
    const created = await createInventoryCategory({ name: decision.name });
    setCategories((cur) => [...cur, created]);
    return created.id;
  }

  async function handleCreate() {
    if (saving || createdIdRef.current !== null) return;
    const nextErrors = validateCreate();
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setError(null);
      focusFirstInvalid(nextErrors);
      return;
    }
    const initial = Number(form.initialQuantity);
    const min = Number(form.minimumQuantity);
    setSaving(true);
    setError(null);
    let created: InventoryItemDTO;
    try {
      const categoryId = await resolveCreateCategoryId();
      const normalizedSupplier = normalizeInventoryText(form.supplierName);
      created = await createInventoryItem({
        name: form.name.trim(),
        barcode: form.barcode.trim() ? form.barcode.trim() : null,
        supplierName: normalizedSupplier ? normalizedSupplier : null,
        sku: form.sku.trim() ? form.sku.trim() : null,
        unitType: form.unitType,
        initialQuantity: Number.isNaN(initial) ? 0 : initial,
        minimumQuantity: Number.isNaN(min) ? 0 : min,
        reorderPoint: optionalNumber(form.reorderPoint),
        costPerUnit: optionalNumber(form.costPerUnit),
        sellPricePerUnit: optionalNumber(form.sellPricePerUnit),
        categoryId,
        description: form.description.trim() ? form.description.trim() : null,
        featuredByOwner: form.featuredByOwner,
      });
    } catch (err: unknown) {
      const message = getErrorMessage(err, t("customers.inventory.common.createItemFailed"));
      setError(message === "UNAUTHORIZED" ? t("customers.inventory.create.noAuthCreate") : message);
      setSaving(false);
      return;
    }
    createdIdRef.current = created.id;
    const target = `/inventory/items/${created.id}`;
    if (selectedFile) {
      try {
        await uploadInventoryItemImage(created.id, selectedFile);
      } catch {
        // The item exists: say so, and go to it (a retry here would create a duplicate).
        inventoryToast.error(IMAGE_SAVED_UPLOAD_FAILED);
        router.replace(target);
        return;
      }
    }
    inventoryToast.success(t("customers.inventory.create.created"));
    router.replace(target);
  }

  async function handleUpdate() {
    if (!item || saving) return;
    const nextErrors = validateEdit();
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setError(null);
      focusFirstInvalid(nextErrors);
      return;
    }
    const minimumQuantity = Number(form.minimumQuantity);
    const reorderPoint = form.reorderPoint.trim() !== "" ? Number(form.reorderPoint) : null;
    try {
      setSaving(true);
      setError(null);
      const categoryId = await resolveEditCategoryId(item);
      const normalizedSupplier = normalizeInventoryText(form.supplierName);
      await updateInventoryItem(item.id, {
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
      inventoryToast.success(t("customers.inventoryKit.product.updated"));
      router.replace(`/inventory/items/${item.id}`);
    } catch (err: unknown) {
      setError(getErrorMessage(err, t("customers.inventoryKit.product.updateError")));
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------- render
  const unitOne = unitWord(form.unitType, 1);
  const editOrphans = useMemo(() => (item?.supplierName ? [item.supplierName] : []), [item]);
  const title = mode === "create" ? "מוצר חדש" : "עריכת מוצר";
  const backFallback = mode === "create" ? "/inventory/items" : itemId ? `/inventory/items/${itemId}` : "/inventory/items";

  if (mode === "edit" && (booting || bootError || !item)) {
    return (
      <InvPage title={title} backFallback={backFallback}>
        {booting ? (
          <InvLoading rows={4} />
        ) : bootError?.kind === "not-found" ? (
          <InvState
            title="המוצר לא נמצא"
            body="ייתכן שהמוצר הוסר או שהקישור שגוי."
            action={
              <InvButton kind="secondary" href="/inventory/items">
                לרשימת המוצרים
              </InvButton>
            }
          />
        ) : (
          <InvError message={bootError?.kind === "other" ? bootError.message : undefined} onRetry={() => void load()} />
        )}
      </InvPage>
    );
  }

  const shownImage = mode === "create" ? previewUrl : item?.imageUrl ?? null;
  const unitChangedWithStock = mode === "edit" && item && form.unitType !== item.unitType && item.currentQuantity > 0;

  return (
    <InvPage
      title={title}
      backFallback={backFallback}
      footer={
        <>
          {error ? <InvNote tone="danger">{error}</InvNote> : null}
          <InvButton block onClick={() => void (mode === "create" ? handleCreate() : handleUpdate())} disabled={saving}>
            {saving ? t("customers.inventory.common.saving") : "שמירת מוצר"}
          </InvButton>
        </>
      }
    >
      <div>
        {/* ---------------- image ---------------- */}
        <section aria-label="תמונת מוצר" style={{ padding: "4px 0 12px" }}>
          <h2 className="i2-h3" style={{ marginTop: 6 }}>
            תמונת מוצר
          </h2>
          <div className="i2-imgpick">
            <span className="i2-imgpick__thumb">
              {shownImage ? (
                <ProductThumb src={shownImage} name={form.name} size={96} />
              ) : (
                <ProductThumb name={form.name.trim()} size={96} />
              )}
              {mode === "create" && previewUrl ? (
                <button type="button" className="i2-imgpick__x" onClick={clearPickedImage} aria-label="הסרת התמונה שנבחרה">
                  <span>{I2.close(16)}</span>
                </button>
              ) : null}
            </span>
            <label className="i2-imgpick__tile" aria-busy={imageBusy || undefined}>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={(e) => void handleFileChange(e)} disabled={imageBusy || saving} />
              {I2.camera(26)}
              <span>{imageBusy ? "מעלה תמונה…" : mode === "edit" && shownImage ? "החלפת תמונה" : "העלאת תמונה"}</span>
            </label>
          </div>
          {imageError ? (
            <p className="i2-field__err" role="alert" style={{ marginTop: 6 }}>
              {imageError}
            </p>
          ) : imageDone ? (
            <p className="i2-field__help" style={{ marginTop: 6 }} role="status">
              {t("customers.inventoryKit.image.updated")}
            </p>
          ) : null}
        </section>

        {/* ---------------- basics ---------------- */}
        <InvSectionBox title="פרטי בסיס">
          <InvField label="שם המוצר" required htmlFor={fid("name")} error={fieldErrors.name}>
            <input
              id={fid("name")}
              className="i2-input"
              value={form.name}
              onChange={(e) => {
                set("name", e.target.value);
                clearErr("name");
              }}
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-required
              autoComplete="off"
            />
          </InvField>
          <InvField label="יחידת מידה" required htmlFor={fid("unit")}>
            <select id={fid("unit")} className="i2-select" value={form.unitType} onChange={(e) => set("unitType", e.target.value)}>
              {UNIT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </InvField>
          {unitChangedWithStock && item ? (
            <InvNote tone="warn">שינוי היחידה לא ממיר את הכמות הקיימת ({qtyWithUnit(item.currentQuantity, item.unitType)})</InvNote>
          ) : null}
          {mode === "create" ? (
            <InvField label="כמות התחלתית" optional htmlFor={fid("initialQuantity")} error={fieldErrors.initialQuantity}>
              <input
                id={fid("initialQuantity")}
                className="i2-input"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="0"
                value={form.initialQuantity}
                onChange={(e) => {
                  set("initialQuantity", e.target.value.replace(/[^\d]/g, ""));
                  clearErr("initialQuantity");
                }}
                aria-invalid={fieldErrors.initialQuantity ? true : undefined}
              />
            </InvField>
          ) : null}
        </InvSectionBox>

        {/* ---------------- thresholds & prices ---------------- */}
        <InvSectionBox title="התראות ומחירים">
          <InvField label="סף מינימום" htmlFor={fid("minimumQuantity")} error={fieldErrors.minimumQuantity} help="רמת מלאי שממנה תופעל התראה על חוסר.">
            <input
              id={fid("minimumQuantity")}
              className="i2-input"
              inputMode="numeric"
              placeholder="0"
              value={form.minimumQuantity}
              onChange={(e) => {
                set("minimumQuantity", e.target.value);
                clearErr("minimumQuantity", "reorderPoint");
              }}
              aria-invalid={fieldErrors.minimumQuantity ? true : undefined}
            />
          </InvField>
          <InvField label="נקודת הזמנה" optional htmlFor={fid("reorderPoint")} error={fieldErrors.reorderPoint} help="רמת מלאי מומלצת להזמנה מחדש.">
            <input
              id={fid("reorderPoint")}
              className="i2-input"
              inputMode="numeric"
              value={form.reorderPoint}
              onChange={(e) => {
                set("reorderPoint", e.target.value);
                clearErr("reorderPoint");
              }}
              aria-invalid={fieldErrors.reorderPoint ? true : undefined}
            />
          </InvField>
          <InvField label={`עלות ל${unitOne}`} optional htmlFor={fid("cost")}>
            <div className="i2-affix">
              <input id={fid("cost")} className="i2-input" inputMode="decimal" value={form.costPerUnit} onChange={(e) => set("costPerUnit", e.target.value)} />
              <span aria-hidden>₪</span>
            </div>
          </InvField>
          <InvField label="מחיר מכירה" optional htmlFor={fid("sell")}>
            <div className="i2-affix">
              <input id={fid("sell")} className="i2-input" inputMode="decimal" value={form.sellPricePerUnit} onChange={(e) => set("sellPricePerUnit", e.target.value)} />
              <span aria-hidden>₪</span>
            </div>
          </InvField>
        </InvSectionBox>

        {/* ---------------- identification & more ---------------- */}
        <InvSectionBox title="זיהוי ופרטים נוספים" summary="קטגוריה, ספק, ברקוד, מק״ט, תיאור, הבלטה" defaultOpen={false}>
          <InvField label="קטגוריה" optional htmlFor={fid("category")}>
            <input
              id={fid("category")}
              className="i2-input"
              list={fid("categories")}
              value={form.categoryName}
              onChange={(e) => set("categoryName", e.target.value)}
              placeholder="בחירה או הקלדת קטגוריה חדשה"
              autoComplete="off"
            />
            <datalist id={fid("categories")}>
              {categories.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </InvField>
          <InvField label="ספק" optional>
            {/* Searches the canonical Suppliers and can create one without leaving
                the form. Create passes the snapshot names already on items as
                secondary choices; Edit keeps the item's own stored name selectable.
                The item is still saved only by "שמירת מוצר". */}
            <SupplierField
              value={form.supplierName}
              onChange={(supplierName) => set("supplierName", supplierName)}
              orphanNames={mode === "create" ? supplierOptions : editOrphans}
              idPrefix={mode === "create" ? "inv-create-supplier" : "inv-edit-supplier"}
            />
          </InvField>
          <InvField label="ברקוד" optional htmlFor={fid("barcode")}>
            <span style={{ display: "flex", gap: 8 }}>
              <input
                id={fid("barcode")}
                className="i2-input"
                value={form.barcode}
                onChange={(e) => {
                  set("barcode", e.target.value);
                  if (duplicateItem) setDuplicateItem(null);
                }}
                style={{ flex: 1, minWidth: 0 }}
                autoComplete="off"
              />
              <button
                type="button"
                className="i2-scanbtn"
                onClick={() => {
                  setDuplicateItem(null);
                  setScannerOpen(true);
                }}
                aria-label="סריקת ברקוד"
              >
                {I2.scan(22)}
              </button>
            </span>
          </InvField>
          {duplicateItem ? (
            <InvNote tone="warn">
              <span>
                {t("customers.inventory.create.duplicateExists")} <b>{duplicateItem.name}</b>
              </span>
              <br />
              <Link href={`/inventory/items/${duplicateItem.id}`} className="i2-link" style={{ paddingInline: 0, fontWeight: 600 }}>
                פתיחת המוצר הקיים {I2.chevronEnd(16)}
              </Link>
            </InvNote>
          ) : null}
          <InvField label="מק״ט" optional htmlFor={fid("sku")}>
            <input id={fid("sku")} className="i2-input" value={form.sku} onChange={(e) => set("sku", e.target.value)} autoComplete="off" />
          </InvField>
          {mode === "create" ? (
            <>
              <InvField label="תיאור" optional htmlFor={fid("description")} stack>
                <textarea
                  id={fid("description")}
                  className="i2-textarea"
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder={t("customers.inventory.create.descriptionPlaceholder")}
                  rows={3}
                />
              </InvField>
              <label className="i2-check">
                <input type="checkbox" checked={form.featuredByOwner} onChange={(e) => set("featuredByOwner", e.target.checked)} />
                <span>מוצר שהעסק רוצה להבליט</span>
              </label>
            </>
          ) : item?.description?.trim() ? (
            <InvField label="תיאור" stack>
              <p style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--i2-ink-2)" }}>{item.description}</p>
            </InvField>
          ) : null}
        </InvSectionBox>
      </div>

      <BarcodeScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleScanDetected}
        mode="single"
        title={t("customers.inventory.create.scannerTitle")}
        hint={t("customers.inventory.common.scanHint")}
      />
    </InvPage>
  );
}
