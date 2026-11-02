/**
 * Revenue report uploads — the pure core. docs/revenue-report-uploads.md.
 *
 *   validate   every draft against the CHECK constraints of its table (migration
 *              20261028090000_revenue_truth_foundation), IN CODE, so a bad row is reported to the owner with a
 *              reason instead of failing the whole commit at the database. The database still enforces all of it.
 *   identify   each draft's source key — the same key the table's unique index uses — and a hash of its facts
 *              (sourcePayloadHash), so the same Z / settlement uploaded again is recognised, and a changed one is a
 *              CONFLICT, never an overwrite.
 *   classify   NEW / EXISTING / CONFLICT against what the business already holds (rows passed in).
 *   decide     the owner's decision on every CONFLICT, checked against what that conflict allows.
 *
 * No I/O, no clock, no database. Money is bigint minor units.
 */
import { createHash } from "node:crypto";

import {
  REPORT_CURRENCIES,
  TENDER_METHODS,
  VAT_CATEGORIES,
  type ReportCurrency,
  type ReportKind,
  type ReportTenderMethod,
  type ReportVatCategory,
  type SettlementDraft,
  type ZReportDraft,
} from "./contract";

const ZERO = BigInt(0);
/** Amounts travel to the browser as JSON numbers: keep every one exactly representable. */
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
export const MAX_DRAFTS_PER_FILE = 2000;
export const MAX_LINES_PER_Z = 64;

// The tables' CHECK token patterns, verbatim.
export const RE_SCOPE = /^[a-z][a-z0-9_.:-]{0,79}$/;
export const RE_EXTERNAL_ID = /^[A-Za-z0-9:_.#/-]{1,200}$/;
export const RE_REGISTER_KEY = /^[A-Za-z0-9:_.-]{1,64}$/;
export const RE_ACQUIRER = /^[a-z][a-z0-9_]{0,39}$/;
export const RE_TENDER_LABEL = /^([a-z][a-z0-9_]{0,39})?$/;
export const RE_VALIDATION_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const RE_PARSER_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** sourceScope of an uploaded report: "upload.z.<parserKey>" / "upload.settlement.<parserKey>". */
export function sourceScopeOf(kind: ReportKind, parserKey: string): string {
  if (!RE_PARSER_KEY.test(parserKey)) throw new Error(`revenue report: parser key "${parserKey}" is not a token`);
  const scope = `upload.${kind}.${parserKey}`;
  if (!RE_SCOPE.test(scope)) throw new Error(`revenue report: scope "${scope}" is not a token`);
  return scope;
}
export const UPLOAD_SCOPE_PREFIX: Record<ReportKind, string> = { z: "upload.z.", settlement: "upload.settlement." };

/** A real calendar date written YYYY-MM-DD (2026-02-30 is refused). */
export function isCalendarDay(day: unknown): day is string {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

const isBig = (v: unknown): v is bigint => typeof v === "bigint";
const nonNeg = (v: unknown): v is bigint => isBig(v) && v >= ZERO;
const fits = (v: bigint) => v <= MAX_MINOR && v >= -MAX_MINOR;
const nonNegInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2_147_483_647;

/* ─────────────────────────────── normalized rows ─────────────────────────────── */

export type ZRow = {
  registerKey: string;
  externalId: string;
  zNumber: bigint | null;
  businessDay: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  currency: ReportCurrency;
  grossMinor: bigint;
  discountMinor: bigint;
  refundMinor: bigint;
  voidMinor: bigint;
  totalMinor: bigint;
  vatMinor: bigint;
  grandTotalMinor: bigint | null;
  transactionCount: number | null;
  tenders: { method: ReportTenderMethod; label: string; amountMinor: bigint; count: number | null }[];
  vatLines: { category: ReportVatCategory; rateBasisPoints: number; taxableMinor: bigint; vatMinor: bigint }[];
  validation: "PASSED" | "WARNINGS";
  validationCodes: string[];
  /** sha256 of the facts (not of the file): the row's sourcePayloadHash. */
  factsHash: string;
  sourceRow: number | null;
};

export type SettlementRow = {
  acquirer: string;
  externalId: string;
  valueDate: string;
  currency: ReportCurrency;
  grossMinor: bigint;
  feeMinor: bigint;
  otherDeductionsMinor: bigint;
  netMinor: bigint;
  installmentNumber: number | null;
  installmentCount: number | null;
  validation: "PASSED" | "WARNINGS";
  validationCodes: string[];
  factsHash: string;
  sourceRow: number | null;
};

export type Validated<T> = { ok: true; row: T } | { ok: false; codes: string[]; sourceRow: number | null };

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Canonical JSON (bigint as string, Dates as ISO), for hashing only. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Date ? v.toISOString() : v));
}

/** The Z's identity within its register: its Z number when the report prints one, else its business day. */
export function zExternalIdOf(draft: Pick<ZReportDraft, "zNumber" | "businessDay">): string {
  return draft.zNumber !== null && draft.zNumber !== undefined ? `z:${draft.zNumber}` : `day:${draft.businessDay}`;
}

/* ─────────────────────────────── validate ─────────────────────────────── */

/** "RevenueDailyClose" (+ tender, + VAT lines): every CHECK, in code. */
export function validateZDraft(d: ZReportDraft): Validated<ZRow> {
  const codes: string[] = [];
  const add = (c: string) => {
    if (!codes.includes(c)) codes.push(c);
  };
  const sourceRow = typeof d.sourceRow === "number" && Number.isInteger(d.sourceRow) ? d.sourceRow : null;

  if (!isCalendarDay(d.businessDay)) add("BUSINESS_DAY_INVALID");
  if (typeof d.registerKey !== "string" || !RE_REGISTER_KEY.test(d.registerKey)) add("REGISTER_KEY_INVALID");
  const currency = d.currency ?? "ILS";
  if (!(REPORT_CURRENCIES as readonly string[]).includes(currency)) add("CURRENCY_INVALID");

  const discount = d.discountMinor ?? ZERO;
  const refund = d.refundMinor ?? ZERO;
  const voids = d.voidMinor ?? ZERO;
  const amounts = [d.grossMinor, discount, refund, voids, d.vatMinor];
  if (!amounts.every(nonNeg) || !isBig(d.totalMinor)) add("AMOUNT_INVALID");
  else if (![...amounts, d.totalMinor].every(fits)) add("AMOUNT_TOO_LARGE");
  else if (d.totalMinor !== d.grossMinor - discount - refund - voids) add("TOTAL_MISMATCH");
  if (d.zNumber !== null && d.zNumber !== undefined && !nonNeg(d.zNumber)) add("Z_NUMBER_INVALID");
  if (d.grandTotalMinor !== null && d.grandTotalMinor !== undefined && !(isBig(d.grandTotalMinor) && fits(d.grandTotalMinor))) add("AMOUNT_INVALID");
  if (d.transactionCount !== null && d.transactionCount !== undefined && !nonNegInt(d.transactionCount)) add("TRANSACTION_COUNT_INVALID");
  const start = d.period?.start ?? null;
  const end = d.period?.end ?? null;
  if ((start !== null && !(start instanceof Date && !Number.isNaN(start.getTime()))) || (end !== null && !(end instanceof Date && !Number.isNaN(end.getTime())))) {
    add("PERIOD_INVALID");
  } else if (start && end && end.getTime() < start.getTime()) add("PERIOD_INVALID");

  const tenders = Array.isArray(d.tenders) ? d.tenders : [];
  const vatLines = Array.isArray(d.vatLines) ? d.vatLines : [];
  if (!Array.isArray(d.tenders) || !Array.isArray(d.vatLines) || tenders.length > MAX_LINES_PER_Z || vatLines.length > MAX_LINES_PER_Z) add("LINES_INVALID");
  const tenderKeys = new Set<string>();
  for (const t of tenders) {
    const label = t.label ?? "";
    if (!(TENDER_METHODS as readonly string[]).includes(t.method) || typeof label !== "string" || !RE_TENDER_LABEL.test(label)) add("TENDER_INVALID");
    else if (!(isBig(t.amountMinor) && fits(t.amountMinor))) add("TENDER_INVALID");
    else if (t.count !== null && t.count !== undefined && !nonNegInt(t.count)) add("TENDER_INVALID");
    const key = `${t.method}|${label}`;
    if (tenderKeys.has(key)) add("TENDER_DUPLICATE");
    tenderKeys.add(key);
  }
  const vatKeys = new Set<string>();
  for (const l of vatLines) {
    const rateOk = Number.isInteger(l.rateBasisPoints) && l.rateBasisPoints >= 0 && l.rateBasisPoints <= 10000;
    const amountsOk = isBig(l.taxableMinor) && fits(l.taxableMinor) && isBig(l.vatMinor) && fits(l.vatMinor);
    if (!(VAT_CATEGORIES as readonly string[]).includes(l.category) || !rateOk || !amountsOk) add("VAT_LINE_INVALID");
    else if (l.category !== "STANDARD" && (l.rateBasisPoints !== 0 || l.vatMinor !== ZERO)) add("VAT_LINE_INVALID");
    const key = `${l.category}|${l.rateBasisPoints}`;
    if (vatKeys.has(key)) add("VAT_LINE_DUPLICATE");
    vatKeys.add(key);
  }

  const externalId = codes.includes("BUSINESS_DAY_INVALID") || codes.includes("Z_NUMBER_INVALID") ? "" : zExternalIdOf(d);
  if (externalId && !RE_EXTERNAL_ID.test(externalId)) add("Z_NUMBER_INVALID");
  if (codes.length) return { ok: false, codes, sourceRow };

  // Consistency the table does not enforce: kept as warnings on the row (validationCodes), never silently fixed.
  const warnings: string[] = [];
  if (tenders.length > 0 && tenders.reduce((s, t) => s + t.amountMinor, ZERO) !== d.totalMinor) warnings.push("TENDERS_TOTAL_MISMATCH");
  if (vatLines.length > 0 && vatLines.reduce((s, l) => s + l.vatMinor, ZERO) !== d.vatMinor) warnings.push("VAT_LINES_MISMATCH");
  if (d.vatMinor > d.totalMinor) warnings.push("VAT_EXCEEDS_TOTAL");

  const facts = {
    kind: "z",
    registerKey: d.registerKey,
    externalId,
    zNumber: d.zNumber ?? null,
    businessDay: d.businessDay,
    periodStart: start,
    periodEnd: end,
    currency,
    grossMinor: d.grossMinor,
    discountMinor: discount,
    refundMinor: refund,
    voidMinor: voids,
    totalMinor: d.totalMinor,
    vatMinor: d.vatMinor,
    grandTotalMinor: d.grandTotalMinor ?? null,
    transactionCount: d.transactionCount ?? null,
    tenders: tenders
      .map((t) => ({ method: t.method, label: t.label ?? "", amountMinor: t.amountMinor, count: t.count ?? null }))
      .sort((a, b) => (`${a.method}|${a.label}` < `${b.method}|${b.label}` ? -1 : 1)),
    vatLines: vatLines
      .map((l) => ({ category: l.category, rateBasisPoints: l.rateBasisPoints, taxableMinor: l.taxableMinor, vatMinor: l.vatMinor }))
      .sort((a, b) => (`${a.category}|${a.rateBasisPoints}` < `${b.category}|${b.rateBasisPoints}` ? -1 : 1)),
  };
  return {
    ok: true,
    row: {
      ...facts,
      currency: currency as ReportCurrency,
      validation: warnings.length ? "WARNINGS" : "PASSED",
      validationCodes: warnings,
      factsHash: sha256(`revenue-report:z:v1\n${canonical(facts)}`),
      sourceRow,
    },
  };
}

/** "RevenueSettlement": every CHECK, in code. */
export function validateSettlementDraft(d: SettlementDraft): Validated<SettlementRow> {
  const codes: string[] = [];
  const add = (c: string) => {
    if (!codes.includes(c)) codes.push(c);
  };
  const sourceRow = typeof d.sourceRow === "number" && Number.isInteger(d.sourceRow) ? d.sourceRow : null;

  if (typeof d.acquirer !== "string" || !RE_ACQUIRER.test(d.acquirer)) add("ACQUIRER_INVALID");
  if (!isCalendarDay(d.valueDate)) add("VALUE_DATE_INVALID");
  if (typeof d.externalId !== "string" || !RE_EXTERNAL_ID.test(d.externalId)) add("EXTERNAL_ID_INVALID");
  const currency = d.currency ?? "ILS";
  if (!(REPORT_CURRENCIES as readonly string[]).includes(currency)) add("CURRENCY_INVALID");
  const fee = d.feeMinor ?? ZERO;
  const other = d.otherDeductionsMinor ?? ZERO;
  const amounts = [d.grossMinor, fee, other];
  if (!amounts.every(nonNeg) || !isBig(d.netMinor)) add("AMOUNT_INVALID");
  else if (![...amounts, d.netMinor].every(fits)) add("AMOUNT_TOO_LARGE");
  else if (d.netMinor !== d.grossMinor - fee - other) add("NET_MISMATCH");
  const inst = d.installments ?? null;
  if (inst !== null) {
    const okCount = Number.isInteger(inst.count) && inst.count >= 1 && inst.count <= 99;
    const okNumber = Number.isInteger(inst.number) && inst.number >= 1 && inst.number <= inst.count;
    if (!okCount || !okNumber) add("INSTALLMENT_INVALID");
  }
  if (codes.length) return { ok: false, codes, sourceRow };

  const warnings: string[] = [];
  if (d.netMinor < ZERO) warnings.push("NET_NEGATIVE");
  const facts = {
    kind: "settlement",
    acquirer: d.acquirer,
    externalId: d.externalId,
    valueDate: d.valueDate,
    currency,
    grossMinor: d.grossMinor,
    feeMinor: fee,
    otherDeductionsMinor: other,
    netMinor: d.netMinor,
    installmentNumber: inst?.number ?? null,
    installmentCount: inst?.count ?? null,
  };
  return {
    ok: true,
    row: {
      ...facts,
      currency: currency as ReportCurrency,
      validation: warnings.length ? "WARNINGS" : "PASSED",
      validationCodes: warnings,
      factsHash: sha256(`revenue-report:settlement:v1\n${canonical(facts)}`),
      sourceRow,
    },
  };
}

/* ─────────────────────────────── in-file duplicates ─────────────────────────────── */

export type PreparedRows<R> = {
  rows: R[];
  /** Rows not recorded, with why (validation codes, or a key repeated in the file). */
  invalid: { sourceRow: number | null; codes: string[] }[];
  /** The same row twice in the file (identical facts): read once. */
  repeatedInFile: number;
};

/** The key a row is unique by within one source scope (the table's unique index, minus business and scope). */
export function zKeyOf(r: Pick<ZRow, "registerKey" | "externalId">): string {
  return `${r.registerKey}|${r.externalId}`;
}

/**
 * Validated rows, each key once. A key twice with identical facts is one row (repeatedInFile); a key twice with
 * different facts is not guessed: every copy is invalid (CONFLICT_IN_FILE).
 */
export function dedupeInFile<R extends { factsHash: string; sourceRow: number | null }>(
  validated: Validated<R>[],
  keyOf: (r: R) => string
): PreparedRows<R> {
  const invalid: PreparedRows<R>["invalid"] = [];
  const byKey = new Map<string, R[]>();
  for (const v of validated) {
    if (!v.ok) {
      invalid.push({ sourceRow: v.sourceRow, codes: v.codes });
      continue;
    }
    const k = keyOf(v.row);
    byKey.set(k, [...(byKey.get(k) ?? []), v.row]);
  }
  const rows: R[] = [];
  let repeatedInFile = 0;
  for (const group of byKey.values()) {
    if (new Set(group.map((g) => g.factsHash)).size > 1) {
      for (const g of group) invalid.push({ sourceRow: g.sourceRow, codes: ["CONFLICT_IN_FILE"] });
      continue;
    }
    rows.push(group[0]);
    repeatedInFile += group.length - 1;
  }
  invalid.sort((a, b) => (a.sourceRow ?? 0) - (b.sourceRow ?? 0));
  return { rows, invalid, repeatedInFile };
}

/* ─────────────────────────────── classify ─────────────────────────────── */

/** A Z the business already holds on the same register and day (any source). */
export type ExistingClose = {
  id: number;
  sourceScope: string;
  registerKey: string;
  externalId: string;
  businessDay: string;
  revision: number;
  /** True when a later revision supersedes this one. */
  superseded: boolean;
  sourcePayloadHash: string | null;
  currency: string;
  totalMinor: bigint;
};

export type ExistingSettlement = {
  id: number;
  sourceScope: string;
  externalId: string;
  sourcePayloadHash: string | null;
  currency: string;
  grossMinor: bigint;
  netMinor: bigint;
};

export type ConflictDecision = "SKIP" | "SUPERSEDE" | "ADD";

/**
 *   NEW        nothing on this key (and, for a Z, nothing on this register and day).
 *   EXISTING   the same facts are already recorded: skipped (an exact replay, or the same Z from another source).
 *   CONFLICT   recorded with DIFFERENT facts. Never written without the owner's decision:
 *                SAME_Z           the same Z (register + Z number / day, this source): SKIP, or SUPERSEDE —
 *                                 recorded as revision n+1 naming the revision it corrects;
 *                SAME_DAY         another Z of this register and day: SKIP, or ADD — a separate Z of the same
 *                                 day (e.g. a second shift);
 *                SAME_SETTLEMENT  the same settlement id, different amounts: SKIP only (a settlement has no
 *                                 revisions; the recorded one stays).
 */
export type Classification =
  | { status: "NEW" }
  | { status: "EXISTING"; existingId: number }
  | {
      status: "CONFLICT";
      conflict: "SAME_Z" | "SAME_DAY" | "SAME_SETTLEMENT";
      existingIds: number[];
      /** The row a SUPERSEDE corrects (SAME_Z only). */
      supersedes: { id: number; revision: number } | null;
      allowed: ConflictDecision[];
      existingTotals: { currency: string; totalMinor: bigint }[];
    };

export function classifyZ(row: ZRow, scope: string, existing: readonly ExistingClose[]): Classification {
  const live = existing.filter((e) => !e.superseded && e.registerKey === row.registerKey && e.businessDay === row.businessDay);
  const chain = existing.filter((e) => e.sourceScope === scope && e.registerKey === row.registerKey && e.externalId === row.externalId);
  if (chain.length > 0) {
    // The chain's latest revision is what the Z says now.
    const latest = chain.reduce((a, b) => (b.revision > a.revision ? b : a));
    if (latest.sourcePayloadHash === row.factsHash) return { status: "EXISTING", existingId: latest.id };
    return {
      status: "CONFLICT",
      conflict: "SAME_Z",
      existingIds: [latest.id],
      supersedes: { id: latest.id, revision: latest.revision },
      allowed: ["SKIP", "SUPERSEDE"],
      existingTotals: [{ currency: latest.currency, totalMinor: latest.totalMinor }],
    };
  }
  if (live.length === 0) return { status: "NEW" };
  const same = live.find((e) => e.sourcePayloadHash === row.factsHash);
  if (same) return { status: "EXISTING", existingId: same.id };
  return {
    status: "CONFLICT",
    conflict: "SAME_DAY",
    existingIds: live.map((e) => e.id).sort((a, b) => a - b),
    supersedes: null,
    allowed: ["SKIP", "ADD"],
    existingTotals: live.map((e) => ({ currency: e.currency, totalMinor: e.totalMinor })),
  };
}

export function classifySettlement(row: SettlementRow, scope: string, existing: readonly ExistingSettlement[]): Classification {
  const same = existing.find((e) => e.sourceScope === scope && e.externalId === row.externalId);
  if (!same) return { status: "NEW" };
  if (same.sourcePayloadHash === row.factsHash) return { status: "EXISTING", existingId: same.id };
  return {
    status: "CONFLICT",
    conflict: "SAME_SETTLEMENT",
    existingIds: [same.id],
    supersedes: null,
    allowed: ["SKIP"],
    existingTotals: [{ currency: same.currency, totalMinor: same.netMinor }],
  };
}

/* ─────────────────────────────── decisions ─────────────────────────────── */

/** The owner's decision for each CONFLICT, keyed by the row's index in the preview. */
export type ConflictDecisions = Record<number, ConflictDecision>;

export type DecisionCheck = { ok: true } | { ok: false; code: "DECISIONS_REQUIRED" | "DECISIONS_INVALID"; missing: number };

/** Every conflict has an allowed decision; nothing else is decided. No default, ever. */
export function checkDecisions(classes: readonly Classification[], decisions: ConflictDecisions): DecisionCheck {
  const conflictIdx = classes.flatMap((c, i) => (c.status === "CONFLICT" ? [i] : []));
  for (const k of Object.keys(decisions)) {
    const i = Number(k);
    if (!conflictIdx.includes(i)) return { ok: false, code: "DECISIONS_INVALID", missing: 0 };
    const c = classes[i];
    if (c.status !== "CONFLICT" || !c.allowed.includes(decisions[i])) return { ok: false, code: "DECISIONS_INVALID", missing: 0 };
  }
  const missing = conflictIdx.filter((i) => decisions[i] === undefined).length;
  if (missing) return { ok: false, code: "DECISIONS_REQUIRED", missing };
  return { ok: true };
}

/** Canonical decisions, hashed: audit evidence, and the identity of a re-decision (a new run, not a replay). */
export function decisionsHashOf(kind: ReportKind, decisions: ConflictDecisions): string {
  const body = Object.keys(decisions)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => `${i}=${decisions[i]}`)
    .join("\n");
  return sha256(`revenue-report:${kind}:decisions:v1\n${body}`);
}

/** The parser's identity in the run ledger (ImportRun.mappingHash): kind, parser, parser version. */
export function parserHashOf(kind: ReportKind, parserKey: string, version: number): string {
  return sha256(`revenue-report:${kind}:parser:${parserKey}:v${version}`);
}

/** What the parse produced, as one hash: the commit refuses a file that reads differently than at analyze. */
export function draftsHashOf(rows: readonly { factsHash: string }[], invalid: readonly { sourceRow: number | null; codes: string[] }[]): string {
  return sha256(
    `revenue-report:drafts:v1\n${rows.map((r) => r.factsHash).join("\n")}\n--\n${invalid.map((i) => `${i.sourceRow ?? ""}:${i.codes.join(",")}`).join("\n")}`
  );
}

export function contentHashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
