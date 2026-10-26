/**
 * Document ↔ supplier link — the owner's decision for one document (flag `document_supplier_linking`).
 *
 *   GET   the current link, the reading and the suggestions (never a link by itself);
 *   POST  { action: "link", supplierId, method, suggestionReason?, expectedVersion, idempotencyKey? }
 *         { action: "unlink", expectedVersion, idempotencyKey? }
 *         { action: "dismiss", supplierId, idempotencyKey? }   — "not this supplier"
 *
 * The business is the session's; a document or supplier of another business is 404. A stale
 * expectedVersion is 409 STALE_VERSION: the screen reloads and shows what changed.
 */
import {
  dismissSuggestion,
  getDocumentSupplierLinkState,
  linkDocumentToSupplier,
  unlinkDocument,
  type LinkMethod,
  type SuggestionReason,
} from "@/lib/services/documents/supplier-link/supplier-link.service";
import { invalid, positiveInt, supplierLinkRoute } from "@/lib/services/documents/supplier-link/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, context: Ctx) {
  const { id } = await context.params;
  return supplierLinkRoute(req, async ({ businessId }) => {
    const documentId = positiveInt(id) ?? invalid();
    return getDocumentSupplierLinkState(businessId, documentId);
  });
}

export async function POST(req: Request, context: Ctx) {
  const { id } = await context.params;
  return supplierLinkRoute(req, async ({ businessId, userId }) => {
    const documentId = positiveInt(id) ?? invalid();
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") invalid();
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
    const expectedVersion =
      typeof body.expectedVersion === "number" && Number.isInteger(body.expectedVersion) && body.expectedVersion >= 0
        ? body.expectedVersion
        : null;

    switch (body.action) {
      case "link": {
        const supplierId = positiveInt(body.supplierId) ?? invalid();
        const method = body.method === "MANUAL_PICK" || body.method === "SUGGESTION_ACCEPTED" ? (body.method as LinkMethod) : invalid();
        const suggestionReason =
          body.suggestionReason === "TAX_ID" || body.suggestionReason === "NAME"
            ? (body.suggestionReason as SuggestionReason)
            : null;
        if (expectedVersion === null) invalid();
        return linkDocumentToSupplier({
          businessId, userId, documentId, supplierId, method, suggestionReason, expectedVersion, idempotencyKey,
        });
      }
      case "unlink":
        if (expectedVersion === null) invalid();
        return unlinkDocument({ businessId, userId, documentId, expectedVersion, idempotencyKey });
      case "dismiss": {
        const supplierId = positiveInt(body.supplierId) ?? invalid();
        return dismissSuggestion({ businessId, userId, documentId, supplierId, idempotencyKey });
      }
      default:
        invalid();
    }
  });
}
