/**
 * Revenue report uploads — analyze, then commit, an owner-uploaded Z report or card settlement report. SERVER-ONLY.
 * docs/revenue-report-uploads.md.
 *
 *   analyze   the registry picks the ONE parser that recognises the file (none today: FORMAT_NOT_SUPPORTED), the
 *             parser turns it into drafts, every draft is validated against its table's CHECKs (core.ts), and each
 *             is classified NEW / EXISTING / CONFLICT against what the business holds. Writes NOTHING. Returns a
 *             signed token binding this business, this user, this kind, this parser, these exact bytes and what
 *             they were read as — no amounts.
 *   commit    the same file, the token and the owner's decision on every CONFLICT. One tenant transaction under a
 *             per-business lock: the run is opened (or found — a replay reports the first outcome), the rows are
 *             classified again, NEW rows (and conflicts the owner chose to SUPERSEDE / ADD) are recorded through the
 *             revenue truth writers, the run is closed. All of it or none of it.
 *
 * Where it writes: RevenueDailyClose (+ tender, + VAT lines) or RevenueSettlement, through lib/revenue-truth/store
 * (append-only, FORCE RLS, SELECT / INSERT only); ImportRun through import-run-store (the ledger's only accessor)
 * with the file's hash — the file itself is NOT kept. Nothing else: no FinancialRecord, no FinancialEvent, no
 * BillingDocument, no ExternalTransaction. A report is evidence of a layer, never an income record.
 *
 *   Z           sourceKind POS, capture from the parser (FILE_STRUCTURED / FILE_EXTRACTED), scope upload.z.<parser>
 *   settlement  sourceKind ACQUIRER / PAYMENT_PROVIDER (the parser's), scope upload.settlement.<parser>
 *
 * `businessId` / `userId` MUST be server-derived (the session) — never from the request.
 */
import {
  SETTLEMENT_REPORT_RUN_DOMAIN,
  Z_REPORT_RUN_DOMAIN,
  completeRevenueReportRunInTx,
  findRevenueReportRunInTx,
  lastRevenueReportImportInTx,
  openRevenueReportRunInTx,
  retryKeyOf,
  type RevenueReportRunDomain,
} from "@/lib/data-transfer/import/execute/import-run-store";
import { IMPORT_PREVIEW_TTL_SECONDS } from "@/lib/data-transfer/import/import-config";
import { signEnvelope, verifyEnvelope, type EnvelopeSpec } from "@/lib/data-transfer/import/preview/signed-envelope";
import { recordDailyCloseInTx, recordSettlementInTx, type WriteResult } from "@/lib/revenue-truth/store";
import { tenantTx, type TenantTxClient } from "@/lib/tenant/tenant-tx";
import type { ReportFile, ReportKind, ReportParser, SettlementParser, ZReportParser } from "./contract";
import {
  MAX_DRAFTS_PER_FILE,
  UPLOAD_SCOPE_PREFIX,
  checkDecisions,
  classifySettlement,
  classifyZ,
  contentHashOf,
  decisionsHashOf,
  dedupeInFile,
  draftsHashOf,
  parserHashOf,
  sourceScopeOf,
  validateSettlementDraft,
  validateZDraft,
  zKeyOf,
  type Classification,
  type ConflictDecisions,
  type ExistingClose,
  type ExistingSettlement,
  type PreparedRows,
  type SettlementRow,
  type ZRow,
} from "./core";
import { SHIPPED_REGISTRY, type ParserRegistry } from "./registry";

const TOKEN_SPEC: EnvelopeSpec = {
  keyLabel: "dubiz:revenue-report-upload:v1",
  purpose: "revenue-report-upload",
  version: 1,
  ttlSeconds: IMPORT_PREVIEW_TTL_SECONDS,
};

const LOCK_PREFIX = "revenue-report-ingest:";
const RUN_DOMAIN: Record<ReportKind, RevenueReportRunDomain> = { z: Z_REPORT_RUN_DOMAIN, settlement: SETTLEMENT_REPORT_RUN_DOMAIN };

export type RevenueReportErrorCode =
  | "FILE_UNREADABLE"
  | "FORMAT_NOT_SUPPORTED"
  | "FORMAT_AMBIGUOUS"
  | "NO_REPORTS"
  | "TOO_MANY_REPORTS"
  | "TOKEN_INVALID"
  | "FILE_CHANGED"
  | "DECISIONS_REQUIRED"
  | "DECISIONS_INVALID"
  | "STATE_CHANGED";

export class RevenueReportError extends Error {
  constructor(
    public readonly code: RevenueReportErrorCode,
    public readonly status: number,
    public readonly detail: Record<string, string | number> = {}
  ) {
    super(code);
    this.name = "RevenueReportError";
  }
}

export type RevenueReportInput = {
  businessId: number;
  userId: number;
  kind: ReportKind;
  filename: string;
  bytes: Buffer;
  mime: string | null;
};

/** Tests (and only tests) pass their own registry; the routes always use the shipped one. */
export type ServiceOptions = { registry?: ParserRegistry };

type Prepared =
  | { kind: "z"; parser: ZReportParser; scope: string; contentHash: string; draftsHash: string; prepared: PreparedRows<ZRow> }
  | { kind: "settlement"; parser: SettlementParser; scope: string; contentHash: string; draftsHash: string; prepared: PreparedRows<SettlementRow> };

function fileOf(input: RevenueReportInput): ReportFile {
  return { bytes: input.bytes, filename: input.filename, mime: input.mime };
}

/** Pick the parser (or the one the token names), parse, validate, dedupe. No database. */
function prepare(input: RevenueReportInput, registry: ParserRegistry, pinned?: { key: string; version: number }): Prepared {
  if (!input.bytes.length) throw new RevenueReportError("FILE_UNREADABLE", 400, { reason: "EMPTY" });
  const file = fileOf(input);
  let parser: ReportParser;
  if (pinned) {
    const p = registry.byKey(input.kind, pinned.key);
    // The parser named at analyze is gone or reads differently now: analyze again.
    if (!p || p.version !== pinned.version) throw new RevenueReportError("FILE_CHANGED", 409, { reason: "PARSER_CHANGED" });
    parser = p;
  } else {
    const picked = registry.select(input.kind, file);
    if (!picked.ok) {
      throw picked.reason === "AMBIGUOUS"
        ? new RevenueReportError("FORMAT_AMBIGUOUS", 422)
        : new RevenueReportError("FORMAT_NOT_SUPPORTED", 422);
    }
    parser = picked.parser;
  }

  let parsed: ReturnType<ZReportParser["parse"]> | ReturnType<SettlementParser["parse"]>;
  try {
    parsed = parser.parse(file);
  } catch {
    // A recognised file the parser cannot read through: never a partial guess.
    throw new RevenueReportError("FILE_UNREADABLE", 400, { reason: "PARSE_FAILED" });
  }
  if (parsed.drafts.length > MAX_DRAFTS_PER_FILE) throw new RevenueReportError("TOO_MANY_REPORTS", 400, { max: MAX_DRAFTS_PER_FILE });
  const parseErrors = parsed.errors.map((e) => ({ sourceRow: e.row, codes: [/^[A-Z][A-Z0-9_]{0,63}$/.test(e.code) ? e.code : "UNREADABLE_ROW"] }));
  const contentHash = contentHashOf(input.bytes);
  const scope = sourceScopeOf(input.kind, parser.key);

  if (parser.kind === "z") {
    const p = dedupeInFile(parsed.drafts.map((d) => validateZDraft(d as Parameters<typeof validateZDraft>[0])), zKeyOf);
    const prepared = { ...p, invalid: [...parseErrors, ...p.invalid] };
    return { kind: "z", parser, scope, contentHash, draftsHash: draftsHashOf(prepared.rows, prepared.invalid), prepared };
  }
  const p = dedupeInFile(parsed.drafts.map((d) => validateSettlementDraft(d as Parameters<typeof validateSettlementDraft>[0])), (r) => r.externalId);
  const prepared = { ...p, invalid: [...parseErrors, ...p.invalid] };
  return { kind: "settlement", parser, scope, contentHash, draftsHash: draftsHashOf(prepared.rows, prepared.invalid), prepared };
}

const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** What the business holds on the registers / days / Z identities of this file (any source), with supersession. */
async function existingCloses(tx: TenantTxClient, businessId: number, scope: string, rows: readonly ZRow[]): Promise<ExistingClose[]> {
  if (!rows.length) return [];
  const days = [...new Set(rows.map((r) => r.businessDay))].map(dayDate);
  const registers = [...new Set(rows.map((r) => r.registerKey))];
  const externalIds = [...new Set(rows.map((r) => r.externalId))];
  const found = await tx.revenueDailyClose.findMany({
    where: {
      businessId,
      registerKey: { in: registers },
      OR: [{ businessDay: { in: days } }, { sourceScope: scope, externalId: { in: externalIds } }],
    },
    select: { id: true, sourceScope: true, registerKey: true, externalId: true, businessDay: true, revision: true, sourcePayloadHash: true, currency: true, totalMinor: true },
  });
  const successors = found.length
    ? await tx.revenueDailyClose.findMany({ where: { businessId, supersedesId: { in: found.map((f) => f.id) } }, select: { supersedesId: true } })
    : [];
  const superseded = new Set(successors.map((s) => s.supersedesId));
  return found.map((f) => ({ ...f, businessDay: isoDay(f.businessDay), superseded: superseded.has(f.id) }));
}

async function existingSettlements(tx: TenantTxClient, businessId: number, scope: string, rows: readonly SettlementRow[]): Promise<ExistingSettlement[]> {
  if (!rows.length) return [];
  return tx.revenueSettlement.findMany({
    where: { businessId, sourceScope: scope, externalId: { in: rows.map((r) => r.externalId) } },
    select: { id: true, sourceScope: true, externalId: true, sourcePayloadHash: true, currency: true, grossMinor: true, netMinor: true },
  });
}

async function classifyAll(tx: TenantTxClient, businessId: number, p: Prepared): Promise<Classification[]> {
  if (p.kind === "z") {
    const existing = await existingCloses(tx, businessId, p.scope, p.prepared.rows);
    return p.prepared.rows.map((r) => classifyZ(r, p.scope, existing));
  }
  const existing = await existingSettlements(tx, businessId, p.scope, p.prepared.rows);
  return p.prepared.rows.map((r) => classifySettlement(r, p.scope, existing));
}

/* ─────────────────────────────── analyze ─────────────────────────────── */

const n = (v: bigint) => Number(v);

export type PreviewConflict = {
  conflict: "SAME_Z" | "SAME_DAY" | "SAME_SETTLEMENT";
  allowed: Array<"SKIP" | "SUPERSEDE" | "ADD">;
  existingTotals: { currency: string; totalMinor: number }[];
};

export type ZPreviewRow = {
  index: number;
  sourceRow: number | null;
  status: "NEW" | "EXISTING" | "CONFLICT";
  conflict: PreviewConflict | null;
  businessDay: string;
  registerKey: string;
  zNumber: string | null;
  currency: string;
  grossMinor: number;
  discountMinor: number;
  refundMinor: number;
  voidMinor: number;
  totalMinor: number;
  vatMinor: number;
  transactionCount: number | null;
  tenders: { method: string; label: string; amountMinor: number; count: number | null }[];
  vatLines: { category: string; rateBasisPoints: number; taxableMinor: number; vatMinor: number }[];
  warnings: string[];
};

export type SettlementPreviewRow = {
  index: number;
  sourceRow: number | null;
  status: "NEW" | "EXISTING" | "CONFLICT";
  conflict: PreviewConflict | null;
  acquirer: string;
  valueDate: string;
  externalId: string;
  currency: string;
  grossMinor: number;
  feeMinor: number;
  otherDeductionsMinor: number;
  netMinor: number;
  installments: { number: number; count: number } | null;
  warnings: string[];
};

export type RevenueReportPreview = {
  status: "READY";
  kind: ReportKind;
  token: string;
  expiresAt: string;
  parser: { key: string; label: string; capture: "FILE_STRUCTURED" | "FILE_EXTRACTED" };
  counts: { reports: number; new: number; existing: number; conflicts: number; invalid: number; repeatedInFile: number; warnings: number };
  invalid: { sourceRow: number | null; codes: string[] }[];
  previouslyImportedAt: string | null;
  /** The source file is never stored — only its hash. Stated so the screen says so. */
  sourceFileStored: false;
  rows: ZPreviewRow[] | SettlementPreviewRow[];
};

function previewConflict(c: Classification): PreviewConflict | null {
  if (c.status !== "CONFLICT") return null;
  return { conflict: c.conflict, allowed: c.allowed, existingTotals: c.existingTotals.map((t) => ({ currency: t.currency, totalMinor: n(t.totalMinor) })) };
}

function zPreview(r: ZRow, i: number, c: Classification): ZPreviewRow {
  return {
    index: i,
    sourceRow: r.sourceRow,
    status: c.status,
    conflict: previewConflict(c),
    businessDay: r.businessDay,
    registerKey: r.registerKey,
    zNumber: r.zNumber === null ? null : r.zNumber.toString(),
    currency: r.currency,
    grossMinor: n(r.grossMinor),
    discountMinor: n(r.discountMinor),
    refundMinor: n(r.refundMinor),
    voidMinor: n(r.voidMinor),
    totalMinor: n(r.totalMinor),
    vatMinor: n(r.vatMinor),
    transactionCount: r.transactionCount,
    tenders: r.tenders.map((t) => ({ method: t.method, label: t.label, amountMinor: n(t.amountMinor), count: t.count })),
    vatLines: r.vatLines.map((l) => ({ category: l.category, rateBasisPoints: l.rateBasisPoints, taxableMinor: n(l.taxableMinor), vatMinor: n(l.vatMinor) })),
    warnings: r.validationCodes,
  };
}

function settlementPreview(r: SettlementRow, i: number, c: Classification): SettlementPreviewRow {
  return {
    index: i,
    sourceRow: r.sourceRow,
    status: c.status,
    conflict: previewConflict(c),
    acquirer: r.acquirer,
    valueDate: r.valueDate,
    externalId: r.externalId,
    currency: r.currency,
    grossMinor: n(r.grossMinor),
    feeMinor: n(r.feeMinor),
    otherDeductionsMinor: n(r.otherDeductionsMinor),
    netMinor: n(r.netMinor),
    installments: r.installmentCount === null || r.installmentNumber === null ? null : { number: r.installmentNumber, count: r.installmentCount },
    warnings: r.validationCodes,
  };
}

type TokenFacts = { b: number; u: number; k: ReportKind; p: string; pv: number; ch: string; dh: string; n: number };

export async function analyzeRevenueReport(input: RevenueReportInput, opts: ServiceOptions = {}): Promise<RevenueReportPreview> {
  const p = prepare(input, opts.registry ?? SHIPPED_REGISTRY);
  const rowsCount = p.prepared.rows.length;
  if (rowsCount === 0 && p.prepared.invalid.length === 0) throw new RevenueReportError("NO_REPORTS", 400);

  const { classes, previous } = await tenantTx(input.businessId, async (tx) => ({
    classes: await classifyAll(tx, input.businessId, p),
    previous: await lastRevenueReportImportInTx(tx, input.businessId, RUN_DOMAIN[input.kind], p.contentHash),
  }));

  const token = signEnvelope<TokenFacts>(TOKEN_SPEC, {
    b: input.businessId,
    u: input.userId,
    k: input.kind,
    p: p.parser.key,
    pv: p.parser.version,
    ch: p.contentHash,
    dh: p.draftsHash,
    n: rowsCount,
  });
  const verified = verifyEnvelope<TokenFacts>(TOKEN_SPEC, token);
  const rows =
    p.kind === "z"
      ? p.prepared.rows.map((r, i) => zPreview(r, i, classes[i]))
      : p.prepared.rows.map((r, i) => settlementPreview(r, i, classes[i]));
  return {
    status: "READY",
    kind: input.kind,
    token,
    expiresAt: verified.ok ? verified.expiresAt.toISOString() : new Date().toISOString(),
    parser: { key: p.parser.key, label: p.parser.label, capture: p.parser.capture },
    counts: {
      reports: rowsCount,
      new: classes.filter((c) => c.status === "NEW").length,
      existing: classes.filter((c) => c.status === "EXISTING").length,
      conflicts: classes.filter((c) => c.status === "CONFLICT").length,
      invalid: p.prepared.invalid.length,
      repeatedInFile: p.prepared.repeatedInFile,
      warnings: p.prepared.rows.filter((r) => r.validationCodes.length > 0).length,
    },
    invalid: p.prepared.invalid.slice(0, 100),
    previouslyImportedAt: previous ? previous.toISOString() : null,
    sourceFileStored: false,
    rows: rows as ZPreviewRow[] | SettlementPreviewRow[],
  };
}

/* ─────────────────────────────── commit ─────────────────────────────── */

export type RevenueReportCommitResult = {
  importRunId: number;
  /** True when this file, parser and decisions were already committed: nothing was done again. */
  replayed: boolean;
  recorded: number;
  existing: number;
  skippedByDecision: number;
  superseded: number;
  invalid: number;
  committedAt: string;
};

export async function commitRevenueReport(
  input: RevenueReportInput & { token: unknown; decisions?: ConflictDecisions | null },
  opts: ServiceOptions = {}
): Promise<RevenueReportCommitResult> {
  const verified = verifyEnvelope<TokenFacts>(TOKEN_SPEC, input.token);
  if (!verified.ok) throw new RevenueReportError("TOKEN_INVALID", 400, { reason: verified.reason });
  const facts = verified.facts;
  if (facts.b !== input.businessId || facts.u !== input.userId || facts.k !== input.kind) {
    throw new RevenueReportError("TOKEN_INVALID", 400, { reason: "BINDING" });
  }
  const p = prepare(input, opts.registry ?? SHIPPED_REGISTRY, { key: facts.p, version: facts.pv });
  if (p.contentHash !== facts.ch || p.draftsHash !== facts.dh || p.prepared.rows.length !== facts.n) {
    throw new RevenueReportError("FILE_CHANGED", 409);
  }
  const decisions: ConflictDecisions = input.decisions ?? {};
  const decisionsHash = decisionsHashOf(input.kind, decisions);
  const parserHash = parserHashOf(input.kind, p.parser.key, p.parser.version);
  // The same file with the same decisions again is a replay; a re-decision (e.g. superseding what was skipped) is a
  // new run. An upload with nothing to decide hashes without a decisions component.
  const retryKey = retryKeyOf({
    businessId: input.businessId,
    contentHash: p.contentHash,
    mappingHash: parserHash,
    overrideActionHash: Object.keys(decisions).length ? decisionsHash : null,
  });
  const total = p.prepared.rows.length + p.prepared.invalid.length + p.prepared.repeatedInFile;

  return tenantTx(
    input.businessId,
    async (tx) => {
      // One revenue report ingest per business and kind at a time.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_PREFIX + input.kind + ":" + String(input.businessId)}))`;

      const prior = await findRevenueReportRunInTx(tx, retryKey);
      if (prior) {
        return {
          importRunId: prior.id,
          replayed: true,
          recorded: prior.createdCount ?? 0,
          existing: prior.skippedCount ?? 0,
          skippedByDecision: 0,
          superseded: 0,
          invalid: prior.failedCount ?? 0,
          committedAt: (prior.completedAt ?? prior.startedAt).toISOString(),
        };
      }

      // Classified again under the lock: what the owner decided must match what conflicts NOW.
      const classes = await classifyAll(tx, input.businessId, p);
      const check = checkDecisions(classes, decisions);
      if (!check.ok) throw new RevenueReportError(check.code, 409, check.code === "DECISIONS_REQUIRED" ? { missing: check.missing } : {});

      const runId = await openRevenueReportRunInTx(tx, {
        businessId: input.businessId,
        userId: input.userId,
        domain: RUN_DOMAIN[input.kind],
        contentHash: p.contentHash,
        mappingHash: parserHash,
        decisionsHash,
        retryKey,
        totalRows: total,
      });
      const ingestRef = `importrun:${runId}`;

      let recorded = 0;
      let existing = 0;
      let skippedByDecision = 0;
      let superseded = 0;
      const expectCreated = (r: WriteResult) => {
        // Under the lock, after classification, a NEW row can only be created; anything else means the state moved.
        if (r.status !== "CREATED") throw new RevenueReportError("STATE_CHANGED", 409);
        recorded += 1;
      };

      for (let i = 0; i < classes.length; i++) {
        const c = classes[i];
        if (c.status === "EXISTING") {
          existing += 1;
          continue;
        }
        let revision = 1;
        let supersedesId: number | null = null;
        if (c.status === "CONFLICT") {
          const d = decisions[i];
          if (d === "SKIP") {
            skippedByDecision += 1;
            continue;
          }
          if (d === "SUPERSEDE" && c.supersedes) {
            revision = c.supersedes.revision + 1;
            supersedesId = c.supersedes.id;
            superseded += 1;
          }
          // ADD: a separate Z of the same register and day, on its own key (revision 1).
        }
        if (p.kind === "z") {
          const r = p.prepared.rows[i];
          expectCreated(
            await recordDailyCloseInTx(tx, input.businessId, {
              sourceKind: "POS",
              capture: p.parser.capture,
              sourceScope: p.scope,
              externalId: r.externalId,
              sourcePayloadHash: r.factsHash,
              ingestRef,
              registerKey: r.registerKey,
              revision,
              supersedesId,
              zNumber: r.zNumber,
              businessDay: r.businessDay,
              periodStart: r.periodStart,
              periodEnd: r.periodEnd,
              currency: r.currency,
              grossMinor: r.grossMinor,
              discountMinor: r.discountMinor,
              refundMinor: r.refundMinor,
              voidMinor: r.voidMinor,
              vatMinor: r.vatMinor,
              grandTotalMinor: r.grandTotalMinor,
              transactionCount: r.transactionCount,
              validation: r.validation,
              validationCodes: r.validationCodes,
              tenders: r.tenders,
              vatLines: r.vatLines,
            })
          );
        } else {
          const r = p.prepared.rows[i];
          expectCreated(
            await recordSettlementInTx(tx, input.businessId, {
              sourceKind: p.parser.sourceKind,
              capture: p.parser.capture,
              sourceScope: p.scope,
              externalId: r.externalId,
              sourcePayloadHash: r.factsHash,
              ingestRef,
              acquirer: r.acquirer,
              valueDate: r.valueDate,
              currency: r.currency,
              grossMinor: r.grossMinor,
              feeMinor: r.feeMinor,
              otherDeductionsMinor: r.otherDeductionsMinor,
              installmentNumber: r.installmentNumber,
              installmentCount: r.installmentCount,
              validation: r.validation,
              validationCodes: r.validationCodes,
            })
          );
        }
      }

      const completedAt = new Date();
      await completeRevenueReportRunInTx(tx, runId, {
        created: recorded,
        skipped: existing + skippedByDecision + p.prepared.repeatedInFile,
        failed: p.prepared.invalid.length,
        completedAt,
      });
      return {
        importRunId: runId,
        replayed: false,
        recorded,
        existing,
        skippedByDecision,
        superseded,
        invalid: p.prepared.invalid.length,
        committedAt: completedAt.toISOString(),
      };
    },
    { timeoutMs: 60_000 }
  );
}

/* ─────────────────────────────── list (read-only) ─────────────────────────────── */

export type RecordedZ = {
  id: number;
  businessDay: string;
  registerKey: string;
  zNumber: string | null;
  revision: number;
  /** A later revision corrects this one. */
  superseded: boolean;
  parserKey: string;
  capture: string;
  currency: string;
  grossMinor: number;
  discountMinor: number;
  refundMinor: number;
  voidMinor: number;
  totalMinor: number;
  vatMinor: number;
  transactionCount: number | null;
  tenders: { method: string; label: string; amountMinor: number }[];
  validationCodes: string[];
  recordedAt: string;
};

export type RecordedSettlement = {
  id: number;
  valueDate: string;
  acquirer: string;
  externalId: string;
  parserKey: string;
  currency: string;
  grossMinor: number;
  feeMinor: number;
  otherDeductionsMinor: number;
  netMinor: number;
  installments: { number: number; count: number } | null;
  validationCodes: string[];
  recordedAt: string;
};

export const LIST_LIMIT = 200;

/** The Z reports recorded from uploads in this business, newest business day first. Writes nothing. */
export async function listUploadedZReports(businessId: number, limit = LIST_LIMIT): Promise<RecordedZ[]> {
  const take = Math.max(1, Math.min(LIST_LIMIT, Math.floor(limit)));
  return tenantTx(businessId, async (tx) => {
    const rows = await tx.revenueDailyClose.findMany({
      where: { businessId, sourceScope: { startsWith: UPLOAD_SCOPE_PREFIX.z } },
      orderBy: [{ businessDay: "desc" }, { registerKey: "asc" }, { id: "desc" }],
      take,
      select: {
        id: true, sourceScope: true, capture: true, businessDay: true, registerKey: true, zNumber: true, revision: true,
        currency: true, grossMinor: true, discountMinor: true, refundMinor: true, voidMinor: true, totalMinor: true,
        vatMinor: true, transactionCount: true, validationCodes: true, recordedAt: true,
      },
    });
    const ids = rows.map((r) => r.id);
    const [successors, tenders] = ids.length
      ? await Promise.all([
          tx.revenueDailyClose.findMany({ where: { businessId, supersedesId: { in: ids } }, select: { supersedesId: true } }),
          tx.revenueDailyCloseTender.findMany({
            where: { businessId, dailyCloseId: { in: ids } },
            select: { dailyCloseId: true, method: true, label: true, amountMinor: true },
            orderBy: [{ dailyCloseId: "asc" }, { id: "asc" }],
          }),
        ])
      : [[], []];
    const superseded = new Set(successors.map((s) => s.supersedesId));
    return rows.map((r) => ({
      id: r.id,
      businessDay: isoDay(r.businessDay),
      registerKey: r.registerKey,
      zNumber: r.zNumber === null ? null : r.zNumber.toString(),
      revision: r.revision,
      superseded: superseded.has(r.id),
      parserKey: r.sourceScope.slice(UPLOAD_SCOPE_PREFIX.z.length),
      capture: r.capture,
      currency: r.currency,
      grossMinor: n(r.grossMinor),
      discountMinor: n(r.discountMinor),
      refundMinor: n(r.refundMinor),
      voidMinor: n(r.voidMinor),
      totalMinor: n(r.totalMinor),
      vatMinor: n(r.vatMinor),
      transactionCount: r.transactionCount,
      tenders: tenders.filter((t) => t.dailyCloseId === r.id).map((t) => ({ method: t.method, label: t.label, amountMinor: n(t.amountMinor) })),
      validationCodes: r.validationCodes,
      recordedAt: r.recordedAt.toISOString(),
    }));
  });
}

/** The settlements recorded from uploads in this business, newest value date first. Writes nothing. */
export async function listUploadedSettlements(businessId: number, limit = LIST_LIMIT): Promise<RecordedSettlement[]> {
  const take = Math.max(1, Math.min(LIST_LIMIT, Math.floor(limit)));
  return tenantTx(businessId, async (tx) => {
    const rows = await tx.revenueSettlement.findMany({
      where: { businessId, sourceScope: { startsWith: UPLOAD_SCOPE_PREFIX.settlement } },
      orderBy: [{ valueDate: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true, sourceScope: true, valueDate: true, acquirer: true, externalId: true, currency: true, grossMinor: true,
        feeMinor: true, otherDeductionsMinor: true, netMinor: true, installmentNumber: true, installmentCount: true,
        validationCodes: true, recordedAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      valueDate: isoDay(r.valueDate),
      acquirer: r.acquirer,
      externalId: r.externalId,
      parserKey: r.sourceScope.slice(UPLOAD_SCOPE_PREFIX.settlement.length),
      currency: r.currency,
      grossMinor: n(r.grossMinor),
      feeMinor: n(r.feeMinor),
      otherDeductionsMinor: n(r.otherDeductionsMinor),
      netMinor: n(r.netMinor),
      installments: r.installmentCount === null || r.installmentNumber === null ? null : { number: r.installmentNumber, count: r.installmentCount },
      validationCodes: r.validationCodes,
      recordedAt: r.recordedAt.toISOString(),
    }));
  });
}
