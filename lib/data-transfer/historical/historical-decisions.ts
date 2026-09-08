/**
 * What the owner decides about each historical row, and what they may decide.
 *
 * # Three actions, and why CREATE_ANYWAY is named rather than implied
 *
 * The tabular import expresses an override by choosing CREATE where the default
 * was SKIP, gated by a per-domain rule. That works, but it makes "import this
 * despite a collision" look identical to "import this ordinary row" in every
 * log, hash and audit trail afterwards.
 *
 * Historical records are fiscal, and a deliberate second copy of an invoice is
 * a thing somebody may have to explain years later. So the override has its own
 * name:
 *
 *   CREATE          an ordinary new record
 *   SKIP            do not import this row
 *   CREATE_ANYWAY   import it KNOWING it collides with something
 *
 * # What CREATE_ANYWAY is not
 *
 * It is not overwrite, merge, update, replace, repair or delete. Historical
 * persistence is INSERT-only — the table has no UPDATE policy and no UPDATE
 * grant — so the only thing this action can possibly do is append another row.
 *
 * And it is not "ignore validation". A row with a structural error is not
 * importable at any setting: an ambiguous date does not become a date because
 * somebody clicked through. CREATE_ANYWAY overrides a DUPLICATE, and nothing
 * else.
 *
 * # Why ambiguity cannot be overridden
 *
 * When two existing records carry one identity, or two documents answer to one
 * credit reference, there is no fact to confirm. Offering an override would let
 * an owner resolve by clicking something Dubiz could not resolve by reasoning,
 * and whatever it then did would be arbitrary. Those rows are blocked, and the
 * way out is fixing the data, not the button.
 */

import { createHash } from "node:crypto";

import type {
  DatabaseDuplicateState,
  InFileDuplicateState,
  ReversalState,
} from "@/lib/data-transfer/historical/historical-duplicates";

export const HISTORICAL_ACTIONS = ["CREATE", "SKIP", "CREATE_ANYWAY"] as const;
export type HistoricalAction = (typeof HISTORICAL_ACTIONS)[number];

/** sourceRowNumber -> action. A row absent from the map takes its default. */
export type HistoricalDecisions = Record<number, HistoricalAction>;

export type DecisionProblem = {
  sourceRowNumber: number;
  code: "UNKNOWN_ROW" | "INVALID_ACTION" | "NOT_PERMITTED" | "BLOCKED_ROW";
  reason: string;
};

/** Why a row cannot be imported at all, whatever the owner chooses. */
export type BlockingReasonCode =
  | "STRUCTURAL_ERROR"
  | "DUPLICATE_AMBIGUOUS"
  | "REVERSAL_AMBIGUOUS"
  | "REVERSAL_TARGET_AFTER_CREDIT"
  | "REVERSAL_TARGET_UNSUPPORTED_TYPE";

/** The row facts a decision is judged against. Nothing else is consulted. */
export type DecidableRow = {
  sourceRowNumber: number;
  /** Structural state from Analyze, before duplicate severity folded in. */
  hasStructuralError: boolean;
  database: DatabaseDuplicateState;
  inFile: InFileDuplicateState;
  reversal: ReversalState;
};

/**
 * Everything that blocks a row, in one place.
 *
 * A blocked row has no decision to make: it is neither imported nor skipped by
 * choice, it simply cannot run. Listing the reasons rather than returning a
 * boolean is deliberate — the owner is owed the reason, and "blocked" with no
 * explanation is the least useful thing a preview can say.
 */
export function blockingReasons(row: DecidableRow): BlockingReasonCode[] {
  const reasons: BlockingReasonCode[] = [];
  if (row.hasStructuralError) reasons.push("STRUCTURAL_ERROR");
  if (row.database === "AMBIGUOUS") reasons.push("DUPLICATE_AMBIGUOUS");
  if (row.reversal === "AMBIGUOUS") reasons.push("REVERSAL_AMBIGUOUS");
  if (row.reversal === "TARGET_AFTER_CREDIT") reasons.push("REVERSAL_TARGET_AFTER_CREDIT");
  if (row.reversal === "UNSUPPORTED_TARGET_TYPE") {
    reasons.push("REVERSAL_TARGET_UNSUPPORTED_TYPE");
  }
  return reasons;
}

export function isBlocked(row: DecidableRow): boolean {
  return blockingReasons(row).length > 0;
}

/**
 * What the server proposes before the owner touches anything.
 *
 *   blocked                    SKIP   there is nothing else it could be
 *   existing exact duplicate   SKIP   the business already holds this document
 *   strong candidate           SKIP   same identity, different facts — ask
 *   later in-file duplicate    SKIP   the first source row wins by default
 *   anything else              CREATE
 *
 * The default is never CREATE_ANYWAY. An override that the server proposed
 * would not be an override.
 */
export function defaultActionFor(row: DecidableRow): HistoricalAction {
  if (isBlocked(row)) return "SKIP";
  if (row.database === "EXACT" || row.database === "STRONG_CANDIDATE") return "SKIP";
  if (row.inFile === "EXACT_DUPLICATE" || row.inFile === "CONFLICTING_DUPLICATE") {
    return "SKIP";
  }
  return "CREATE";
}

/**
 * The actions the owner may choose for this row.
 *
 * A blocked row offers SKIP alone. A colliding row offers SKIP or the named
 * override. An ordinary row offers CREATE or SKIP — and NOT CREATE_ANYWAY,
 * because there is nothing to override and recording one would put a
 * meaningless bypass into the decision hash.
 */
export function allowedActionsFor(row: DecidableRow): HistoricalAction[] {
  if (isBlocked(row)) return ["SKIP"];
  const collides =
    row.database === "EXACT" ||
    row.database === "STRONG_CANDIDATE" ||
    row.inFile === "EXACT_DUPLICATE" ||
    row.inFile === "CONFLICTING_DUPLICATE";
  return collides ? ["SKIP", "CREATE_ANYWAY"] : ["CREATE", "SKIP"];
}

/**
 * Does this row need the owner to say something before anything can run?
 *
 * A collision the server defaulted to SKIP is a real question — the owner may
 * well have meant to import a corrected copy — so it is surfaced rather than
 * silently resolved. A blocked row is not a question: nothing the owner says
 * changes it.
 */
export function requiresOwnerDecision(row: DecidableRow): boolean {
  if (isBlocked(row)) return false;
  return row.database === "STRONG_CANDIDATE" || row.inFile === "CONFLICTING_DUPLICATE";
}

/**
 * Check every submitted decision against freshly derived server truth.
 *
 * A signature proves a decision was not altered in transit. It does not prove
 * the decision was ever legitimate, so each one is re-checked against the row
 * the server just computed — not the row the client says it saw.
 */
export function validateDecisions(
  rows: readonly DecidableRow[],
  decisions: HistoricalDecisions
): DecisionProblem[] {
  const byRow = new Map(rows.map((row) => [row.sourceRowNumber, row]));
  const problems: DecisionProblem[] = [];

  for (const [rawRow, action] of Object.entries(decisions)) {
    const sourceRowNumber = Number(rawRow);
    const row = byRow.get(sourceRowNumber);
    if (!row) {
      problems.push({
        sourceRowNumber,
        code: "UNKNOWN_ROW",
        reason: "אין שורה כזאת בקובץ",
      });
      continue;
    }
    if (!(HISTORICAL_ACTIONS as readonly string[]).includes(action)) {
      problems.push({
        sourceRowNumber,
        code: "INVALID_ACTION",
        reason: "פעולה לא מוכרת",
      });
      continue;
    }
    if (isBlocked(row) && action !== "SKIP") {
      problems.push({
        sourceRowNumber,
        code: "BLOCKED_ROW",
        reason: "השורה חסומה ולא ניתן לייבא אותה",
      });
      continue;
    }
    if (!allowedActionsFor(row).includes(action)) {
      problems.push({
        sourceRowNumber,
        code: "NOT_PERMITTED",
        reason: "הפעולה אינה אפשרית עבור השורה הזאת",
      });
    }
  }

  return problems;
}

/** Every row's action: the owner's where they said, the default elsewhere. */
export function resolveDecisions(
  rows: readonly DecidableRow[],
  submitted: HistoricalDecisions | null
): HistoricalDecisions {
  const out: HistoricalDecisions = {};
  for (const row of rows) {
    const chosen = submitted?.[row.sourceRowNumber];
    out[row.sourceRowNumber] =
      chosen && allowedActionsFor(row).includes(chosen)
        ? chosen
        : defaultActionFor(row);
  }
  return out;
}

/** Rows still waiting on the owner, given what they have said so far. */
export function unresolvedRows(
  rows: readonly DecidableRow[],
  submitted: HistoricalDecisions | null
): number[] {
  return rows
    .filter((row) => requiresOwnerDecision(row) && submitted?.[row.sourceRowNumber] === undefined)
    .map((row) => row.sourceRowNumber);
}

/** Stable text for the decision set, so the hash cannot depend on key order. */
export function canonicalizeDecisions(decisions: HistoricalDecisions): string {
  return Object.keys(decisions)
    .map((key) => Number(key))
    .filter((key) => Number.isInteger(key))
    .sort((a, b) => a - b)
    .map((key) => `${key}=${decisions[key]}`)
    .join("\n");
}

export function decisionsHashOf(decisions: HistoricalDecisions): string {
  return createHash("sha256")
    .update(`historical-decisions:v1\n${canonicalizeDecisions(decisions)}`)
    .digest("hex");
}
