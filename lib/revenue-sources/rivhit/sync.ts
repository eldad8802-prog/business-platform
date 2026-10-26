/**
 * Rivhit — the poller (S1-A), run by the intake sweeper for each business with a pos.rivhit connection, inside that
 * business's tenant job. docs/revenue-sources-s1a-rivhit.md.
 *
 *   Rivhit has no webhook for documents, so "near real time" is polling:
 *   1. forward    per confirmed sale / refund / receipt type, the numbers after the cursor (Document.List by number
 *                 range — the issue date cannot be a cursor: documents may be dated ahead); each new number is read
 *                 in full (Details) and handed to intake as a durable receipt; the cursor passes only what was handed
 *                 over or recorded as unreadable;
 *   2. rescan     hourly, the last RESCAN_DAYS days by date: a document / receipt Rivhit cancelled AFTER it was read
 *                 becomes a void / cancellation receipt (there is no "changed since" filter);
 *   3. backfill   when the owner asked for one, day by day from the day they chose; each finished day is checked
 *                 against Rivhit's own daily summary (count and total per type, cancelled included).
 *
 *   Every run is bounded: at most CALL_BUDGET Rivhit calls per connection (paced under Rivhit's 200 / minute).
 *   What intake already holds is never fetched again (its receipt identity is checked first).
 *
 * Nothing here bypasses the gate: receipts go through ingestAcquisition (feature enabled, business active).
 * The api_token and the sync state live only in the connection's ENCRYPTED bundle. Counts only leave this module.
 */
import { createHash } from "node:crypto";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { sourceGate } from "@/lib/intake/acquisition/gate";
import { ingestAcquisition } from "@/lib/intake/acquisition/ingest";
import { readConnectionSecrets, setConnectionHealth, updateConnectionSecrets } from "@/lib/intake/acquisition/connection.service";
import type { IntakeReceiptDraft } from "@/lib/intake/core/contract";
import { deriveEventIdentity } from "@/lib/intake/core/event-identity";
import { addCalendarDays, jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import { rivhit, RivhitApiError, type ListRange } from "./client";
import {
  docRole, originOf, parseDocumentDetails, parseListRow, parsePaymentTypes, parseReceiptDetails, parseSummary, receiptRole,
  reconcileDay, RivhitParseError, RIVHIT_SOURCE, typeRanges, type DayCheck, type ListRow, type RivhitPaymentType, type TypeConfig,
} from "./parse";
import { documentReceipt, receiptCancelledReceipt, standaloneReceipt, voidReceipt } from "./adapter";

export const CALL_BUDGET = 60;
/** Numbers asked per forward list call (a small window: Rivhit has no paging and a 30 s cap). */
export const FORWARD_WINDOW = 100;
export const RESCAN_DAYS = 7;
const RESCAN_EVERY_MS = 60 * 60_000;
const PAY_TYPES_TTL_MS = 24 * 60 * 60_000;
export const MAX_BACKFILL_DAYS = 366;
const MAX_UNREADABLE = 50;
const MAX_CHECKS = 31;

/** The sync state kept (as JSON strings) in the connection's encrypted bundle, next to the api_token. */
export type RivhitState = {
  apiToken: string;
  companyId: string;
  /** The proposal until the owner confirms it; read nothing before. */
  types: TypeConfig;
  typesConfirmed: boolean;
  payTypes: RivhitPaymentType[];
  payTypesAt: string | null;
  /** Last number handed over, per document / receipt type. */
  cursor: { docs: Record<string, number>; receipts: Record<string, number> };
  backfill: { fromDay: string; toDay: string; nextDay: string } | null;
  rescanAt: string | null;
  /** Documents Rivhit returned that could not be read (bounded): visible to the owner, never silently dropped. */
  unreadable: string[];
  checks: Array<DayCheck & { day: string }>;
};

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function encodeState(s: RivhitState): Record<string, string> {
  return {
    apiToken: s.apiToken,
    companyId: s.companyId,
    types: JSON.stringify(s.types),
    typesConfirmed: s.typesConfirmed ? "1" : "",
    payTypes: JSON.stringify(s.payTypes),
    payTypesAt: s.payTypesAt ?? "",
    cursor: JSON.stringify(s.cursor),
    backfill: s.backfill ? JSON.stringify(s.backfill) : "",
    rescanAt: s.rescanAt ?? "",
    unreadable: JSON.stringify(s.unreadable),
    checks: JSON.stringify(s.checks, bigintSafe),
  };
}

export function decodeState(b: Record<string, string> | null): RivhitState | null {
  if (!b?.apiToken || !b.companyId) return null;
  const parse = <T>(v: string | undefined, fallback: T): T => {
    if (!v) return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  };
  const checks = parse<Array<Record<string, unknown>>>(b.checks, []).map((c) => ({
    ...(c as unknown as DayCheck & { day: string }),
    summaryMinor: BigInt(String(c.summaryMinor ?? "0")),
    listedMinor: BigInt(String(c.listedMinor ?? "0")),
  }));
  return {
    apiToken: b.apiToken,
    companyId: b.companyId,
    types: parse<TypeConfig>(b.types, { docs: {}, receipts: {}, registerTypes: [] }),
    typesConfirmed: b.typesConfirmed === "1",
    payTypes: parse<RivhitPaymentType[]>(b.payTypes, []),
    payTypesAt: b.payTypesAt || null,
    cursor: parse(b.cursor, { docs: {}, receipts: {} }),
    backfill: parse(b.backfill, null),
    rescanAt: b.rescanAt || null,
    unreadable: parse<string[]>(b.unreadable, []),
    checks,
  };
}

export type RivhitSyncReport = { connections: number; receipts: number; unreadable: number; failures: number; calls: number };

class Budget {
  used = 0;
  constructor(readonly max: number) {}
  get left() {
    return this.max - this.used;
  }
  async spend<T>(fn: () => Promise<T>): Promise<T> {
    this.used += 1;
    return fn();
  }
}

/** The intake identity of a receipt the adapter builds — to skip what intake already holds. */
function identityOf(publicId: string, providerEventId: string): string {
  return deriveEventIdentity({ providerEventId, accountScope: publicId }).externalEventId;
}

async function knownIdentities(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await withTenantTransaction((tx) =>
    tx.intakeEvent.findMany({ where: { sourceKey: RIVHIT_SOURCE, externalEventId: { in: ids } }, select: { externalEventId: true } })
  );
  return new Set(rows.map((r) => r.externalEventId));
}

function typesOf(cfg: TypeConfig, kind: "docs" | "receipts", roles: string[]): number[] {
  return Object.entries(cfg[kind]).filter(([, r]) => roles.includes(r)).map(([t]) => Number(t)).filter(Number.isInteger);
}

type Ctx = {
  businessId: number;
  connectionId: number;
  publicId: string;
  state: RivhitState;
  budget: Budget;
  report: RivhitSyncReport;
  now: Date;
};

function noteUnreadable(ctx: Ctx, id: string, code: string) {
  ctx.report.unreadable += 1;
  const entry = `${id}:${code}`.slice(0, 80);
  if (!ctx.state.unreadable.includes(entry)) ctx.state.unreadable = [...ctx.state.unreadable, entry].slice(-MAX_UNREADABLE);
}

async function ingest(ctx: Ctx, receipts: IntakeReceiptDraft[]): Promise<void> {
  if (!receipts.length) return;
  const r = await ingestAcquisition({
    sourceKey: RIVHIT_SOURCE, businessId: ctx.businessId, connectionId: ctx.connectionId, accountRef: ctx.publicId, receipts, processInline: true,
  });
  // Refused (the source switched off, the connection not live): nothing may pass the cursor.
  if (r.status !== "accepted") throw new Error(`ingest_refused:${r.reason}`);
  ctx.report.receipts += r.newCount;
}

/** Read one listed document / receipt in full; null when it cannot be read (recorded as unreadable). */
async function readRow(ctx: Ctx, kind: "document" | "receipt", row: ListRow): Promise<IntakeReceiptDraft | null> {
  const { state, publicId } = ctx;
  try {
    if (kind === "document") {
      const role = docRole(state.types, row.type);
      if (role === "IGNORE") return null;
      const raw = await ctx.budget.spend(() => rivhit.documentDetails(state.apiToken, row.type, row.number));
      if (raw === null) {
        noteUnreadable(ctx, `doc:${row.type}:${row.number}`, "not_found");
        return null;
      }
      const doc = parseDocumentDetails(raw, { type: row.type, number: row.number, role, origin: originOf(state.types, row.type), payTypes: state.payTypes });
      return documentReceipt(publicId, { ...doc, cancelled: doc.cancelled || row.cancelled });
    }
    if (receiptRole(state.types, row.type) !== "RECEIPT") return null;
    const raw = await ctx.budget.spend(() => rivhit.receiptDetails(state.apiToken, row.type, row.number));
    if (raw === null) {
      noteUnreadable(ctx, `rcpt:${row.type}:${row.number}`, "not_found");
      return null;
    }
    const r = parseReceiptDetails(raw, { type: row.type, number: row.number, origin: originOf(state.types, row.type), payTypes: state.payTypes, cancelled: row.cancelled });
    return standaloneReceipt(publicId, r);
  } catch (e) {
    if (e instanceof RivhitParseError) {
      noteUnreadable(ctx, `${kind === "document" ? "doc" : "rcpt"}:${row.type}:${row.number}`, e.code);
      return null;
    }
    throw e;
  }
}

/** The rows of one list not yet held by intake, oldest number first. */
async function unseen(ctx: Ctx, kind: "document" | "receipt", rows: ListRow[]): Promise<ListRow[]> {
  const prefix = kind === "document" ? "doc" : "rcpt";
  const ids = rows.map((r) => identityOf(ctx.publicId, `${prefix}:${r.type}:${r.number}`));
  const known = await knownIdentities(ids);
  return rows.filter((_, i) => !known.has(ids[i])).sort((a, b) => a.type - b.type || a.number - b.number);
}

function parseRows(raw: unknown[], kind: "document" | "receipt"): ListRow[] {
  return raw.map((r) => parseListRow(r, kind)).filter((r): r is ListRow => r !== null);
}

// 1. forward
async function forward(ctx: Ctx, kind: "document" | "receipt"): Promise<void> {
  const cfgKey = kind === "document" ? "docs" : "receipts";
  const types = kind === "document" ? typesOf(ctx.state.types, "docs", ["SALE", "REFUND"]) : typesOf(ctx.state.types, "receipts", ["RECEIPT"]);
  for (const type of types.sort((a, b) => a - b)) {
    if (ctx.budget.left < 2) return;
    const after = ctx.state.cursor[cfgKey][String(type)] ?? 0;
    const list = async (to: number) => {
      const range: ListRange = { kind: "number", type, from: after + 1, to };
      return parseRows(
        await ctx.budget.spend(() => (kind === "document" ? rivhit.documentList(ctx.state.apiToken, range) : rivhit.receiptList(ctx.state.apiToken, range))),
        kind
      ).filter((r) => r.type === type && r.number > after);
    };
    let listed = await list(after + FORWARD_WINDOW);
    // Nothing in the window: either nothing new, or the numbering jumped (a new start number) — an open-ended look,
    // hourly (with the rescan), so a jump can never stall the cursor without doubling every run's calls.
    if (!listed.length && wideLookDue(ctx) && ctx.budget.left >= 2) listed = await list(999_999);
    const fresh = new Set((await unseen(ctx, kind, listed)).map((r) => r.number));
    for (const row of listed.sort((a, b) => a.number - b.number)) {
      if (fresh.has(row.number)) {
        if (ctx.budget.left < 1) break;
        const receipt = await readRow(ctx, kind, row);
        if (receipt) await ingest(ctx, [receipt]);
      }
      // Row by row: a failure on the next one (an outage) must not lose the progress already handed to intake.
      ctx.state.cursor[cfgKey][String(type)] = row.number;
    }
  }
}

/** The open-ended look runs at most hourly — on the runs the cancellation rescan is due. */
function wideLookDue(ctx: Ctx): boolean {
  return !ctx.state.rescanAt || ctx.now.getTime() - new Date(ctx.state.rescanAt).getTime() >= RESCAN_EVERY_MS;
}

// 2. rescan: cancellations of what was already read
async function rescan(ctx: Ctx): Promise<void> {
  if (ctx.state.rescanAt && ctx.now.getTime() - new Date(ctx.state.rescanAt).getTime() < RESCAN_EVERY_MS) return;
  const today = jerusalemDayKey(ctx.now);
  const fromDay = addCalendarDays(today, -RESCAN_DAYS);
  const kinds: Array<["document" | "receipt", number[]]> = [
    ["document", typesOf(ctx.state.types, "docs", ["SALE", "REFUND"])],
    ["receipt", typesOf(ctx.state.types, "receipts", ["RECEIPT"])],
  ];
  for (const [kind, types] of kinds) {
    for (const [lo, hi] of typeRanges(types)) {
      if (ctx.budget.left < 1) return;
      const range: ListRange = { kind: "date", fromType: lo, toType: hi, fromDay, toDay: today };
      const cancelled = parseRows(
        await ctx.budget.spend(() => (kind === "document" ? rivhit.documentList(ctx.state.apiToken, range) : rivhit.receiptList(ctx.state.apiToken, range))),
        kind
      ).filter((r) => r.cancelled && types.includes(r.type));
      if (!cancelled.length) continue;
      const prefix = kind === "document" ? "doc" : "rcpt";
      const seenIds = cancelled.map((r) => identityOf(ctx.publicId, `${prefix}:${r.type}:${r.number}`));
      const cancelIds = cancelled.map((r) => identityOf(ctx.publicId, `${prefix}:${r.type}:${r.number}:${kind === "document" ? "void" : "cancel"}`));
      const known = await knownIdentities([...seenIds, ...cancelIds]);
      const receipts = cancelled.flatMap((r, i) => {
        // Only what intake already holds, and not cancelled yet; an unread one is read whole (cancelled) by forward.
        if (!known.has(seenIds[i]) || known.has(cancelIds[i])) return [];
        const id = `${prefix}:${r.type}:${r.number}`;
        return [kind === "document" ? voidReceipt(ctx.publicId, id) : receiptCancelledReceipt(ctx.publicId, id)];
      });
      await ingest(ctx, receipts);
    }
  }
  ctx.state.rescanAt = ctx.now.toISOString();
}

// 3. backfill, one day at a time, each finished day checked against Rivhit's own summary
async function backfill(ctx: Ctx): Promise<void> {
  const b = ctx.state.backfill;
  if (!b) return;
  const saleTypes = typesOf(ctx.state.types, "docs", ["SALE", "REFUND"]);
  const receiptTypes = typesOf(ctx.state.types, "receipts", ["RECEIPT"]);
  while (ctx.state.backfill && ctx.budget.left > 3) {
    const day = ctx.state.backfill.nextDay;
    if (day > ctx.state.backfill.toDay) {
      ctx.state.backfill = null;
      return;
    }
    const docRows: ListRow[] = [];
    for (const [lo, hi] of typeRanges(saleTypes)) {
      const range: ListRange = { kind: "date", fromType: lo, toType: hi, fromDay: day, toDay: day };
      docRows.push(...parseRows(await ctx.budget.spend(() => rivhit.documentList(ctx.state.apiToken, range)), "document").filter((r) => saleTypes.includes(r.type)));
    }
    const rcptRows: ListRow[] = [];
    for (const [lo, hi] of typeRanges(receiptTypes)) {
      const range: ListRange = { kind: "date", fromType: lo, toType: hi, fromDay: day, toDay: day };
      rcptRows.push(...parseRows(await ctx.budget.spend(() => rivhit.receiptList(ctx.state.apiToken, range)), "receipt").filter((r) => receiptTypes.includes(r.type)));
    }
    let finished = true;
    for (const [kind, rows] of [["document", docRows], ["receipt", rcptRows]] as const) {
      for (const row of await unseen(ctx, kind, rows)) {
        if (ctx.budget.left < 2) {
          finished = false;
          break;
        }
        const receipt = await readRow(ctx, kind, row);
        if (receipt) await ingest(ctx, [receipt]);
      }
      if (!finished) break;
    }
    if (!finished) return; // the next run continues this day; what it handed over is skipped then
    if (saleTypes.length && ctx.budget.left > 0) {
      const summary = parseSummary(await ctx.budget.spend(() => rivhit.summaryReport(ctx.state.apiToken, day)));
      const checks = reconcileDay(docRows, summary, saleTypes).map((c) => ({ ...c, day }));
      ctx.state.checks = [...ctx.state.checks.filter((c) => c.day !== day), ...checks].slice(-MAX_CHECKS * Math.max(1, saleTypes.length));
    }
    ctx.state.backfill = { ...ctx.state.backfill, nextDay: addCalendarDays(day, 1) };
  }
}

async function refreshPayTypes(ctx: Ctx): Promise<void> {
  const at = ctx.state.payTypesAt ? new Date(ctx.state.payTypesAt).getTime() : 0;
  if (ctx.state.payTypes.length && ctx.now.getTime() - at < PAY_TYPES_TTL_MS) return;
  ctx.state.payTypes = parsePaymentTypes(await ctx.budget.spend(() => rivhit.paymentTypes(ctx.state.apiToken)));
  ctx.state.payTypesAt = ctx.now.toISOString();
}

function stateDigest(s: RivhitState): string {
  return createHash("sha256").update(JSON.stringify(encodeState(s))).digest("hex");
}

/** Sync ONE connection. Exported for the lab; the sweeper calls {@link syncRivhit}. */
export async function syncRivhitConnection(
  businessId: number,
  c: { id: number; publicId: string },
  report: RivhitSyncReport,
  opts: { now?: Date; budget?: number } = {}
): Promise<void> {
  const state = decodeState(await readConnectionSecrets(businessId, c.id, { anyLiveStatus: true }));
  if (!state || !state.typesConfirmed) return;
  const before = stateDigest(state);
  const ctx: Ctx = { businessId, connectionId: c.id, publicId: c.publicId, state, budget: new Budget(opts.budget ?? CALL_BUDGET), report, now: opts.now ?? new Date() };
  try {
    await refreshPayTypes(ctx);
    await forward(ctx, "document");
    await forward(ctx, "receipt");
    await rescan(ctx);
    await backfill(ctx);
    await setConnectionHealth(c.id, null);
  } catch (e) {
    report.failures += 1;
    // Only what the OWNER must fix turns the connection to ERROR (a token Rivhit no longer accepts); an outage or a
    // refusal is retried by the next run.
    if (e instanceof RivhitApiError && e.code === "unauthorized") await setConnectionHealth(c.id, "RIVHIT_TOKEN_REJECTED");
  } finally {
    report.calls += ctx.budget.used;
    // Progress made before a failure is kept: the cursor only ever covers what was handed to intake.
    if (stateDigest(state) !== before) await updateConnectionSecrets(businessId, c.id, encodeState(state));
  }
}

/** Sync every live Rivhit connection of ONE business (tenant job). */
export async function syncRivhit(businessId: number, opts: { now?: Date; budget?: number } = {}): Promise<RivhitSyncReport> {
  const report: RivhitSyncReport = { connections: 0, receipts: 0, unreadable: 0, failures: 0, calls: 0 };
  const conns = await withTenantTransaction((tx) =>
    tx.acquisitionConnection.findMany({
      where: { sourceKey: RIVHIT_SOURCE, status: "ACTIVE" },
      select: { id: true, publicId: true },
      orderBy: { id: "asc" },
    })
  );
  if (!conns.length) return report;
  // A source the business does not have enabled is not polled (and talks to no Rivhit account).
  if (!(await sourceGate(businessId, RIVHIT_SOURCE)).ok) return report;
  for (const c of conns) {
    report.connections += 1;
    await syncRivhitConnection(businessId, c, report, opts);
  }
  return report;
}
