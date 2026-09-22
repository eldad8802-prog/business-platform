/**
 * Accounts Payable Phases 4–6 — the pure rules. No Prisma, no I/O, no clock.
 *
 *   §A  PaymentPreparation ("הכן תשלום") lifecycle and the approval snapshot
 *   §B  OutboundExecution state machine (provider-independent)
 *   §C  bank-statement CSV parsing and the idempotent identity of a bank line
 *   §D  matching a bank line to the ledger — the Phase 2 rules, reused
 *
 * One accounting truth runs through all four: nothing here moves money or
 * settles anything. A preparation is an intention, an execution is a request,
 * a bank line is an observation. Only a canonical Payment with active
 * allocations counts, and every path converges on exactly one.
 */

import { createHash } from "node:crypto";
import {
  PayablesValidationError,
  fromMinorUnits,
  toMinorUnits,
} from "@/lib/services/payables/payables-core";
import {
  amountsAgree,
  scoreCandidate,
  type Candidate,
  type CandidateTarget,
  type DocumentFacts,
} from "@/lib/services/payables/payables-matching";

/* ══════════════════════════ §A preparation ══════════════════════════════ */

export type PreparationStatusValue =
  | "PREPARED"
  | "APPROVED"
  | "SUBMITTED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type CompletionSourceValue = "OWNER_REPORTED" | "PROVIDER_SETTLED" | "BANK_OBSERVED";

/** Methods a preparation may carry. CHECK has its own first-class path (Phase 3). */
export const PREPARABLE_METHODS = [
  "BANK_TRANSFER",
  "CASH",
  "CREDIT_CARD",
  "DIRECT_DEBIT",
  "STANDING_ORDER",
  "BIT",
  "PAYBOX",
  "OTHER",
] as const;
export type PreparableMethod = (typeof PREPARABLE_METHODS)[number];

export function assertPreparableMethod(method: unknown): asserts method is PreparableMethod {
  if (method === "CHECK") {
    throw new PayablesValidationError(
      "A cheque is prepared through the cheque register, where its number and chequebook are recorded",
    );
  }
  if (typeof method !== "string" || !(PREPARABLE_METHODS as readonly string[]).includes(method)) {
    throw new PayablesValidationError("method must be one of " + PREPARABLE_METHODS.join(", "));
  }
}

/** A bank transfer without a destination is not a prepared payment — it is a wish. */
export function assertDestinationRule(method: PreparableMethod, destinationId: number | null): void {
  if (method === "BANK_TRANSFER" && !destinationId) {
    throw new PayablesValidationError("A bank transfer needs a destination account");
  }
  if (method !== "BANK_TRANSFER" && destinationId) {
    throw new PayablesValidationError("Only a bank transfer is paid to a destination account");
  }
}

const PREP_TRANSITIONS: Record<PreparationStatusValue, readonly PreparationStatusValue[]> = {
  PREPARED: ["APPROVED", "CANCELLED"],
  APPROVED: ["SUBMITTED", "COMPLETED", "CANCELLED"],
  SUBMITTED: ["COMPLETED", "FAILED"],
  // A failed attempt returns the decision to the owner: try again, pay another
  // way (report it), or cancel. Nothing was paid.
  FAILED: ["SUBMITTED", "COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function assertPreparationTransition(
  from: PreparationStatusValue,
  to: PreparationStatusValue,
): void {
  if (!PREP_TRANSITIONS[from].includes(to)) {
    throw new PayablesValidationError(`A ${from} payment preparation cannot become ${to}`);
  }
}

export function preparationActions(status: PreparationStatusValue): {
  approve: boolean;
  cancel: boolean;
  reportCompleted: boolean;
  execute: boolean;
} {
  return {
    approve: status === "PREPARED",
    cancel: PREP_TRANSITIONS[status].includes("CANCELLED"),
    reportCompleted: status === "APPROVED" || status === "FAILED",
    execute: status === "APPROVED" || status === "FAILED",
  };
}

export type ApprovalSnapshot = {
  preparationId: number;
  businessId: number;
  commitmentId: number;
  installmentId: number | null;
  payeeId: number | null;
  amount: string;
  currency: string;
  method: string;
  destinationId: number | null;
  destinationFingerprint: string | null;
  sourceBankAccountId: number | null;
  sourceFingerprint: string | null;
  reference: string | null;
};

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

/**
 * The frozen identity of WHAT WILL BE PAID. Any change to amount, destination
 * (including its coordinates, via the fingerprint), source, payee or obligation
 * produces a different hash — which is how a substituted destination is caught
 * at execution time instead of being silently paid.
 */
export function approvalHash(snapshot: ApprovalSnapshot): string {
  const normalized = { v: 1, ...snapshot, amount: fromMinorUnits(toMinorUnits(snapshot.amount)) };
  return createHash("sha256").update(stable(normalized), "utf8").digest("hex");
}

/* ══════════════════════════ §B execution ════════════════════════════════ */

export type ExecutionStatusValue =
  | "REQUESTED"
  | "SUBMITTED"
  | "ACKNOWLEDGED"
  | "SETTLED"
  | "FAILED"
  | "CANCELLED";

const EXEC_TRANSITIONS: Record<ExecutionStatusValue, readonly ExecutionStatusValue[]> = {
  REQUESTED: ["SUBMITTED", "FAILED", "CANCELLED"],
  SUBMITTED: ["ACKNOWLEDGED", "SETTLED", "FAILED"],
  // Acknowledged = the provider accepted the instruction. NOT settled: money may
  // still not move. Only SETTLED produces a Payment.
  ACKNOWLEDGED: ["SETTLED", "FAILED"],
  SETTLED: [],
  FAILED: [],
  CANCELLED: [],
};

export function assertExecutionTransition(from: ExecutionStatusValue, to: ExecutionStatusValue): void {
  if (!EXEC_TRANSITIONS[from].includes(to)) {
    throw new PayablesValidationError(`An execution ${from} cannot become ${to}`);
  }
}

export function isLiveExecution(status: ExecutionStatusValue): boolean {
  return status === "REQUESTED" || status === "SUBMITTED" || status === "ACKNOWLEDGED";
}

/* ══════════════════════════ §C bank statements ══════════════════════════ */

export type StatementLine = {
  lineNumber: number;
  bookedAt: Date;
  amountMinor: number;
  direction: "DEBIT" | "CREDIT";
  description: string | null;
  reference: string | null;
  counterpartyName: string | null;
};

export type StatementParseResult = {
  lines: StatementLine[];
  /** Line numbers and the FIELD at fault — never the content, which can name people. */
  errors: Array<{ lineNumber: number; field: string }>;
};

const HEADER_ALIASES: Record<string, string[]> = {
  date: ["date", "booked", "bookedat", "תאריך", "תאריך ערך", "תאריך פעולה"],
  amount: ["amount", "סכום"],
  debit: ["debit", "חובה", "חיוב"],
  credit: ["credit", "זכות", "זיכוי"],
  description: ["description", "details", "תיאור", "פרטים", "תיאור פעולה"],
  reference: ["reference", "ref", "אסמכתא", "אסמכתה"],
  counterparty: ["counterparty", "payee", "name", "מוטב", "שם", "לטובת"],
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur.trim() === "") {
      // A quote OPENS a quoted field only at the start of the field (RFC 4180).
      // Mid-field it is a literal — and Hebrew uses it constantly: בע"מ, ח"פ.
      quoted = true;
      cur = "";
    }
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** "1,234.50", "-1234.5", "₪ 1,234.50", "1234.50-" → minor units; null if not money. */
export function parseStatementAmount(raw: string): number | null {
  let s = raw.replace(/[₪\s]/g, "").replace(/,/g, "");
  if (s === "") return null;
  let negative = false;
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const minor = toMinorUnits(s);
  return negative ? -minor : minor;
}

/** YYYY-MM-DD, DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY, two-digit years as 20YY. Noon UTC. */
export function parseStatementDate(raw: string): Date | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (y < 100) y += 2000;
  }
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/**
 * Parse an owner-exported bank statement. Header names are matched against
 * English and Hebrew aliases; a signed `amount` column or separate
 * `debit`/`credit` columns are both accepted. A line that cannot be read is
 * reported by number and field and skipped — never guessed at.
 */
export function parseStatementCsv(text: string): StatementParseResult {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((r) => r.trim() !== "");
  if (rows.length === 0) return { lines: [], errors: [{ lineNumber: 0, field: "file" }] };

  const header = splitCsvLine(rows[0]).map((h) => h.toLowerCase().replace(/[\s_]+/g, " ").trim());
  const col: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h) || aliases.includes(h.replace(/ /g, "")));
    if (idx >= 0) col[key] = idx;
  }
  if (col.date === undefined) return { lines: [], errors: [{ lineNumber: 1, field: "date column" }] };
  if (col.amount === undefined && col.debit === undefined && col.credit === undefined) {
    return { lines: [], errors: [{ lineNumber: 1, field: "amount column" }] };
  }

  const lines: StatementLine[] = [];
  const errors: StatementParseResult["errors"] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const lineNumber = i + 1;
    const cells = splitCsvLine(rows[i]);
    const bookedAt = parseStatementDate(cells[col.date] ?? "");
    if (!bookedAt) {
      errors.push({ lineNumber, field: "date" });
      continue;
    }
    let signed: number | null = null;
    if (col.amount !== undefined) {
      signed = parseStatementAmount(cells[col.amount] ?? "");
    } else {
      const debit = col.debit !== undefined ? parseStatementAmount(cells[col.debit] ?? "") : null;
      const credit = col.credit !== undefined ? parseStatementAmount(cells[col.credit] ?? "") : null;
      if (debit && Math.abs(debit) > 0) signed = -Math.abs(debit);
      else if (credit && Math.abs(credit) > 0) signed = Math.abs(credit);
    }
    if (signed === null || signed === 0) {
      errors.push({ lineNumber, field: "amount" });
      continue;
    }
    const text = (k: string) => {
      const v = col[k] !== undefined ? (cells[col[k]] ?? "").trim() : "";
      return v === "" ? null : v.slice(0, 300);
    };
    lines.push({
      lineNumber,
      bookedAt,
      amountMinor: Math.abs(signed),
      direction: signed < 0 ? "DEBIT" : "CREDIT",
      description: text("description"),
      reference: text("reference"),
      counterpartyName: text("counterparty"),
    });
  }
  return { lines, errors };
}

/**
 * The identity of an uploaded line when the bank gives none: a digest of its
 * facts plus its occurrence among IDENTICAL facts in the same file. Re-uploading
 * an overlapping statement reproduces the same identities, so the unique index
 * (business, source, externalId) makes the second upload a no-op for every line
 * already seen. Two genuinely identical charges on one day stay two rows.
 */
export function statementLineIdentities(
  businessId: number,
  sourceBankAccountId: number | null,
  lines: StatementLine[],
): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = [
      "v1",
      businessId,
      sourceBankAccountId ?? "-",
      l.bookedAt.toISOString().slice(0, 10),
      l.direction,
      l.amountMinor,
      l.reference ?? "",
      (l.description ?? "").replace(/\s+/g, " ").toLowerCase(),
    ].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return "upl:" + createHash("sha256").update(`${base}|#${n}`, "utf8").digest("hex");
  });
}

/* ══════════════════════════ §D matching a bank line ═════════════════════ */

export type BankLineFacts = {
  externalTransactionId: number;
  amountMinor: number;
  bookedAt: Date;
  direction: "DEBIT" | "CREDIT";
  counterpartyName: string | null;
  description: string | null;
  reference: string | null;
};

/** A PAYMENT target may also carry the reference it was made with (a cheque number). */
export type BankCandidateTarget = CandidateTarget & { externalReference?: string | null };

export type BankCandidate = Candidate & { target: BankCandidateTarget };

function normalizeRef(s: string | null | undefined): string {
  return (s ?? "").replace(/[\s\-/#]/g, "").replace(/^0+/, "").toLowerCase();
}

/**
 * Score a bank line against a Payment or an open installment using EXACTLY the
 * Phase 2 rules (amount must agree AND be corroborated; never MATCHED, only
 * STRONG), with one additional corroborating signal a bank line can carry and a
 * document usually cannot: a reference equal to the Payment's own reference —
 * the cheque number on a cleared-cheque debit, the transfer reference on a
 * transfer. A reference is never enough ALONE either: the amount must agree.
 */
export function scoreBankLine(line: BankLineFacts, target: BankCandidateTarget): BankCandidate | null {
  const facts: DocumentFacts = {
    documentId: line.externalTransactionId,
    financialRecordId: null,
    amountMinor: line.amountMinor,
    date: line.bookedAt,
    vendorName: line.counterpartyName ?? line.description ?? "",
    direction: line.direction === "DEBIT" ? "expense" : "income",
  };
  const base = scoreCandidate(facts, target);

  const refMatches =
    target.kind === "PAYMENT" &&
    normalizeRef(target.externalReference) !== "" &&
    (normalizeRef(line.reference) === normalizeRef(target.externalReference) ||
      normalizeRef(line.description).includes(normalizeRef(target.externalReference)));

  if (!refMatches || target.kind !== "PAYMENT") return base as BankCandidate | null;
  if (line.direction !== "DEBIT") return null;
  if (!amountsAgree(line.amountMinor, target.amountMinor)) return null;

  const withRef: BankCandidate = base
    ? { ...base, target, signals: [...base.signals], reasons: [...base.reasons] }
    : { target, score: 0.4, signals: ["AMOUNT"], reasons: ["הסכום זהה"], dayGap: 0 };
  if (!base) {
    withRef.dayGap = Math.round(Math.abs(line.bookedAt.getTime() - target.paidAt.getTime()) / 86_400_000);
  }
  // The same signal vocabulary as Phase 2: a matching reference is treated as a
  // PAYEE_LINK-strength corroboration, reported in plain words.
  withRef.signals.push("PAYEE_LINK");
  withRef.reasons.push("האסמכתא תואמת");
  withRef.score = Math.min(1, Number((withRef.score + 0.3).toFixed(4)));
  return withRef;
}
