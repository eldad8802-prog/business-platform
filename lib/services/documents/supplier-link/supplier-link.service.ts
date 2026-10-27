/**
 * Document ↔ supplier link (milestone 1) — SERVER-ONLY.
 *
 * The owner's DECISION of which supplier a document belongs to. Nothing here links by itself:
 *   - suggestions are computed on read (same tax id, or the same name) and are only suggestions — the owner
 *     accepts one, picks a supplier, or says "not this supplier" (never suggested again for this document);
 *   - a name alone is a WEAK suggestion; a tax id only counts when the reading's check is OK;
 *   - the business itself is never suggested (its own name / tax id are the document's recipient);
 *   - nothing is created: no supplier, no expense, no payment.
 *
 * Every change names the version it saw (optimistic concurrency) and may carry an idempotency key; each one
 * writes exactly one row of the append-only trail. Everything runs in one tenant transaction, under FORCE RLS,
 * with the business taken from the session — a document or supplier of another business is "not found".
 */
import { authoritativeTaxId } from "@/lib/identity/tax-id";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import {
  buildOwnBusinessIdentity,
  isOwnName,
  nameKey,
  type OwnBusinessIdentity,
} from "@/lib/services/documents/issuer/issuer-reading";

export type LinkMethod = "MANUAL_PICK" | "SUGGESTION_ACCEPTED";
export type SuggestionReason = "TAX_ID" | "NAME";

export class DocumentSupplierLinkError extends Error {
  constructor(
    readonly code:
      | "DOCUMENT_NOT_FOUND"
      | "SUPPLIER_NOT_FOUND"
      | "STALE_VERSION"
      | "NOT_LINKED"
      | "SUGGESTION_STALE"
      | "IDEMPOTENCY_KEY_REUSED"
      | "INVALID_REQUEST",
    readonly status: number
  ) {
    super(code);
  }
}

export type SupplierSuggestion = {
  supplierId: number;
  name: string;
  isActive: boolean;
  reason: SuggestionReason;
  /** TAX_ID = the document's valid issuer tax id equals the supplier's; NAME = the same name only (weak). */
  strength: "STRONG" | "WEAK";
};

export type SuggestionNote =
  | "NO_READING"
  | "INCOME_DOCUMENT"
  | "OWN_BUSINESS_NAME"
  | "SEVERAL_SUPPLIERS_SHARE_TAX_ID"
  | "TAX_ID_INVALID"
  | "CONFLICTING_TAX_IDS";

export type DocumentSupplierLinkState = {
  documentId: number;
  /** 0 = no decision was ever made for this document. */
  version: number;
  link: {
    supplierId: number;
    supplierName: string;
    supplierActive: boolean;
    method: LinkMethod;
    suggestionReason: SuggestionReason | null;
    linkedAt: string;
  } | null;
  reading: {
    vendorName: string | null;
    /**
     * The reading names a supplier the screen may present as identified: a distinctive name (not a generic word
     * such as "חשבונית") that is not the business itself. False ⇒ "no supplier identified with confidence".
     */
    vendorIdentified: boolean;
    issuerTaxId: string | null;
    issuerCheck: string | null;
    ownBusinessExcluded: boolean;
  } | null;
  suggestions: SupplierSuggestion[];
  notes: SuggestionNote[];
  replayed?: boolean;
};

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const SUPPLIER_SCAN_CAP = 5000;

function inTenant<T>(businessId: number, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return runWithTenantContext({ businessId }, () => withTenantTransaction(fn));
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === "P2002";
}

async function loadOwnIdentityTx(tx: TenantTx, businessId: number): Promise<OwnBusinessIdentity> {
  const business = await tx.business.findFirst({ where: { id: businessId }, select: { name: true } });
  const profile = await tx.businessProfile.findFirst({
    where: { businessId },
    select: { billingLegalName: true, billingTaxId: true, billingVatNumber: true },
  });
  const own = buildOwnBusinessIdentity({
    businessName: business?.name ?? null,
    legalName: profile?.billingLegalName ?? null,
    taxId: profile?.billingTaxId ?? null,
  });
  const vat = buildOwnBusinessIdentity({ taxId: profile?.billingVatNumber ?? null });
  return { taxIds: [...new Set([...own.taxIds, ...vat.taxIds])], nameKeys: own.nameKeys };
}

async function requireDocument(tx: TenantTx, businessId: number, documentId: number) {
  const doc = await tx.document.findFirst({ where: { id: documentId, businessId }, select: { id: true } });
  if (!doc) throw new DocumentSupplierLinkError("DOCUMENT_NOT_FOUND", 404);
}

async function requireSupplier(tx: TenantTx, businessId: number, supplierId: number) {
  const s = await tx.supplier.findFirst({
    where: { id: supplierId, businessId },
    select: { id: true, name: true, isActive: true },
  });
  if (!s) throw new DocumentSupplierLinkError("SUPPLIER_NOT_FOUND", 404);
  return s;
}

/** Suggestions for one document, from its reading and the business's suppliers. Read-only. */
export async function computeSuggestionsTx(
  tx: TenantTx,
  businessId: number,
  documentId: number,
  linkedSupplierId: number | null
): Promise<{ suggestions: SupplierSuggestion[]; notes: SuggestionNote[]; reading: DocumentSupplierLinkState["reading"] }> {
  const extracted = await tx.extractedData.findFirst({
    where: { documentId, document: { businessId } },
    select: {
      vendorName: true,
      direction: true,
      issuerTaxId: true,
      issuerCheck: true,
      ownBusinessExcluded: true,
    },
  });
  if (!extracted) return { suggestions: [], notes: ["NO_READING"], reading: null };
  const own = await loadOwnIdentityTx(tx, businessId);
  const vendorKey = nameKey(extracted.vendorName);
  const reading = {
    vendorName: extracted.vendorName,
    vendorIdentified: vendorKey !== null && !isOwnName(own, extracted.vendorName),
    issuerTaxId: extracted.issuerTaxId,
    issuerCheck: extracted.issuerCheck,
    ownBusinessExcluded: extracted.ownBusinessExcluded,
  };
  const notes: SuggestionNote[] = [];
  if (extracted.direction === "income") return { suggestions: [], notes: ["INCOME_DOCUMENT"], reading };
  if (extracted.issuerCheck === "TAX_ID_INVALID") notes.push("TAX_ID_INVALID");
  if (extracted.issuerCheck === "CONFLICTING_TAX_IDS") notes.push("CONFLICTING_TAX_IDS");

  const dismissed = new Set(
    (
      await tx.documentSupplierLinkEvent.findMany({
        where: { businessId, documentId, action: "SUGGESTION_DISMISSED" },
        select: { supplierId: true },
      })
    ).map((e) => e.supplierId)
  );
  const skip = (id: number) => dismissed.has(id) || id === linkedSupplierId;

  const suppliers = await tx.supplier.findMany({
    where: { businessId },
    select: { id: true, name: true, legalName: true, isActive: true, taxId: true },
    orderBy: { id: "asc" },
    take: SUPPLIER_SCAN_CAP,
  });

  const out = new Map<number, SupplierSuggestion>();
  if (extracted.issuerCheck === "OK" && extracted.issuerTaxId) {
    const byTaxId = suppliers.filter((s) => authoritativeTaxId(s.taxId) === extracted.issuerTaxId);
    if (byTaxId.length > 1) notes.push("SEVERAL_SUPPLIERS_SHARE_TAX_ID");
    for (const s of byTaxId) {
      if (skip(s.id)) continue;
      out.set(s.id, { supplierId: s.id, name: s.name, isActive: s.isActive, reason: "TAX_ID", strength: "STRONG" });
    }
  }

  if (vendorKey && isOwnName(own, extracted.vendorName)) {
    // A reading from before the own-business guard (or a business renamed since): its "vendor" is the business.
    notes.push("OWN_BUSINESS_NAME");
  } else if (vendorKey) {
    for (const s of suppliers) {
      if (skip(s.id) || out.has(s.id)) continue;
      if (nameKey(s.name) === vendorKey || nameKey(s.legalName) === vendorKey) {
        out.set(s.id, { supplierId: s.id, name: s.name, isActive: s.isActive, reason: "NAME", strength: "WEAK" });
      }
    }
  }

  const suggestions = [...out.values()].sort(
    (a, b) =>
      Number(b.reason === "TAX_ID") - Number(a.reason === "TAX_ID") ||
      Number(b.isActive) - Number(a.isActive) ||
      a.supplierId - b.supplierId
  );
  return { suggestions, notes, reading };
}

async function stateTx(tx: TenantTx, businessId: number, documentId: number): Promise<DocumentSupplierLinkState> {
  await requireDocument(tx, businessId, documentId);
  const row = await tx.documentSupplierLink.findFirst({ where: { businessId, documentId } });
  let link: DocumentSupplierLinkState["link"] = null;
  if (row && row.status === "ACTIVE" && row.supplierId != null) {
    const s = await tx.supplier.findFirst({
      where: { id: row.supplierId, businessId },
      select: { name: true, isActive: true },
    });
    link = {
      supplierId: row.supplierId,
      supplierName: s?.name ?? "",
      supplierActive: s?.isActive ?? false,
      method: row.method as LinkMethod,
      suggestionReason: (row.suggestionReason as SuggestionReason | null) ?? null,
      linkedAt: (row.linkedAt ?? row.updatedAt).toISOString(),
    };
  }
  const { suggestions, notes, reading } = await computeSuggestionsTx(
    tx,
    businessId,
    documentId,
    link?.supplierId ?? null
  );
  return { documentId, version: row?.version ?? 0, link, reading, suggestions, notes };
}

export function getDocumentSupplierLinkState(businessId: number, documentId: number) {
  return inTenant(businessId, (tx) => stateTx(tx, businessId, documentId));
}

type ChangeBase = {
  businessId: number;
  userId: number;
  documentId: number;
  /** The version the caller saw (0 = no decision yet). */
  expectedVersion: number;
  idempotencyKey?: string | null;
};

function checkKey(key: string | null | undefined) {
  if (key != null && !IDEMPOTENCY_KEY.test(key)) throw new DocumentSupplierLinkError("INVALID_REQUEST", 400);
}

/** A repeated request (same key) returns the current state; the same key on another document is refused. */
async function replayTx(tx: TenantTx, businessId: number, documentId: number, key: string | null | undefined) {
  if (!key) return null;
  const ev = await tx.documentSupplierLinkEvent.findFirst({
    where: { businessId, idempotencyKey: key },
    select: { documentId: true },
  });
  if (!ev) return null;
  if (ev.documentId !== documentId) throw new DocumentSupplierLinkError("IDEMPOTENCY_KEY_REUSED", 409);
  return { ...(await stateTx(tx, businessId, documentId)), replayed: true };
}

async function withReplay(
  input: ChangeBase,
  fn: (tx: TenantTx) => Promise<DocumentSupplierLinkState>
): Promise<DocumentSupplierLinkState> {
  checkKey(input.idempotencyKey);
  try {
    return await inTenant(input.businessId, async (tx) => {
      const replay = await replayTx(tx, input.businessId, input.documentId, input.idempotencyKey);
      return replay ?? fn(tx);
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // A concurrent request won: the same key ⇒ return what it did; otherwise our version was stale.
    const replay = input.idempotencyKey
      ? await inTenant(input.businessId, (tx) =>
          replayTx(tx, input.businessId, input.documentId, input.idempotencyKey)
        )
      : null;
    if (replay) return replay;
    throw new DocumentSupplierLinkError("STALE_VERSION", 409);
  }
}

export function linkDocumentToSupplier(
  input: ChangeBase & { supplierId: number; method: LinkMethod; suggestionReason?: SuggestionReason | null }
): Promise<DocumentSupplierLinkState> {
  const { businessId, documentId, supplierId, method } = input;
  const reason = method === "SUGGESTION_ACCEPTED" ? input.suggestionReason ?? null : null;
  if (method === "SUGGESTION_ACCEPTED" && !reason) throw new DocumentSupplierLinkError("INVALID_REQUEST", 400);
  return withReplay(input, async (tx) => {
    await requireDocument(tx, businessId, documentId);
    await requireSupplier(tx, businessId, supplierId);
    const row = await tx.documentSupplierLink.findFirst({ where: { businessId, documentId } });
    const current = row?.version ?? 0;
    if (current !== input.expectedVersion) throw new DocumentSupplierLinkError("STALE_VERSION", 409);
    if (row?.status === "ACTIVE" && row.supplierId === supplierId) return stateTx(tx, businessId, documentId);

    if (method === "SUGGESTION_ACCEPTED") {
      // The provenance is checked, not trusted: the supplier must be suggested NOW, for that reason.
      const { suggestions } = await computeSuggestionsTx(tx, businessId, documentId, row?.status === "ACTIVE" ? row.supplierId : null);
      if (!suggestions.some((s) => s.supplierId === supplierId && s.reason === reason)) {
        throw new DocumentSupplierLinkError("SUGGESTION_STALE", 409);
      }
    }

    const now = new Date();
    const previous = row?.status === "ACTIVE" ? row.supplierId : null;
    const data = {
      status: "ACTIVE",
      supplierId,
      method,
      suggestionReason: reason,
      linkedByUserId: input.userId,
      linkedAt: now,
      removedByUserId: null,
      removedAt: null,
    };
    if (!row) {
      // ON CONFLICT DO NOTHING: a concurrent first link waits for the winner, then inserts nothing — that is
      // a replay of the same request (same key) or a stale version, never an error to log.
      const res = await tx.documentSupplierLink.createMany({
        data: [{ businessId, documentId, version: 1, ...data }],
        skipDuplicates: true,
      });
      if (res.count !== 1) {
        const replay = await replayTx(tx, businessId, documentId, input.idempotencyKey);
        if (replay) return replay;
        throw new DocumentSupplierLinkError("STALE_VERSION", 409);
      }
    } else {
      const res = await tx.documentSupplierLink.updateMany({
        where: { id: row.id, businessId, version: row.version },
        data: { ...data, version: row.version + 1 },
      });
      if (res.count !== 1) throw new DocumentSupplierLinkError("STALE_VERSION", 409);
    }
    await tx.documentSupplierLinkEvent.create({
      data: {
        businessId,
        documentId,
        action: previous != null ? "RELINKED" : "LINKED",
        supplierId,
        previousSupplierId: previous,
        method,
        suggestionReason: reason,
        actorUserId: input.userId,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });
    return stateTx(tx, businessId, documentId);
  });
}

export function unlinkDocument(input: ChangeBase): Promise<DocumentSupplierLinkState> {
  const { businessId, documentId } = input;
  return withReplay(input, async (tx) => {
    await requireDocument(tx, businessId, documentId);
    const row = await tx.documentSupplierLink.findFirst({ where: { businessId, documentId } });
    if ((row?.version ?? 0) !== input.expectedVersion) throw new DocumentSupplierLinkError("STALE_VERSION", 409);
    if (!row || row.status !== "ACTIVE" || row.supplierId == null) {
      throw new DocumentSupplierLinkError("NOT_LINKED", 409);
    }
    const res = await tx.documentSupplierLink.updateMany({
      where: { id: row.id, businessId, version: row.version },
      data: {
        status: "REMOVED",
        supplierId: null,
        method: null,
        suggestionReason: null,
        removedByUserId: input.userId,
        removedAt: new Date(),
        version: row.version + 1,
      },
    });
    if (res.count !== 1) throw new DocumentSupplierLinkError("STALE_VERSION", 409);
    await tx.documentSupplierLinkEvent.create({
      data: {
        businessId,
        documentId,
        action: "UNLINKED",
        supplierId: null,
        previousSupplierId: row.supplierId,
        actorUserId: input.userId,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });
    return stateTx(tx, businessId, documentId);
  });
}

/** "Not this supplier": the suggestion is never offered again for this document. No version: it is not a link. */
export function dismissSuggestion(
  input: Omit<ChangeBase, "expectedVersion"> & { supplierId: number }
): Promise<DocumentSupplierLinkState> {
  const { businessId, documentId, supplierId } = input;
  return withReplay({ ...input, expectedVersion: 0 }, async (tx) => {
    await requireDocument(tx, businessId, documentId);
    await requireSupplier(tx, businessId, supplierId);
    const already = await tx.documentSupplierLinkEvent.findFirst({
      where: { businessId, documentId, supplierId, action: "SUGGESTION_DISMISSED" },
      select: { id: true },
    });
    if (!already) {
      await tx.documentSupplierLinkEvent.create({
        data: {
          businessId,
          documentId,
          action: "SUGGESTION_DISMISSED",
          supplierId,
          actorUserId: input.userId,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });
    }
    return stateTx(tx, businessId, documentId);
  });
}

export type SupplierDocumentRow = {
  documentId: number;
  linkedAt: string;
  method: LinkMethod;
  fileName: string | null;
  receivedAt: string;
  status: string;
  vendorName: string | null;
  documentDate: string | null;
  /** From the approved FinancialRecord only — the defined source of truth; null when not approved. */
  approved: { amount: number; direction: string; date: string } | null;
};

/** The documents linked to one supplier, newest decision first. Offset paging with a total. */
export function listSupplierDocuments(input: {
  businessId: number;
  supplierId: number;
  offset?: number;
  limit?: number;
}): Promise<{ rows: SupplierDocumentRow[]; total: number; hasMore: boolean; offset: number; limit: number }> {
  const { businessId, supplierId } = input;
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
  const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
  return inTenant(businessId, async (tx) => {
    await requireSupplier(tx, businessId, supplierId);
    const where = { businessId, supplierId, status: "ACTIVE" };
    const [links, total] = await Promise.all([
      tx.documentSupplierLink.findMany({
        where,
        orderBy: [{ linkedAt: "desc" }, { id: "desc" }],
        skip: offset,
        take: limit,
        select: { documentId: true, linkedAt: true, method: true },
      }),
      tx.documentSupplierLink.count({ where }),
    ]);
    const ids = links.map((l) => l.documentId);
    const [docs, extracted, records] = await Promise.all([
      tx.document.findMany({
        where: { businessId, id: { in: ids } },
        select: { id: true, originalFilename: true, createdAt: true, status: true },
      }),
      tx.extractedData.findMany({
        where: { documentId: { in: ids }, document: { businessId } },
        select: { documentId: true, vendorName: true, date: true },
      }),
      tx.financialRecord.findMany({
        where: { businessId, documentId: { in: ids } },
        select: { documentId: true, amount: true, direction: true, date: true },
      }),
    ]);
    const doc = new Map(docs.map((d) => [d.id, d]));
    const ext = new Map(extracted.map((e) => [e.documentId, e]));
    const rec = new Map(records.map((r) => [r.documentId, r]));
    const rows: SupplierDocumentRow[] = [];
    for (const l of links) {
      const d = doc.get(l.documentId);
      if (!d) continue;
      const e = ext.get(l.documentId);
      const r = rec.get(l.documentId);
      rows.push({
        documentId: l.documentId,
        linkedAt: (l.linkedAt ?? d.createdAt).toISOString(),
        method: l.method as LinkMethod,
        fileName: d.originalFilename,
        receivedAt: d.createdAt.toISOString(),
        status: d.status,
        vendorName: e?.vendorName ?? null,
        documentDate: e?.date ? e.date.toISOString() : null,
        approved: r ? { amount: r.amount, direction: r.direction, date: r.date.toISOString() } : null,
      });
    }
    return { rows, total, hasMore: offset + links.length < total, offset, limit };
  });
}
