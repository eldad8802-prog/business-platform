"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  buildSupplierOrderText,
  downloadSupplierPurchaseOrderPdf,
  openSupplierOrderMailto,
  openWhatsAppWithSupplierOrderText,
  type SupplierPurchaseDraftForDocument,
} from "@/lib/services/inventory/supplier-purchase-document.service";
import { buildClientAuthHeaders, redirectToLogin } from "@/lib/client-session";
import { getInventoryItems, type InventoryItemDTO } from "@/lib/api/inventory";
import { getSupplier } from "@/lib/api/suppliers";
import { qtyWithUnit } from "@/lib/inventory/unit-words";
import { draftStatus, formatOrderDate } from "@/lib/inventory/purchase-order-view";
import {
  I2,
  InvButton,
  InvError,
  InvLoading,
  InvNote,
  InvPage,
  InvStatus,
  ProductThumb,
} from "@/components/inventory/v2/kit";

type DraftLine = {
  id: number;
  rawName: string | null;
  quantity: number;
  unitType: string | null;
  matchedItemId?: number | null;
};

type ApiDraft = {
  id: number;
  supplierId?: number | null;
  supplierName: string | null;
  externalOrderId: string | null;
  orderDate: string | null;
  createdAt: string;
  status: string;
  lines: DraftLine[];
};

function toDocument(draft: ApiDraft): SupplierPurchaseDraftForDocument {
  return {
    id: draft.id,
    supplierName: draft.supplierName,
    externalOrderId: draft.externalOrderId,
    orderDate: draft.orderDate,
    createdAt: draft.createdAt,
    lines: draft.lines.map((l) => ({ rawName: l.rawName, quantity: l.quantity, unitType: l.unitType })),
  };
}

/**
 * Order detail for a wizard / CSV draft (redesign, mockup "פרטי הזמנה").
 * Sharing (WhatsApp without a number, mail without an address, clipboard, PDF) is
 * unchanged and only offered while the draft awaits receipt. Sharing never marks the
 * order as sent and never changes stock. The phone icon is a call link only.
 */
export default function SupplierPurchaseSendPage() {
  const params = useParams();
  const rawId = params?.id;
  const draftIdFromRoute = Number(Array.isArray(rawId) ? rawId[0] : rawId ?? NaN);

  const [draft, setDraft] = useState<ApiDraft | null>(null);
  const [items, setItems] = useState<Map<number, InventoryItemDTO>>(new Map());
  const [phone, setPhone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copyOk, setCopyOk] = useState(false);

  const loadDraft = useCallback(async () => {
    if (!draftIdFromRoute || Number.isNaN(draftIdFromRoute)) {
      setError("מספר ההזמנה אינו תקין.");
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      // Unchanged: the drafts list is loaded and the one draft is found in it.
      const res = await fetch("/api/inventory/supplier-purchases", {
        method: "GET",
        headers: buildClientAuthHeaders(),
        cache: "no-store",
      });
      if (res.status === 401) return redirectToLogin();
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "load failed");
      const list: ApiDraft[] = Array.isArray(data?.drafts) ? data.drafts : [];
      const found = list.find((d) => d.id === draftIdFromRoute) ?? null;
      if (!found) {
        setDraft(null);
        setError("ההזמנה לא נמצאה.");
        return;
      }
      setDraft(found);
      // Optional context: product images, and the supplier's phone for a call link.
      void getInventoryItems()
        .then((list2) => setItems(new Map(list2.map((i) => [i.id, i]))))
        .catch(() => setItems(new Map()));
      if (found.supplierId != null) {
        void getSupplier(found.supplierId)
          .then((s) => setPhone(s?.phone?.trim() || null))
          .catch(() => setPhone(null));
      }
    } catch {
      setError(null);
      setDraft(null);
    } finally {
      setLoading(false);
    }
  }, [draftIdFromRoute]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDraft(), 0);
    return () => window.clearTimeout(timer);
  }, [loadDraft]);

  const orderText = useMemo(() => (draft ? buildSupplierOrderText(toDocument(draft)) : ""), [draft]);
  const canDispatch = draft?.status === "PENDING_REVIEW" && draft.lines.length > 0;
  const pending = draft?.status === "PENDING_REVIEW";

  async function copyOrderText() {
    if (!orderText) return;
    try {
      await navigator.clipboard.writeText(orderText);
      setShareError(null);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 2500);
    } catch {
      setShareError("לא הצלחנו להעתיק. נסו שוב.");
    }
  }

  function handleWhatsApp() {
    if (!orderText) return;
    openWhatsAppWithSupplierOrderText(orderText);
  }

  function handleMailto() {
    if (!draft || !orderText) return;
    const subject = `הזמנה #${draft.id} - ${draft.supplierName?.trim() || "ספק"}`;
    openSupplierOrderMailto(subject, orderText);
  }

  function handlePdf() {
    if (!draft) return;
    downloadSupplierPurchaseOrderPdf(toDocument(draft));
  }

  const status = draft ? draftStatus(draft.status) : null;

  return (
    <InvPage
      title="פרטי הזמנה"
      backFallback="/inventory/supplier-purchases"
      footer={
        draft && pending ? (
          <>
            <div className="i2-footer__row">
              <InvButton href={`/inventory/supplier-purchases/pending?draft=${draft.id}`}>מעבר לקליטה מלאה</InvButton>
            </div>
            <p className="i2-footer__note">אישור הקליטה יוסיף את כל הכמויות למלאי</p>
          </>
        ) : undefined
      }
    >
      {loading ? (
        <InvLoading rows={4} />
      ) : !draft ? (
        <InvError message={error ?? undefined} onRetry={() => void loadDraft()} />
      ) : (
        <>
          <p className="i2-row__kicker" style={{ margin: "8px 0 0" }}>טיוטת הזמנה</p>
          <h2 className="i2-h2" style={{ margin: "2px 0 6px", fontSize: 24 }}>
            <bdi>הזמנה {draft.id}</bdi>
          </h2>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 17, fontWeight: 500, overflowWrap: "anywhere" }}>
              <bdi>{draft.supplierName?.trim() || "ללא ספק"}</bdi>
            </span>
            {phone ? (
              <a className="i2-iconbtn" href={`tel:${phone.replace(/[^\d+]/g, "")}`} aria-label={`התקשרות לספק · ${phone}`}>
                {I2.phone(20)}
              </a>
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", margin: "8px 0 4px" }}>
            {status ? <InvStatus tone={status.tone}>{status.label}</InvStatus> : null}
            <span className="i2-muted i2-num">תאריך הזמנה: {formatOrderDate(draft.orderDate ?? draft.createdAt) || "—"}</span>
          </div>

          <table className="i2-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>מוצר</th>
                <th style={{ width: "34%" }}>כמות</th>
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((line) => {
                const item = line.matchedItemId != null ? items.get(line.matchedItemId) : undefined;
                const name = line.rawName?.trim() || item?.name || "מוצר ללא שם";
                return (
                  <tr key={line.id}>
                    <td>
                      <span className="i2-cellprod">
                        <ProductThumb src={item?.imageUrl} name={name} size={40} />
                        <span style={{ overflowWrap: "anywhere" }}>{name}</span>
                      </span>
                    </td>
                    <td className="i2-num">{qtyWithUnit(line.quantity, line.unitType)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {canDispatch ? (
            <>
              <h3 className="i2-h3">שיתוף עם הספק</h3>
              <div className="i2-tiles i2-tiles--3">
                <button type="button" className="i2-tile" onClick={handleWhatsApp}>
                  {I2.whatsapp(26)}
                  <span>וואטסאפ</span>
                </button>
                <button type="button" className="i2-tile" onClick={handleMailto}>
                  {I2.mail(26)}
                  <span>מייל</span>
                </button>
                <button type="button" className="i2-tile" onClick={() => void copyOrderText()}>
                  {I2.copy(26)}
                  <span>{copyOk ? "הועתק" : "העתקה"}</span>
                </button>
              </div>
              <div style={{ marginTop: 10 }}>
                <InvButton kind="secondary" block onClick={handlePdf}>
                  {I2.pdf(20)} הורדת PDF
                </InvButton>
              </div>
              {copyOk ? <InvNote tone="ok">נוסח ההזמנה הועתק</InvNote> : null}
              {shareError ? <InvNote tone="danger">{shareError}</InvNote> : null}
              <InvNote>שיתוף ההזמנה אינו מעדכן מלאי</InvNote>
            </>
          ) : draft.status === "APPROVED" ? (
            <InvNote tone="ok">ההזמנה נקלטה במלאי.</InvNote>
          ) : draft.status === "REJECTED" ? (
            <InvNote>ההזמנה בוטלה. המלאי לא השתנה.</InvNote>
          ) : null}
        </>
      )}
    </InvPage>
  );
}
