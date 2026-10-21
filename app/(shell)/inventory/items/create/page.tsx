"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import { SegmentedControl, SaveBar } from "@/components/inventory/inventory-design";
import { IconScan } from "@/components/inventory/inventory-primitives";
import { SupplierField } from "@/components/inventory/supplier-field";
import BarcodeScanner from "@/components/inventory/barcode-scanner";
import {
  createInventoryCategory,
  createInventoryItem,
  getInventoryCategories,
  getInventoryItems,
  uploadInventoryItemImage,
  type InventoryCategoryDTO,
  type InventoryItemDTO,
} from "@/lib/api/inventory";
import { inventoryTextKey, normalizeInventoryText } from "@/lib/inventory/normalize";
import { inventoryToast } from "@/components/inventory/inventory-toast";

type CreateFieldErrors = Partial<
  Record<"name" | "initialQuantity" | "minimumQuantity" | "reorderPoint", string>
>;

const UNIT_OPTIONS: ReadonlyArray<{ value: string; labelKey: MessageKey }> = [
  { value: "UNIT", labelKey: "customers.inventory.units.long.UNIT" },
  { value: "KG", labelKey: "customers.inventory.units.long.KG" },
  { value: "GRAM", labelKey: "customers.inventory.units.long.GRAM" },
  { value: "LITER", labelKey: "customers.inventory.units.long.LITER" },
  { value: "ML", labelKey: "customers.inventory.units.long.ML" },
  { value: "BOX", labelKey: "customers.inventory.units.long.BOX" },
];

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

export default function CreateInventoryItemPage() {
  const router = useRouter();
  const { t } = useI18n();
  const unitOptions = UNIT_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }));
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [unitType, setUnitType] = useState("UNIT");
  const [initialQuantity, setInitialQuantity] = useState("0");
  const [minimumQuantity, setMinimumQuantity] = useState("0");
  const [reorderPoint, setReorderPoint] = useState("");
  const [costPerUnit, setCostPerUnit] = useState("");
  const [sellPricePerUnit, setSellPricePerUnit] = useState("");
  const [description, setDescription] = useState("");
  const [featuredByOwner, setFeaturedByOwner] = useState(false);
  const [categories, setCategories] = useState<InventoryCategoryDTO[]>([]);
  const [categoryName, setCategoryName] = useState("");
  const [supplierOptions, setSupplierOptions] = useState<string[]>([]);
  // Loaded items power both the supplier autocomplete and barcode duplicate
  // detection when scanning while creating a product.
  const [items, setItems] = useState<InventoryItemDTO[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [duplicateItem, setDuplicateItem] = useState<InventoryItemDTO | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<CreateFieldErrors>({});

  const parsedInitialQuantity = useMemo(() => {
    const n = Number(initialQuantity);
    return Number.isNaN(n) ? null : n;
  }, [initialQuantity]);
  const parsedMinimumQuantity = useMemo(() => {
    const n = Number(minimumQuantity);
    return Number.isNaN(n) ? null : n;
  }, [minimumQuantity]);
  const normalizedReorderPoint = useMemo(() => {
    if (!reorderPoint.trim()) return null;
    const n = Number(reorderPoint);
    return Number.isNaN(n) ? null : n;
  }, [reorderPoint]);
  const normalizedCostPerUnit = useMemo(() => {
    if (!costPerUnit.trim()) return null;
    const n = Number(costPerUnit);
    return Number.isNaN(n) ? null : n;
  }, [costPerUnit]);
  const normalizedSellPricePerUnit = useMemo(() => {
    if (!sellPricePerUnit.trim()) return null;
    const n = Number(sellPricePerUnit);
    return Number.isNaN(n) ? null : n;
  }, [sellPricePerUnit]);

  useEffect(() => {
    let isMounted = true;
    const timer = window.setTimeout(async () => {
      try {
        const [result, items] = await Promise.all([
          getInventoryCategories(),
          // Supplier names already on items. Since the picker searches the
          // canonical Suppliers, these are only the SECONDARY choices — snapshot
          // values with no supplier record behind them, kept so nothing already
          // in use becomes unreachable.
          getInventoryItems().catch(() => []),
        ]);
        if (!isMounted) return;
        setCategories(result);
        setItems(Array.isArray(items) ? items : []);
        const uniqueSuppliers = new Map<string, string>();
        for (const item of items) {
          const normalized = normalizeInventoryText(item.supplierName);
          if (normalized) uniqueSuppliers.set(normalized.toLowerCase(), normalized);
        }
        setSupplierOptions(
          Array.from(uniqueSuppliers.values()).sort((a, b) => a.localeCompare(b, "he"))
        );
      } catch (err: unknown) {
        const message = getErrorMessage(err, t("customers.inventory.create.loadCategoriesFailed"));
        if (isMounted) setError(message === "UNAUTHORIZED" ? t("customers.inventory.common.noAuth") : message);
      }
    }, 0);
    return () => {
      isMounted = false;
      window.clearTimeout(timer);
    };
  }, [t]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] || null;
    setError(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (!file) {
      setSelectedFile(null);
      setPreviewUrl(null);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setSelectedFile(null);
      setPreviewUrl(null);
      setError(t("customers.inventory.create.imageOnly"));
      return;
    }
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  async function resolveCategoryId(): Promise<number | null> {
    const normalized = normalizeInventoryText(categoryName);
    if (!normalized) return null;
    const key = normalized.toLowerCase();
    const existing = categories.find((c) => inventoryTextKey(c.name) === key);
    if (existing) return existing.id;
    const created = await createInventoryCategory({ name: normalized });
    return created.id;
  }

  async function handleSubmit() {
    if (loading) return;

    const nextErrors: CreateFieldErrors = {};
    if (!name.trim()) nextErrors.name = t("customers.inventory.create.nameRequired");
    if (parsedInitialQuantity === null || parsedInitialQuantity < 0)
      nextErrors.initialQuantity = t("customers.inventory.create.initialQtyInvalid");
    if (parsedMinimumQuantity === null || parsedMinimumQuantity < 0)
      nextErrors.minimumQuantity = t("customers.inventory.create.minQtyInvalid");
    if (
      normalizedReorderPoint !== null &&
      parsedMinimumQuantity !== null &&
      normalizedReorderPoint < parsedMinimumQuantity
    )
      nextErrors.reorderPoint = t("customers.inventory.create.reorderBelowMin");

    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setError(null);
      return;
    }

    // Validated non-null above; narrow for the typed API call.
    const safeInitialQuantity = parsedInitialQuantity ?? 0;
    const safeMinimumQuantity = parsedMinimumQuantity ?? 0;

    setLoading(true);
    setError(null);
    try {
      const categoryId = await resolveCategoryId();
      const normalizedSupplier = normalizeInventoryText(supplierName);
      const createdItem = await createInventoryItem({
        name: name.trim(),
        barcode: barcode.trim() ? barcode.trim() : null,
        supplierName: normalizedSupplier ? normalizedSupplier : null,
        sku: sku.trim() ? sku.trim() : null,
        unitType,
        initialQuantity: safeInitialQuantity,
        minimumQuantity: safeMinimumQuantity,
        reorderPoint: normalizedReorderPoint,
        costPerUnit: normalizedCostPerUnit,
        sellPricePerUnit: normalizedSellPricePerUnit,
        categoryId,
        description: description.trim() ? description.trim() : null,
        featuredByOwner,
      });
      if (selectedFile) await uploadInventoryItemImage(createdItem.id, selectedFile);
      inventoryToast.success(t("customers.inventory.create.created"));
      router.push(`/inventory/items?q=${encodeURIComponent(createdItem.name)}`);
    } catch (err: unknown) {
      const message = getErrorMessage(err, t("customers.inventory.common.createItemFailed"));
      setError(message === "UNAUTHORIZED" ? t("customers.inventory.create.noAuthCreate") : message);
    } finally {
      setLoading(false);
    }
  }

  function handleScanDetected(code: string) {
    const scanned = code.trim();
    setScannerOpen(false);
    if (!scanned) return;
    const existing = items.find((it) => (it.barcode || "").trim() === scanned);
    if (existing) {
      // Duplicate barcode — don't autofill into a new product; surface the
      // existing item and offer to open it instead of creating a duplicate.
      setDuplicateItem(existing);
      return;
    }
    setDuplicateItem(null);
    setBarcode(scanned);
    inventoryToast.success(t("customers.inventory.create.barcodeAdded"));
  }

  return (
    <InventorySubPage intent="standard" title={t("customers.inventory.create.title")} backHref="/inventory/items" bottomNav="products">
      <div className="inv-desk-workspace inv-create-grid">
      <div className="inv-fwrap">
        <label
          className="inv-imgpick"
          style={{
            marginTop: 8,
            minHeight: 120,
            border: "1.5px dashed var(--inv-border)",
            borderRadius: "var(--inv-radius-md)",
            background: previewUrl ? "#000" : "var(--inv-surface)",
            color: "var(--inv-text-muted)",
            fontWeight: 600,
            fontSize: 14,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            cursor: "pointer",
            overflow: "hidden",
          }}
        >
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={handleFileChange} />
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="" style={{ width: "100%", height: 120, objectFit: "cover" }} />
          ) : (
            t("customers.inventory.create.addImage")
          )}
        </label>

        <div className="inv-field">
          <div className="inv-field__lab">{t("customers.inventory.common.productName")} <span>*</span></div>
          <input
            className={`inv-input${fieldErrors.name ? " inv-input--err" : ""}`}
            value={name}
            onChange={(e) => { setName(e.target.value); if (fieldErrors.name) setFieldErrors((f) => ({ ...f, name: undefined })); }}
            placeholder={t("customers.inventory.create.namePlaceholder")}
            aria-invalid={fieldErrors.name ? true : undefined}
          />
          {fieldErrors.name ? <div className="inv-field__err">{fieldErrors.name}</div> : null}
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">{t("customers.inventory.create.description")}</div>
          <textarea
            className="inv-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("customers.inventory.create.descriptionPlaceholder")}
            rows={3}
          />
        </div>

        <label className="inv-field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={featuredByOwner}
            onChange={(e) => setFeaturedByOwner(e.target.checked)}
          />
          <span>{t("customers.inventory.create.featured")}</span>
        </label>

        <div className="inv-field">
          <div className="inv-field__lab">{t("customers.inventory.common.category")}</div>
          <input className="inv-input" list="inv-categories" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder={t("customers.inventory.create.categoryPlaceholder")} />
          <datalist id="inv-categories">
            {categories.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">{t("customers.inventory.common.unitOfMeasure")}</div>
          <SegmentedControl value={unitType} onChange={setUnitType} options={unitOptions} />
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">{t("customers.inventory.create.supplier")}</div>
          {/* Searches the canonical Suppliers, and can create one without
              leaving this form. `supplierOptions` are the snapshot names already
              on items — kept as secondary choices so nothing already in use
              becomes unreachable. The item is still saved only by Save below. */}
          <SupplierField
            value={supplierName}
            onChange={setSupplierName}
            orphanNames={supplierOptions}
            idPrefix="inv-create-supplier"
          />
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">{t("customers.inventory.common.initialQuantity")}</div>
          <input
            className={`inv-input${fieldErrors.initialQuantity ? " inv-input--err" : ""}`}
            inputMode="numeric"
            value={initialQuantity}
            onChange={(e) => { setInitialQuantity(e.target.value); if (fieldErrors.initialQuantity) setFieldErrors((f) => ({ ...f, initialQuantity: undefined })); }}
            aria-invalid={fieldErrors.initialQuantity ? true : undefined}
          />
          {fieldErrors.initialQuantity ? <div className="inv-field__err">{fieldErrors.initialQuantity}</div> : null}
        </div>

        <div className="inv-two">
          <div className="inv-field">
            <div className="inv-field__lab">{t("customers.inventory.common.minThreshold")}</div>
            <input
              className={`inv-input${fieldErrors.minimumQuantity ? " inv-input--err" : ""}`}
              inputMode="numeric"
              value={minimumQuantity}
              onChange={(e) => { setMinimumQuantity(e.target.value); if (fieldErrors.minimumQuantity || fieldErrors.reorderPoint) setFieldErrors((f) => ({ ...f, minimumQuantity: undefined, reorderPoint: undefined })); }}
              placeholder="0"
              aria-invalid={fieldErrors.minimumQuantity ? true : undefined}
            />
            {fieldErrors.minimumQuantity ? <div className="inv-field__err">{fieldErrors.minimumQuantity}</div> : <div className="inv-field__help">{t("customers.inventory.create.minHelp")}</div>}
          </div>
          <div className="inv-field">
            <div className="inv-field__lab">{t("customers.inventory.common.reorderThreshold")}</div>
            <input
              className={`inv-input${fieldErrors.reorderPoint ? " inv-input--err" : ""}`}
              inputMode="numeric"
              value={reorderPoint}
              onChange={(e) => { setReorderPoint(e.target.value); if (fieldErrors.reorderPoint) setFieldErrors((f) => ({ ...f, reorderPoint: undefined })); }}
              placeholder="0"
              aria-invalid={fieldErrors.reorderPoint ? true : undefined}
            />
            {fieldErrors.reorderPoint ? <div className="inv-field__err">{fieldErrors.reorderPoint}</div> : <div className="inv-field__help">{t("customers.inventory.create.reorderHelp")}</div>}
          </div>
        </div>

        <div className="inv-two">
          <div className="inv-field">
            <div className="inv-field__lab">{t("customers.inventory.create.costPerUnit")}</div>
            <input className="inv-input" inputMode="decimal" value={costPerUnit} onChange={(e) => setCostPerUnit(e.target.value)} placeholder="₪0.00" />
          </div>
          <div className="inv-field">
            <div className="inv-field__lab">{t("customers.inventory.create.sellPrice")}</div>
            <input className="inv-input" inputMode="decimal" value={sellPricePerUnit} onChange={(e) => setSellPricePerUnit(e.target.value)} placeholder="₪0.00" />
          </div>
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">{t("customers.inventory.create.sku")}</div>
          <input className="inv-input" value={sku} onChange={(e) => setSku(e.target.value)} placeholder={t("customers.inventory.common.optional")} />
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">{t("customers.inventory.common.barcode")}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="inv-input"
              value={barcode}
              onChange={(e) => { setBarcode(e.target.value); if (duplicateItem) setDuplicateItem(null); }}
              placeholder={t("customers.inventory.create.barcodePlaceholder")}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              onClick={() => { setDuplicateItem(null); setScannerOpen(true); }}
              aria-label={t("customers.inventory.common.scanBarcode")}
              style={{
                flexShrink: 0,
                minWidth: 46,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "var(--inv-radius-md)",
                border: "1px solid var(--inv-border-hover)",
                background: "var(--inv-surface-2)",
                color: "var(--inv-accent)",
                cursor: "pointer",
              }}
            >
              <IconScan />
            </button>
          </div>
          {duplicateItem ? (
            <div
              className="inv-alert inv-alert--error"
              style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}
            >
              <span>{t("customers.inventory.create.duplicateExists")} <b>{duplicateItem.name}</b></span>
              <Link
                href={`/inventory/items/${duplicateItem.id}`}
                style={{ color: "var(--inv-accent)", fontWeight: 600, textDecoration: "none" }}
              >
                {t("customers.inventory.create.openExisting")}
              </Link>
            </div>
          ) : null}
        </div>

        {error ? <div className="inv-alert inv-alert--error" style={{ marginTop: 16 }}>{error}</div> : null}
      </div>
      <aside className="inv-ops__side">
        <h2>{name.trim() || t("customers.inventory.create.title")}</h2>
        <p>{categoryName.trim() || t("customers.inventory.create.noCategory")} · {unitOptions.find((option) => option.value === unitType)?.label ?? unitType}</p>
        <p>{t("customers.inventory.create.sideInitialQty", { quantity: initialQuantity || "0" })}{supplierName.trim() ? ` · ${t("customers.inventory.create.sideSupplier", { name: supplierName.trim() })}` : ""}</p>
        <p>{t("customers.inventory.create.sideNote")}</p>
      </aside>
      </div>

      <SaveBar label={loading ? t("customers.inventory.common.saving") : t("customers.inventory.create.save")} onClick={() => void handleSubmit()} disabled={loading} />

      <BarcodeScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleScanDetected}
        mode="single"
        title={t("customers.inventory.create.scannerTitle")}
        hint={t("customers.inventory.common.scanHint")}
      />
    </InventorySubPage>
  );
}
