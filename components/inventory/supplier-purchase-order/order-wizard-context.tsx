"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  getInventoryCategories,
  getInventoryItems,
  type InventoryCategoryDTO,
} from "@/lib/api/inventory";
import {
  clearSupplierPurchaseOrderDraft,
  readSupplierPurchaseOrderDraft,
  writeSupplierPurchaseOrderDraft,
} from "@/lib/inventory/supplier-purchase-order-draft";

export type OrderWizardItem = {
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
  suggestedOrderQuantity: number;
};

type OrderWizardContextValue = {
  loading: boolean;
  items: OrderWizardItem[];
  categories: InventoryCategoryDTO[];
  suggestions: ReorderSuggestion[];
  order: Record<number, number>;
  setOrder: React.Dispatch<React.SetStateAction<Record<number, number>>>;
  unitCosts: Record<number, string>;
  setUnitCost: (itemId: number, value: string) => void;
  supplierName: string;
  setSupplierName: (v: string) => void;
  categoryId: string;
  setCategoryId: (v: string) => void;
  productSearch: string;
  setProductSearch: (v: string) => void;
  error: string | null;
  setError: (v: string | null) => void;
  success: string | null;
  setSuccess: (v: string | null) => void;
  actionLoading: boolean;
  hasLocalDraft: boolean;
  hasUnsavedWork: boolean;
  selectedItems: OrderWizardItem[];
  browsableItems: OrderWizardItem[];
  supplierOptions: string[];
  filteredCategories: InventoryCategoryDTO[];
  supplierHasItems: boolean;
  summary: {
    totalItems: number;
    totalUnits: number;
    autoSuggestions: number;
  };
  getCategoryName: (item: OrderWizardItem) => string;
  isSuggested: (itemId: number) => boolean;
  incrementItem: (id: number) => void;
  decrementItem: (id: number) => void;
  removeItem: (id: number) => void;
  quickAddItem: (item: OrderWizardItem) => void;
  clearOrder: () => void;
  applyRecommendations: () => void;
  persistDraft: () => void;
  restoreLocalDraft: () => void;
  clearLocalDraft: () => void;
  createOrder: () => Promise<void>;
  showExitGuard: boolean;
  setShowExitGuard: (v: boolean) => void;
  confirmExitAndGoBack: () => void;
  recommendationsBanner: string | null;
  dismissRecommendationsBanner: () => void;
};

const OrderWizardContext = createContext<OrderWizardContextValue | null>(null);

function buildHeaders() {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
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

function normalizeUnitCosts(unitCosts: Record<number, string>) {
  return Object.fromEntries(
    Object.entries(unitCosts).map(([itemId, value]) => {
      const trimmed = value.trim();
      if (!trimmed) return [Number(itemId), null];
      const parsed = Number(trimmed);
      return [Number(itemId), Number.isFinite(parsed) && parsed >= 0 ? parsed : null];
    })
  );
}

export function useOrderWizard() {
  const ctx = useContext(OrderWizardContext);
  if (!ctx) {
    throw new Error("useOrderWizard must be used within OrderWizardProvider");
  }
  return ctx;
}

export function OrderWizardProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [items, setItems] = useState<OrderWizardItem[]>([]);
  const [categories, setCategories] = useState<InventoryCategoryDTO[]>([]);
  const [suggestions, setSuggestions] = useState<ReorderSuggestion[]>([]);
  const [defaultRecommendations, setDefaultRecommendations] = useState<
    Record<number, number>
  >({});
  const [order, setOrder] = useState<Record<number, number>>({});
  const [unitCosts, setUnitCosts] = useState<Record<number, string>>({});
  const [supplierName, setSupplierName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [hasLocalDraft, setHasLocalDraft] = useState(false);
  const [showExitGuard, setShowExitGuard] = useState(false);
  const initializedRef = useRef(false);
  const [recommendationsBanner, setRecommendationsBanner] = useState<
    string | null
  >(null);

  const hasUnsavedWork = useMemo(() => {
    return Boolean(supplierName.trim()) || Object.keys(order).length > 0;
  }, [supplierName, order]);

  const persistDraft = useCallback(() => {
    writeSupplierPurchaseOrderDraft({
      supplierName,
      order,
      unitCosts: normalizeUnitCosts(unitCosts),
      categoryId,
      itemId: "",
      quantity: "1",
    });
    setHasLocalDraft(true);
  }, [supplierName, order, unitCosts, categoryId]);

  const clearLocalDraft = useCallback(() => {
    clearSupplierPurchaseOrderDraft();
    setHasLocalDraft(false);
  }, []);

  const restoreLocalDraft = useCallback(() => {
    const draft = readSupplierPurchaseOrderDraft();
    if (!draft) return;
    setSupplierName(draft.supplierName || "");
    setOrder(draft.order || {});
    setUnitCosts(
      Object.fromEntries(
        Object.entries(draft.unitCosts || {}).map(([itemId, value]) => [
          Number(itemId),
          value == null ? "" : String(value),
        ])
      )
    );
    setCategoryId(draft.categoryId || "");
    setError(null);
    setSuccess("המשכנו את ההזמנה שנשמרה מקומית.");
  }, []);

  const load = useCallback(async () => {
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
          defaults[suggestion.itemId] = Number(suggestion.suggestedOrderQuantity);
        }
      });

      setItems(normalizedItems);
      setCategories(Array.isArray(categoriesData) ? categoriesData : []);
      setSuggestions(normalizedSuggestions);
      setDefaultRecommendations(defaults);

      if (!initializedRef.current) {
        const existing = readSupplierPurchaseOrderDraft();
        if (existing?.order && Object.keys(existing.order).length > 0) {
          setOrder(existing.order);
          setUnitCosts(
            Object.fromEntries(
              Object.entries(existing.unitCosts || {}).map(([itemId, value]) => [
                Number(itemId),
                value == null ? "" : String(value),
              ])
            )
          );
          setSupplierName(existing.supplierName || "");
          setCategoryId(existing.categoryId || "");
        } else if (Object.keys(defaults).length > 0) {
          setOrder(defaults);
          const count = Object.keys(defaults).length;
          setRecommendationsBanner(
            `הוספנו ${count} פריטים מומלצים לפי מצב המלאי. אפשר לערוך לפני ההמשך.`
          );
        } else {
          setOrder({});
        }
        initializedRef.current = true;
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message === "UNAUTHORIZED"
          ? "אין הרשאה. התחברו מחדש ונסו שוב."
          : err instanceof Error
            ? err.message
            : "שגיאה בטעינת יצירת ההזמנה";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  useEffect(() => {
    queueMicrotask(() => {
      setHasLocalDraft(Boolean(readSupplierPurchaseOrderDraft()));
    });
  }, []);

  useEffect(() => {
    if (!hasUnsavedWork) return;
    queueMicrotask(() => {
      persistDraft();
    });
  }, [order, supplierName, categoryId, hasUnsavedWork, persistDraft]);

  useEffect(() => {
    if (typeof window === "undefined" || !hasUnsavedWork) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedWork]);

  const selectedItems = useMemo(() => {
    return items.filter((item) => Number(order[item.id] || 0) > 0);
  }, [items, order]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const selectedSupplier = supplierName.trim();
      if (selectedSupplier) {
        const itemSupplier = (item.supplierName || "").trim().toLowerCase();
        if (itemSupplier !== selectedSupplier.toLowerCase()) return false;
      }
      if (!categoryId) return true;
      return item.categoryId === Number(categoryId);
    });
  }, [items, categoryId, supplierName]);

  const browsableItems = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return filteredItems.slice(0, 12);
    return filteredItems
      .filter((item) => item.name.toLowerCase().includes(q))
      .slice(0, 12);
  }, [filteredItems, productSearch]);

  const supplierOptions = useMemo(() => {
    const unique = new Set<string>();
    for (const item of items) {
      const value =
        typeof item.supplierName === "string" ? item.supplierName.trim() : "";
      if (value) unique.add(value);
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b, "he"));
  }, [items]);

  const filteredCategories = useMemo(() => {
    const selectedSupplier = supplierName.trim();
    if (!selectedSupplier) {
      return categories
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, "he"));
    }

    const categoryIds = new Set<number>();
    for (const item of items) {
      const itemSupplier =
        typeof item.supplierName === "string" ? item.supplierName.trim() : "";
      if (!itemSupplier) continue;
      if (itemSupplier.toLowerCase() !== selectedSupplier.toLowerCase()) continue;
      if (typeof item.categoryId === "number") categoryIds.add(item.categoryId);
    }

    return categories
      .filter((category) => categoryIds.has(category.id))
      .sort((a, b) => a.name.localeCompare(b.name, "he"));
  }, [items, categories, supplierName]);

  const supplierHasItems = useMemo(() => {
    const selectedSupplier = supplierName.trim();
    if (!selectedSupplier) return true;
    return items.some((item) => {
      const value =
        typeof item.supplierName === "string" ? item.supplierName.trim() : "";
      return value.toLowerCase() === selectedSupplier.toLowerCase();
    });
  }, [items, supplierName]);

  const summary = useMemo(() => {
    return {
      totalItems: selectedItems.length,
      totalUnits: selectedItems.reduce(
        (sum, item) => sum + Number(order[item.id] || 0),
        0
      ),
      autoSuggestions: selectedItems.filter((item) =>
        suggestions.some((s) => s.itemId === item.id)
      ).length,
    };
  }, [selectedItems, order, suggestions]);

  const getCategoryName = useCallback(
    (item: OrderWizardItem) => {
      if (!item.categoryId) return "ללא קטגוריה";
      return (
        categories.find((c) => c.id === item.categoryId)?.name ||
        "ללא קטגוריה"
      );
    },
    [categories]
  );

  const isSuggested = useCallback(
    (itemId: number) => suggestions.some((s) => s.itemId === itemId),
    [suggestions]
  );

  const incrementItem = useCallback((itemId: number) => {
    setOrder((prev) => ({
      ...prev,
      [itemId]: Number(prev[itemId] || 0) + 1,
    }));
  }, []);

  const decrementItem = useCallback((itemId: number) => {
    setOrder((prev) => {
      const current = Number(prev[itemId] || 0);
      if (current <= 1) {
        const next = { ...prev };
        delete next[itemId];
        return next;
      }
      return { ...prev, [itemId]: current - 1 };
    });
  }, []);

  const removeItem = useCallback((itemId: number) => {
    setOrder((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    setUnitCosts((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }, []);

  const setUnitCost = useCallback((itemId: number, value: string) => {
    setUnitCosts((prev) => ({ ...prev, [itemId]: value }));
  }, []);

  const quickAddItem = useCallback((item: OrderWizardItem) => {
    setOrder((prev) => ({
      ...prev,
      [item.id]: Number(prev[item.id] || 0) + 1,
    }));
    setError(null);
    setSuccess(`${item.name} נוסף לעגלה`);
  }, []);

  const clearOrder = useCallback(() => {
    setOrder({});
    setUnitCosts({});
    setError(null);
    setSuccess("העגלה נוקתה");
  }, []);

  const applyRecommendations = useCallback(() => {
    setOrder(defaultRecommendations);
    setSuccess("המלצות המערכת הוחלו על ההזמנה");
    setError(null);
  }, [defaultRecommendations]);

  const createOrder = useCallback(async () => {
    try {
      setActionLoading(true);
      setError(null);
      setSuccess(null);

      const lines = Object.entries(order)
        .filter(([, qty]) => Number(qty) > 0)
        .map(([selectedItemId, itemQuantity]) => {
          const item = items.find((c) => c.id === Number(selectedItemId));
          const unitCostRaw = unitCosts[Number(selectedItemId)]?.trim() ?? "";
          let unitCost: number | null = null;
          if (unitCostRaw) {
            const parsed = Number(unitCostRaw);
            if (!Number.isFinite(parsed) || parsed < 0) {
              throw new Error(
                `עלות ליחידה לא תקינה עבור ${item?.name || "מוצר"}`
              );
            }
            unitCost = parsed;
          }

          return {
            rawName: item?.name || null,
            sku: item?.sku || null,
            barcode: item?.barcode || null,
            quantity: Number(itemQuantity),
            unitCost,
            unitType: item?.unitType || "UNIT",
          };
        });

      if (lines.length === 0) throw new Error("אין מוצרים להזמנה");

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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "שגיאה ביצירת הזמנה");
    } finally {
      setActionLoading(false);
    }
  }, [order, unitCosts, items, supplierName, clearLocalDraft, router]);

  const confirmExitAndGoBack = useCallback(() => {
    persistDraft();
    setShowExitGuard(false);
    router.push("/inventory");
  }, [persistDraft, router]);

  const value: OrderWizardContextValue = {
    loading,
    items,
    categories,
    suggestions,
    order,
    setOrder,
    unitCosts,
    setUnitCost,
    supplierName,
    setSupplierName,
    categoryId,
    setCategoryId,
    productSearch,
    setProductSearch,
    error,
    setError,
    success,
    setSuccess,
    actionLoading,
    hasLocalDraft,
    hasUnsavedWork,
    selectedItems,
    browsableItems,
    supplierOptions,
    filteredCategories,
    supplierHasItems,
    summary,
    getCategoryName,
    isSuggested,
    incrementItem,
    decrementItem,
    removeItem,
    quickAddItem,
    clearOrder,
    applyRecommendations,
    persistDraft,
    restoreLocalDraft,
    clearLocalDraft,
    createOrder,
    showExitGuard,
    setShowExitGuard,
    confirmExitAndGoBack,
    recommendationsBanner,
    dismissRecommendationsBanner: () => setRecommendationsBanner(null),
  };

  return (
    <OrderWizardContext.Provider value={value}>
      {children}
    </OrderWizardContext.Provider>
  );
}
