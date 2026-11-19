/**
 * Purchase-order sheet — "שמירת עותק" of the supplier order document (owner-approved 2026-11-09). SERVER-ONLY.
 *
 * Saving renders the document the send screen produces — the inventory module's own builder, the same header (the
 * screen's title in the user's interface language) and the date rule in Israel time — stores the bytes create-once in
 * the private business-docs domain, and records the copy with a snapshot of exactly what was printed (the number = the
 * supplier order's id, the external number, supplier, lines, header, date, language). A later edit of the order never
 * changes a saved copy, and a download always returns the stored file itself.
 *
 * It is a saved copy, nothing more: it records WHEN it was saved, never that it was sent, and it does not claim to be
 * the file the supplier received (a re-rendering may use details changed since). It reads the supplier order and
 * never writes to it — no status, no receiving, no inventory change.
 *
 * Once per server-issued key (operation PURCHASE_ORDER_SHEET): a retry returns the first saved copy, never a second.
 * The order must belong to the business (the tenant read below, and the database guard of migration 20261121090000).
 */
import type { Locale } from "@/lib/i18n/config";
import { getStorageService, type StorageService } from "@/lib/storage";
import type { SupplierPurchaseDraftForDocument } from "@/lib/services/inventory/supplier-purchase-document.service";

import { bdTx, type BdTx } from "../bd-tx";
import { abandonPendingFile, commitFile, createPendingFile, sha256Hex, uploadCreateOnce } from "../files/business-docs-files";
import { attachRequestFile, canonicalJson, claimRequest, completeRequest, releaseRequest, requestHashOf } from "../requests/business-docs-requests";
import { renderSupplierOrderPdf, supplierOrderDisplayDate, supplierOrderHeaderTitle } from "./po-sheet-pdf";

export const PO_SHEET_LOCALES: readonly Locale[] = ["he", "en"];

export type PurchaseOrderSheetView = {
  id: number;
  supplierOrderId: number;
  displayedNumber: string;
  externalNumber: string | null;
  supplierName: string | null;
  displayDate: string;
  locale: string;
  savedAt: string;
  replay?: boolean;
};

export type SavePurchaseOrderSheetDeps = {
  storage?: StorageService;
  render?: typeof renderSupplierOrderPdf;
  now?: () => Date;
};

type SheetRow = { id: number; supplierPurchaseDraftId: number; displayedNumberSnapshot: string; externalNumberSnapshot: string | null; supplierNameSnapshot: string | null; displayDateSnapshot: string; locale: string; createdAt: Date };

function viewOf(r: SheetRow): PurchaseOrderSheetView {
  return {
    id: r.id,
    supplierOrderId: r.supplierPurchaseDraftId,
    displayedNumber: r.displayedNumberSnapshot,
    externalNumber: r.externalNumberSnapshot,
    supplierName: r.supplierNameSnapshot,
    displayDate: r.displayDateSnapshot,
    locale: r.locale,
    savedAt: r.createdAt.toISOString(),
  };
}

/** The supplier order exactly as the send screen maps it for its document (lines in creation order), or null. */
export async function supplierOrderForDocumentTx(tx: BdTx, businessId: number, supplierOrderId: number): Promise<SupplierPurchaseDraftForDocument | null> {
  const d = await tx.supplierPurchaseDraft.findFirst({
    where: { id: supplierOrderId, businessId },
    select: { id: true, supplierName: true, externalOrderId: true, orderDate: true, createdAt: true, lines: { orderBy: { id: "asc" }, select: { rawName: true, quantity: true, unitType: true } } },
  });
  if (!d) return null;
  return {
    id: d.id,
    supplierName: d.supplierName,
    externalOrderId: d.externalOrderId,
    orderDate: d.orderDate,
    createdAt: d.createdAt,
    lines: d.lines.map((l) => ({ rawName: l.rawName, quantity: l.quantity, unitType: l.unitType })),
  };
}

export class PurchaseOrderSheetNotFoundError extends Error {
  constructor() {
    super("supplier order not found");
    this.name = "PurchaseOrderSheetNotFoundError";
  }
}

export async function savePurchaseOrderSheet(
  input: { businessId: number; userId: number; supplierOrderId: number; locale: Locale; idempotencyKey: string },
  deps: SavePurchaseOrderSheetDeps = {}
): Promise<PurchaseOrderSheetView> {
  const { businessId, userId, supplierOrderId, locale, idempotencyKey } = input;
  const storage = deps.storage ?? getStorageService();
  const render = deps.render ?? renderSupplierOrderPdf;
  const now = deps.now ?? (() => new Date());
  const requestHash = requestHashOf({ op: "PURCHASE_ORDER_SHEET", supplierOrderId, locale });

  const claim = await bdTx(businessId, (tx) => claimRequest(tx, businessId, "PURCHASE_ORDER_SHEET", idempotencyKey, requestHash));
  if (claim.kind === "REPLAY") {
    const r = await bdTx(businessId, (tx) => tx.purchaseOrderSheet.findFirstOrThrow({ where: { businessId, id: claim.resultId } }));
    return { ...viewOf(r), replay: true };
  }

  let fileId: number | null = null;
  try {
    const order = await bdTx(businessId, (tx) => supplierOrderForDocumentTx(tx, businessId, supplierOrderId));
    if (!order) throw new PurchaseOrderSheetNotFoundError();
    const headerTitle = supplierOrderHeaderTitle(locale);
    const displayDate = supplierOrderDisplayDate(order, now());
    const bytes = await render(order, { headerTitle, displayDate });
    if (!bytes || bytes.length === 0) throw new Error("the renderer produced no bytes");

    const documentSnapshot = {
      id: order.id,
      supplierName: order.supplierName,
      externalOrderId: order.externalOrderId ?? null,
      orderDate: order.orderDate ? new Date(order.orderDate).toISOString() : null,
      createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : null,
      lines: order.lines,
    };
    const contentHash = sha256Hex(Buffer.from(canonicalJson({ documentSnapshot, headerTitle, displayDate, locale }), "utf8"));
    const external = order.externalOrderId?.trim() || null;

    const pending = await bdTx(businessId, async (tx) => {
      const f = await createPendingFile(tx, businessId, "PURCHASE_ORDER_SHEET", claim.leaseOwner);
      await attachRequestFile(tx, claim.requestId, claim.leaseOwner, f.id);
      return f;
    });
    fileId = pending.id;
    if ((await uploadCreateOnce(businessId, pending.objectKey, bytes, storage)) !== "CREATED") throw new Error("a fresh object key was already taken");

    const saved = await bdTx(businessId, async (tx) => {
      if (!(await commitFile(tx, businessId, pending.id, claim.leaseOwner, bytes))) throw new Error("the upload lease was lost");
      const row = await tx.purchaseOrderSheet.create({
        data: {
          businessId,
          supplierPurchaseDraftId: order.id,
          fileId: pending.id,
          sha256: sha256Hex(bytes),
          contentHash,
          displayedNumberSnapshot: `#${order.id}`,
          externalNumberSnapshot: external ? external.slice(0, 200) : null,
          supplierNameSnapshot: order.supplierName ? order.supplierName.slice(0, 300) : null,
          documentSnapshot,
          locale,
          headerTitleSnapshot: headerTitle,
          displayDateSnapshot: displayDate,
          createdByUserId: userId,
        },
      });
      await completeRequest(tx, claim.requestId, claim.leaseOwner, row.id);
      return row;
    });
    return viewOf(saved);
  } catch (error) {
    await bdTx(businessId, async (tx) => {
      if (fileId !== null) await abandonPendingFile(tx, businessId, fileId);
      await releaseRequest(tx, claim.requestId, claim.leaseOwner);
    }).catch(() => undefined);
    throw error;
  }
}

/** The saved copies of one supplier order, newest first. */
export async function listPurchaseOrderSheets(businessId: number, supplierOrderId: number): Promise<PurchaseOrderSheetView[]> {
  const rows = await bdTx(businessId, (tx) =>
    tx.purchaseOrderSheet.findMany({ where: { businessId, supplierPurchaseDraftId: supplierOrderId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 })
  );
  return rows.map(viewOf);
}

/** The stored file of a saved copy (of this business), or null. */
export async function purchaseOrderSheetFile(businessId: number, sheetId: number): Promise<{ fileId: number; supplierOrderId: number } | null> {
  const r = await bdTx(businessId, (tx) => tx.purchaseOrderSheet.findFirst({ where: { businessId, id: sheetId }, select: { fileId: true, supplierPurchaseDraftId: true } }));
  return r ? { fileId: r.fileId, supplierOrderId: r.supplierPurchaseDraftId } : null;
}
