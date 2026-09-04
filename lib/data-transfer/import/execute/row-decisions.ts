/**
 * What the owner decided to do with each row, and how that decision is bound.
 *
 * # The two-call shape, and why it is not a third endpoint
 *
 * Preview is called twice. The first call carries no decisions: the server
 * computes a DEFAULT for every row and returns it with a token. The owner
 * changes what they want to change, and preview is called again WITH those
 * decisions — the server re-derives every row from the same bytes, checks that
 * each decision is one it would actually offer for that row, and issues a token
 * binding `decisionsHash` alongside `contentHash` and `mappingHash`.
 *
 * Execute then requires that token and the same decisions. It cannot be handed
 * a decision the owner never saw, and it cannot be handed the owner's decisions
 * against a different file.
 *
 * # Decisions are VALIDATED, not merely bound
 *
 * A signature proves a decision was not altered in transit. It does not prove
 * the decision was ever legitimate. So every decision is re-checked against
 * freshly computed server truth: you cannot CREATE a row the server has marked
 * ERROR, and you cannot CREATE over an open lead. The one place an owner may
 * override the default is a Supplier tax-id match, because Suppliers have no
 * uniqueness and a deliberate second supplier is a real business case.
 */

import { createHash } from "node:crypto";
import type { DerivedRow } from "@/lib/data-transfer/import/derive-rows";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import {
  resolveInFileGroups,
  verdictFor,
} from "@/lib/data-transfer/import/execute/duplicate-policy";

export const ROW_ACTIONS = ["CREATE", "SKIP"] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

/** sourceRowNumber -> action. A row absent from the map takes the default. */
export type RowDecisions = Record<number, RowAction>;

export type DecisionProblem = {
  rowNumber: number;
  code: "UNKNOWN_ROW" | "INVALID_ACTION" | "NOT_PERMITTED";
  reason: string;
};

/**
 * The action the server proposes for a row, before the owner touches anything.
 *
 * Domain-specific, never blanket. An ERROR row is never executable. Otherwise
 * the duplicate POLICY decides — an exact supplier tax-id match blocks while a
 * supplier name match does not, and a closed lead does not block at all. See
 * `duplicate-policy.ts` for the locked table.
 */
export function defaultActionFor(
  domainId: DataTransferDomainId,
  row: DerivedRow,
  inFileEligible: ReadonlySet<number>
): RowAction {
  if (row.status === "ERROR") return "SKIP";

  const evidence = row.duplicates.filter(
    (e) => e.scope !== "IN_FILE" || !inFileEligible.has(row.rowNumber)
  );
  return verdictFor(domainId, evidence).blocking ? "SKIP" : "CREATE";
}

/** The eligible member of every in-file collision group. */
export function inFileEligibleRows(
  rows: readonly DerivedRow[]
): Set<number> {
  return resolveInFileGroups(
    new Map(rows.map((r) => [r.rowNumber, r.duplicates]))
  );
}

/** Server-computed defaults for the whole file. */
export function defaultDecisions(
  domainId: DataTransferDomainId,
  rows: readonly DerivedRow[]
): RowDecisions {
  const eligible = inFileEligibleRows(rows);
  const out: RowDecisions = {};
  for (const row of rows) {
    out[row.rowNumber] = defaultActionFor(domainId, row, eligible);
  }
  return out;
}

/**
 * May the owner choose CREATE for this row?
 *
 * Only when every blocking reason is one the locked policy marks overridable —
 * today that is exactly an exact supplier tax-id match against an existing
 * supplier. An in-file collision is never overridable: the owner's own file
 * contradicts itself, and the fix belongs in the spreadsheet.
 */
export function mayOverrideToCreate(
  domainId: DataTransferDomainId,
  row: DerivedRow,
  inFileEligible: ReadonlySet<number>
): boolean {
  if (row.status === "ERROR") return false;
  const evidence = row.duplicates.filter(
    (e) => e.scope !== "IN_FILE" || !inFileEligible.has(row.rowNumber)
  );
  const verdict = verdictFor(domainId, evidence);
  return !verdict.blocking || verdict.overridable;
}

/**
 * Check a submitted decision set against freshly derived rows.
 *
 * Returns every problem, not the first: someone fixing their choices wants the
 * whole list. SKIP is always permitted — declining to import is never invalid.
 */
export function validateDecisions(input: {
  domainId: DataTransferDomainId;
  rows: readonly DerivedRow[];
  decisions: RowDecisions;
}): DecisionProblem[] {
  const byNumber = new Map(input.rows.map((r) => [r.rowNumber, r]));
  const eligible = inFileEligibleRows(input.rows);
  const problems: DecisionProblem[] = [];

  for (const [rawNumber, action] of Object.entries(input.decisions)) {
    const rowNumber = Number(rawNumber);
    const row = byNumber.get(rowNumber);

    if (!Number.isInteger(rowNumber) || !row) {
      problems.push({
        rowNumber,
        code: "UNKNOWN_ROW",
        reason: "השורה אינה קיימת בקובץ",
      });
      continue;
    }
    if (!(ROW_ACTIONS as readonly string[]).includes(action)) {
      problems.push({
        rowNumber,
        code: "INVALID_ACTION",
        reason: "פעולה לא מוכרת",
      });
      continue;
    }
    if (action === "CREATE" && !mayOverrideToCreate(input.domainId, row, eligible)) {
      problems.push({
        rowNumber,
        code: "NOT_PERMITTED",
        reason:
          row.status === "ERROR"
            ? "שורה עם שגיאה אינה ניתנת לייבוא"
            : "לא ניתן ליצור רשומה חדשה כשקיימת התאמה חוסמת",
      });
    }
  }

  return problems;
}

/**
 * Merge the owner's choices over the server's defaults, so the result always
 * covers every row. A row the client never mentioned keeps the default.
 */
export function resolveDecisions(
  domainId: DataTransferDomainId,
  rows: readonly DerivedRow[],
  submitted: RowDecisions | null
): RowDecisions {
  const resolved = defaultDecisions(domainId, rows);
  if (!submitted) return resolved;
  for (const [rawNumber, action] of Object.entries(submitted)) {
    const rowNumber = Number(rawNumber);
    if (Number.isInteger(rowNumber) && rowNumber in resolved) {
      resolved[rowNumber] = action;
    }
  }
  return resolved;
}

/**
 * Canonical, order-independent serialization — the same discipline the column
 * mapping uses, so the same logical decision set always produces the same hash
 * regardless of JSON key order.
 */
export function canonicalizeDecisions(decisions: RowDecisions): string {
  return Object.keys(decisions)
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b)
    .map((n) => `${n}=${decisions[n]}`)
    .join("\n");
}

export function decisionsHashOf(decisions: RowDecisions): string {
  return createHash("sha256")
    .update(canonicalizeDecisions(decisions))
    .digest("hex");
}
