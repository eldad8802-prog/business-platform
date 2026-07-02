"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import { SegmentedControl, SaveBar } from "@/components/inventory/inventory-design";
import {
  createInventoryCategory,
  createInventoryItem,
  getInventoryCategories,
  getInventoryItems,
  uploadInventoryItemImage,
  type InventoryCategoryDTO,
} from "@/lib/api/inventory";
import { inventoryTextKey, normalizeInventoryText } from "@/lib/inventory/normalize";
import { inventoryToast } from "@/components/inventory/inventory-toast";
import { getAccessibleFieldProps, focusFirstInvalidField } from "@/components/ui/accessible-field";

type CreateFieldErrors = Partial<
  Record<"name" | "initialQuantity" | "minimumQuantity" | "reorderPoint", string>
>;

const UNIT_OPTIONS = [
  { value: "UNIT", label: "יחידה" },
  { value: "KG", label: "ק״ג" },
  { value: "GRAM", label: "גרם" },
  { value: "LITER", label: "ליטר" },
  { value: "ML", label: "מ״ל" },
  { value: "BOX", label: "מארז" },
];

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

export default function CreateInventoryItemPage() {
  const router = useRouter();
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
  const [categories, setCategories] = useState<InventoryCategoryDTO[]>([]);
  const [categoryName, setCategoryName] = useState("");
  const [supplierOptions, setSupplierOptions] = useState<string[]>([]);
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
          // Existing supplier names power the autocomplete so the same supplier
          // is reused instead of re-typed into a near-duplicate. (audit P1 #5)
          getInventoryItems().catch(() => []),
        ]);
        if (!isMounted) return;
        setCategories(result);
        const uniqueSuppliers = new Map<string, string>();
        for (const item of items) {
          const normalized = normalizeInventoryText(item.supplierName);
          if (normalized) uniqueSuppliers.set(normalized.toLowerCase(), normalized);
        }
        setSupplierOptions(
          Array.from(uniqueSuppliers.values()).sort((a, b) => a.localeCompare(b, "he"))
        );
      } catch (err: unknown) {
        const message = getErrorMessage(err, "שגיאה בטעינת קטגוריות");
        if (isMounted) setError(message === "UNAUTHORIZED" ? "אין הרשאה. צריך להתחבר מחדש." : message);
      }
    }, 0);
    return () => {
      isMounted = false;
      window.clearTimeout(timer);
    };
  }, []);

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
      setError("אפשר להעלות קובץ תמונה בלבד");
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
    if (!name.trim()) nextErrors.name = "צריך להזין שם מוצר";
    if (parsedInitialQuantity === null || parsedInitialQuantity < 0)
      nextErrors.initialQuantity = "כמות התחלתית חייבת להיות 0 או יותר";
    if (parsedMinimumQuantity === null || parsedMinimumQuantity < 0)
      nextErrors.minimumQuantity = "סף מינימום חייב להיות 0 או יותר";
    if (
      normalizedReorderPoint !== null &&
      parsedMinimumQuantity !== null &&
      normalizedReorderPoint < parsedMinimumQuantity
    )
      nextErrors.reorderPoint = "סף ההזמנה חייב להיות שווה או גבוה מהסף הקריטי";

    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setError(null);
      // WP1 A-15: move focus to the first invalid field on submit failure.
      focusFirstInvalidField();
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
      });
      if (selectedFile) await uploadInventoryItemImage(createdItem.id, selectedFile);
      inventoryToast.success("המוצר נוסף למלאי");
      router.push(`/inventory/items?q=${encodeURIComponent(createdItem.name)}`);
    } catch (err: unknown) {
      const message = getErrorMessage(err, "שגיאה ביצירת המוצר");
      setError(message === "UNAUTHORIZED" ? "אין הרשאה ליצור מוצר. צריך להתחבר מחדש." : message);
    } finally {
      setLoading(false);
    }
  }

  const nameField = getAccessibleFieldProps({
    id: "inv-create-name",
    error: fieldErrors.name,
    required: true,
  });

  return (
    <InventorySubPage title="מוצר חדש" backHref="/inventory/items" bottomNav="products">
      <div className="inv-fwrap">
        <label
          className="inv-imgpick"
          style={{
            marginTop: 8,
            minHeight: 120,
            border: "1.5px dashed var(--inv-border)",
            borderRadius: "var(--inv-radius-md)",
            background: previewUrl ? "#000" : "var(--inv-surface, #f5f7f9)",
            color: "var(--inv-text-muted)",
            fontWeight: 700,
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
            "הוספת תמונת מוצר"
          )}
        </label>

        <div className="inv-field">
          <div className="inv-field__lab" {...nameField.labelProps}>שם המוצר <span>*</span></div>
          <input
            className={`inv-input${fieldErrors.name ? " inv-input--err" : ""}`}
            value={name}
            onChange={(e) => { setName(e.target.value); if (fieldErrors.name) setFieldErrors((f) => ({ ...f, name: undefined })); }}
            placeholder="לדוגמה: חלב 3% תנובה"
            {...nameField.controlProps}
          />
          {fieldErrors.name ? <div className="inv-field__err" {...nameField.errorProps}>{fieldErrors.name}</div> : null}
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">קטגוריה</div>
          <input className="inv-input" list="inv-categories" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder="בחר או צור קטגוריה" />
          <datalist id="inv-categories">
            {categories.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">יחידת מידה</div>
          <SegmentedControl value={unitType} onChange={setUnitType} options={UNIT_OPTIONS} />
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">ספק</div>
          <input className="inv-input" list="inv-suppliers" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} placeholder="בחר או הקלד שם ספק" />
          <datalist id="inv-suppliers">
            {supplierOptions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">כמות התחלתית</div>
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
            <div className="inv-field__lab">סף מינימום</div>
            <input
              className={`inv-input${fieldErrors.minimumQuantity ? " inv-input--err" : ""}`}
              inputMode="numeric"
              value={minimumQuantity}
              onChange={(e) => { setMinimumQuantity(e.target.value); if (fieldErrors.minimumQuantity || fieldErrors.reorderPoint) setFieldErrors((f) => ({ ...f, minimumQuantity: undefined, reorderPoint: undefined })); }}
              placeholder="0"
              aria-invalid={fieldErrors.minimumQuantity ? true : undefined}
            />
            {fieldErrors.minimumQuantity ? <div className="inv-field__err">{fieldErrors.minimumQuantity}</div> : <div className="inv-field__help">בסף זה או מתחתיו — מלאי קריטי (אדום)</div>}
          </div>
          <div className="inv-field">
            <div className="inv-field__lab">סף הזמנה מחדש</div>
            <input
              className={`inv-input${fieldErrors.reorderPoint ? " inv-input--err" : ""}`}
              inputMode="numeric"
              value={reorderPoint}
              onChange={(e) => { setReorderPoint(e.target.value); if (fieldErrors.reorderPoint) setFieldErrors((f) => ({ ...f, reorderPoint: undefined })); }}
              placeholder="0"
              aria-invalid={fieldErrors.reorderPoint ? true : undefined}
            />
            {fieldErrors.reorderPoint ? <div className="inv-field__err">{fieldErrors.reorderPoint}</div> : <div className="inv-field__help">בסף זה או מתחתיו — מלאי נמוך (כתום)</div>}
          </div>
        </div>

        <div className="inv-two">
          <div className="inv-field">
            <div className="inv-field__lab">עלות ליחידה</div>
            <input className="inv-input" inputMode="decimal" value={costPerUnit} onChange={(e) => setCostPerUnit(e.target.value)} placeholder="₪0.00" />
          </div>
          <div className="inv-field">
            <div className="inv-field__lab">מחיר מכירה</div>
            <input className="inv-input" inputMode="decimal" value={sellPricePerUnit} onChange={(e) => setSellPricePerUnit(e.target.value)} placeholder="₪0.00" />
          </div>
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">מק״ט</div>
          <input className="inv-input" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="אופציונלי" />
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">ברקוד</div>
          <input className="inv-input" value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="סרוק או הקלד" />
        </div>

        {error ? <div className="inv-alert inv-alert--error" style={{ marginTop: 16 }}>{error}</div> : null}
      </div>

      <SaveBar label={loading ? "שומר…" : "שמירת מוצר"} onClick={() => void handleSubmit()} disabled={loading} />
    </InventorySubPage>
  );
}
