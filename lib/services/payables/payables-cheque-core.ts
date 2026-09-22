/**
 * Cheque lifecycle — Accounts Payable Phase 3. Pure: no Prisma, no I/O.
 *
 * Every rule about what may happen to a cheque lives here, so the service only
 * loads, asks, and writes. The table below is the whole lifecycle; anything not
 * in it is refused.
 *
 *   PLANNED ──► ISSUED ──► DELIVERED ──► PRESENTED
 *                 │            │             │
 *                 └────────────┴─────────────┴──► CLEARED   (owner-asserted)
 *                 └────────────┴─────────────┴──► BOUNCED
 *   PLANNED / ISSUED / DELIVERED / BOUNCED ─────► CANCELLED
 *   anything not yet cleared or replaced ───────► REPLACED  (via a new cheque)
 *
 *   CLEARED ──► BOUNCED is the one way back: the owner said it cleared, the bank
 *   says it did not. The Payment that clearing created is VOIDED, not deleted.
 *
 * # What this module refuses to know
 *
 * Cheque numbers are TEXT. Nothing here parses one, compares two numerically,
 * or proposes "the next" number. Chequebooks are issued in blocks, replacements
 * come from wherever the book is now, and arithmetic over them would invent
 * facts about paper the business is holding.
 *
 * # CLEARED is an assertion
 *
 * There is no bank feed. CLEARED means the OWNER says the money left, and it is
 * recorded with provenance OWNER_ASSERTED — never "verified", never "confirmed
 * by the bank". A future bank-observed provenance is a different value, not a
 * stronger reading of this one.
 */

import { PayablesValidationError } from "@/lib/services/payables/payables-core";

export type ChequeStatusValue =
  | "PLANNED"
  | "ISSUED"
  | "DELIVERED"
  | "PRESENTED"
  | "CLEARED"
  | "BOUNCED"
  | "CANCELLED"
  | "REPLACED";

export const CHEQUE_STATUSES: readonly ChequeStatusValue[] = [
  "PLANNED",
  "ISSUED",
  "DELIVERED",
  "PRESENTED",
  "CLEARED",
  "BOUNCED",
  "CANCELLED",
  "REPLACED",
];

/** The only provenance representable today. */
export const CHEQUE_CLEARED_SOURCE = "OWNER_ASSERTED" as const;

/** Plain forward steps — no money moves, nothing else is created. */
const ADVANCE: Record<ChequeStatusValue, readonly ChequeStatusValue[]> = {
  PLANNED: ["ISSUED"],
  ISSUED: ["DELIVERED", "PRESENTED"],
  DELIVERED: ["PRESENTED"],
  PRESENTED: [],
  CLEARED: [],
  BOUNCED: [],
  CANCELLED: [],
  REPLACED: [],
};

const CLEARABLE: readonly ChequeStatusValue[] = ["ISSUED", "DELIVERED", "PRESENTED"];
const BOUNCEABLE: readonly ChequeStatusValue[] = ["ISSUED", "DELIVERED", "PRESENTED", "CLEARED"];
const CANCELLABLE: readonly ChequeStatusValue[] = ["PLANNED", "ISSUED", "DELIVERED", "BOUNCED"];
const REPLACEABLE: readonly ChequeStatusValue[] = [
  "PLANNED",
  "ISSUED",
  "DELIVERED",
  "PRESENTED",
  "BOUNCED",
  "CANCELLED",
];

/** Statuses a cheque may be CREATED in. Anything later needs its own event. */
export const CREATABLE_STATUSES: readonly ChequeStatusValue[] = ["PLANNED", "ISSUED"];

export const CHEQUE_NUMBER_MAX_LENGTH = 32;

export function isChequeStatus(value: unknown): value is ChequeStatusValue {
  return typeof value === "string" && (CHEQUE_STATUSES as readonly string[]).includes(value);
}

/**
 * A cheque number as the owner wrote it — trimmed, otherwise untouched. Leading
 * zeros, letters and slashes all survive, because they are all real.
 */
export function normalizeChequeNumber(value: unknown): string {
  if (typeof value !== "string") {
    throw new PayablesValidationError("chequeNumber must be given as text");
  }
  const trimmed = value.trim();
  if (trimmed === "") throw new PayablesValidationError("chequeNumber is required");
  if (trimmed.length > CHEQUE_NUMBER_MAX_LENGTH) {
    throw new PayablesValidationError(
      `chequeNumber must be at most ${CHEQUE_NUMBER_MAX_LENGTH} characters`,
    );
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new PayablesValidationError("chequeNumber contains control characters");
  }
  return trimmed;
}

/** A plain forward step (ISSUED, DELIVERED, PRESENTED). */
export function assertChequeAdvance(from: ChequeStatusValue, to: ChequeStatusValue): void {
  if (!ADVANCE[from].includes(to)) {
    throw new PayablesValidationError(`A ${from} cheque cannot move to ${to}`);
  }
}

export function assertChequeClearable(from: ChequeStatusValue): void {
  if (!CLEARABLE.includes(from)) {
    throw new PayablesValidationError(
      from === "PLANNED"
        ? "A planned cheque has not been written yet, so it cannot have cleared"
        : `A ${from} cheque cannot be marked as cleared`,
    );
  }
}

export function assertChequeBounceable(from: ChequeStatusValue): void {
  if (!BOUNCEABLE.includes(from)) {
    throw new PayablesValidationError(`A ${from} cheque cannot be marked as bounced`);
  }
}

export function assertChequeCancellable(from: ChequeStatusValue): void {
  if (!CANCELLABLE.includes(from)) {
    throw new PayablesValidationError(
      from === "CLEARED"
        ? "A cleared cheque cannot be cancelled — money already left. Mark it bounced if the bank reversed it"
        : `A ${from} cheque cannot be cancelled`,
    );
  }
}

export function assertChequeReplaceable(from: ChequeStatusValue): void {
  if (!REPLACEABLE.includes(from)) {
    throw new PayablesValidationError(
      from === "CLEARED"
        ? "A cleared cheque cannot be replaced — it already paid"
        : `A ${from} cheque cannot be replaced`,
    );
  }
}

export function assertCreatableStatus(status: ChequeStatusValue): void {
  if (!CREATABLE_STATUSES.includes(status)) {
    throw new PayablesValidationError(
      `A cheque is recorded as PLANNED or ISSUED; ${status} is reached through its own action`,
    );
  }
}

/**
 * Whether a cheque still holds its number in its chequebook. Mirrors the
 * migration's partial index predicate (`cancelledAt IS NULL`): CANCELLED and
 * REPLACED rows set `cancelledAt`, every other status leaves it NULL.
 */
export function holdsItsNumber(status: ChequeStatusValue): boolean {
  return status !== "CANCELLED" && status !== "REPLACED";
}

/** What the owner can do next, for the screen. Derived from the same tables. */
export function availableChequeActions(status: ChequeStatusValue): {
  advance: ChequeStatusValue[];
  clear: boolean;
  bounce: boolean;
  cancel: boolean;
  replace: boolean;
} {
  return {
    advance: [...ADVANCE[status]],
    clear: CLEARABLE.includes(status),
    bounce: BOUNCEABLE.includes(status),
    cancel: CANCELLABLE.includes(status),
    replace: REPLACEABLE.includes(status),
  };
}

/**
 * Whether a clearing date is plausible NOW. A clearing is a calendar DAY the
 * owner picks, and the form sends noon of that day in the owner's own time zone
 * — so "today" can be a timestamp hours ahead of the server clock. Comparing
 * instants refused a same-day clearing every morning in Israel (found in the
 * Phase 3 Production E2E). Allowed: anything up to the end of the current UTC
 * day plus the widest real time-zone offset (UTC+14). A later day is refused.
 */
export function isClearingDateAllowed(clearedAt: Date, now: Date): boolean {
  if (Number.isNaN(clearedAt.getTime())) return false;
  const endOfUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999);
  return clearedAt.getTime() <= endOfUtcDay + 14 * 60 * 60 * 1000;
}

/** The ledger key tying a cleared cheque to its one canonical Payment. */
export function chequePaymentKey(chequeId: number): string {
  if (!Number.isInteger(chequeId) || chequeId <= 0) {
    throw new PayablesValidationError("chequeId must be a positive integer");
  }
  return `cheque:${chequeId}`;
}
