"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/ui/page-header";

type DraftMatch = {
  itemId: number;
  itemName: string;
  matchScore: number;
  reason: string;
};

type DraftDecision = {
  recommendedAction: "MERGE" | "CREATE_NEW" | "REVIEW";
  recommendedItemId?: number;
  confidence: number;
  reason: string;
} | null;

type Draft = {
  id: number;
  detectedName?: string | null;
  detectedCategory?: string | null;
  detectedBarcode?: string | null;
  detectedUnitType?: string | null;
  imageUrl?: string | null;
  confidenceScore?: number | null;
  status: string;
  mergedToItemId?: number | null;
  matches?: DraftMatch[];
  decision?: DraftDecision;
};

type ApproveFormState = {
  name: string;
  unitType: string;
  barcode: string;
  initialQuantity: string;
  minimumQuantity: string;
  reorderPoint: string;
};

type ActionState = {
  draftId: number;
  action: "APPROVE" | "MERGE" | "REJECT";
} | null;

const UNIT_OPTIONS = [
  { value: "UNIT", label: "יחידה" },
  { value: "ML", label: 'מ"ל' },
  { value: "GRAM", label: "גרם" },
  { value: "KG", label: "קילוגרם" },
  { value: "LITER", label: "ליטר" },
  { value: "BOX", label: "קופסה" },
];

function getSafeImageUrl(imageUrl?: string | null) {
  if (!imageUrl) return null;
  if (imageUrl.includes("example.com")) return null;
  return imageUrl;
}

export default function InventoryDraftsPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionState, setActionState] = useState<ActionState>(null);
  const [error, setError] = useState<string | null>(null);
  const [openApproveDraftId, setOpenApproveDraftId] = useState<number | null>(
    null
  );
  const [approveForms, setApproveForms] = useState<
    Record<number, ApproveFormState>
  >({});

  useEffect(() => {
    void loadDrafts();
  }, []);

  async function loadDrafts(options?: { silent?: boolean }) {
    try {
      if (options?.silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError(null);

      const response = await fetch("/api/inventory/drafts", {
        headers: {
          Authorization: "Bearer 1",
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "אירעה שגיאה בטעינת הטיוטות");
      }

      const loadedDrafts: Draft[] = Array.isArray(data.drafts)
        ? data.drafts
        : [];

      setDrafts(loadedDrafts);

      setApproveForms((prev) => {
        const next = { ...prev };

        for (const draft of loadedDrafts) {
          if (!next[draft.id]) {
            next[draft.id] = {
              name: draft.detectedName || "",
              unitType: draft.detectedUnitType || "UNIT",
              barcode: draft.detectedBarcode || "",
              initialQuantity: "0",
              minimumQuantity: "0",
              reorderPoint: "",
            };
          }
        }

        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "אירעה שגיאה בטעינת הטיוטות");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  function validateNumberField(value: string, label: string) {
    if (value.trim() === "") return undefined;

    const parsed = Number(value);

    if (Number.isNaN(parsed) || !Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${label} חייב להיות מספר תקין וגדול או שווה ל־0`);
    }

    return parsed;
  }

  async function handleApprove(draftId: number) {
    if (actionState) return;

    try {
      setError(null);
      setActionState({ draftId, action: "APPROVE" });

      const form = approveForms[draftId];

      if (!form || !form.name.trim()) {
        throw new Error("נדרש להזין שם מוצר");
      }

      if (!form.unitType.trim()) {
        throw new Error("נדרש לבחור יחידת מידה");
      }

      const initialQuantity = validateNumberField(
        form.initialQuantity,
        "כמות התחלתית"
      );

      const minimumQuantity = validateNumberField(
        form.minimumQuantity,
        "כמות מינימום"
      );

      const reorderPoint = validateNumberField(
        form.reorderPoint,
        "נקודת הזמנה"
      );

      const response = await fetch(`/api/inventory/drafts/${draftId}/approve`, {
        method: "POST",
        headers: {
          Authorization: "Bearer 1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: form.name.trim(),
          unitType: form.unitType.trim(),
          barcode: form.barcode.trim() || undefined,
          initialQuantity,
          minimumQuantity,
          reorderPoint,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "אירעה שגיאה באישור הטיוטה");
      }

      setOpenApproveDraftId(null);
      await loadDrafts({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "אירעה שגיאה באישור הטיוטה");
    } finally {
      setActionState(null);
    }
  }

  async function handleReject(draftId: number) {
    if (actionState) return;

    try {
      setError(null);
      setActionState({ draftId, action: "REJECT" });

      const response = await fetch(`/api/inventory/drafts/${draftId}/reject`, {
        method: "POST",
        headers: {
          Authorization: "Bearer 1",
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "אירעה שגיאה בדחיית הטיוטה");
      }

      if (openApproveDraftId === draftId) {
        setOpenApproveDraftId(null);
      }

      await loadDrafts({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "אירעה שגיאה בדחיית הטיוטה");
    } finally {
      setActionState(null);
    }
  }

  async function handleMerge(draftId: number, targetItemId: number) {
    if (actionState) return;

    try {
      setError(null);
      setActionState({ draftId, action: "MERGE" });

      const response = await fetch(`/api/inventory/drafts/${draftId}/merge`, {
        method: "POST",
        headers: {
          Authorization: "Bearer 1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          targetItemId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "אירעה שגיאה במיזוג הטיוטה");
      }

      if (openApproveDraftId === draftId) {
        setOpenApproveDraftId(null);
      }

      await loadDrafts({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "אירעה שגיאה במיזוג הטיוטה");
    } finally {
      setActionState(null);
    }
  }

  function openApproveForm(draft: Draft) {
    setError(null);

    setApproveForms((prev) => ({
      ...prev,
      [draft.id]: prev[draft.id] || {
        name: draft.detectedName || "",
        unitType: draft.detectedUnitType || "UNIT",
        barcode: draft.detectedBarcode || "",
        initialQuantity: "0",
        minimumQuantity: "0",
        reorderPoint: "",
      },
    }));

    setOpenApproveDraftId(draft.id);
  }

  function closeApproveForm() {
    setOpenApproveDraftId(null);
  }

  function updateApproveForm(
    draftId: number,
    field: keyof ApproveFormState,
    value: string
  ) {
    setError(null);

    setApproveForms((prev) => ({
      ...prev,
      [draftId]: {
        ...prev[draftId],
        [field]: value,
      },
    }));
  }

  function getDecisionText(decision: DraftDecision) {
    if (!decision) return null;

    if (decision.recommendedAction === "MERGE") {
      return "המערכת ממליצה למזג למוצר קיים";
    }

    if (decision.recommendedAction === "CREATE_NEW") {
      return "המערכת ממליצה ליצור מוצר חדש";
    }

    return "המערכת ממליצה לבצע בדיקה ידנית לפני החלטה";
  }

function getDecisionColor(decision?: DraftDecision) {
  if (!decision) {
    return {
      background: "#f8fafc",
      border: "#e5e7eb",
      color: "#374151",
    };
  }

  if (decision.recommendedAction === "MERGE") {
    return {
      background: "#eff6ff",
      border: "#bfdbfe",
      color: "#1d4ed8",
    };
  }

  if (decision.recommendedAction === "CREATE_NEW") {
    return {
      background: "#f0fdf4",
      border: "#bbf7d0",
      color: "#166534",
    };
  }

  return {
    background: "#fffbeb",
    border: "#fde68a",
    color: "#92400e",
  };
}
  function getStatusLabel(status: string) {
    if (status === "PENDING_REVIEW") return "ממתין לבדיקה";
    if (status === "APPROVED") return "אושר";
    if (status === "REJECTED") return "נדחה";
    if (status === "MERGED") return "מוזג";
    return status;
  }

  function getStatusStyle(status: string) {
    if (status === "PENDING_REVIEW") {
      return {
        background: "#fffbeb",
        color: "#92400e",
      };
    }

    if (status === "APPROVED") {
      return {
        background: "#dcfce7",
        color: "#166534",
      };
    }

    if (status === "REJECTED") {
      return {
        background: "#fee2e2",
        color: "#991b1b",
      };
    }

    if (status === "MERGED") {
      return {
        background: "#eff6ff",
        color: "#1d4ed8",
      };
    }

    return {
      background: "#f3f4f6",
      color: "#374151",
    };
  }

  function getReasonLabel(reason: string) {
    if (reason === "EXACT_BARCODE") return "התאמה לפי ברקוד";
    if (reason === "NAME_MATCH") return "התאמה לפי שם";
    if (reason === "CATEGORY_MATCH") return "התאמה לפי קטגוריה";
    return reason;
  }

  function isDraftBusy(draftId: number) {
    return actionState?.draftId === draftId;
  }

  function getActionText(draftId: number, action: "APPROVE" | "MERGE" | "REJECT") {
    if (actionState?.draftId !== draftId || actionState.action !== action) {
      return null;
    }

    if (action === "APPROVE") return "יוצר מוצר...";
    if (action === "MERGE") return "ממזג...";
    return "דוחה...";
  }

  if (loading) {
    return (
      <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
        <PageHeader title="טיוטות מלאי" />

        <main
          style={{
            maxWidth: "900px",
            margin: "0 auto",
            padding: "16px",
          }}
        >
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
            טוען טיוטות מלאי...
          </section>
        </main>
      </div>
    );
  }

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <PageHeader title="טיוטות מלאי" />

      <main
        style={{
          padding: "16px",
          maxWidth: "900px",
          margin: "0 auto",
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
              margin: 0,
              marginBottom: "6px",
              fontSize: "20px",
              fontWeight: 800,
              color: "#111827",
            }}
          >
            בדיקת טיוטות מלאי
          </h1>

          <p
            style={{
              margin: 0,
              color: "#6b7280",
              fontSize: "14px",
              lineHeight: 1.6,
            }}
          >
            כאן אפשר לעבור על מוצרים שזוהו, לבדוק התאמות אפשריות, ולהחליט אם
            ליצור מוצר חדש, למזג למוצר קיים או לדחות את הטיוטה.
          </p>
        </section>

        {refreshing && (
          <div
            style={{
              fontSize: "13px",
              color: "#6b7280",
              textAlign: "center",
            }}
          >
            מעדכן טיוטות...
          </div>
        )}

        {error && (
          <div
            style={{
              color: "#991b1b",
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

        {drafts.length === 0 ? (
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
            <div style={{ fontSize: "30px", marginBottom: "8px" }}>🧾</div>

            <div
              style={{
                fontWeight: 800,
                color: "#111827",
                marginBottom: "6px",
              }}
            >
              אין טיוטות שממתינות לבדיקה
            </div>

            <div style={{ fontSize: "14px", lineHeight: 1.6 }}>
              כשפריטים חדשים יזוהו מתהליך קליטה, הם יופיעו כאן לבדיקה.
            </div>
          </section>
        ) : (
          <div style={{ display: "grid", gap: "16px" }}>
            {drafts.map((draft) => {
              const isPending = draft.status === "PENDING_REVIEW";
              const form = approveForms[draft.id];
              const safeImageUrl = getSafeImageUrl(draft.imageUrl);
              const statusStyle = getStatusStyle(draft.status);
              const decisionStyle = getDecisionColor(draft.decision);
              const busy = isDraftBusy(draft.id);

              return (
                <section
                  key={draft.id}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: "18px",
                    padding: "16px",
                    background: "#ffffff",
                    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "14px",
                      alignItems: "flex-start",
                    }}
                  >
                    {safeImageUrl ? (
                      <img
                        src={safeImageUrl}
                        alt={draft.detectedName || "תמונת טיוטה"}
                        style={{
                          width: 96,
                          height: 96,
                          objectFit: "cover",
                          borderRadius: "14px",
                          border: "1px solid #e5e7eb",
                          flexShrink: 0,
                          background: "#f3f4f6",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 96,
                          height: 96,
                          borderRadius: "14px",
                          border: "1px solid #e5e7eb",
                          background: "#f3f4f6",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#6b7280",
                          fontSize: "26px",
                          flexShrink: 0,
                        }}
                      >
                        📦
                      </div>
                    )}

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: "10px",
                          flexWrap: "wrap",
                          marginBottom: "8px",
                        }}
                      >
                        <h2
                          style={{
                            margin: 0,
                            fontSize: "18px",
                            fontWeight: 800,
                            color: "#111827",
                          }}
                        >
                          {draft.detectedName || "טיוטה ללא שם"}
                        </h2>

                        <span
                          style={{
                            padding: "5px 10px",
                            borderRadius: "999px",
                            background: statusStyle.background,
                            color: statusStyle.color,
                            fontSize: "12px",
                            fontWeight: 800,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {getStatusLabel(draft.status)}
                        </span>
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(140px, 1fr))",
                          gap: "8px",
                          fontSize: "13px",
                          color: "#374151",
                        }}
                      >
                        <div>
                          <strong>רמת ביטחון:</strong>{" "}
                          {draft.confidenceScore ?? "—"}
                        </div>
                        <div>
                          <strong>קטגוריה:</strong>{" "}
                          {draft.detectedCategory || "—"}
                        </div>
                        <div>
                          <strong>ברקוד:</strong>{" "}
                          {draft.detectedBarcode || "—"}
                        </div>
                        <div>
                          <strong>יחידת מידה:</strong>{" "}
                          {draft.detectedUnitType || "—"}
                        </div>
                        {draft.mergedToItemId ? (
                          <div>
                            <strong>מוזג למוצר:</strong>{" "}
                            {draft.mergedToItemId}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {isPending && draft.decision && (
                    <div
                      style={{
                        marginTop: "16px",
                        padding: "12px",
                        borderRadius: "14px",
                        background: decisionStyle.background,
                        border: `1px solid ${decisionStyle.border}`,
                        color: decisionStyle.color,
                      }}
                    >
                      <div style={{ fontWeight: 800, marginBottom: "4px" }}>
                        {getDecisionText(draft.decision)}
                      </div>

                      <div style={{ fontSize: "13px", lineHeight: 1.6 }}>
                        סיבה: {draft.decision.reason}
                      </div>

                      <div style={{ fontSize: "13px", lineHeight: 1.6 }}>
                        רמת ביטחון: {draft.decision.confidence}
                      </div>
                    </div>
                  )}

                  {isPending && (
                    <div style={{ marginTop: "16px" }}>
                      <h3
                        style={{
                          margin: "0 0 8px 0",
                          fontSize: "16px",
                          fontWeight: 800,
                          color: "#111827",
                        }}
                      >
                        התאמות אפשריות
                      </h3>

                      {draft.matches && draft.matches.length > 0 ? (
                        <div style={{ display: "grid", gap: "8px" }}>
                          {draft.matches.map((match) => {
                            const isRecommendedMerge =
                              draft.decision?.recommendedAction === "MERGE" &&
                              draft.decision?.recommendedItemId ===
                                match.itemId;

                            return (
                              <div
                                key={`${draft.id}-${match.itemId}`}
                                style={{
                                  border: isRecommendedMerge
                                    ? "1px solid #93c5fd"
                                    : "1px solid #e5e7eb",
                                  background: isRecommendedMerge
                                    ? "#eff6ff"
                                    : "#ffffff",
                                  borderRadius: "14px",
                                  padding: "12px",
                                  display: "flex",
                                  justifyContent: "space-between",
                                  gap: "12px",
                                  alignItems: "center",
                                  flexWrap: "wrap",
                                }}
                              >
                                <div>
                                  <div
                                    style={{
                                      fontWeight: 800,
                                      color: "#111827",
                                      marginBottom: "4px",
                                    }}
                                  >
                                    {match.itemName}
                                  </div>

                                  <div
                                    style={{
                                      fontSize: "13px",
                                      color: "#6b7280",
                                      lineHeight: 1.5,
                                    }}
                                  >
                                    ציון התאמה: {match.matchScore} • סיבה:{" "}
                                    {getReasonLabel(match.reason)}
                                  </div>

                                  {isRecommendedMerge && (
                                    <div
                                      style={{
                                        fontSize: "12px",
                                        color: "#1d4ed8",
                                        marginTop: "4px",
                                        fontWeight: 800,
                                      }}
                                    >
                                      זו ההתאמה המומלצת כרגע
                                    </div>
                                  )}
                                </div>

                                <button
                                  type="button"
                                  disabled={busy || Boolean(actionState)}
                                  onClick={() =>
                                    handleMerge(draft.id, match.itemId)
                                  }
                                  style={{
                                    minHeight: "42px",
                                    padding: "9px 13px",
                                    borderRadius: "12px",
                                    border: "1px solid #d1d5db",
                                    background: "#f9fafb",
                                    color: "#111827",
                                    cursor:
                                      busy || actionState
                                        ? "not-allowed"
                                        : "pointer",
                                    opacity: busy || actionState ? 0.65 : 1,
                                    fontWeight: 700,
                                  }}
                                >
                                  {getActionText(draft.id, "MERGE") ||
                                    "מיזוג למוצר הזה"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div
                          style={{
                            color: "#6b7280",
                            fontSize: "14px",
                            background: "#f8fafc",
                            border: "1px solid #e5e7eb",
                            borderRadius: "12px",
                            padding: "12px",
                          }}
                        >
                          לא נמצאו התאמות אפשריות.
                        </div>
                      )}
                    </div>
                  )}

                  {isPending && (
                    <div
                      style={{
                        display: "flex",
                        gap: "8px",
                        marginTop: "16px",
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        type="button"
                        disabled={busy || Boolean(actionState)}
                        onClick={() => openApproveForm(draft)}
                        style={{
                          minHeight: "44px",
                          padding: "10px 14px",
                          borderRadius: "12px",
                          border: "1px solid #bbf7d0",
                          background: "#f0fdf4",
                          color: "#166534",
                          cursor:
                            busy || actionState ? "not-allowed" : "pointer",
                          opacity: busy || actionState ? 0.65 : 1,
                          fontWeight: 800,
                        }}
                      >
                        יצירת מוצר חדש
                      </button>

                      <button
                        type="button"
                        disabled={busy || Boolean(actionState)}
                        onClick={() => handleReject(draft.id)}
                        style={{
                          minHeight: "44px",
                          padding: "10px 14px",
                          borderRadius: "12px",
                          border: "1px solid #fecaca",
                          background: "#fef2f2",
                          color: "#991b1b",
                          cursor:
                            busy || actionState ? "not-allowed" : "pointer",
                          opacity: busy || actionState ? 0.65 : 1,
                          fontWeight: 800,
                        }}
                      >
                        {getActionText(draft.id, "REJECT") || "דחיית הטיוטה"}
                      </button>
                    </div>
                  )}

                  {isPending && openApproveDraftId === draft.id && form && (
                    <div
                      style={{
                        marginTop: "16px",
                        padding: "16px",
                        border: "1px solid #bbf7d0",
                        borderRadius: "16px",
                        background: "#f0fdf4",
                      }}
                    >
                      <h3
                        style={{
                          margin: 0,
                          marginBottom: "12px",
                          fontSize: "16px",
                          fontWeight: 800,
                          color: "#166534",
                        }}
                      >
                        יצירת מוצר חדש מתוך הטיוטה
                      </h3>

                      <div
                        style={{
                          display: "grid",
                          gap: "12px",
                        }}
                      >
                        <label style={{ display: "grid", gap: "6px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 700 }}>
                            שם מוצר
                          </span>
                          <input
                            value={form.name}
                            disabled={busy || Boolean(actionState)}
                            onChange={(e) =>
                              updateApproveForm(
                                draft.id,
                                "name",
                                e.target.value
                              )
                            }
                            style={{
                              minHeight: "44px",
                              padding: "10px 12px",
                              borderRadius: "12px",
                              border: "1px solid #d1d5db",
                              background: "#ffffff",
                              boxSizing: "border-box",
                            }}
                          />
                        </label>

                        <label style={{ display: "grid", gap: "6px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 700 }}>
                            יחידת מידה
                          </span>
                          <select
                            value={form.unitType}
                            disabled={busy || Boolean(actionState)}
                            onChange={(e) =>
                              updateApproveForm(
                                draft.id,
                                "unitType",
                                e.target.value
                              )
                            }
                            style={{
                              minHeight: "44px",
                              padding: "10px 12px",
                              borderRadius: "12px",
                              border: "1px solid #d1d5db",
                              background: "#ffffff",
                              boxSizing: "border-box",
                            }}
                          >
                            {UNIT_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label style={{ display: "grid", gap: "6px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 700 }}>
                            ברקוד
                          </span>
                          <input
                            value={form.barcode}
                            disabled={busy || Boolean(actionState)}
                            onChange={(e) =>
                              updateApproveForm(
                                draft.id,
                                "barcode",
                                e.target.value
                              )
                            }
                            placeholder="לא חובה"
                            style={{
                              minHeight: "44px",
                              padding: "10px 12px",
                              borderRadius: "12px",
                              border: "1px solid #d1d5db",
                              background: "#ffffff",
                              boxSizing: "border-box",
                            }}
                          />
                        </label>

                        <label style={{ display: "grid", gap: "6px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 700 }}>
                            כמות התחלתית
                          </span>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={form.initialQuantity}
                            disabled={busy || Boolean(actionState)}
                            onChange={(e) =>
                              updateApproveForm(
                                draft.id,
                                "initialQuantity",
                                e.target.value
                              )
                            }
                            style={{
                              minHeight: "44px",
                              padding: "10px 12px",
                              borderRadius: "12px",
                              border: "1px solid #d1d5db",
                              background: "#ffffff",
                              boxSizing: "border-box",
                            }}
                          />
                        </label>

                        <label style={{ display: "grid", gap: "6px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 700 }}>
                            כמות מינימום
                          </span>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={form.minimumQuantity}
                            disabled={busy || Boolean(actionState)}
                            onChange={(e) =>
                              updateApproveForm(
                                draft.id,
                                "minimumQuantity",
                                e.target.value
                              )
                            }
                            style={{
                              minHeight: "44px",
                              padding: "10px 12px",
                              borderRadius: "12px",
                              border: "1px solid #d1d5db",
                              background: "#ffffff",
                              boxSizing: "border-box",
                            }}
                          />
                        </label>

                        <label style={{ display: "grid", gap: "6px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 700 }}>
                            נקודת הזמנה
                          </span>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={form.reorderPoint}
                            disabled={busy || Boolean(actionState)}
                            onChange={(e) =>
                              updateApproveForm(
                                draft.id,
                                "reorderPoint",
                                e.target.value
                              )
                            }
                            placeholder="לא חובה"
                            style={{
                              minHeight: "44px",
                              padding: "10px 12px",
                              borderRadius: "12px",
                              border: "1px solid #d1d5db",
                              background: "#ffffff",
                              boxSizing: "border-box",
                            }}
                          />
                        </label>
                      </div>

                      <div
                        style={{
                          display: "flex",
                          gap: "8px",
                          marginTop: "16px",
                          flexWrap: "wrap",
                        }}
                      >
                        <button
                          type="button"
                          disabled={busy || Boolean(actionState)}
                          onClick={() => handleApprove(draft.id)}
                          style={{
                            minHeight: "44px",
                            padding: "10px 14px",
                            borderRadius: "12px",
                            border: "none",
                            background: "#166534",
                            color: "#ffffff",
                            cursor:
                              busy || actionState ? "not-allowed" : "pointer",
                            opacity: busy || actionState ? 0.75 : 1,
                            fontWeight: 800,
                          }}
                        >
                          {getActionText(draft.id, "APPROVE") ||
                            "אישור יצירת מוצר"}
                        </button>

                        <button
                          type="button"
                          disabled={busy || Boolean(actionState)}
                          onClick={closeApproveForm}
                          style={{
                            minHeight: "44px",
                            padding: "10px 14px",
                            borderRadius: "12px",
                            border: "1px solid #d1d5db",
                            background: "#ffffff",
                            color: "#111827",
                            cursor:
                              busy || actionState ? "not-allowed" : "pointer",
                            opacity: busy || actionState ? 0.65 : 1,
                            fontWeight: 700,
                          }}
                        >
                          ביטול
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}