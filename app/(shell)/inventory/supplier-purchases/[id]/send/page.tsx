"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import PageHeader from "@/components/ui/page-header";
import {
  buildSupplierOrderText,
  downloadSupplierPurchaseOrderPdf,
  formatSupplierDraftDisplayDate,
  openSupplierOrderMailto,
  openWhatsAppWithSupplierOrderText,
} from "@/lib/services/inventory/supplier-purchase-document.service";

type DraftLine = {
  id: number;
  rawName: string | null;
  quantity: number;
  unitType: string | null;
};

type ApiDraft = {
  id: number;
  supplierName: string | null;
  externalOrderId: string | null;
  orderDate: string | null;
  createdAt: string;
  status: string;
  lines: DraftLine[];
};

const MAIN_MAX_WIDTH = 980;

const SUPPLIER_PURCHASE_FLOW_STEPS = [
  "יצירה",
  "שליחה לספק",
  "ממתינה לקליטה",
  "קליטה למלאי",
] as const;

/** Index of "שליחה לספק" on this page */
const CURRENT_FLOW_STEP_INDEX = 1;

function buildHeaders() {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export default function SupplierPurchaseSendPage() {
  const params = useParams();
  const router = useRouter();
  const rawId = params?.id;
  const draftIdFromRoute = Number(
    Array.isArray(rawId) ? rawId[0] : rawId ?? NaN
  );

  const [draft, setDraft] = useState<ApiDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyOk, setCopyOk] = useState<string | null>(null);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);

  const loadDraft = useCallback(async () => {
    if (!draftIdFromRoute || Number.isNaN(draftIdFromRoute)) {
      setError("מזהה הזמנה לא תקין");
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const res = await fetch("/api/inventory/supplier-purchases", {
        method: "GET",
        headers: buildHeaders(),
        cache: "no-store",
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(data?.error || "לא הצלחנו לטעון את ההזמנה");
      }

      const list: ApiDraft[] = Array.isArray(data?.drafts)
        ? data.drafts
        : [];

      const found = list.find((d) => d.id === draftIdFromRoute) ?? null;

      if (!found) {
        setDraft(null);
        setError("לא נמצאה הזמנה עם המזהה הזה.");
        return;
      }

      setDraft(found);
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : "שגיאה בטעינת ההזמנה";
      setError(msg);
      setDraft(null);
    } finally {
      setLoading(false);
    }
  }, [draftIdFromRoute]);

  useEffect(() => {
    loadDraft();
  }, [loadDraft]);

  const orderText = useMemo(() => {
    if (!draft) return "";
    return buildSupplierOrderText({
      id: draft.id,
      supplierName: draft.supplierName,
      externalOrderId: draft.externalOrderId,
      orderDate: draft.orderDate,
      createdAt: draft.createdAt,
      lines: draft.lines.map((l) => ({
        rawName: l.rawName,
        quantity: l.quantity,
        unitType: l.unitType,
      })),
    });
  }, [draft]);

  const canDispatch =
    draft?.status === "PENDING_REVIEW" && draft.lines.length > 0;

  async function copyOrderText() {
    if (!orderText) return;
    try {
      await navigator.clipboard.writeText(orderText);
      setCopyOk("הנוסח הועתק.");
      setTimeout(() => setCopyOk(null), 2500);
    } catch {
      setError("לא הצלחנו להעתיק — נסו שוב או סמנו את הטקסט ידנית.");
    }
  }

  function handleWhatsApp() {
    if (!orderText) return;
    openWhatsAppWithSupplierOrderText(orderText);
  }

  function handlePdf() {
    if (!draft) return;
    downloadSupplierPurchaseOrderPdf({
      id: draft.id,
      supplierName: draft.supplierName,
      externalOrderId: draft.externalOrderId,
      orderDate: draft.orderDate,
      createdAt: draft.createdAt,
      lines: draft.lines.map((l) => ({
        rawName: l.rawName,
        quantity: l.quantity,
        unitType: l.unitType,
      })),
    });
  }

  function handleMailto() {
    if (!draft || !orderText) return;
    const subject = `הזמנה #${draft.id} — ${draft.supplierName?.trim() || "ספק"}`;
    openSupplierOrderMailto(subject, orderText);
  }

  async function handleShareClick() {
    if (!canDispatch || !orderText) return;
    setError(null);

    if (
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function"
    ) {
      try {
        await navigator.share({
          title: "הזמנה לספק",
          text: orderText,
        });
      } catch (e: unknown) {
        const name =
          e &&
          typeof e === "object" &&
          "name" in e &&
          typeof (e as { name?: unknown }).name === "string"
            ? (e as { name: string }).name
            : "";
        if (name === "AbortError") return;
        setShareMenuOpen(true);
      }
      return;
    }

    setShareMenuOpen(true);
  }

  const displayDateLabel = draft
    ? formatSupplierDraftDisplayDate({
        id: draft.id,
        supplierName: draft.supplierName,
        externalOrderId: draft.externalOrderId,
        orderDate: draft.orderDate,
        createdAt: draft.createdAt,
        lines: draft.lines.map((l) => ({
          rawName: l.rawName,
          quantity: l.quantity,
          unitType: l.unitType,
        })),
      })
    : "";

  const createdLabel = draft
    ? new Date(draft.createdAt).toLocaleString("he-IL", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "";

  if (loading) {
    return (
      <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
        <PageHeader
          title="שליחת הזמנה לספק"
          backHref="/inventory/supplier-purchases"
        />
        <main
          style={{
            maxWidth: MAIN_MAX_WIDTH,
            margin: "0 auto",
            padding: 16,
            textAlign: "center",
            color: "#6b7280",
          }}
        >
          טוען הזמנה...
        </main>
      </div>
    );
  }

  if (error && !draft) {
    return (
      <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
        <PageHeader
          title="שליחת הזמנה לספק"
          backHref="/inventory/supplier-purchases"
        />
        <main style={{ maxWidth: MAIN_MAX_WIDTH, margin: "0 auto", padding: 16 }}>
          <section
            style={{
              border: "1px solid #fecaca",
              background: "#fef2f2",
              color: "#991b1b",
              borderRadius: 18,
              padding: 16,
              fontSize: 14,
              fontWeight: 800,
              textAlign: "center",
              lineHeight: 1.6,
            }}
          >
            {error}
          </section>
          <button
            type="button"
            onClick={() => router.push("/inventory/supplier-purchases")}
            style={{
              marginTop: 14,
              width: "100%",
              minHeight: 48,
              borderRadius: 16,
              border: "none",
              background: "#111827",
              color: "#fff",
              fontWeight: 950,
              cursor: "pointer",
            }}
          >
            חזרה להזמנות ספק
          </button>
        </main>
      </div>
    );
  }

  if (!draft) {
    return null;
  }

  const totalUnits = draft.lines.reduce(
    (s, l) => s + Number(l.quantity || 0),
    0
  );

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <PageHeader
        title="שליחת הזמנה לספק"
        backHref="/inventory/supplier-purchases"
      />

      <main
        style={{
          maxWidth: MAIN_MAX_WIDTH,
          margin: "0 auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {error && draft && (
          <div
            style={{
              border: "1px solid #fecaca",
              background: "#fef2f2",
              color: "#991b1b",
              borderRadius: 14,
              padding: 12,
              fontSize: 13,
              fontWeight: 800,
              textAlign: "center",
            }}
          >
            {error}
          </div>
        )}

        {copyOk && (
          <div
            style={{
              border: "1px solid #bbf7d0",
              background: "#f0fdf4",
              color: "#166534",
              borderRadius: 14,
              padding: 12,
              fontSize: 13,
              fontWeight: 800,
              textAlign: "center",
            }}
          >
            {copyOk}
          </div>
        )}

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 22,
            background: "#ffffff",
            padding: "14px 16px",
            boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              alignItems: "center",
              gap: 8,
              rowGap: 12,
            }}
          >
            {SUPPLIER_PURCHASE_FLOW_STEPS.map((label, i) => (
              <span
                key={label}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {i > 0 ? (
                  <span style={{ color: "#d1d5db", fontWeight: 900 }}>·</span>
                ) : null}
                <span
                  style={{
                    padding: "7px 14px",
                    borderRadius: 999,
                    fontSize: 12,
                    fontWeight: 950,
                    whiteSpace: "nowrap",
                    background:
                      i === CURRENT_FLOW_STEP_INDEX ? "#111827" : "#f3f4f6",
                    color:
                      i === CURRENT_FLOW_STEP_INDEX ? "#ffffff" : "#6b7280",
                    border:
                      i === CURRENT_FLOW_STEP_INDEX
                        ? "1px solid #111827"
                        : "1px solid #e5e7eb",
                  }}
                >
                  {label}
                </span>
              </span>
            ))}
          </div>
        </section>

        <section
          style={{
            borderRadius: 28,
            padding: 22,
            background:
              "linear-gradient(135deg, #111827 0%, #1f2937 50%, #0f766e 100%)",
            color: "#ffffff",
            boxShadow: "0 18px 44px rgba(15, 23, 42, 0.22)",
            textAlign: "center",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 15,
              lineHeight: 1.75,
              fontWeight: 800,
              color: "rgba(255,255,255,0.94)",
            }}
          >
            ההזמנה נוצרה. עכשיו אפשר לשלוח אותה לספק. לאחר קבלת הסחורה, חזור
            לבדיקת קבלה כדי לקלוט למלאי.
          </p>
        </section>

        {draft.status !== "PENDING_REVIEW" && (
          <section
            style={{
              border: "1px solid #fde68a",
              background: "#fffbeb",
              color: "#92400e",
              borderRadius: 18,
              padding: 14,
              fontSize: 13,
              fontWeight: 800,
              textAlign: "center",
              lineHeight: 1.55,
            }}
          >
            ההזמנה לא בשלב שליחה פעילה ({draft.status}). הפעולות למטה עשויות
            להיות לא רלוונטיות.
          </section>
        )}

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 22,
            background: "#ffffff",
            padding: 18,
            boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              display: "inline-flex",
              padding: "6px 12px",
              borderRadius: 999,
              background: "#fef3c7",
              color: "#92400e",
              fontSize: 12,
              fontWeight: 950,
              marginBottom: 12,
            }}
          >
            ממתינה לקליטת סחורה
          </div>

          <h1
            style={{
              margin: "0 0 8px",
              fontSize: 20,
              fontWeight: 950,
              color: "#111827",
            }}
          >
            {draft.supplierName?.trim() || "הזמנה ללא שם ספק"}
          </h1>

          <div
            style={{
              fontSize: 13,
              color: "#6b7280",
              lineHeight: 1.65,
            }}
          >
            <div>מספר פנימי: #{draft.id}</div>
            {draft.externalOrderId?.trim() ? (
              <div>מספר חיצוני: {draft.externalOrderId.trim()}</div>
            ) : null}
            <div>תאריך להזמנה: {displayDateLabel}</div>
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.9 }}>
              נוצרה במערכת: {createdLabel}
            </div>
          </div>
        </section>

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 22,
            background: "#ffffff",
            padding: 16,
            boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 950,
              color: "#111827",
              marginBottom: 12,
              textAlign: "center",
            }}
          >
            פריטים ({draft.lines.length}) · {totalUnits} יחידות
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {draft.lines.map((line) => (
              <div
                key={line.id}
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 16,
                  padding: 12,
                  background: "#f9fafb",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontWeight: 950,
                    fontSize: 14,
                    color: "#111827",
                  }}
                >
                  {line.rawName || "מוצר ללא שם"}
                </div>
                <div style={{ marginTop: 6, fontSize: 13, color: "#6b7280" }}>
                  כמות: {line.quantity} · יחידה: {line.unitType || "UNIT"}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 22,
            background: "#ffffff",
            padding: 18,
            boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 950,
              color: "#111827",
              marginBottom: 12,
              textAlign: "center",
            }}
          >
            שליחת ההזמנה
          </div>
          <p
            style={{
              margin: "0 0 16px",
              fontSize: 13,
              color: "#6b7280",
              lineHeight: 1.55,
              textAlign: "center",
            }}
          >
            שיתוף עם הספק או הורדת מסמך להדפסה
          </p>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <button
              type="button"
              disabled={!canDispatch}
              onClick={() => void handleShareClick()}
              style={{
                minHeight: 52,
                borderRadius: 16,
                border: "none",
                background: canDispatch ? "#111827" : "#e5e7eb",
                color: canDispatch ? "#ffffff" : "#9ca3af",
                fontWeight: 950,
                fontSize: 15,
                cursor: canDispatch ? "pointer" : "not-allowed",
              }}
            >
              שיתוף
            </button>

            <button
              type="button"
              disabled={!canDispatch}
              onClick={() => {
                setError(null);
                handlePdf();
              }}
              style={{
                minHeight: 48,
                borderRadius: 16,
                border: "1px solid #e5e7eb",
                background: "#ffffff",
                color: canDispatch ? "#111827" : "#9ca3af",
                fontWeight: 950,
                fontSize: 14,
                cursor: canDispatch ? "pointer" : "not-allowed",
              }}
            >
              הורדה כ־PDF
            </button>
          </div>
        </section>

        {shareMenuOpen && (
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
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-menu-title"
            onClick={() => setShareMenuOpen(false)}
          >
            <section
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                maxWidth: 380,
                borderRadius: 22,
                background: "#ffffff",
                boxShadow: "0 24px 70px rgba(15, 23, 42, 0.28)",
                padding: 20,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div
                id="share-menu-title"
                style={{
                  fontSize: 17,
                  fontWeight: 950,
                  color: "#111827",
                  textAlign: "center",
                  marginBottom: 4,
                }}
              >
                איך לשתף?
              </div>
              <button
                type="button"
                disabled={!canDispatch}
                onClick={() => {
                  setError(null);
                  handleWhatsApp();
                  setShareMenuOpen(false);
                }}
                style={{
                  minHeight: 48,
                  borderRadius: 14,
                  border: "1px solid #bbf7d0",
                  background: "#f0fdf4",
                  color: "#166534",
                  fontWeight: 950,
                  cursor: canDispatch ? "pointer" : "not-allowed",
                }}
              >
                WhatsApp
              </button>
              <button
                type="button"
                disabled={!canDispatch}
                onClick={() => {
                  setError(null);
                  handleMailto();
                  setShareMenuOpen(false);
                }}
                style={{
                  minHeight: 48,
                  borderRadius: 14,
                  border: "1px solid #bfdbfe",
                  background: "#eff6ff",
                  color: "#1d4ed8",
                  fontWeight: 950,
                  cursor: canDispatch ? "pointer" : "not-allowed",
                }}
              >
                פתיחה במייל
              </button>
              <button
                type="button"
                disabled={!canDispatch}
                onClick={() => {
                  setError(null);
                  void copyOrderText();
                  setShareMenuOpen(false);
                }}
                style={{
                  minHeight: 48,
                  borderRadius: 14,
                  border: "1px solid #e5e7eb",
                  background: "#ffffff",
                  color: "#111827",
                  fontWeight: 950,
                  cursor: canDispatch ? "pointer" : "not-allowed",
                }}
              >
                העתק נוסח
              </button>
              <button
                type="button"
                onClick={() => setShareMenuOpen(false)}
                style={{
                  minHeight: 44,
                  borderRadius: 14,
                  border: "none",
                  background: "#f3f4f6",
                  color: "#374151",
                  fontWeight: 900,
                  cursor: "pointer",
                }}
              >
                סגור
              </button>
            </section>
          </div>
        )}

        <button
          type="button"
          onClick={() =>
            router.push("/inventory/supplier-purchases/pending")
          }
          style={{
            minHeight: 52,
            borderRadius: 18,
            border: "none",
            background: "#059669",
            color: "#ffffff",
            fontSize: 15,
            fontWeight: 950,
            cursor: "pointer",
            boxShadow: "0 10px 22px rgba(5, 150, 105, 0.16)",
          }}
        >
          מעבר לבדיקת קבלה
        </button>

        <button
          type="button"
          onClick={() => router.push("/inventory/supplier-purchases")}
          style={{
            minHeight: 46,
            borderRadius: 16,
            border: "1px solid #e5e7eb",
            background: "#ffffff",
            color: "#374151",
            fontWeight: 900,
            cursor: "pointer",
          }}
        >
          חזרה למרכז הזמנות ספק
        </button>
      </main>
    </div>
  );
}
