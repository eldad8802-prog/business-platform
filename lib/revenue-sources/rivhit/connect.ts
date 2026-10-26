/**
 * Rivhit — the owner's side of a connection (S1-A). Tenant context only. docs/revenue-sources-s1a-rivhit.md.
 *
 *   connect      the owner pastes the api_token they generated in Rivhit Online → Dubiz checks it (Company.Details),
 *                binds the Rivhit company to this business (one company, one live business — the partial unique
 *                index refuses a second), and PROPOSES which document / receipt types are sales. Nothing is read yet.
 *   confirm      the owner confirms (or corrects) the roles; the cursor starts at each type's last number, so the
 *                poller reads only what is issued from now on — history only through an explicit backfill.
 *   backfill     the owner asks for history from a day (at most MAX_BACKFILL_DAYS back), read day by day.
 *   status       what the owner sees: roles, cursor progress, backfill, unreadable documents, day checks — never the
 *                token.
 */
import { ValidationError } from "@/lib/errors";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { addCalendarDays, jerusalemDayKey, daysBetweenDayKeys } from "@/lib/utils/jerusalem-day";
import { createSignedConnection, readConnectionSecrets, updateConnectionSecrets, type ConnectionView } from "@/lib/intake/acquisition/connection.service";
import { isRivhitToken, rivhit, RivhitApiError } from "./client";
import { parseDocTypes, parseReceiptTypes, proposeTypeRoles, RIVHIT_SOURCE, type DocRole, type ReceiptRole, type TypeConfig } from "./parse";
import { decodeState, encodeState, MAX_BACKFILL_DAYS, type RivhitState } from "./sync";

export type RivhitTypeView = { kind: "document" | "receipt"; type: number; name: string; role: DocRole | ReceiptRole };

export class RivhitConnectError extends ValidationError {
  constructor(readonly code: "token_invalid" | "token_rejected" | "rivhit_unreachable" | "company_unknown" | "company_in_use") {
    super(code);
    if (code === "company_in_use") this.statusCode = 409;
  }
}

function mapApiError(e: unknown): never {
  if (e instanceof RivhitApiError) throw new RivhitConnectError(e.code === "unauthorized" ? "token_rejected" : "rivhit_unreachable");
  throw e;
}

async function typeViews(token: string, cfg: TypeConfig): Promise<RivhitTypeView[]> {
  const [docs, receipts] = await Promise.all([rivhit.documentTypes(token), rivhit.receiptTypes(token)]).catch(mapApiError);
  return [
    ...parseDocTypes(docs).map((d) => ({ kind: "document" as const, type: d.type, name: d.name, role: cfg.docs[String(d.type)] ?? "IGNORE" })),
    ...parseReceiptTypes(receipts).map((r) => ({ kind: "receipt" as const, type: r.type, name: r.name, role: cfg.receipts[String(r.type)] ?? "IGNORE" })),
  ];
}

export async function connectRivhit(input: { businessId: number; userId: number; apiToken: unknown; label?: unknown }): Promise<{ connection: ConnectionView; types: RivhitTypeView[] }> {
  if (!isRivhitToken(input.apiToken)) throw new RivhitConnectError("token_invalid");
  const token = input.apiToken;
  const company = (await rivhit.companyDetails(token).catch(mapApiError)) as { company_id?: unknown } | null;
  const companyId = typeof company?.company_id === "number" && Number.isSafeInteger(company.company_id) && company.company_id > 0 ? String(company.company_id) : null;
  if (!companyId) throw new RivhitConnectError("company_unknown");
  const [docs, receipts] = await Promise.all([rivhit.documentTypes(token), rivhit.receiptTypes(token)]).catch(mapApiError);
  const types = proposeTypeRoles(parseDocTypes(docs), parseReceiptTypes(receipts));
  const state: RivhitState = {
    apiToken: token, companyId, types, typesConfirmed: false, payTypes: [], payTypesAt: null,
    cursor: { docs: {}, receipts: {} }, backfill: null, rescanAt: null, unreadable: [], checks: [],
  };
  const { connection } = await createSignedConnection({
    businessId: input.businessId, userId: input.userId, sourceKey: RIVHIT_SOURCE, label: input.label, externalResourceId: companyId, extraSecrets: encodeState(state),
  }).catch((e: unknown) => {
    // The partial unique index: this Rivhit company is live on a business already (this one or another).
    if ((e as { code?: unknown } | null)?.code === "P2002") throw new RivhitConnectError("company_in_use");
    throw e;
  });
  return { connection, types: await typeViews(token, types) };
}

async function liveState(businessId: number, connectionId: number): Promise<RivhitState> {
  const row = await withTenantTransaction((tx) =>
    tx.acquisitionConnection.findFirst({ where: { id: connectionId, sourceKey: RIVHIT_SOURCE, status: { not: "REVOKED" } }, select: { id: true } })
  );
  if (!row) throw new ValidationError("no such Rivhit connection");
  const state = decodeState(await readConnectionSecrets(businessId, connectionId, { anyLiveStatus: true }));
  if (!state) throw new ValidationError("no such Rivhit connection");
  return state;
}

const DOC_ROLES = new Set<string>(["SALE", "REFUND", "IGNORE"]);
const RECEIPT_ROLES = new Set<string>(["RECEIPT", "MIRROR", "IGNORE"]);

function validRoles(raw: unknown): TypeConfig {
  const o = (raw ?? {}) as { docs?: unknown; receipts?: unknown; registerTypes?: unknown };
  const roles = <R extends string>(v: unknown, allowed: Set<string>): Record<string, R> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ValidationError("types must map a type number to a role");
    const out: Record<string, R> = {};
    for (const [k, r] of Object.entries(v)) {
      if (!/^\d{1,3}$/.test(k) || typeof r !== "string" || !allowed.has(r)) throw new ValidationError("types must map a type number to a role");
      out[k] = r as R;
    }
    return out;
  };
  const registerTypes = o.registerTypes === undefined ? [] : o.registerTypes;
  if (!Array.isArray(registerTypes) || !registerTypes.every((t) => Number.isInteger(t) && t >= 0 && t <= 999)) throw new ValidationError("registerTypes must be type numbers");
  return { docs: roles<DocRole>(o.docs, DOC_ROLES), receipts: roles<ReceiptRole>(o.receipts, RECEIPT_ROLES), registerTypes: registerTypes as number[] };
}

/**
 * The owner confirms the roles. The cursor of each confirmed type starts at its last number now: from here on the
 * poller reads only new documents. `registerTypes` stays empty unless the owner names till-only types.
 */
export async function confirmRivhitTypes(businessId: number, connectionId: number, raw: unknown): Promise<{ types: RivhitTypeView[] }> {
  const state = await liveState(businessId, connectionId);
  const types = validRoles(raw);
  const cursor = { docs: { ...state.cursor.docs }, receipts: { ...state.cursor.receipts } };
  try {
    for (const [t, role] of Object.entries(types.docs)) {
      if (role !== "IGNORE" && cursor.docs[t] === undefined) cursor.docs[t] = await rivhit.lastDocumentNumber(state.apiToken, Number(t));
    }
    for (const [t, role] of Object.entries(types.receipts)) {
      if (role === "RECEIPT" && cursor.receipts[t] === undefined) cursor.receipts[t] = await rivhit.lastReceiptNumber(state.apiToken, Number(t));
    }
  } catch (e) {
    mapApiError(e);
  }
  await updateConnectionSecrets(businessId, connectionId, encodeState({ ...state, types, typesConfirmed: true, cursor }));
  return { types: await typeViews(state.apiToken, types) };
}

/** History from `fromDay` (Israel day, YYYY-MM-DD) up to yesterday, read day by day by the poller. */
export async function requestRivhitBackfill(businessId: number, connectionId: number, fromDay: unknown, now = new Date()): Promise<{ fromDay: string; toDay: string }> {
  const state = await liveState(businessId, connectionId);
  if (!state.typesConfirmed) throw new ValidationError("confirm the document types first");
  if (typeof fromDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fromDay)) throw new ValidationError("fromDay must be YYYY-MM-DD");
  const toDay = addCalendarDays(jerusalemDayKey(now), -1);
  if (daysBetweenDayKeys(fromDay, toDay) < 0) throw new ValidationError("fromDay must be before today");
  if (daysBetweenDayKeys(fromDay, toDay) >= MAX_BACKFILL_DAYS) throw new ValidationError(`at most ${MAX_BACKFILL_DAYS} days back`);
  await updateConnectionSecrets(businessId, connectionId, encodeState({ ...state, backfill: { fromDay, toDay, nextDay: fromDay } }));
  return { fromDay, toDay };
}

export type RivhitStatus = {
  typesConfirmed: boolean;
  types: TypeConfig;
  cursor: RivhitState["cursor"];
  backfill: RivhitState["backfill"];
  lastRescanAt: string | null;
  unreadable: string[];
  checks: Array<{ day: string; type: number; ok: boolean; summaryCount: number; listedCount: number; summaryMinor: string; listedMinor: string }>;
  /** Always false until Rivhit confirms how a till's documents can be told apart (see the S1-A doc). */
  registerProven: boolean;
};

export async function rivhitStatus(businessId: number, connectionId: number): Promise<RivhitStatus> {
  const s = await liveState(businessId, connectionId);
  return {
    typesConfirmed: s.typesConfirmed,
    types: s.types,
    cursor: s.cursor,
    backfill: s.backfill,
    lastRescanAt: s.rescanAt,
    unreadable: s.unreadable,
    checks: s.checks.map((c) => ({ ...c, summaryMinor: c.summaryMinor.toString(), listedMinor: c.listedMinor.toString() })),
    registerProven: s.types.registerTypes.length > 0,
  };
}
