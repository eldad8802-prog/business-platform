"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
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
      setError("מזהה ההזמנה לא תקין");
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
      setError(e instanceof Error ? e.message : "שגיאה בטעינת ההזמנה");
      setDraft(null);
    } finally {
      setLoading(false);
    }
  }, [draftIdFromRoute]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadDraft();
    });
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
      setCopyOk("נוסח ההזמנה הועתק.");
      setTimeout(() => setCopyOk(null), 2500);
    } catch {
      setError("לא הצלחנו להעתיק. אפשר לסמן את הטקסט ידנית.");
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
    const subject = `הזמנה #${draft.id} - ${
      draft.supplierName?.trim() || "ספק"
    }`;
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

  const totalUnits =
    draft?.lines.reduce((s, l) => s + Number(l.quantity || 0), 0) ?? 0;

  return (
    <InventorySubPage
      title="שליחת הזמנה לספק"
      backHref="/inventory/supplier-purchases"
      backLabel="מרכז הזמנות ספק"
      bottomNav="orders"
    >
      {loading ? (
        <section className="inv-surface-card inv-center-state" aria-busy="true">
          טוען הזמנה...
        </section>
      ) : error && !draft ? (
        <section className="inv-surface-card inv-center-state">
          <strong>לא הצלחנו לפתוח את ההזמנה</strong>
          <p>{error}</p>
          <button
            type="button"
            className="inv-primary-button"
            onClick={() => router.push("/inventory/supplier-purchases")}
          >
            חזרה למרכז ההזמנות
          </button>
        </section>
      ) : draft ? (
        <div className="inv-screen-stack">
          {error ? <div className="inv-alert inv-alert--error">{error}</div> : null}
          {copyOk ? (
            <div className="inv-alert inv-alert--success">{copyOk}</div>
          ) : null}

          <section className="inv-hero-card inv-hero-card--green">
            <span className="inv-kicker">שלב: שליחה לספק</span>
            <h1>
              {draft.supplierName?.trim()
                ? `הזמנה ל${draft.supplierName.trim()}`
                : "הזמנה מוכנה לשליחה"}
            </h1>
            <p>
              ההזמנה נוצרה. עכשיו שולחים אותה לספק, ולאחר הגעת הסחורה חוזרים
              לקליטה כדי לעדכן מלאי.
            </p>
          </section>

          <section className="inv-surface-card">
            <div className="inv-mini-stepper" aria-label="רצף הזמנה">
              {["יצירה", "שליחה", "קליטה", "היסטוריה"].map((label, index) => (
                <span
                  key={label}
                  className={`inv-mini-step${
                    index === 1 ? " is-current" : index < 1 ? " is-done" : ""
                  }`}
                >
                  {label}
                </span>
              ))}
            </div>
          </section>

          <section className="inv-surface-card">
            <div className="inv-section-heading">
              <h2>מה כלול בהזמנה</h2>
              <span>
                {draft.lines.length} פריטים · {totalUnits} יחידות
              </span>
            </div>
            <div className="inv-data-pairs">
              <div>
                <span>מספר פנימי</span>
                <strong>#{draft.id}</strong>
              </div>
              <div>
                <span>תאריך הזמנה</span>
                <strong>{displayDateLabel}</strong>
              </div>
              <div>
                <span>מצב</span>
                <strong>
                  {draft.status === "PENDING_REVIEW"
                    ? "ממתינה לקליטה"
                    : draft.status}
                </strong>
              </div>
            </div>
            <ul className="inv-simple-list" role="list">
              {draft.lines.map((line) => (
                <li key={line.id}>
                  <span>{line.rawName || "מוצר ללא שם"}</span>
                  <strong>
                    {line.quantity} {line.unitType || "יחידות"}
                  </strong>
                </li>
              ))}
            </ul>
          </section>

          <section className="inv-surface-card">
            <div className="inv-section-heading">
              <h2>פעולה הבאה</h2>
              <span>בחרו איך לשלוח לספק</span>
            </div>
            <div className="inv-action-grid">
              <button
                type="button"
                disabled={!canDispatch}
                onClick={() => void handleShareClick()}
                className="inv-primary-button"
              >
                שתף הזמנה
              </button>
              <button
                type="button"
                disabled={!canDispatch}
                onClick={handlePdf}
                className="inv-secondary-button"
              >
                הורדת PDF
              </button>
              <button
                type="button"
                onClick={() => router.push("/inventory/supplier-purchases/pending")}
                className="inv-secondary-button"
              >
                מעבר לקליטת הזמנות
              </button>
            </div>
          </section>

          {shareMenuOpen ? (
            <div
              className="inv-modal-backdrop"
              role="dialog"
              aria-modal="true"
              aria-labelledby="share-menu-title"
              onClick={() => setShareMenuOpen(false)}
            >
              <section
                className="inv-modal-panel"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 id="share-menu-title">איך לשלוח לספק?</h2>
                <button type="button" onClick={handleWhatsApp}>
                  WhatsApp
                </button>
                <button type="button" onClick={handleMailto}>
                  פתיחה במייל
                </button>
                <button type="button" onClick={() => void copyOrderText()}>
                  העתקת נוסח
                </button>
                <button type="button" onClick={() => setShareMenuOpen(false)}>
                  סגירה
                </button>
              </section>
            </div>
          ) : null}
        </div>
      ) : null}
    </InventorySubPage>
  );
}
