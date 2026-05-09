"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/ui/page-header";
import { getInventoryItems } from "@/lib/api/inventory";
import MovementModal from "@/components/inventory/movement-modal";

type InventorySuggestedAction =
  | {
      type: "CREATE_ITEM";
      suggestedName: string;
      confidence: number;
    }
  | {
      type: "LINK_EXISTING";
      itemId: number;
      itemName: string;
      confidence: number;
    };

type InventoryInsight = {
  type: string;
  key: string;
  count: number;
  message: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  suggestedActions?: InventorySuggestedAction[];
};

type InventoryAlert = {
  id: number;
  type: string;
  message?: string | null;
  isResolved?: boolean;
  createdAt?: string;
};

type Item = {
  id: number;
  name: string;
  currentQuantity: number;
  imageUrl?: string | null;
  alerts?: InventoryAlert[];
};

type ModalState = {
  open: boolean;
  itemId: number | null;
  itemName: string;
  mode: "ADD" | "REMOVE";
};

type AlertDisplay = {
  label: string;
  background: string;
  color: string;
  border: string;
  icon: string;
  priority: number;
};

function isValidImageUrl(imageUrl?: string | null) {
  if (!imageUrl) return false;
  if (imageUrl.includes("example.com")) return false;
  return true;
}

function getAlertDisplay(type: string): AlertDisplay {
  if (type === "CRITICAL_STOCK") {
    return {
      label: "מלאי קריטי",
      background: "#fee2e2",
      color: "#991b1b",
      border: "#fecaca",
      icon: "🔴",
      priority: 1,
    };
  }

  if (type === "LOW_STOCK") {
    return {
      label: "מלאי נמוך",
      background: "#fffbeb",
      color: "#92400e",
      border: "#fde68a",
      icon: "🟠",
      priority: 2,
    };
  }

  if (type === "SUSPICIOUS_CORRECTION") {
    return {
      label: "פעולה חריגה",
      background: "#fef3c7",
      color: "#92400e",
      border: "#fcd34d",
      icon: "⚠️",
      priority: 3,
    };
  }

  if (type === "UNMATCHED_POS_PRODUCT") {
    return {
      label: "מוצר לא זוהה",
      background: "#eff6ff",
      color: "#1d4ed8",
      border: "#bfdbfe",
      icon: "🔎",
      priority: 4,
    };
  }

  return {
    label: "התראה פתוחה",
    background: "#f3f4f6",
    color: "#374151",
    border: "#e5e7eb",
    icon: "⚠️",
    priority: 99,
  };
}

function getPrimaryAlert(alerts?: InventoryAlert[]) {
  if (!alerts || alerts.length === 0) return null;

  const sortedAlerts = [...alerts].sort((a, b) => {
    const aDisplay = getAlertDisplay(a.type);
    const bDisplay = getAlertDisplay(b.type);
    return aDisplay.priority - bDisplay.priority;
  });

  const primaryAlert = sortedAlerts[0];
  const display = getAlertDisplay(primaryAlert.type);

  return {
    alert: primaryAlert,
    display,
    count: alerts.length,
  };
}

function getInsightDisplay(severity: InventoryInsight["severity"]) {
  if (severity === "HIGH") {
    return {
      background: "#fef2f2",
      border: "#fecaca",
      color: "#991b1b",
      icon: "🔴",
      label: "חשיבות גבוהה",
    };
  }

  if (severity === "MEDIUM") {
    return {
      background: "#fffbeb",
      border: "#fde68a",
      color: "#92400e",
      icon: "🟠",
      label: "כדאי לבדוק",
    };
  }

  return {
    background: "#eff6ff",
    border: "#bfdbfe",
    color: "#1d4ed8",
    icon: "🔎",
    label: "תובנה",
  };
}

export default function InventoryPage() {
  const router = useRouter();

  const [items, setItems] = useState<Item[]>([]);
  const [insights, setInsights] = useState<InventoryInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [insightSuccessMessage, setInsightSuccessMessage] = useState<
    string | null
  >(null);
  const [insightActionLoadingKey, setInsightActionLoadingKey] = useState<
    string | null
  >(null);
  const [openLinkSelectorKey, setOpenLinkSelectorKey] = useState<string | null>(
    null
  );
  const [selectedInsightItemByKey, setSelectedInsightItemByKey] = useState<
    Record<string, number | "">
  >({});

  const [modalState, setModalState] = useState<ModalState>({
    open: false,
    itemId: null,
    itemName: "",
    mode: "ADD",
  });

  const openAlertsCount = useMemo(() => {
    return items.reduce((total, item) => total + (item.alerts?.length || 0), 0);
  }, [items]);

  async function load(options?: { silent?: boolean }) {
    try {
      if (options?.silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError(null);

      const token =
        typeof window !== "undefined" ? localStorage.getItem("token") : null;

      const [itemsData, insightsResponse] = await Promise.all([
        getInventoryItems(),
        fetch("/api/inventory/insights", {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          cache: "no-store",
        }),
      ]);

      setItems(Array.isArray(itemsData) ? itemsData : []);

      if (insightsResponse.status === 401) {
        setInsights([]);
      } else if (insightsResponse.ok) {
        const insightsData = await insightsResponse.json();
        setInsights(
          Array.isArray(insightsData?.insights) ? insightsData.insights : []
        );
      } else {
        setInsights([]);
      }
    } catch (err: any) {
      console.error(err);
      setError(err?.message || "לא הצלחנו לטעון את המלאי");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openMovementModal(item: Item, mode: "ADD" | "REMOVE") {
    setModalState({
      open: true,
      itemId: item.id,
      itemName: item.name,
      mode,
    });
  }

  function closeMovementModal() {
    setModalState({
      open: false,
      itemId: null,
      itemName: "",
      mode: "ADD",
    });
  }

  async function handleMovementSuccess() {
    await load({ silent: true });
  }

  async function executeInsightAction(input: {
    action: "CREATE_ITEM_FROM_INSIGHT" | "LINK_EXISTING_FROM_INSIGHT";
    key: string;
    itemId?: number;
  }) {
    try {
      setInsightActionLoadingKey(input.key);
      setInsightSuccessMessage(null);
      setError(null);

      const token =
        typeof window !== "undefined" ? localStorage.getItem("token") : null;

      const response = await fetch("/api/inventory/insights/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(input),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "שגיאה בטיפול בתובנה");
      }

      if (input.action === "CREATE_ITEM_FROM_INSIGHT") {
        setInsightSuccessMessage(
          `נוצר מוצר חדש עבור "${input.key}" ונסגרו ${data?.resolvedCount || 0} אירועים.`
        );
      }

      if (input.action === "LINK_EXISTING_FROM_INSIGHT") {
        setInsightSuccessMessage(
          `האירועים של "${input.key}" שויכו למוצר קיים ונסגרו ${data?.resolvedCount || 0} אירועים.`
        );
        setOpenLinkSelectorKey(null);
        setSelectedInsightItemByKey((prev) => ({
          ...prev,
          [input.key]: "",
        }));
      }

      await load({ silent: true });
    } catch (err: any) {
      setError(err?.message || "שגיאה בטיפול בתובנה");
    } finally {
      setInsightActionLoadingKey(null);
    }
  }

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <PageHeader title="מלאי" />

      <main
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          boxSizing: "border-box",
          direction: "rtl",
        }}
      >
        <section
          style={{
            borderRadius: 30,
            padding: 22,
            background:
              "linear-gradient(135deg, #111827 0%, #1f2937 50%, #0f766e 100%)",
            color: "#ffffff",
            boxShadow: "0 18px 44px rgba(15, 23, 42, 0.22)",
            display: "flex",
            flexDirection: "column",
            gap: 16,
            overflow: "hidden",
          }}
        >
          <div>
            <div
              style={{
                display: "inline-flex",
                padding: "7px 11px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.18)",
                fontSize: 12,
                fontWeight: 900,
                marginBottom: 12,
              }}
            >
              Workspace מלאי
            </div>

            <h1
              style={{
                margin: 0,
                fontSize: 28,
                lineHeight: 1.25,
                fontWeight: 950,
              }}
            >
              ניהול מלאי
            </h1>

            <p
              style={{
                margin: "8px 0 0",
                color: "rgba(255,255,255,0.78)",
                fontSize: 14,
                lineHeight: 1.7,
                maxWidth: 760,
              }}
            >
              צפייה בפריטים, יצירה מהירה, ועדכון כמויות דרך תנועות מלאי — הכל
              במקום אחד.
            </p>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 10,
              direction: "rtl",
            }}
          >
            <div
              style={{
                borderRadius: 22,
                padding: 14,
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.18)",
                minWidth: 0,
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>
                פריטים
              </div>
              <div style={{ fontSize: 28, fontWeight: 950, marginTop: 4 }}>
                {items.length}
              </div>
            </div>

            <div
              style={{
                borderRadius: 22,
                padding: 14,
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.18)",
                minWidth: 0,
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>
                התראות פתוחות
              </div>
              <div style={{ fontSize: 28, fontWeight: 950, marginTop: 4 }}>
                {openAlertsCount}
              </div>
            </div>

            <div
              style={{
                borderRadius: 22,
                padding: 14,
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.18)",
                minWidth: 0,
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>
                תובנות פעילות
              </div>
              <div style={{ fontSize: 28, fontWeight: 950, marginTop: 4 }}>
                {insights.length}
              </div>
            </div>
          </div>
        </section>

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 26,
            background: "#ffffff",
            padding: 18,
            boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 950,
                color: "#111827",
              }}
            >
              פעולות מהירות
            </h2>
            <p
              style={{
                margin: "6px 0 0",
                color: "#6b7280",
                fontSize: 13,
                lineHeight: 1.6,
                maxWidth: 760,
              }}
            >
              התחילו מהפעולה המרכזית, או עברו לכלי תפעול נוספים במלאי.
            </p>
          </div>

          {openAlertsCount > 0 && (
            <div
              style={{
                border: "1px solid #fde68a",
                borderRadius: 16,
                background: "#fffbeb",
                color: "#92400e",
                padding: "12px 14px",
                fontSize: 13,
                fontWeight: 800,
                lineHeight: 1.5,
              }}
            >
              יש {openAlertsCount} התראות פתוחות. כדאי לפתוח פריטים מסומנים
              ולטפל בהם.
            </div>
          )}

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              direction: "rtl",
              justifyContent: "flex-start",
              alignItems: "stretch",
            }}
          >
            <button
              type="button"
              onClick={() => router.push("/inventory/items/create")}
              style={{
                flex: "0 1 280px",
                width: "100%",
                minHeight: 96,
                padding: "14px 16px",
                borderRadius: 22,
                background: "#111827",
                color: "#ffffff",
                border: "none",
                cursor: "pointer",
                boxShadow: "0 12px 26px rgba(17, 24, 39, 0.18)",
                boxSizing: "border-box",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 950, lineHeight: 1.2 }}>
                + הוספת פריט חדש
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  lineHeight: 1.5,
                  opacity: 0.85,
                }}
              >
                יצירת פריט חדש והכנסתו למלאי
              </div>
            </button>

            <button
              type="button"
              onClick={() => router.push("/inventory/sales/create")}
              style={{
                flex: "0 1 280px",
                width: "100%",
                minHeight: 96,
                padding: "14px 16px",
                borderRadius: 22,
                background: "#f0fdf4",
                color: "#065f46",
                border: "1px solid #bbf7d0",
                cursor: "pointer",
                boxShadow: "0 8px 22px rgba(15, 23, 42, 0.06)",
                boxSizing: "border-box",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 950, lineHeight: 1.2 }}>
                רישום מכירה
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.5 }}>
                עדכון מלאי אוטומטי דרך תנועת SALE
              </div>
            </button>

            <button
              type="button"
              onClick={() => router.push("/inventory/supplier-purchases")}
              style={{
                flex: "0 1 280px",
                width: "100%",
                minHeight: 96,
                padding: "14px 16px",
                borderRadius: 22,
                background: "#ffffff",
                color: "#111827",
                border: "1px solid #d1d5db",
                cursor: "pointer",
                boxShadow: "0 8px 22px rgba(15, 23, 42, 0.06)",
                boxSizing: "border-box",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 950, lineHeight: 1.2 }}>
                הזמנות מספקים
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  lineHeight: 1.5,
                  color: "#6b7280",
                }}
              >
                תכנון הזמנה וקליטת סחורה למלאי
              </div>
            </button>
          </div>
        </section>

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 22,
            background: "#ffffff",
            padding: 16,
            boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: 16,
                fontWeight: 900,
                color: "#111827",
              }}
            >
              ממתינים לבדיקה
            </h2>
            <p
              style={{
                margin: "6px 0 0",
                color: "#6b7280",
                fontSize: 13,
                lineHeight: 1.6,
                maxWidth: 760,
              }}
            >
              דברים שנכנסו למערכת ומחכים להחלטה שלך (אישור / שיוך / דחייה).
            </p>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              direction: "rtl",
              justifyContent: "flex-start",
              alignItems: "stretch",
            }}
          >
            <button
              type="button"
              onClick={() => router.push("/inventory/unmatched")}
              style={{
                flex: "0 1 260px",
                width: "100%",
                minHeight: 90,
                padding: "14px 16px",
                borderRadius: 22,
                background: "#eff6ff",
                color: "#1d4ed8",
                border: "1px solid #bfdbfe",
                cursor: "pointer",
                boxShadow: "0 8px 22px rgba(15, 23, 42, 0.06)",
                boxSizing: "border-box",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 950, lineHeight: 1.2 }}>
                מוצרים שלא זוהו
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.5 }}>
                שיוך למוצר קיים או יצירת מוצר חדש
              </div>
            </button>

            <button
              type="button"
              onClick={() => router.push("/inventory/drafts")}
              style={{
                flex: "0 1 260px",
                width: "100%",
                minHeight: 90,
                padding: "14px 16px",
                borderRadius: 22,
                background: "#fffbeb",
                color: "#92400e",
                border: "1px solid #fde68a",
                cursor: "pointer",
                boxShadow: "0 8px 22px rgba(15, 23, 42, 0.06)",
                boxSizing: "border-box",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 950, lineHeight: 1.2 }}>
                טיוטות מלאי
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.5 }}>
                אישור / מיזוג / דחייה של פריטים ממתינים
              </div>
            </button>
          </div>
        </section>
        {insightSuccessMessage && (
          <section
            style={{
              border: "1px solid #bbf7d0",
              borderRadius: "16px",
              background: "#f0fdf4",
              padding: "14px",
              color: "#166534",
              fontSize: "14px",
              fontWeight: 800,
            }}
          >
            {insightSuccessMessage}
          </section>
        )}

        {insights.length > 0 && (
          <section
            style={{
              border: "1px solid #fde68a",
              borderRadius: "18px",
              background: "#ffffff",
              padding: "16px",
              boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: "17px",
                  fontWeight: 900,
                  color: "#111827",
                }}
              >
                תובנות מלאי שדורשות תשומת לב
              </h2>

              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: "13px",
                  lineHeight: 1.5,
                  color: "#6b7280",
                }}
              >
                המערכת זיהתה דפוסים שחוזרים על עצמם ויכולים להעיד על פערים
                בהגדרת מוצרים או בקליטת מכירות.
              </p>
            </div>

            {insights.map((insight, index) => {
              const display = getInsightDisplay(insight.severity);
              const hasCreateAction = insight.suggestedActions?.some(
                (action) => action.type === "CREATE_ITEM"
              );
              const hasLinkAction = insight.suggestedActions?.some(
                (action) => action.type === "LINK_EXISTING"
              );
              const isActionLoading = insightActionLoadingKey === insight.key;
              const isLinkSelectorOpen = openLinkSelectorKey === insight.key;
              const selectedItemId = selectedInsightItemByKey[insight.key];

              return (
                <article
                  key={`${insight.type}-${insight.key}-${index}`}
                  style={{
                    border: `1px solid ${display.border}`,
                    borderRadius: "14px",
                    background: display.background,
                    padding: "12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "10px",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: "8px",
                        alignItems: "flex-start",
                        color: display.color,
                        fontWeight: 800,
                        lineHeight: 1.5,
                        fontSize: "14px",
                      }}
                    >
                      <span>{display.icon}</span>
                      <span>{insight.message}</span>
                    </div>

                    <span
                      style={{
                        border: `1px solid ${display.border}`,
                        borderRadius: "999px",
                        background: "#ffffff",
                        color: display.color,
                        padding: "4px 8px",
                        fontSize: "11px",
                        fontWeight: 900,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {display.label}
                    </span>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "8px",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => router.push("/inventory/unmatched")}
                      disabled={Boolean(insightActionLoadingKey)}
                      style={{
                        minHeight: "38px",
                        padding: "8px 12px",
                        borderRadius: "10px",
                        border: "none",
                        background: "#111827",
                        color: "#ffffff",
                        cursor: insightActionLoadingKey
                          ? "not-allowed"
                          : "pointer",
                        opacity: insightActionLoadingKey ? 0.65 : 1,
                        fontSize: "13px",
                        fontWeight: 800,
                      }}
                    >
                      לטיפול במוצרים שלא זוהו
                    </button>

                    {hasCreateAction && (
                      <button
                        type="button"
                        onClick={() =>
                          executeInsightAction({
                            action: "CREATE_ITEM_FROM_INSIGHT",
                            key: insight.key,
                          })
                        }
                        disabled={Boolean(insightActionLoadingKey)}
                        style={{
                          minHeight: "38px",
                          padding: "8px 12px",
                          borderRadius: "10px",
                          border: "1px solid #10b981",
                          background: "#ecfdf5",
                          color: "#065f46",
                          cursor: insightActionLoadingKey
                            ? "not-allowed"
                            : "pointer",
                          opacity: insightActionLoadingKey ? 0.65 : 1,
                          fontSize: "13px",
                          fontWeight: 800,
                        }}
                      >
                        {isActionLoading ? "יוצר מוצר..." : "צור מוצר מההצעה"}
                      </button>
                    )}

                    {hasLinkAction && (
                      <button
                        type="button"
                        onClick={() => {
                          setOpenLinkSelectorKey((current) =>
                            current === insight.key ? null : insight.key
                          );
                          setInsightSuccessMessage(null);
                        }}
                        disabled={Boolean(insightActionLoadingKey)}
                        style={{
                          minHeight: "38px",
                          padding: "8px 12px",
                          borderRadius: "10px",
                          border: "1px solid #bfdbfe",
                          background: "#eff6ff",
                          color: "#1d4ed8",
                          cursor: insightActionLoadingKey
                            ? "not-allowed"
                            : "pointer",
                          opacity: insightActionLoadingKey ? 0.65 : 1,
                          fontSize: "13px",
                          fontWeight: 800,
                        }}
                      >
                        שייך למוצר קיים
                      </button>
                    )}
                  </div>

                  {isLinkSelectorOpen && (
                    <div
                      style={{
                        border: "1px solid #bfdbfe",
                        borderRadius: "14px",
                        background: "#ffffff",
                        padding: "12px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "10px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "13px",
                          color: "#1d4ed8",
                          fontWeight: 800,
                          lineHeight: 1.5,
                        }}
                      >
                        בחר מוצר קיים שאליו יש לשייך את כל האירועים של{" "}
                        <strong>{insight.key}</strong>.
                      </div>

                      <select
                        value={selectedItemId || ""}
                        onChange={(event) =>
                          setSelectedInsightItemByKey((prev) => ({
                            ...prev,
                            [insight.key]: Number(event.target.value),
                          }))
                        }
                        disabled={Boolean(insightActionLoadingKey)}
                        style={{
                          minHeight: "42px",
                          borderRadius: "12px",
                          border: "1px solid #d1d5db",
                          padding: "0 12px",
                          background: "#ffffff",
                          color: "#111827",
                          fontWeight: 700,
                        }}
                      >
                        <option value="">בחירת מוצר קיים</option>
                        {items.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} — כמות נוכחית: {item.currentQuantity}
                          </option>
                        ))}
                      </select>

                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "8px",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (!selectedItemId) {
                              setError("צריך לבחור מוצר קיים לשיוך.");
                              return;
                            }

                            executeInsightAction({
                              action: "LINK_EXISTING_FROM_INSIGHT",
                              key: insight.key,
                              itemId: Number(selectedItemId),
                            });
                          }}
                          disabled={Boolean(insightActionLoadingKey)}
                          style={{
                            minHeight: "38px",
                            padding: "8px 12px",
                            borderRadius: "10px",
                            border: "none",
                            background: "#1d4ed8",
                            color: "#ffffff",
                            cursor: insightActionLoadingKey
                              ? "not-allowed"
                              : "pointer",
                            opacity: insightActionLoadingKey ? 0.65 : 1,
                            fontSize: "13px",
                            fontWeight: 800,
                          }}
                        >
                          {isActionLoading ? "משייך..." : "שייך למוצר שנבחר"}
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setOpenLinkSelectorKey(null);
                            setSelectedInsightItemByKey((prev) => ({
                              ...prev,
                              [insight.key]: "",
                            }));
                          }}
                          disabled={Boolean(insightActionLoadingKey)}
                          style={{
                            minHeight: "38px",
                            padding: "8px 12px",
                            borderRadius: "10px",
                            border: "1px solid #e5e7eb",
                            background: "#f9fafb",
                            color: "#374151",
                            cursor: insightActionLoadingKey
                              ? "not-allowed"
                              : "pointer",
                            opacity: insightActionLoadingKey ? 0.65 : 1,
                            fontSize: "13px",
                            fontWeight: 800,
                          }}
                        >
                          ביטול
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        )}

        {refreshing && !loading && (
          <div
            style={{
              fontSize: "13px",
              color: "#6b7280",
              textAlign: "center",
            }}
          >
            מעדכן מלאי...
          </div>
        )}

        {loading ? (
          <section
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: "18px",
              background: "#ffffff",
              padding: "28px",
              textAlign: "center",
              color: "#6b7280",
              boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
            }}
          >
            טוען מלאי...
          </section>
        ) : error ? (
          <section
            style={{
              border: "1px solid #fecaca",
              borderRadius: "18px",
              background: "#fef2f2",
              padding: "22px",
              textAlign: "center",
              color: "#991b1b",
              boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
            }}
          >
            <div style={{ fontWeight: 800, marginBottom: "8px" }}>
              משהו השתבש
            </div>

            <div style={{ fontSize: "14px", marginBottom: "14px" }}>
              {error}
            </div>

            <button
              type="button"
              onClick={() => load()}
              style={{
                minHeight: "42px",
                padding: "10px 16px",
                borderRadius: "12px",
                border: "none",
                background: "#991b1b",
                color: "#ffffff",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              נסה שוב
            </button>
          </section>
        ) : items.length === 0 ? (
          <section
            style={{
              border: "1px dashed #d1d5db",
              borderRadius: 26,
              background: "#ffffff",
              padding: 26,
              textAlign: "center",
              color: "#6b7280",
              boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                fontSize: 38,
                marginBottom: 10,
              }}
            >
              📦
            </div>

            <div
              style={{
                fontSize: 18,
                fontWeight: 950,
                color: "#111827",
                marginBottom: 6,
              }}
            >
              עדיין אין פריטים במלאי
            </div>

            <div
              style={{
                fontSize: 14,
                lineHeight: 1.6,
                marginBottom: 16,
                maxWidth: 520,
                marginLeft: "auto",
                marginRight: "auto",
              }}
            >
              כדאי להתחיל מפריט ראשון כדי לבנות מקור אמת מסודר.
            </div>

            <button
              type="button"
              onClick={() => router.push("/inventory/items/create")}
              style={{
                width: "100%",
                maxWidth: 420,
                minHeight: 52,
                padding: "12px 18px",
                borderRadius: 18,
                border: "none",
                background: "#111827",
                color: "#ffffff",
                cursor: "pointer",
                fontWeight: 950,
                fontSize: 15,
                boxShadow: "0 10px 22px rgba(17, 24, 39, 0.14)",
              }}
            >
              הוספת פריט ראשון
            </button>
          </section>
        ) : (
          <section
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            {items.map((item) => {
              const primaryAlert = getPrimaryAlert(item.alerts);

              return (
                <article
                  key={item.id}
                  onClick={() => router.push(`/inventory/items/${item.id}`)}
                  style={{
                    background: "#ffffff",
                    borderRadius: "18px",
                    padding: "12px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    border: primaryAlert
                      ? `1px solid ${primaryAlert.display.border}`
                      : "1px solid #e5e7eb",
                    cursor: "pointer",
                    boxShadow: primaryAlert
                      ? "0 6px 18px rgba(146, 64, 14, 0.08)"
                      : "0 4px 14px rgba(15, 23, 42, 0.04)",
                    gap: "12px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "12px",
                      alignItems: "center",
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <div style={{ position: "relative", flexShrink: 0 }}>
                      {isValidImageUrl(item.imageUrl) ? (
                        <img
                          src={item.imageUrl || ""}
                          alt={item.name}
                          style={{
                            width: 72,
                            height: 72,
                            borderRadius: 14,
                            objectFit: "cover",
                            flexShrink: 0,
                            background: "#f3f4f6",
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 72,
                            height: 72,
                            background: "#f3f4f6",
                            borderRadius: 14,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            fontSize: "24px",
                          }}
                        >
                          📦
                        </div>
                      )}

                      {primaryAlert && (
                        <div
                          style={{
                            position: "absolute",
                            top: "-6px",
                            right: "-6px",
                            width: "24px",
                            height: "24px",
                            borderRadius: "999px",
                            background: primaryAlert.display.background,
                            color: primaryAlert.display.color,
                            border: `1px solid ${primaryAlert.display.border}`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "12px",
                            boxShadow: "0 4px 10px rgba(15, 23, 42, 0.12)",
                          }}
                          title={primaryAlert.display.label}
                        >
                          {primaryAlert.display.icon}
                        </div>
                      )}
                    </div>

                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontWeight: 800,
                          fontSize: "15px",
                          color: "#111827",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.name}
                      </div>

                      <div
                        style={{
                          fontSize: "13px",
                          color: "#6b7280",
                          marginTop: "4px",
                        }}
                      >
                        כמות נוכחית: {item.currentQuantity}
                      </div>

                      {primaryAlert && (
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            marginTop: "8px",
                            padding: "5px 9px",
                            borderRadius: "999px",
                            background: primaryAlert.display.background,
                            color: primaryAlert.display.color,
                            border: `1px solid ${primaryAlert.display.border}`,
                            fontSize: "12px",
                            fontWeight: 800,
                            lineHeight: 1,
                          }}
                        >
                          <span>{primaryAlert.display.icon}</span>
                          <span>{primaryAlert.display.label}</span>
                          {primaryAlert.count > 1 && (
                            <span>+{primaryAlert.count - 1}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      display: "flex",
                      gap: "8px",
                      flexShrink: 0,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => openMovementModal(item, "REMOVE")}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: "12px",
                        border: "none",
                        background: "#fee2e2",
                        color: "#b91c1c",
                        cursor: "pointer",
                        fontSize: "20px",
                        fontWeight: 800,
                      }}
                      aria-label={`הפחתת מלאי עבור ${item.name}`}
                    >
                      −
                    </button>

                    <button
                      type="button"
                      onClick={() => openMovementModal(item, "ADD")}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: "12px",
                        border: "none",
                        background: "#dcfce7",
                        color: "#15803d",
                        cursor: "pointer",
                        fontSize: "20px",
                        fontWeight: 800,
                      }}
                      aria-label={`הוספת מלאי עבור ${item.name}`}
                    >
                      +
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </main>

      <MovementModal
        open={modalState.open}
        itemId={modalState.itemId}
        itemName={modalState.itemName}
        mode={modalState.mode}
        onClose={closeMovementModal}
        onSuccess={handleMovementSuccess}
      />
    </div>
  );
}