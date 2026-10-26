/**
 * Rivhit through Business Intake (S1-A): the poller turns what it read into durable receipts; this adapter turns
 * each receipt into revenue-truth evidence. docs/revenue-sources-s1a-rivhit.md.
 *
 *   revenue.document           a sales / refund document → RevenueSale (+ one RevenueReceipt per tender)
 *   revenue.void               Rivhit cancelled a document already written → a VOID naming that sale (same money)
 *   revenue.receipt            a standalone receipt → RevenueReceipt per tender (no sale of its own)
 *   revenue.receipt_cancelled  Rivhit cancelled a receipt → each of its tenders REJECTED (reason SOURCE_CANCELLED);
 *                              append-only evidence is never changed or deleted
 *
 * The payload is the NORMALIZED document — amounts, tenders, dates; no customer name, phone, email or item text —
 * so a receipt holds no personal data even before it is purged. Every write is idempotent (revenue truth's own
 * unique keys); a retry re-runs route() safely. The family is CUSTOM and the target `revenue` (rule R10): never a
 * Lead, never a CommerceOrder, no identity is resolved.
 */
import type { IntakeAdapter, IntakeReceiptDraft, NormalizeResult, RouteResult } from "@/lib/intake/core/contract";
import { deriveEventIdentity } from "@/lib/intake/core/event-identity";
import { listAcquisitionTenants, resolvePublicConnection } from "@/lib/intake/acquisition/resolve";
import { connectionStateForRef } from "@/lib/intake/acquisition/connection.service";
import { recordDecision, recordReceipt, recordSale } from "@/lib/revenue-truth/store";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { createHash } from "node:crypto";
import {
  posDocumentToRevenue, posReceiptToRevenue, voidOf, type PosDocument, type PosReceipt, type ReceiptDraft, type SaleDraft,
} from "../contract";
import { RIVHIT_SOURCE } from "./parse";

export const RIVHIT_NORMALIZER_VERSION = `${RIVHIT_SOURCE}@1`;
export type RivhitEventType = "revenue.document" | "revenue.void" | "revenue.receipt" | "revenue.receipt_cancelled";

/** The revenue-truth scope of one connection: every row it writes is keyed inside it. */
export function rivhitScope(connectionId: number): string {
  return `${RIVHIT_SOURCE}:c${connectionId}`;
}

// ── payload (bigint-safe JSON) ───────────────────────────────────────────────────────────────────────

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function toJson(v: unknown): Json {
  if (typeof v === "bigint") return { $n: v.toString() };
  if (v instanceof Date) return { $d: v.toISOString() };
  if (Array.isArray(v)) return v.map(toJson);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
  return (v ?? null) as Json;
}

function fromJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromJson);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$n === "string" && Object.keys(o).length === 1) return BigInt(o.$n);
    if (typeof o.$d === "string" && Object.keys(o).length === 1) return new Date(o.$d);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fromJson(x)]));
  }
  return v;
}

/** Key order canonical: a jsonb round trip reorders keys, and the hash must not move with it. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

// ── receipts the poller builds ───────────────────────────────────────────────────────────────────────

function receipt(eventType: RivhitEventType, identity: string, publicId: string, occurredAt: Date | null, body: Json, metadata: Json): IntakeReceiptDraft {
  const id = deriveEventIdentity({ providerEventId: identity, accountScope: publicId });
  return {
    family: "CUSTOM",
    eventType,
    externalEventId: id.externalEventId,
    dedupeBasis: id.dedupeBasis,
    providerAccountRef: publicId,
    occurredAt,
    payload: body as never,
    metadata: metadata as never,
  };
}

/** A document as read. Its identity is the document itself: Rivhit documents are legal records, never re-issued. */
export function documentReceipt(publicId: string, doc: PosDocument): IntakeReceiptDraft {
  const body = toJson({ doc });
  return receipt("revenue.document", doc.externalId, publicId, doc.occurredAt, body, {
    kind: doc.kind, origin: doc.origin, tenders: doc.tenders.length, skippedTenders: doc.skippedTenders, cancelled: doc.cancelled,
  });
}

export function voidReceipt(publicId: string, externalId: string): IntakeReceiptDraft {
  return receipt("revenue.void", `${externalId}:void`, publicId, null, { externalId }, { kind: "VOID" });
}

export function standaloneReceipt(publicId: string, r: PosReceipt): IntakeReceiptDraft {
  return receipt("revenue.receipt", r.externalId, publicId, r.occurredAt, toJson({ receipt: r }), {
    origin: r.origin, tenders: r.tenders.length, skippedTenders: r.skippedTenders, cancelled: r.cancelled,
  });
}

export function receiptCancelledReceipt(publicId: string, externalId: string): IntakeReceiptDraft {
  return receipt("revenue.receipt_cancelled", `${externalId}:cancel`, publicId, null, { externalId }, { kind: "RECEIPT_CANCELLED" });
}

// ── normalize: pure ──────────────────────────────────────────────────────────────────────────────────

const EVENT_TYPES = new Set<string>(["revenue.document", "revenue.void", "revenue.receipt", "revenue.receipt_cancelled"]);
const EXTERNAL_ID = /^(doc|rcpt):\d{1,3}:\d{1,6}$/;

function validPayload(eventType: string, payload: unknown): boolean {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (eventType === "revenue.document") {
    const d = (p.doc ?? {}) as Record<string, unknown>;
    return typeof d.externalId === "string" && /^doc:/.test(d.externalId) && EXTERNAL_ID.test(d.externalId) && Array.isArray(d.tenders);
  }
  if (eventType === "revenue.receipt") {
    const r = (p.receipt ?? {}) as Record<string, unknown>;
    return typeof r.externalId === "string" && /^rcpt:/.test(r.externalId) && EXTERNAL_ID.test(r.externalId) && Array.isArray(r.tenders);
  }
  if (eventType === "revenue.void") return typeof p.externalId === "string" && /^doc:/.test(p.externalId) && EXTERNAL_ID.test(p.externalId);
  return typeof p.externalId === "string" && /^rcpt:/.test(p.externalId) && EXTERNAL_ID.test(p.externalId);
}

export function normalizeRivhit(event: { eventType: string; payload: unknown; occurredAt: Date | null }): NormalizeResult {
  if (!EVENT_TYPES.has(event.eventType)) return { ok: false, code: "unknown_event_type" };
  if (!validPayload(event.eventType, event.payload)) return { ok: false, code: "payload_malformed" };
  return {
    ok: true,
    normalized: { occurredAt: event.occurredAt, contactHints: null, signals: {}, identity: "none", attribution: null, target: "revenue" },
  };
}

// ── route: the revenue writes ────────────────────────────────────────────────────────────────────────

async function connectionOf(publicId: string | null): Promise<number | null> {
  if (!publicId) return null;
  const row = await withTenantTransaction((tx) =>
    tx.acquisitionConnection.findFirst({ where: { sourceKey: RIVHIT_SOURCE, publicId, status: { not: "REVOKED" } }, select: { id: true } })
  );
  return row?.id ?? null;
}

const ref = (scope: string, connectionId: number, externalId: string, hash: string | null, eventId: number) => ({
  capture: "API_PULL" as const, sourceScope: scope, externalId, connectionId, sourcePayloadHash: hash, ingestRef: `intake:${eventId}`,
});

async function writeSale(businessId: number, scope: string, connectionId: number, s: SaleDraft, hash: string | null, eventId: number, originalSaleId: number | null) {
  return recordSale(businessId, {
    ...ref(scope, connectionId, s.externalId, hash, eventId),
    sourceKind: s.sourceKind, kind: s.kind, originalSaleId, occurredAt: s.occurredAt, businessDay: s.businessDay,
    registerKey: s.registerKey, currency: s.currency, grossMinor: s.grossMinor, discountMinor: s.discountMinor, vatMinor: s.vatMinor,
  });
}

async function writeReceipt(businessId: number, scope: string, connectionId: number, r: ReceiptDraft, hash: string | null, eventId: number, saleId: number | null) {
  return recordReceipt(businessId, {
    ...ref(scope, connectionId, r.externalId, hash, eventId),
    sourceKind: r.sourceKind, saleId, direction: r.direction, method: r.method, receivedAt: r.receivedAt, businessDay: r.businessDay,
    registerKey: r.registerKey, currency: r.currency, amountMinor: r.amountMinor, cardBrand: r.cardBrand, installmentCount: r.installmentCount,
  });
}

async function saleByExternalId(scope: string, externalId: string) {
  return withTenantTransaction((tx) =>
    tx.revenueSale.findFirst({
      where: { sourceScope: scope, externalId },
      select: { id: true, sourceKind: true, occurredAt: true, businessDay: true, registerKey: true, currency: true, grossMinor: true, discountMinor: true, vatMinor: true },
    })
  );
}

async function voidSale(businessId: number, scope: string, connectionId: number, externalId: string, eventId: number): Promise<"written" | "missing" | "conflict"> {
  const original = await saleByExternalId(scope, externalId);
  if (!original) return "missing";
  const v = voidOf({
    externalId,
    sourceKind: original.sourceKind === "POS" ? "POS" : "ACCOUNTING_APP",
    occurredAt: original.occurredAt,
    businessDay: original.businessDay.toISOString().slice(0, 10),
    registerKey: original.registerKey,
    currency: original.currency,
    grossMinor: original.grossMinor,
    discountMinor: original.discountMinor,
    vatMinor: original.vatMinor,
  });
  const r = await writeSale(businessId, scope, connectionId, v, null, eventId, original.id);
  return r.status === "CONFLICT" ? "conflict" : "written";
}

async function rejectReceiptTenders(businessId: number, scope: string, externalId: string): Promise<number> {
  const rows = await withTenantTransaction((tx) =>
    tx.revenueReceipt.findMany({ where: { sourceScope: scope, externalId: { startsWith: `${externalId}:pay:` } }, select: { id: true, externalId: true } })
  );
  for (const row of rows) {
    await recordDecision(businessId, {
      subject: { receiptId: row.id },
      decision: "REJECTED",
      actor: "SYSTEM",
      reasonCode: "SOURCE_CANCELLED",
      // The decision key alphabet has no '.': the scope's dot becomes '_'.
      idempotencyKey: `${scope.replace(/\./g, "_")}:${row.externalId}:cancelled`,
    });
  }
  return rows.length;
}

export async function routeRivhit(
  ctx: { businessId: number; now: Date },
  event: { id: number; eventType: string; payload: unknown; providerAccountRef: string | null }
): Promise<RouteResult> {
  const connectionId = await connectionOf(event.providerAccountRef);
  if (connectionId === null) return { kind: "ignored", code: "connection_revoked" };
  const scope = rivhitScope(connectionId);
  const hash = payloadHash(event.payload);
  const p = fromJson(event.payload) as Record<string, unknown>;

  if (event.eventType === "revenue.document") {
    const doc = p.doc as PosDocument;
    const { sale, receipts } = posDocumentToRevenue(doc);
    const s = await writeSale(ctx.businessId, scope, connectionId, sale, hash, event.id, null);
    if (s.status === "CONFLICT") return { kind: "ignored", code: "revenue_conflict" };
    for (const r of receipts) await writeReceipt(ctx.businessId, scope, connectionId, r, hash, event.id, s.id);
    // Already cancelled when first read: the sale and its void, so the day's evidence nets to nothing and matches
    // Rivhit's own summary (which counts cancelled documents).
    if (doc.cancelled) await voidSale(ctx.businessId, scope, connectionId, doc.externalId, event.id);
    return { kind: "routed", refs: {}, alreadyExisted: s.status === "DUPLICATE" };
  }

  if (event.eventType === "revenue.void") {
    const v = await voidSale(ctx.businessId, scope, connectionId, String(p.externalId), event.id);
    // The document is not written yet (its own receipt is still on its way): try again later.
    if (v === "missing") return { kind: "deferred", code: "original_not_written", until: new Date(ctx.now.getTime() + 15 * 60_000) };
    if (v === "conflict") return { kind: "ignored", code: "revenue_conflict" };
    return { kind: "routed", refs: {} };
  }

  if (event.eventType === "revenue.receipt") {
    const r = p.receipt as PosReceipt;
    for (const d of posReceiptToRevenue(r)) {
      const w = await writeReceipt(ctx.businessId, scope, connectionId, d, hash, event.id, null);
      if (w.status === "CONFLICT") return { kind: "ignored", code: "revenue_conflict" };
    }
    if (r.cancelled) await rejectReceiptTenders(ctx.businessId, scope, r.externalId);
    return { kind: "routed", refs: {} };
  }

  const n = await rejectReceiptTenders(ctx.businessId, scope, String(p.externalId));
  if (n === 0) return { kind: "deferred", code: "original_not_written", until: new Date(ctx.now.getTime() + 15 * 60_000) };
  return { kind: "routed", refs: {} };
}

export const rivhitAdapter: IntakeAdapter = {
  sourceKey: RIVHIT_SOURCE,
  families: ["CUSTOM"],
  normalizerVersion: RIVHIT_NORMALIZER_VERSION,
  async resolveTenant(accountRef) {
    return (await resolvePublicConnection(RIVHIT_SOURCE, accountRef))?.businessId ?? null;
  },
  // Every retry first re-checks the connection: a receipt whose connection was revoked after it arrived is
  // settled IGNORED — never revenue.
  async hydrate(_ctx, event) {
    if ((await connectionStateForRef(RIVHIT_SOURCE, event.providerAccountRef)) === "revoked") return { kind: "ignored", code: "connection_revoked" };
    return { kind: "unchanged" };
  },
  normalize: normalizeRivhit,
  route: (ctx, _normalized, event) => routeRivhit(ctx, event),
  listTenants: () => listAcquisitionTenants(RIVHIT_SOURCE),
};
