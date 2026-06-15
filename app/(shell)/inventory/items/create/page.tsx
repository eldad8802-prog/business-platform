"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  createInventoryCategory,
  createInventoryItem,
  getInventoryCategories,
  type InventoryCategoryDTO,
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

const createItemCss = `
[data-create-inventory-item] {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.create-item-intro,
.create-item-section,
.create-item-state {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 20px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.04);
}

.create-item-intro,
.create-item-section,
.create-item-state {
  padding: 18px;
}

.create-item-kicker {
  margin-bottom: 8px;
  color: #2563eb;
  font-size: 0.78rem;
  font-weight: 900;
}

.create-item-intro h1,
.create-item-section h2 {
  margin: 0;
  color: #0f172a;
  font-weight: 900;
  line-height: 1.25;
}

.create-item-intro h1 {
  font-size: 1.35rem;
}

.create-item-section h2 {
  font-size: 1rem;
}

.create-item-intro p,
.create-item-section p {
  margin: 8px 0 0;
  color: #64748b;
  font-size: 0.9rem;
  line-height: 1.55;
}

.create-item-fields {
  display: grid;
  gap: 13px;
  margin-top: 16px;
}

.create-item-field {
  display: grid;
  gap: 7px;
}

.create-item-field span {
  color: #0f172a;
  font-size: 0.82rem;
  font-weight: 850;
}

.create-item-field small {
  color: #64748b;
  font-size: 0.76rem;
  line-height: 1.45;
}

.create-item-input {
  width: 100%;
  min-height: 48px;
  border: 1px solid #dbe3ef;
  border-radius: 14px;
  background: #ffffff;
  padding: 10px 12px;
  box-sizing: border-box;
  color: #0f172a;
  font: inherit;
}

.create-item-input:disabled {
  background: #f8fafc;
  color: #94a3b8;
}

.create-item-input:focus {
  outline: 3px solid rgba(37, 99, 235, 0.18);
  border-color: #93c5fd;
}

.create-item-number-grid {
  display: grid;
  gap: 12px;
}

.create-item-image-box {
  margin-top: 16px;
  min-height: 180px;
  border: 1px dashed #cbd5e1;
  border-radius: 18px;
  background: #f8fafc;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: #64748b;
}

.create-item-image-box img {
  width: 100%;
  max-height: 280px;
  object-fit: cover;
  display: block;
}

.create-item-upload-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 12px;
}

.create-item-file-button,
.create-item-remove-button,
.create-item-submit {
  min-height: 48px;
  border-radius: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #dbe3ef;
  background: #ffffff;
  color: #0f172a;
  font: inherit;
  font-weight: 900;
  cursor: pointer;
}

.create-item-file-button input {
  display: none;
}

.create-item-remove-button {
  width: 100%;
  margin-top: 10px;
  border-color: #fecaca;
  background: #fef2f2;
  color: #991b1b;
}

.create-item-submit {
  width: 100%;
  border: 0;
  background: #0f766e;
  color: #ffffff;
  box-shadow: 0 12px 24px rgba(15, 118, 110, 0.18);
}

.create-item-submit:disabled,
.create-item-file-button.is-disabled,
.create-item-remove-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.create-item-state {
  font-size: 0.86rem;
  line-height: 1.5;
}

.create-item-state--error {
  border-color: #fecaca;
  background: #fef2f2;
  color: #991b1b;
}

.create-item-state--success {
  border-color: #bbf7d0;
  background: #f0fdf4;
  color: #166534;
}

@media (min-width: 760px) {
  .create-item-number-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 360px) {
  .create-item-upload-actions {
    grid-template-columns: 1fr;
  }
}
`;

export default function CreateInventoryItemPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [supplierName, setSupplierName] = useState("");
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
      } catch (err: unknown) {
        if (isMounted) {
          const message = getErrorMessage(err, "שגיאה בטעינת קטגוריות");
          setError(message === "UNAUTHORIZED" ? "אין הרשאה לטעון קטגוריות. צריך להתחבר מחדש." : message);
        }
      } finally {
        if (isMounted) {
          setCategoriesLoading(false);
        }
      }
    }

    const timer = window.setTimeout(() => {
      void loadCategories();
    }, 0);

    return () => {
      isMounted = false;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] || null;

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
        (category) => category.name.trim().toLowerCase() === trimmedNewCategoryName.toLowerCase()
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

    if (parsedInitialQuantity === null || parsedInitialQuantity < 0 || !Number.isFinite(parsedInitialQuantity)) {
      setError("כמות התחלתית חייבת להיות 0 או יותר");
      return;
    }

    if (parsedMinimumQuantity === null || parsedMinimumQuantity < 0 || !Number.isFinite(parsedMinimumQuantity)) {
      setError("מינימום רצוי חייב להיות 0 או יותר");
      return;
    }

    if (
      reorderPoint.trim() &&
      (normalizedReorderPoint === null || normalizedReorderPoint < 0 || !Number.isFinite(normalizedReorderPoint))
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
        supplierName: supplierName.trim() ? supplierName.trim() : null,
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
    } catch (err: unknown) {
      const message = getErrorMessage(err, "שגיאה ביצירת הפריט");
      setError(message === "UNAUTHORIZED" ? "אין הרשאה ליצור פריט. צריך להתחבר מחדש." : message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <InventorySubPage title="הוספת פריט" backHref="/inventory/items" backLabel="כל הפריטים" bottomNav="products">
      <style>{createItemCss}</style>

      <div data-create-inventory-item>
        <section className="create-item-intro">
          <div className="create-item-kicker">מלאי · פריט חדש</div>
          <h1>יצירת פריט מלאי</h1>
          <p>ממלאים רק את מה שצריך כדי שהפריט יהיה ברור, מדיד וניתן לטיפול בהמשך.</p>
        </section>

        <section className="create-item-section">
          <h2>פרטים בסיסיים</h2>
          <p>שם הפריט הוא העוגן. שאר הפרטים עוזרים לזיהוי מהיר.</p>

          <div className="create-item-fields">
            <Field label="שם הפריט">
              <input
                className="create-item-input"
                type="text"
                value={name}
                disabled={loading}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                placeholder="שם הפריט"
              />
            </Field>

            <Field label="ברקוד" hint="לא חובה">
              <input
                className="create-item-input"
                type="text"
                value={barcode}
                disabled={loading}
                onChange={(event) => {
                  setBarcode(event.target.value);
                  setError(null);
                }}
                placeholder="ברקוד אם קיים"
              />
            </Field>

            <Field label="ספק" hint="לא חובה">
              <input
                className="create-item-input"
                type="text"
                value={supplierName}
                disabled={loading}
                onChange={(event) => {
                  setSupplierName(event.target.value);
                  setError(null);
                }}
                placeholder="שם ספק"
              />
            </Field>
          </div>
        </section>

        <section className="create-item-section">
          <h2>מלאי</h2>
          <p>הכמות והמינימום קובעים איך הפריט יופיע במסכי האמת של המלאי.</p>

          <div className="create-item-fields">
            <Field label="סוג יחידה">
              <select
                className="create-item-input"
                value={unitType}
                disabled={loading}
                onChange={(event) => {
                  setUnitType(event.target.value);
                  setError(null);
                }}
              >
                {UNIT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="create-item-number-grid">
              <Field label="כמות התחלתית">
                <input
                  className="create-item-input"
                  type="number"
                  min="0"
                  step="1"
                  value={initialQuantity}
                  disabled={loading}
                  onChange={(event) => {
                    setInitialQuantity(event.target.value);
                    setError(null);
                  }}
                />
              </Field>

              <Field label="מינימום רצוי">
                <input
                  className="create-item-input"
                  type="number"
                  min="0"
                  step="1"
                  value={minimumQuantity}
                  disabled={loading}
                  onChange={(event) => {
                    setMinimumQuantity(event.target.value);
                    setError(null);
                  }}
                />
              </Field>

              <Field label="נקודת הזמנה" hint="לא חובה">
                <input
                  className="create-item-input"
                  type="number"
                  min="0"
                  step="1"
                  value={reorderPoint}
                  disabled={loading}
                  onChange={(event) => {
                    setReorderPoint(event.target.value);
                    setError(null);
                  }}
                  placeholder="לא חובה"
                />
              </Field>
            </div>
          </div>
        </section>

        <section className="create-item-section">
          <h2>קטגוריה ותמונה</h2>
          <p>קטגוריה ותמונה עוזרות לזהות את הפריט מהר, אבל לא חוסמות שמירה.</p>

          <div className="create-item-fields">
            <Field label="קטגוריה קיימת">
              <select
                className="create-item-input"
                value={selectedCategoryId}
                disabled={loading || categoriesLoading || Boolean(newCategoryName.trim())}
                onChange={(event) => {
                  setSelectedCategoryId(event.target.value);
                  setError(null);
                }}
              >
                <option value="">{categoriesLoading ? "טוען קטגוריות..." : "ללא קטגוריה"}</option>
                {categories.map((category) => (
                  <option key={category.id} value={String(category.id)}>
                    {category.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="קטגוריה חדשה" hint="אם ממלאים כאן, היא תקבל עדיפות">
              <input
                className="create-item-input"
                type="text"
                value={newCategoryName}
                disabled={loading}
                onChange={(event) => {
                  setNewCategoryName(event.target.value);
                  setError(null);
                }}
                placeholder="שם קטגוריה חדשה"
              />
            </Field>
          </div>

          <div className="create-item-image-box">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="תצוגה מקדימה" />
            ) : (
              <div>
                <div style={{ fontSize: 28, marginBottom: 8 }}>+</div>
                <strong>הוסף תמונת פריט</strong>
                <div style={{ marginTop: 6, fontSize: 13 }}>צילום או בחירה מהגלריה</div>
              </div>
            )}
          </div>

          <div className="create-item-upload-actions">
            <FileButton label="בחירה מהגלריה" disabled={loading} onChange={handleFileChange} />
            <FileButton label="צילום פריט" disabled={loading} capture onChange={handleFileChange} />
          </div>

          {selectedFile ? (
            <>
              <div style={{ marginTop: 10, color: "#475569", fontSize: 13 }}>קובץ נבחר: {selectedFile.name}</div>
              <button type="button" className="create-item-remove-button" disabled={loading} onClick={clearImage}>
                הסרת תמונה
              </button>
            </>
          ) : null}
        </section>

        {error ? <div className="create-item-state create-item-state--error">{error}</div> : null}
        {successText ? <div className="create-item-state create-item-state--success">{successText}</div> : null}

        <section className="create-item-section">
          <h2>שמירה</h2>
          <p>לאחר השמירה הפריט יופיע ברשימת המלאי לפי מצב הכמות שהוגדרה.</p>
          <div style={{ marginTop: 16 }}>
            <button type="button" className="create-item-submit" disabled={loading} onClick={handleSubmit}>
              {loading ? "שומר פריט..." : "שמירת פריט"}
            </button>
          </div>
        </section>
      </div>
    </InventorySubPage>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="create-item-field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function FileButton({
  label,
  disabled,
  capture,
  onChange,
}: {
  label: string;
  disabled: boolean;
  capture?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className={`create-item-file-button${disabled ? " is-disabled" : ""}`}>
      {label}
      <input type="file" accept="image/*" capture={capture ? "environment" : undefined} disabled={disabled} onChange={onChange} />
    </label>
  );
}

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}
