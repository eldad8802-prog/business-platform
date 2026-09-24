/**
 * SEC-E / H-5 — the ERASURE LEDGER, on the tenant's own `LearningEvent` rows.
 *
 * WHY NO NEW TABLE. The durable state an erasure needs is: that it is owed (already
 * durable — `Business.deletionRequestedAt`, the quarantine), who asked, which attempt
 * is running and until when, how the last one ended (stage + PII-free error class +
 * next-attempt time), which destructive-once steps are done, and what each provider
 * said. All of it is append-only fact, and `LearningEvent` is already the append-only,
 * tenant-scoped, FORCE-RLS'd event store the erasure writes its evidence
 * (`ACCOUNT_DELETED`) to. M5.5 gave it `idempotencyKey` with a unique index on
 * (businessId, idempotencyKey) — migration 20260925090000, applied in Production —
 * which is exactly the primitive a claim needs: "insert attempt N" succeeds for one
 * caller and is a no-op for every other. So this needs no migration, no new grant and
 * no new policy, and it cannot be read across tenants.
 *
 * Every statement runs under `runTenantJob(..., { quarantinePolicy: "erasure" })`, so
 * the GUC is set and RLS admits exactly this business's rows, and raw SQL is used only
 * so the idempotency key can drive `ON CONFLICT DO NOTHING`.
 *
 * NOTHING PERSONAL IS WRITTEN HERE. Payloads carry attempt numbers, ISO timestamps,
 * stage names, fixed error classes, provider names, connection ids and outcome codes.
 * The one user id recorded (who requested) points at a User row the erasure anonymises.
 *
 * Event types, all prefixed ACCOUNT_ERASURE_ so no product consumer reads them:
 *   ACCOUNT_ERASURE_REQUESTED        account-erasure:requested
 *   ACCOUNT_ERASURE_ATTEMPT          account-erasure:attempt:<n>
 *   ACCOUNT_ERASURE_RESULT           account-erasure:result:<n>
 *   ACCOUNT_ERASURE_STEP             account-erasure:step:<STEP>
 *   ACCOUNT_ERASURE_PROVIDER_REVOKE  account-erasure:revoke:<provider>:<action>:<connectionId>
 */
import { runTenantJob } from "@/lib/tenant/job";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import type {
  ErasureAttemptResult,
  ErasureClaim,
  ErasureLedger,
  ProviderOutcomeRecord,
} from "@/lib/services/account/erasure-job";

type Row = { eventType: string; idempotencyKey: string | null; payload: unknown };

const TYPES = {
  requested: "ACCOUNT_ERASURE_REQUESTED",
  attempt: "ACCOUNT_ERASURE_ATTEMPT",
  result: "ACCOUNT_ERASURE_RESULT",
  step: "ACCOUNT_ERASURE_STEP",
  revoke: "ACCOUNT_ERASURE_PROVIDER_REVOKE",
} as const;

function inErasureTx<T>(businessId: number, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return runTenantJob({ businessId }, () => withTenantTransaction(fn), { quarantinePolicy: "erasure" });
}

/** Insert one fact; returns false when its idempotency key already exists. */
async function insertFact(
  tx: TenantTx,
  businessId: number,
  eventType: string,
  key: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    INSERT INTO "LearningEvent" ("businessId", "eventType", "entityType", "entityId", "payload", "idempotencyKey")
    VALUES (${businessId}, ${eventType}, 'BUSINESS', ${businessId}, ${JSON.stringify(payload)}::jsonb, ${key})
    ON CONFLICT ("businessId", "idempotencyKey") DO NOTHING
    RETURNING "id"
  `;
  return rows.length === 1;
}

async function readFacts(tx: TenantTx, businessId: number, types: readonly string[]): Promise<Row[]> {
  return tx.$queryRaw<Row[]>`
    SELECT "eventType", "idempotencyKey", "payload"
    FROM "LearningEvent"
    WHERE "businessId" = ${businessId} AND "eventType" = ANY(${types as string[]}::text[])
  `;
}

const obj = (p: unknown): Record<string, unknown> =>
  p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};

export const prismaErasureLedger: ErasureLedger = {
  async recordRequested(businessId, input) {
    await inErasureTx(businessId, (tx) =>
      insertFact(tx, businessId, TYPES.requested, "account-erasure:requested", {
        requestedByUserId: input.requestedByUserId,
        at: input.at.toISOString(),
      })
    );
  },

  async readRequestedBy(businessId) {
    const rows = await inErasureTx(businessId, (tx) => readFacts(tx, businessId, [TYPES.requested]));
    const v = obj(rows[0]?.payload).requestedByUserId;
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
  },

  async claimAttempt(businessId, input): Promise<ErasureClaim> {
    return inErasureTx(businessId, async (tx) => {
      const rows = await readFacts(tx, businessId, [TYPES.attempt, TYPES.result]);
      const attempts = new Map<number, Record<string, unknown>>();
      const results = new Map<number, Record<string, unknown>>();
      for (const r of rows) {
        const p = obj(r.payload);
        const n = typeof p.attempt === "number" ? p.attempt : NaN;
        if (!Number.isInteger(n)) continue;
        (r.eventType === TYPES.attempt ? attempts : results).set(n, p);
      }
      const last = attempts.size === 0 ? 0 : Math.max(...attempts.keys());
      const now = input.now.getTime();
      if (last > 0) {
        const res = results.get(last);
        if (!res) {
          const leaseUntil = String(attempts.get(last)?.leaseUntil ?? "");
          if (Date.parse(leaseUntil) > now) {
            return { kind: "BUSY", attempt: last, leaseUntil };
          }
          // The lease lapsed without a result: that worker died. Take the next attempt.
        } else if (res.outcome === "FAILED" && input.respectBackoff) {
          const next = String(res.nextAttemptAt ?? "");
          if (Date.parse(next) > now) {
            return { kind: "NOT_DUE", attempt: last, nextAttemptAt: next };
          }
        }
      }
      const attempt = last + 1;
      const won = await insertFact(tx, businessId, TYPES.attempt, `account-erasure:attempt:${attempt}`, {
        attempt,
        trigger: input.trigger,
        claimedAt: input.now.toISOString(),
        leaseUntil: new Date(now + input.leaseMs).toISOString(),
      });
      // Lost the unique-key race to a concurrent claimer: that one runs attempt N.
      return won ? { kind: "CLAIMED", attempt } : { kind: "BUSY", attempt, leaseUntil: "" };
    });
  },

  async recordAttemptResult(businessId, attempt, result: ErasureAttemptResult) {
    await inErasureTx(businessId, (tx) =>
      insertFact(tx, businessId, TYPES.result, `account-erasure:result:${attempt}`, { attempt, ...result })
    );
  },

  async hasStep(businessId, step) {
    const rows = await inErasureTx(businessId, (tx) => readFacts(tx, businessId, [TYPES.step]));
    return rows.some((r) => r.idempotencyKey === `account-erasure:step:${step}`);
  },

  async recordStep(businessId, step, at) {
    await inErasureTx(businessId, (tx) =>
      insertFact(tx, businessId, TYPES.step, `account-erasure:step:${step}`, { step, at: at.toISOString() })
    );
  },

  async readProviderOutcomes(businessId): Promise<ProviderOutcomeRecord[]> {
    const rows = await inErasureTx(businessId, (tx) => readFacts(tx, businessId, [TYPES.revoke]));
    return rows.map((r) => {
      const p = obj(r.payload);
      return {
        provider: String(p.provider),
        action: String(p.action),
        connectionId: Number(p.connectionId),
        outcome: p.outcome as ProviderOutcomeRecord["outcome"],
        reason: typeof p.reason === "string" ? p.reason : null,
      };
    });
  },

  async recordProviderOutcome(businessId, record, at) {
    await inErasureTx(businessId, (tx) =>
      insertFact(
        tx,
        businessId,
        TYPES.revoke,
        `account-erasure:revoke:${record.provider}:${record.action}:${record.connectionId}`,
        { ...record, at: at.toISOString() }
      )
    );
  },
};
