"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  inventoryCardStyle,
  InventorySubheader,
  inventoryMainStyle,
  inventoryPageStyle,
  inventoryFieldStyle,
  orderPipelineCss,
  inventoryTheme,
} from "@/components/inventory/inventory-design";
import {
  getInventoryCategories,
  getInventoryItems,
  InventoryCategoryDTO,
} from "@/lib/api/inventory";

type Item = {
  id: number;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  unitType: string;
  supplierName?: string | null;
  currentQuantity: number;
  minimumQuantity: number;
  reorderPoint: number | null;
  categoryId?: number | null;
  imageUrl?: string | null;
};

type ReorderSuggestion = {
  itemId: number;
  name: string;
  currentQuantity: number;
  minimumQuantity: number;
  reorderPoint: number | null;
  suggestedOrderQuantity: number;
};

type LocalSupplierPurchaseDraftV1 = {
  version: 1;
  savedAt: string;
  supplierName: string;
  order: Record<number, number>;
  categoryId: string;
  itemId: string;
  quantity: string;
};

const LOCAL_DRAFT_KEY = "inventory:supplierPurchases:newDraft:v1";

function isValidImageUrl(imageUrl?: string | null) {
  if (!imageUrl) return false;
  if (imageUrl.includes("example.com")) return false;
  return true;
}

function ItemThumb({
  name,
  imageUrl,
  size = 40,
}: {
  name: string;
  imageUrl?: string | null;
  size?: number;
}) {
  if (isValidImageUrl(imageUrl)) {
    return (
      <img
        src={imageUrl || ""}
        alt=""
        style={{
          width: size,
          height: size,
          borderRadius: 10,
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        background: "#f1f5f9",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.4,
        flexShrink: 0,
      }}
    >
      📦
    </div>
  );
}

function extractCreatedDraftId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const nestedDraft =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>).draft
      : undefined;
  const draft = root.draft ?? nestedDraft;
  if (!draft || typeof draft !== "object") return null;
  const raw = (draft as Record<string, unknown>).id;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function buildHeaders() {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export default function NewSupplierPurchasePage() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [categories, setCategories] = useState<InventoryCategoryDTO[]>([]);
  const [suggestions, setSuggestions] = useState<ReorderSuggestion[]>([]);
  const [order, setOrder] = useState<Record<number, number>>({});

  const [supplierName, setSupplierName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [productSearch, setProductSearch] = useState("");

  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [hasLocalDraft, setHasLocalDraft] = useState(false);
  const [showExitGuard, setShowExitGuard] = useState(false);

  const exitIntentRef = useRef<null | { type: "BACK" }>(null);
  const allowNextExitRef = useRef(false);

  const hasUnsavedWork = useMemo(() => {
    const hasOrder = Object.keys(order).length > 0;
    const hasSupplierName = Boolean(supplierName.trim());
    const hasInProgressSelection =
      Boolean(categoryId) ||
      Boolean(itemId) ||
      (quantity.trim() !== "" && quantity.trim() !== "1");

    return hasSupplierName || hasOrder || hasInProgressSelection;
  }, [supplierName, order, categoryId, itemId, quantity]);

  function readLocalDraft(): LocalSupplierPurchaseDraftV1 | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(LOCAL_DRAFT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as LocalSupplierPurchaseDraftV1;
      if (!parsed || parsed.version !== 1) return null;
      if (typeof parsed.supplierName !== "string") return null;
      if (!parsed.order || typeof parsed.order !== "object") return null;
      if (typeof parsed.categoryId !== "string") return null;
      if (typeof parsed.itemId !== "string") return null;
      if (typeof parsed.quantity !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeLocalDraft() {
    if (typeof window === "undefined") return;
    const draft: LocalSupplierPurchaseDraftV1 = {
      version: 1,
      savedAt: new Date().toISOString(),
      supplierName,
      order,
      categoryId,
      itemId,
      quantity,
    };
    localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(draft));
    setHasLocalDraft(true);
  }

  function clearLocalDraft() {
    if (typeof window === "undefined") return;
    localStorage.removeItem(LOCAL_DRAFT_KEY);
    setHasLocalDraft(false);
  }

  function restoreLocalDraft() {
    const draft = readLocalDraft();
    if (!draft) return;
    setSupplierName(draft.supplierName || "");
    setOrder(draft.order || {});
    setCategoryId(draft.categoryId || "");
    setItemId(draft.itemId || "");
    setQuantity(draft.quantity || "1");
    setError(null);
    setSuccess("המשכנו הזמנה שנשמרה מקומית.");
  }

  async function load() {
    try {
      setLoading(true);
      setError(null);

      const [itemsData, categoriesData, suggestionsResponse] =
        await Promise.all([
          getInventoryItems(),
          getInventoryCategories(),
          fetch("/api/inventory/reorder-suggestions", {
            method: "GET",
            headers: buildHeaders(),
            cache: "no-store",
          }),
        ]);

      const suggestionsData = await suggestionsResponse.json();

      if (!suggestionsResponse.ok) {
        throw new Error(
          suggestionsData?.error || "לא הצלחנו לטעון המלצות להזמנה"
        );
      }

      const normalizedItems = Array.isArray(itemsData) ? itemsData : [];
      const normalizedSuggestions = Array.isArray(suggestionsData?.suggestions)
        ? suggestionsData.suggestions
        : [];

      const defaults: Record<number, number> = {};

      normalizedSuggestions.forEach((suggestion: ReorderSuggestion) => {
        if (Number(suggestion.suggestedOrderQuantity) > 0) {
          defaults[suggestion.itemId] = Number(
            suggestion.suggestedOrderQuantity
          );
        }
      });

      setItems(normalizedItems);
      setCategories(Array.isArray(categoriesData) ? categoriesData : []);
      setSuggestions(normalizedSuggestions);
      setOrder(defaults);
    } catch (err: any) {
      setError(err?.message || "שגיאה בטעינת יצירת ההזמנה");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const existing = readLocalDraft();
    setHasLocalDraft(Boolean(existing));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!hasUnsavedWork) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      // We only block for refresh/close; route transitions are handled separately.
      event.preventDefault();
      // Chrome requires returnValue to be set.
      event.returnValue = "";
      return "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedWork]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Minimal back navigation guard without touching routing: use history popstate.
    // Strategy: add a "sentinel" history entry. When user goes back, we immediately
    // re-push it and show a modal. If user confirms exit, we allow back once.
    window.history.pushState({ __inventorySupplierNewGuard: true }, "", window.location.href);

    const handlePopState = () => {
      if (allowNextExitRef.current) {
        allowNextExitRef.current = false;
        return;
      }

      if (!hasUnsavedWork) {
        allowNextExitRef.current = true;
        window.history.back();
        return;
      }

      // Stay on the page and show a guard.
      window.history.pushState(
        { __inventorySupplierNewGuard: true },
        "",
        window.location.href
      );
      exitIntentRef.current = { type: "BACK" };
      setShowExitGuard(true);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [hasUnsavedWork]);

  const selectedItems = useMemo(() => {
    return items.filter((item) => Number(order[item.id] || 0) > 0);
  }, [items, order]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const selectedSupplier = supplierName.trim();
      if (selectedSupplier) {
        if (
          (item.supplierName || "").trim().toLowerCase() !==
          selectedSupplier.toLowerCase()
        ) {
          return false;
        }
      }
      if (!categoryId) return true;
      return item.categoryId === Number(categoryId);
    });
  }, [items, categoryId, supplierName]);

  const browsableItems = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return filteredItems.slice(0, 8);
    return filteredItems
      .filter((item) => item.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [filteredItems, productSearch]);

  const supplierOptions = useMemo(() => {
    const unique = new Set<string>();
    for (const item of items) {
      const value = typeof item.supplierName === "string" ? item.supplierName.trim() : "";
      if (!value) continue;
      unique.add(value);
    }

    return Array.from(unique).sort((a, b) => a.localeCompare(b, "he"));
  }, [items]);

  const filteredCategories = useMemo(() => {
    const selectedSupplier = supplierName.trim();
    if (!selectedSupplier) {
      return categories.slice().sort((a, b) => a.name.localeCompare(b.name, "he"));
    }

    const categoryIds = new Set<number>();
    for (const item of items) {
      const itemSupplier = typeof item.supplierName === "string" ? item.supplierName.trim() : "";
      if (!itemSupplier) continue;
      if (itemSupplier.toLowerCase() !== selectedSupplier.toLowerCase()) continue;
      if (typeof item.categoryId === "number" && Number.isFinite(item.categoryId)) {
        categoryIds.add(item.categoryId);
      }
    }

    return categories
      .filter((category) => categoryIds.has(category.id))
      .sort((a, b) => a.name.localeCompare(b.name, "he"));
  }, [items, categories, supplierName]);

  const supplierHasItems = useMemo(() => {
    const selectedSupplier = supplierName.trim();
    if (!selectedSupplier) return true;
    return items.some((item) => {
      const value = typeof item.supplierName === "string" ? item.supplierName.trim() : "";
      return value.toLowerCase() === selectedSupplier.toLowerCase();
    });
  }, [items, supplierName]);

  const summary = useMemo(() => {
    return {
      totalItems: selectedItems.length,
      totalUnits: selectedItems.reduce((sum, item) => {
        return sum + Number(order[item.id] || 0);
      }, 0),
      autoSuggestions: selectedItems.filter((item) =>
        suggestions.some((suggestion) => suggestion.itemId === item.id)
      ).length,
    };
  }, [selectedItems, order, suggestions]);

  function getCategoryName(item: Item) {
    if (!item.categoryId) return "ללא קטגוריה";
    return (
      categories.find((category) => category.id === item.categoryId)?.name ||
      "ללא קטגוריה"
    );
  }

  function isSuggested(itemId: number) {
    return suggestions.some((suggestion) => suggestion.itemId === itemId);
  }

  function addToOrder() {
    const parsedItemId = Number(itemId);
    const parsedQuantity = Number(quantity);

    if (!parsedItemId || !Number.isFinite(parsedItemId)) {
      setError("צריך לבחור מוצר");
      return;
    }

    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      setError("צריך להזין כמות תקינה");
      return;
    }

    setOrder((prev) => ({
      ...prev,
      [parsedItemId]: Number(prev[parsedItemId] || 0) + parsedQuantity,
    }));

    setItemId("");
    setQuantity("1");
    setError(null);
    setSuccess("המוצר נוסף להזמנה");
  }

  function updateQuantity(itemIdToUpdate: number, value: string) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      setOrder((prev) => {
        const next = { ...prev };
        delete next[itemIdToUpdate];
        return next;
      });
      return;
    }

    setOrder((prev) => ({
      ...prev,
      [itemIdToUpdate]: parsed,
    }));
  }

  function removeItem(itemIdToRemove: number) {
    setOrder((prev) => {
      const next = { ...prev };
      delete next[itemIdToRemove];
      return next;
    });
  }

  function incrementItem(itemIdToUpdate: number) {
    setOrder((prev) => ({
      ...prev,
      [itemIdToUpdate]: Number(prev[itemIdToUpdate] || 0) + 1,
    }));
  }

  function decrementItem(itemIdToUpdate: number) {
    setOrder((prev) => {
      const current = Number(prev[itemIdToUpdate] || 0);
      if (current <= 1) {
        const next = { ...prev };
        delete next[itemIdToUpdate];
        return next;
      }
      return { ...prev, [itemIdToUpdate]: current - 1 };
    });
  }

  function quickAddItem(item: Item) {
    setOrder((prev) => ({
      ...prev,
      [item.id]: Number(prev[item.id] || 0) + 1,
    }));
    setError(null);
    setSuccess(`${item.name} נוסף לעגלה`);
  }

  function clearOrder() {
    setOrder({});
    setError(null);
    setSuccess("העגלה נוקתה");
  }

  async function createOrder() {
    try {
      setActionLoading(true);
      setError(null);
      setSuccess(null);

      const lines = Object.entries(order)
        .filter(([, itemQuantity]) => Number(itemQuantity) > 0)
        .map(([selectedItemId, itemQuantity]) => {
          const item = items.find(
            (candidate) => candidate.id === Number(selectedItemId)
          );

          return {
            rawName: item?.name || null,
            sku: item?.sku || null,
            barcode: item?.barcode || null,
            quantity: Number(itemQuantity),
            unitType: item?.unitType || "UNIT",
          };
        });

      if (lines.length === 0) {
        throw new Error("אין מוצרים להזמנה");
      }

      const response = await fetch("/api/inventory/supplier-purchases", {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
          supplierName: supplierName.trim() || null,
          source: "MANUAL",
          lines,
        }),
      });

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("לא התקבלה תגובה תקינה מהשרת.");
      }

      if (!response.ok) {
        const msg =
          payload &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof (payload as { error?: unknown }).error === "string"
            ? (payload as { error: string }).error
            : "לא הצלחנו ליצור הזמנה";
        throw new Error(msg);
      }

      const draftId = extractCreatedDraftId(payload);
      if (draftId !== null) {
        clearLocalDraft();
        router.replace(`/inventory/supplier-purchases/${draftId}/send`);
        return;
      }

      throw new Error(
        "ההזמנה נוצרה אך לא התקבל מזהה מהשרת. רעננו את העמוד או נסו שוב."
      );
    } catch (err: any) {
      setError(err?.message || "שגיאה ביצירת הזמנה");
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={inventoryPageStyle()}>
        <InventorySubheader
          title="יצירת הזמנה חדשה"
          backHref="/inventory/supplier-purchases"
        />
        <main style={inventoryMainStyle(980)}>טוען נתונים...</main>
      </div>
    );
  }
  return (
    <div style={inventoryPageStyle()}>
      <style>{orderPipelineCss}</style>
      <InventorySubheader title="יצירת הזמנה חדשה" backHref="/inventory/supplier-purchases" />

      <main style={inventoryMainStyle(980)}>
        {hasLocalDraft && !hasUnsavedWork && (
          <section
            style={{
              border: "1px solid #bfdbfe",
              background: "#eff6ff",
              color: "#1d4ed8",
              borderRadius: 18,
              padding: 14,
              fontSize: 14,
              fontWeight: 800,
              lineHeight: 1.5,
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ flex: "1 1 260px" }}>
              יש הזמנה שלא הושלמה ונשמרה מקומית.
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                onClick={restoreLocalDraft}
                style={{
                  minHeight: 42,
                  padding: "10px 14px",
                  borderRadius: 12,
                  border: "none",
                  background: "#1d4ed8",
                  color: "#ffffff",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                המשך הזמנה
              </button>

              <button
                type="button"
                onClick={clearLocalDraft}
                style={{
                  minHeight: 42,
                  padding: "10px 14px",
                  borderRadius: 12,
                  border: "1px solid #bfdbfe",
                  background: "#ffffff",
                  color: "#1d4ed8",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                מחק והתחל מחדש
              </button>
            </div>
          </section>
        )}

        {error && (
          <div
            style={{
              border: "1px solid #fecaca",
              background: "#fef2f2",
              color: "#991b1b",
              borderRadius: 18,
              padding: 14,
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            {error}
          </div>
        )}

        {success && (
          <div
            style={{
              border: "1px solid #bbf7d0",
              background: "#f0fdf4",
              color: "#166534",
              borderRadius: 18,
              padding: 14,
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            {success}
          </div>
        )}

        {hasUnsavedWork && !success && (
          <div
            style={{
              fontSize: 12,
              color: "#6b7280",
              textAlign: "center",
              lineHeight: 1.6,
            }}
          >
            שינויים לא נשמרו. אפשר לשמור להמשך לפני יציאה מהמסך.
          </div>
        )}

        {showExitGuard && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(15, 23, 42, 0.45)",
              zIndex: 60,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            <section
              style={{
                width: "100%",
                maxWidth: 520,
                borderRadius: 20,
                background: "#ffffff",
                boxShadow: "0 24px 70px rgba(15, 23, 42, 0.28)",
                padding: 18,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 950, color: "#111827" }}>
                יש הזמנה בתהליך
              </div>
              <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>
                לפני יציאה מהמסך, תרצו לשמור את ההזמנה להמשך?
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    writeLocalDraft();
                    setShowExitGuard(false);
                    allowNextExitRef.current = true;
                    window.history.back();
                  }}
                  style={{
                    flex: "1 1 160px",
                    minHeight: 46,
                    borderRadius: 14,
                    border: "none",
                    background: "#111827",
                    color: "#ffffff",
                    cursor: "pointer",
                    fontWeight: 950,
                  }}
                >
                  שמור להמשך
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearLocalDraft();
                    setShowExitGuard(false);
                    allowNextExitRef.current = true;
                    window.history.back();
                  }}
                  style={{
                    flex: "1 1 160px",
                    minHeight: 46,
                    borderRadius: 14,
                    border: "1px solid #fecaca",
                    background: "#fef2f2",
                    color: "#991b1b",
                    cursor: "pointer",
                    fontWeight: 950,
                  }}
                >
                  צא בלי לשמור
                </button>
                <button
                  type="button"
                  onClick={() => {
                    exitIntentRef.current = null;
                    setShowExitGuard(false);
                  }}
                  style={{
                    flex: "1 1 160px",
                    minHeight: 46,
                    borderRadius: 14,
                    border: "1px solid #e5e7eb",
                    background: "#ffffff",
                    color: "#111827",
                    cursor: "pointer",
                    fontWeight: 900,
                  }}
                >
                  המשך עריכה
                </button>
              </div>
            </section>
          </div>
        )}

        <div className="order-pipeline">
        <section
          style={{
            ...inventoryCardStyle(),
            border: `1px solid ${inventoryTheme.accent}`,
            background: "#ecfdf5",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 900, color: inventoryTheme.accent, marginBottom: 8 }}>
            א · טעינה אוטומטית
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              lineHeight: 1.25,
              fontWeight: 950,
              color: inventoryTheme.text,
            }}
          >
            {summary.totalItems > 0
              ? `הזמנה מוכנה עם ${summary.totalItems} מוצרים`
              : "בונים הזמנה חדשה"}
          </h1>
          <p
            style={{
              margin: "8px 0 14px",
              color: inventoryTheme.textMuted,
              fontSize: 14,
              lineHeight: 1.7,
            }}
          >
            המערכת טענה המלצות לפי מצב המלאי. אפשר לערוך, להוסיף ולהסיר לפני
            יצירת ההזמנה.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 10,
            }}
          >
            <div style={{ borderRadius: 14, padding: 14, background: "#ffffff", border: `1px solid ${inventoryTheme.cardBorder}` }}>
              <div style={{ fontSize: 12, color: inventoryTheme.textMuted, fontWeight: 800 }}>מוצרים בהזמנה</div>
              <div style={{ fontSize: 28, fontWeight: 950, marginTop: 4, color: inventoryTheme.text }}>{summary.totalItems}</div>
            </div>
            <div style={{ borderRadius: 14, padding: 14, background: "#ffffff", border: `1px solid ${inventoryTheme.cardBorder}` }}>
              <div style={{ fontSize: 12, color: inventoryTheme.textMuted, fontWeight: 800 }}>יחידות להזמנה</div>
              <div style={{ fontSize: 28, fontWeight: 950, marginTop: 4, color: inventoryTheme.text }}>{summary.totalUnits}</div>
            </div>
            <div style={{ borderRadius: 14, padding: 14, background: "#ffffff", border: `1px solid ${inventoryTheme.cardBorder}` }}>
              <div style={{ fontSize: 12, color: inventoryTheme.textMuted, fontWeight: 800 }}>המלצות מערכת</div>
              <div style={{ fontSize: 28, fontWeight: 950, marginTop: 4, color: inventoryTheme.text }}>{summary.autoSuggestions}</div>
            </div>
          </div>

          {selectedItems.length > 0 ? (
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8, maxHeight: 220, overflowY: "auto" }}>
              {selectedItems.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 12,
                    background: "#ffffff",
                    border: `1px solid ${inventoryTheme.cardBorder}`,
                  }}
                >
                  <ItemThumb name={item.name} imageUrl={item.imageUrl} size={36} />
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 900, color: inventoryTheme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.name}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 950, color: inventoryTheme.accent }}>
                    ×{order[item.id]}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>


          <section style={inventoryCardStyle()}>
            <div style={{ fontSize: 12, fontWeight: 900, color: inventoryTheme.textMuted, marginBottom: 8 }}>
              ב · עגלת הזמנה ({summary.totalItems})
            </div>
            <div style={{ marginBottom: 14 }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: 18,
                  fontWeight: 950,
                  color: "#111827",
                }}
              >
                מוצרים בהזמנה
              </h2>
              <p
                style={{
                  margin: "6px 0 0",
                  color: "#6b7280",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                אפשר לערוך כמות ישירות או להסיר מוצר מההזמנה.
              </p>
            </div>

            {selectedItems.length === 0 ? (
              <div
                style={{
                  border: "1px dashed #d1d5db",
                  borderRadius: 22,
                  background: "#f9fafb",
                  padding: 24,
                  textAlign: "center",
                  color: "#6b7280",
                }}
              >
                <div style={{ fontSize: 34, marginBottom: 8 }}>🛒</div>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 900,
                    color: "#111827",
                    marginBottom: 5,
                  }}
                >
                  ההזמנה עדיין ריקה
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                  בחרו קטגוריה, מוצר וכמות — והמוצר ייכנס לכאן.
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {selectedItems.map((item) => (
                  <article
                    key={item.id}
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 18,
                      padding: 14,
                      background: "#ffffff",
                      display: "grid",
                      gridTemplateColumns: "44px 1fr 110px 44px",
                      gap: 10,
                      alignItems: "center",
                    }}
                  >
                    <ItemThumb name={item.name} imageUrl={item.imageUrl} size={40} />
                    <div>
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <div
                          style={{
                            color: "#111827",
                            fontSize: 15,
                            fontWeight: 950,
                          }}
                        >
                          {item.name}
                        </div>

                        <span
                          style={{
                            borderRadius: 999,
                            padding: "4px 8px",
                            background: isSuggested(item.id)
                              ? "#fef3c7"
                              : "#e0f2fe",
                            color: isSuggested(item.id) ? "#92400e" : "#075985",
                            fontSize: 11,
                            fontWeight: 950,
                          }}
                        >
                          {isSuggested(item.id)
                            ? "המלצת מערכת"
                            : "הוסף ידנית"}
                        </span>
                      </div>

                      <div
                        style={{
                          marginTop: 5,
                          color: "#6b7280",
                          fontSize: 12,
                          lineHeight: 1.5,
                        }}
                      >
                        {getCategoryName(item)} · במלאי: {item.currentQuantity}
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
                      <button type="button" onClick={() => decrementItem(item.id)} style={{ width: 34, height: 34, borderRadius: 10, border: `1px solid ${inventoryTheme.cardBorder}`, background: "#fff", cursor: "pointer", fontWeight: 900 }}>−</button>
                      <span style={{ minWidth: 28, textAlign: "center", fontWeight: 950 }}>{order[item.id]}</span>
                      <button type="button" onClick={() => incrementItem(item.id)} style={{ width: 34, height: 34, borderRadius: 10, border: `1px solid ${inventoryTheme.cardBorder}`, background: "#fff", cursor: "pointer", fontWeight: 900 }}>+</button>
                    </div>

                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: 14,
                        border: "1px solid #fecaca",
                        background: "#fef2f2",
                        color: "#991b1b",
                        cursor: "pointer",
                        fontSize: 17,
                        fontWeight: 950,
                      }}
                    >
                      ×
                    </button>
                  </article>
                ))}
              </div>
            )}

            {selectedItems.length > 0 ? (
              <>
                <div
                  style={{
                    marginTop: 14,
                    padding: "12px 14px",
                    borderRadius: 14,
                    background: "#f8fafc",
                    border: `1px solid ${inventoryTheme.cardBorder}`,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: inventoryTheme.textMuted, fontWeight: 800 }}>סה״כ יחידות</span>
                  <span style={{ fontWeight: 950, color: inventoryTheme.text }}>{summary.totalUnits}</span>
                </div>
                <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={clearOrder} style={{ flex: 1, minHeight: 40, borderRadius: 12, border: `1px solid ${inventoryTheme.cardBorder}`, background: "#fff", cursor: "pointer", fontWeight: 800, fontSize: 13 }}>
                  נקה הכל
                </button>
                <button type="button" onClick={writeLocalDraft} style={{ flex: 1, minHeight: 40, borderRadius: 12, border: "none", background: inventoryTheme.text, color: "#fff", cursor: "pointer", fontWeight: 800, fontSize: 13 }}>
                  שמור להמשך
                </button>
                </div>
              </>
            ) : null}
          </section>

          <section style={{ ...inventoryCardStyle(), height: "fit-content" }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: inventoryTheme.primaryBtn, marginBottom: 8 }}>
              ג · הוספת מוצר
            </div>
            <div style={{ marginBottom: 14 }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: 18,
                  fontWeight: 950,
                  color: "#111827",
                }}
              >
                הוספת מוצר
              </h2>
              <p
                style={{
                  margin: "6px 0 0",
                  color: "#6b7280",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                בחרו ספק, קטגוריה וחפשו מוצר — לחיצה על + מוסיפה לעגלה.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 900, color: "#374151" }}>ספק</span>
                <select
                  value={supplierName}
                  onChange={(event) => {
                    setSupplierName(event.target.value);
                    setCategoryId("");
                    setProductSearch("");
                  }}
                  style={inventoryFieldStyle()}
                >
                  <option value="">בחר ספק</option>
                  {supplierOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 900, color: "#374151" }}>קטגוריה</span>
                <select
                  value={categoryId}
                  onChange={(event) => {
                    setCategoryId(event.target.value);
                    setProductSearch("");
                  }}
                  style={inventoryFieldStyle()}
                >
                  <option value="">כל הקטגוריות</option>
                  {filteredCategories.map((category) => (
                    <option key={category.id} value={String(category.id)}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>

              {supplierName.trim() && !supplierHasItems && (
                <div
                  style={{
                    border: "1px dashed #d1d5db",
                    borderRadius: 14,
                    background: "#f9fafb",
                    padding: 12,
                    textAlign: "center",
                    color: "#6b7280",
                    fontSize: 13,
                    lineHeight: 1.6,
                  }}
                >
                  לא נמצאו מוצרים לספק הזה.
                </div>
              )}

              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 900, color: "#374151" }}>חיפוש מוצר</span>
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 16, opacity: 0.5 }}>🔍</span>
                  <input
                    type="search"
                    value={productSearch}
                    onChange={(event) => setProductSearch(event.target.value)}
                    placeholder="חפש לפי שם..."
                    style={{ ...inventoryFieldStyle(), paddingRight: 40 }}
                  />
                </div>
              </label>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 280, overflowY: "auto" }}>
                {browsableItems.length === 0 ? (
                  <div style={{ padding: 16, textAlign: "center", color: inventoryTheme.textMuted, fontSize: 13, borderRadius: 14, border: "1px dashed #d1d5db", background: "#f9fafb" }}>
                    לא נמצאו מוצרים. נסו לשנות סינון או חיפוש.
                  </div>
                ) : (
                  browsableItems.map((item) => (
                    <article
                      key={item.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 12px",
                        borderRadius: 14,
                        border: `1px solid ${inventoryTheme.cardBorder}`,
                        background: "#fff",
                      }}
                    >
                      <ItemThumb name={item.name} imageUrl={item.imageUrl} size={44} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 950, color: inventoryTheme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.name}
                        </div>
                        <div style={{ fontSize: 12, color: inventoryTheme.textMuted, marginTop: 2 }}>
                          {getCategoryName(item)} · במלאי: {item.currentQuantity}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => quickAddItem(item)}
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: 12,
                          border: "none",
                          background: inventoryTheme.successBtn,
                          color: "#fff",
                          cursor: "pointer",
                          fontSize: 20,
                          fontWeight: 900,
                          flexShrink: 0,
                        }}
                        aria-label={`הוסף ${item.name}`}
                      >
                        +
                      </button>
                    </article>
                  ))
                )}
              </div>
            </div>
          </section>

        <section style={{ ...inventoryCardStyle(), textAlign: "center" }}>
          <div style={{ fontSize: 12, fontWeight: 900, color: inventoryTheme.primaryBtn, marginBottom: 8 }}>
            ד · צור הזמנה
          </div>
          <p style={{ margin: "0 0 14px", fontSize: 13, color: inventoryTheme.textMuted, lineHeight: 1.6 }}>
            המלאי יתעדכן רק אחרי אישור קבלת הסחורה בפועל.
          </p>
          <button
            type="button"
            onClick={createOrder}
            disabled={actionLoading || summary.totalItems === 0}
            style={{
              width: "100%",
              minHeight: 54,
              borderRadius: 18,
              border: "none",
              background:
                actionLoading || summary.totalItems === 0
                  ? "#cbd5e1"
                  : inventoryTheme.primaryBtn,
              color: "#ffffff",
              fontSize: 15,
              fontWeight: 950,
              cursor:
                actionLoading || summary.totalItems === 0
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {actionLoading ? "יוצר הזמנה..." : "צור הזמנה"}
          </button>
        </section>
        </div>
      </main>
    </div>
  );
}
