"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/ui/page-header";
import {
  createInventoryCategory,
  createInventoryItem,
  getInventoryCategories,
  InventoryCategoryDTO,
  uploadInventoryItemImage,
} from "@/lib/api/inventory";

type UnitOption = {
  value: string;
  label: string;
};

const UNIT_OPTIONS: UnitOption[] = [
  { value: "UNIT", label: "יחידה" },
  { value: "ML", label: 'מ"ל' },
  { value: "GRAM", label: "גרם" },
  { value: "KG", label: "קילוגרם" },
  { value: "LITER", label: "ליטר" },
  { value: "BOX", label: "קופסה" },
];

export default function CreateInventoryItemPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [unitType, setUnitType] = useState("UNIT");
  const [initialQuantity, setInitialQuantity] = useState("0");
  const [minimumQuantity, setMinimumQuantity] = useState("0");
  const [reorderPoint, setReorderPoint] = useState("");

  const [categories, setCategories] = useState<InventoryCategoryDTO[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoriesLoading, setCategoriesLoading] = useState(false);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [successText, setSuccessText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsedInitialQuantity = useMemo(() => {
    const parsed = Number(initialQuantity);
    return Number.isNaN(parsed) ? null : parsed;
  }, [initialQuantity]);

  const parsedMinimumQuantity = useMemo(() => {
    const parsed = Number(minimumQuantity);
    return Number.isNaN(parsed) ? null : parsed;
  }, [minimumQuantity]);

  const normalizedReorderPoint = useMemo(() => {
    if (!reorderPoint.trim()) return null;

    const parsed = Number(reorderPoint);
    return Number.isNaN(parsed) ? null : parsed;
  }, [reorderPoint]);

  useEffect(() => {
    let isMounted = true;

    async function loadCategories() {
      setCategoriesLoading(true);

      try {
        const result = await getInventoryCategories();

        if (isMounted) {
          setCategories(result);
        }
      } catch (err: any) {
        if (isMounted) {
          if (err?.message === "UNAUTHORIZED") {
            setError("אין הרשאה לטעון קטגוריות. צריך להתחבר מחדש.");
          } else {
            setError(err?.message || "שגיאה בטעינת קטגוריות");
          }
        }
      } finally {
        if (isMounted) {
          setCategoriesLoading(false);
        }
      }
    }

    loadCategories();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] || null;

    setError(null);
    setSuccessText(null);

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

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

  function clearImage() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    setSelectedFile(null);
    setPreviewUrl(null);
    setError(null);
    setSuccessText(null);
  }

  async function resolveCategoryId(): Promise<number | null> {
    const trimmedNewCategoryName = newCategoryName.trim();

    if (trimmedNewCategoryName) {
      const existingCategory = categories.find(
        (category) =>
          category.name.trim().toLowerCase() ===
          trimmedNewCategoryName.toLowerCase()
      );

      if (existingCategory) {
        return existingCategory.id;
      }

      const createdCategory = await createInventoryCategory({
        name: trimmedNewCategoryName,
      });

      return createdCategory.id;
    }

    if (!selectedCategoryId) {
      return null;
    }

    const parsedCategoryId = Number(selectedCategoryId);
    return Number.isFinite(parsedCategoryId) ? parsedCategoryId : null;
  }

  async function handleSubmit() {
    if (loading) return;

    if (!name.trim()) {
      setError("צריך להזין שם פריט");
      return;
    }

    if (
      parsedInitialQuantity === null ||
      parsedInitialQuantity < 0 ||
      !Number.isFinite(parsedInitialQuantity)
    ) {
      setError("כמות התחלתית חייבת להיות 0 או יותר");
      return;
    }

    if (
      parsedMinimumQuantity === null ||
      parsedMinimumQuantity < 0 ||
      !Number.isFinite(parsedMinimumQuantity)
    ) {
      setError("מינימום רצוי חייב להיות 0 או יותר");
      return;
    }

    if (
      reorderPoint.trim() &&
      (normalizedReorderPoint === null ||
        normalizedReorderPoint < 0 ||
        !Number.isFinite(normalizedReorderPoint))
    ) {
      setError("נקודת הזמנה חייבת להיות מספר תקין");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessText(null);

    try {
      const categoryId = await resolveCategoryId();

      const createdItem = await createInventoryItem({
        name: name.trim(),
        barcode: barcode.trim() ? barcode.trim() : null,
        unitType,
        initialQuantity: parsedInitialQuantity,
        minimumQuantity: parsedMinimumQuantity,
        reorderPoint: normalizedReorderPoint,
        categoryId,
      });

      if (selectedFile) {
        setSuccessText("הפריט נוצר, מעלה תמונה...");
        await uploadInventoryItemImage(createdItem.id, selectedFile);
      }

      setSuccessText("הפריט נשמר בהצלחה");
      router.push("/inventory");
    } catch (err: any) {
      if (err?.message === "UNAUTHORIZED") {
        setError("אין הרשאה ליצור פריט. צריך להתחבר מחדש.");
      } else {
        setError(err?.message || "שגיאה ביצירת הפריט");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <PageHeader title="הוספת פריט" />

      <main
        style={{
          maxWidth: "720px",
          margin: "0 auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "22px",
            background: "#ffffff",
            padding: "18px",
            boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
          }}
        >
          <h1
            style={{
              fontSize: "20px",
              fontWeight: 800,
              color: "#111827",
              margin: 0,
              marginBottom: "6px",
            }}
          >
            יצירת פריט מלאי חדש
          </h1>

          <p
            style={{
              fontSize: "14px",
              lineHeight: 1.6,
              color: "#6b7280",
              margin: 0,
            }}
          >
            הפריט ייכנס למלאי עם כמות התחלתית מסודרת, וכל שינוי עתידי יתועד
            דרך תנועות מלאי.
          </p>
        </section>

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "18px",
            background: "#ffffff",
            padding: "18px",
            boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
          }}
        >
          <div
            style={{
              fontSize: "16px",
              fontWeight: 800,
              color: "#111827",
            }}
          >
            פרטי הפריט
          </div>

          <div>
            <label
              htmlFor="inventory-item-name"
              style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "13px",
                fontWeight: 700,
                color: "#111827",
              }}
            >
              שם הפריט
            </label>

            <input
              id="inventory-item-name"
              type="text"
              value={name}
              disabled={loading}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="למשל: שמפו קרטין"
              style={{
                width: "100%",
                minHeight: "46px",
                padding: "10px 12px",
                borderRadius: "12px",
                border: "1px solid #d1d5db",
                fontSize: "14px",
                background: loading ? "#f9fafb" : "#ffffff",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div>
            <label
              htmlFor="inventory-item-barcode"
              style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "13px",
                fontWeight: 700,
                color: "#111827",
              }}
            >
              ברקוד
            </label>

            <input
              id="inventory-item-barcode"
              type="text"
              value={barcode}
              disabled={loading}
              onChange={(e) => {
                setBarcode(e.target.value);
                setError(null);
              }}
              placeholder="לא חובה"
              style={{
                width: "100%",
                minHeight: "46px",
                padding: "10px 12px",
                borderRadius: "12px",
                border: "1px solid #d1d5db",
                fontSize: "14px",
                background: loading ? "#f9fafb" : "#ffffff",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div>
            <label
              htmlFor="inventory-item-category"
              style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "13px",
                fontWeight: 700,
                color: "#111827",
              }}
            >
              קטגוריה קיימת
            </label>

            <select
              id="inventory-item-category"
              value={selectedCategoryId}
              disabled={loading || categoriesLoading || !!newCategoryName.trim()}
              onChange={(e) => {
                setSelectedCategoryId(e.target.value);
                setError(null);
              }}
              style={{
                width: "100%",
                minHeight: "46px",
                padding: "10px 12px",
                borderRadius: "12px",
                border: "1px solid #d1d5db",
                fontSize: "14px",
                background:
                  loading || categoriesLoading || !!newCategoryName.trim()
                    ? "#f9fafb"
                    : "#ffffff",
                boxSizing: "border-box",
              }}
            >
              <option value="">
                {categoriesLoading ? "טוען קטגוריות..." : "ללא קטגוריה"}
              </option>

              {categories.map((category) => (
                <option key={category.id} value={String(category.id)}>
                  {category.name}
                </option>
              ))}
            </select>

            <div
              style={{
                marginTop: "8px",
                fontSize: "12px",
                color: "#6b7280",
                lineHeight: 1.5,
              }}
            >
              אם ממלאים קטגוריה חדשה למטה, היא תקבל עדיפות על הבחירה הקיימת.
            </div>
          </div>

          <div>
            <label
              htmlFor="inventory-item-new-category"
              style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "13px",
                fontWeight: 700,
                color: "#111827",
              }}
            >
              יצירת קטגוריה חדשה
            </label>

            <input
              id="inventory-item-new-category"
              type="text"
              value={newCategoryName}
              disabled={loading}
              onChange={(e) => {
                setNewCategoryName(e.target.value);
                setError(null);
              }}
              placeholder="למשל: מוצרי שיער"
              style={{
                width: "100%",
                minHeight: "46px",
                padding: "10px 12px",
                borderRadius: "12px",
                border: "1px solid #d1d5db",
                fontSize: "14px",
                background: loading ? "#f9fafb" : "#ffffff",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div>
            <label
              htmlFor="inventory-item-unit-type"
              style={{
                display: "block",
                marginBottom: "6px",
                fontSize: "13px",
                fontWeight: 700,
                color: "#111827",
              }}
            >
              סוג יחידה
            </label>

            <select
              id="inventory-item-unit-type"
              value={unitType}
              disabled={loading}
              onChange={(e) => {
                setUnitType(e.target.value);
                setError(null);
              }}
              style={{
                width: "100%",
                minHeight: "46px",
                padding: "10px 12px",
                borderRadius: "12px",
                border: "1px solid #d1d5db",
                fontSize: "14px",
                background: loading ? "#f9fafb" : "#ffffff",
                boxSizing: "border-box",
              }}
            >
              {UNIT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: "14px",
            }}
          >
            <div>
              <label
                htmlFor="inventory-item-initial-quantity"
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontSize: "13px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                כמות התחלתית
              </label>

              <input
                id="inventory-item-initial-quantity"
                type="number"
                min="0"
                step="1"
                value={initialQuantity}
                disabled={loading}
                onChange={(e) => {
                  setInitialQuantity(e.target.value);
                  setError(null);
                }}
                style={{
                  width: "100%",
                  minHeight: "46px",
                  padding: "10px 12px",
                  borderRadius: "12px",
                  border: "1px solid #d1d5db",
                  fontSize: "14px",
                  background: loading ? "#f9fafb" : "#ffffff",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div>
              <label
                htmlFor="inventory-item-minimum-quantity"
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontSize: "13px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                מינימום רצוי
              </label>

              <input
                id="inventory-item-minimum-quantity"
                type="number"
                min="0"
                step="1"
                value={minimumQuantity}
                disabled={loading}
                onChange={(e) => {
                  setMinimumQuantity(e.target.value);
                  setError(null);
                }}
                style={{
                  width: "100%",
                  minHeight: "46px",
                  padding: "10px 12px",
                  borderRadius: "12px",
                  border: "1px solid #d1d5db",
                  fontSize: "14px",
                  background: loading ? "#f9fafb" : "#ffffff",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div>
              <label
                htmlFor="inventory-item-reorder-point"
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontSize: "13px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                נקודת הזמנה
              </label>

              <input
                id="inventory-item-reorder-point"
                type="number"
                min="0"
                step="1"
                value={reorderPoint}
                disabled={loading}
                onChange={(e) => {
                  setReorderPoint(e.target.value);
                  setError(null);
                }}
                placeholder="לא חובה"
                style={{
                  width: "100%",
                  minHeight: "46px",
                  padding: "10px 12px",
                  borderRadius: "12px",
                  border: "1px solid #d1d5db",
                  fontSize: "14px",
                  background: loading ? "#f9fafb" : "#ffffff",
                  boxSizing: "border-box",
                }}
              />
            </div>
          </div>
        </section>

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "18px",
            background: "#ffffff",
            padding: "18px",
            boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "16px",
                fontWeight: 800,
                color: "#111827",
                marginBottom: "4px",
              }}
            >
              תמונת פריט
            </div>

            <div
              style={{
                fontSize: "13px",
                color: "#6b7280",
                lineHeight: 1.5,
              }}
            >
              לא חובה, אבל תמונה עוזרת לזהות פריטים מהר יותר.
            </div>
          </div>

          <div
            style={{
              width: "100%",
              minHeight: "220px",
              borderRadius: "16px",
              border: "1px dashed #d1d5db",
              background: "#f9fafb",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="תצוגה מקדימה"
                style={{
                  width: "100%",
                  maxHeight: "320px",
                  objectFit: "cover",
                  display: "block",
                }}
              />
            ) : (
              <div
                style={{
                  color: "#6b7280",
                  fontSize: "14px",
                  textAlign: "center",
                  padding: "20px",
                  lineHeight: 1.6,
                }}
              >
                <div style={{ fontSize: "30px", marginBottom: "8px" }}>📦</div>
                עדיין לא נבחרה תמונה
              </div>
            )}
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "10px",
            }}
          >
            <label
              style={{
                minHeight: "44px",
                padding: "10px 14px",
                borderRadius: "12px",
                border: "1px solid #d1d5db",
                background: loading ? "#f9fafb" : "#ffffff",
                cursor: loading ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "14px",
                fontWeight: 700,
                color: "#111827",
                opacity: loading ? 0.6 : 1,
              }}
            >
              בחירה מהגלריה
              <input
                type="file"
                accept="image/*"
                disabled={loading}
                onChange={handleFileChange}
                style={{ display: "none" }}
              />
            </label>

            <label
              style={{
                minHeight: "44px",
                padding: "10px 14px",
                borderRadius: "12px",
                border: "1px solid #d1d5db",
                background: loading ? "#f9fafb" : "#ffffff",
                cursor: loading ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "14px",
                fontWeight: 700,
                color: "#111827",
                opacity: loading ? 0.6 : 1,
              }}
            >
              צילום פריט
              <input
                type="file"
                accept="image/*"
                capture="environment"
                disabled={loading}
                onChange={handleFileChange}
                style={{ display: "none" }}
              />
            </label>

            {selectedFile && (
              <button
                type="button"
                onClick={clearImage}
                disabled={loading}
                style={{
                  minHeight: "44px",
                  padding: "10px 14px",
                  borderRadius: "12px",
                  border: "1px solid #fecaca",
                  background: "#fef2f2",
                  color: "#991b1b",
                  cursor: loading ? "not-allowed" : "pointer",
                  fontSize: "14px",
                  fontWeight: 700,
                  opacity: loading ? 0.6 : 1,
                }}
              >
                הסרת תמונה
              </button>
            )}
          </div>

          {selectedFile && (
            <div
              style={{
                fontSize: "13px",
                color: "#374151",
                lineHeight: 1.5,
              }}
            >
              קובץ נבחר: {selectedFile.name}
            </div>
          )}
        </section>

        {error && (
          <div
            style={{
              color: "#b91c1c",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: "14px",
              padding: "12px 14px",
              fontSize: "13px",
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        )}

        {successText && (
          <div
            style={{
              color: "#166534",
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              borderRadius: "14px",
              padding: "12px 14px",
              fontSize: "13px",
              lineHeight: 1.5,
            }}
          >
            {successText}
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={loading}
          style={{
            width: "100%",
            minHeight: "50px",
            padding: "12px 16px",
            borderRadius: "15px",
            background: "#111827",
            color: "#ffffff",
            border: "none",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.75 : 1,
            fontSize: "15px",
            fontWeight: 800,
            boxShadow: "0 8px 20px rgba(17, 24, 39, 0.12)",
          }}
        >
          {loading ? "שומר/ת פריט..." : "שמירת פריט"}
        </button>
      </main>
    </div>
  );
}