/**
 * Saved copies of a supplier order's document ("שמירת עותק").
 *   GET  /api/business-documents/supplier-orders/[id]/sheets → the saved copies, newest first (with the date saved).
 *   POST /api/business-documents/supplier-orders/[id]/sheets {idempotencyKey, locale} → render the document the send
 *        screen produces (the inventory module's own builder; header in that language; the date rule in Israel time),
 *        store it create-once and record it with a snapshot. A retry with the same key returns the same copy.
 * [id] is the supplier order (SupplierPurchaseDraft) id — the number printed on the document. It records WHEN the copy
 * was saved, never that anything was sent. Session + flag (404 when off).
 */
import { NextResponse, type NextRequest } from "next/server";

import { isLocale } from "@/lib/i18n/config";
import { businessDocumentsRoute, readJsonBody, routeId } from "@/lib/services/business-documents/business-documents-http";
import { listPurchaseOrderSheets, PurchaseOrderSheetNotFoundError, savePurchaseOrderSheet } from "@/lib/services/business-documents/po-sheet/po-sheet.service";

export const runtime = "nodejs";
export const maxDuration = 60;

const notFound = () => NextResponse.json({ error: "NOT_FOUND", message: "ההזמנה לא נמצאה" }, { status: 404 });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return businessDocumentsRoute(req, async ({ businessId }) => {
    const orderId = routeId((await params).id);
    if (orderId === null) return notFound();
    return NextResponse.json({ sheets: await listPurchaseOrderSheets(businessId, orderId) }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return businessDocumentsRoute(req, async ({ businessId, userId }) => {
    const orderId = routeId((await params).id);
    if (orderId === null) return notFound();
    const body = await readJsonBody(req);
    if (!isLocale(body.locale)) {
      return NextResponse.json({ error: "VALIDATION", problems: [{ field: "locale", message: "שפה לא מוכרת" }] }, { status: 400 });
    }
    try {
      const saved = await savePurchaseOrderSheet({ businessId, userId, supplierOrderId: orderId, locale: body.locale, idempotencyKey: String(body.idempotencyKey ?? "") });
      return NextResponse.json(saved, { status: saved.replay ? 200 : 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof PurchaseOrderSheetNotFoundError) return notFound();
      throw error;
    }
  });
}
