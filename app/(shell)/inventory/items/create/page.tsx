"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import { SegmentedControl, SaveBar } from "@/components/inventory/inventory-design";
import {
  createInventoryCategory,
  createInventoryItem,
  getInventoryCategories,
  uploadInventoryItemImage,
  type InventoryCategoryDTO,
} from "@/lib/api/inventory";

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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const result = await getInventoryCategories();
        if (isMounted) setCategories(result);
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
    const trimmed = categoryName.trim();
    if (!trimmed) return null;
    const existing = categories.find((c) => c.name.trim().toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing.id;
    const created = await createInventoryCategory({ name: trimmed });
    return created.id;
  }

  async function handleSubmit() {
    if (loading) return;
    if (!name.trim()) return setError("צריך להזין שם מוצר");
    if (parsedInitialQuantity === null || parsedInitialQuantity < 0) return setError("כמות התחלתית חייבת להיות 0 או יותר");
    if (parsedMinimumQuantity === null || parsedMinimumQuantity < 0) return setError("סף מינימום חייב להיות 0 או יותר");

    setLoading(true);
    setError(null);
    try {
      const categoryId = await resolveCategoryId();
      const createdItem = await createInventoryItem({
        name: name.trim(),
        barcode: barcode.trim() ? barcode.trim() : null,
        supplierName: supplierName.trim() ? supplierName.trim() : null,
        sku: sku.trim() ? sku.trim() : null,
        unitType,
        initialQuantity: parsedInitialQuantity,
        minimumQuantity: parsedMinimumQuantity,
        reorderPoint: normalizedReorderPoint,
        costPerUnit: normalizedCostPerUnit,
        sellPricePerUnit: normalizedSellPricePerUnit,
        categoryId,
      });
      if (selectedFile) await uploadInventoryItemImage(createdItem.id, selectedFile);
      router.push(`/inventory/items?q=${encodeURIComponent(createdItem.name)}`);
    } catch (err: unknown) {
      const message = getErrorMessage(err, "שגיאה ביצירת המוצר");
      setError(message === "UNAUTHORIZED" ? "אין הרשאה ליצור מוצר. צריך להתחבר מחדש." : message);
    } finally {
      setLoading(false);
    }
  }

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
          <div className="inv-field__lab">שם המוצר <span>*</span></div>
          <input className="inv-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: חלב 3% תנובה" />
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
          <input className="inv-input" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} placeholder="שם הספק" />
        </div>

        <div className="inv-field">
          <div className="inv-field__lab">כמות התחלתית</div>
          <input className="inv-input" inputMode="numeric" value={initialQuantity} onChange={(e) => setInitialQuantity(e.target.value)} />
        </div>

        <div className="inv-two">
          <div className="inv-field">
            <div className="inv-field__lab">סף מינימום</div>
            <input className="inv-input" inputMode="numeric" value={minimumQuantity} onChange={(e) => setMinimumQuantity(e.target.value)} placeholder="0" />
            <div className="inv-field__help">מתחת לזה — מלאי קריטי (אדום)</div>
          </div>
          <div className="inv-field">
            <div className="inv-field__lab">סף הזמנה מחדש</div>
            <input className="inv-input" inputMode="numeric" value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} placeholder="0" />
            <div className="inv-field__help">מתחת לזה — מלאי נמוך (כתום)</div>
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
