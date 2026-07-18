/**
 * Unit tests for recordAuthorityHeldDecisionTx (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-held-decision-tx.test.ts
 * Minimal injected fake tx — no real DB.
 */
import {
  BillingAuthorityDecisionType,
  BillingAuthoritySubmissionStatus,
  Prisma,
} from "@prisma/client";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import { recordAuthorityHeldDecisionTx } from "@/lib/services/billing/authority/billing-authority-transition.service";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}
async function expect(name: string, ctor: new (...a: never[]) => Error, fn: () => Promise<unknown>) {
  try { await fn(); console.error("FAIL:", name, "(no throw)"); failed += 1; }
  catch (e) { ok(name, e instanceof ctor, e); }
}

type Sub = {
  id: number; businessId: number; billingDocumentId: number;
  status: BillingAuthoritySubmissionStatus;
  heldDecisionType: BillingAuthorityDecisionType | null;
  heldDecisionReportedAt: Date | null;
};

function fakeTx(sub: Sub, opts: { missConditionalOnce?: boolean; concurrentOnMiss?: BillingAuthorityDecisionType } = {}) {
  let miss = opts.missConditionalOnce ?? false;
  const audits: { eventType: string; metadata: Record<string, unknown> }[] = [];
  const tx = {
    billingAuthoritySubmission: {
      async findFirst() { return { ...sub }; },
      async updateMany(args: { where: Record<string, unknown>; data: Prisma.BillingAuthoritySubmissionUpdateInput }) {
        const w = args.where;
        if (miss) {
          miss = false;
          // Simulate a concurrent decision that won the race between findFirst and this update.
          if (opts.concurrentOnMiss) { sub.heldDecisionType = opts.concurrentOnMiss; sub.heldDecisionReportedAt = REPORTED; }
          return { count: 0 };
        }
        if (
          sub.status === w.status &&
          sub.heldDecisionType === (w.heldDecisionType ?? null) &&
          sub.heldDecisionReportedAt === (w.heldDecisionReportedAt ?? null)
        ) {
          sub.heldDecisionType = (args.data.heldDecisionType as BillingAuthorityDecisionType);
          sub.heldDecisionReportedAt = (args.data.heldDecisionReportedAt as Date);
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    billingAuditEvent: {
      async create(args: { data: { eventType: string; metadata: Prisma.InputJsonValue } }) {
        audits.push({ eventType: args.data.eventType, metadata: args.data.metadata as Record<string, unknown> });
        return { id: audits.length };
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, audits, getSub: () => sub };
}

const REPORTED = new Date("2026-07-18T10:00:00.000Z");
function heldSub(over: Partial<Sub> = {}): Sub {
  return { id: 55, businessId: 1, billingDocumentId: 42, status: BillingAuthoritySubmissionStatus.HELD, heldDecisionType: null, heldDecisionReportedAt: null, ...over };
}
const input = (decisionType: BillingAuthorityDecisionType) => ({ businessId: 1, billingDocumentId: 42, decisionType, reportedAt: REPORTED, actorUserId: 3, authorityMessage: "Decision accepted", correlationId: "corr-1" });

async function main(): Promise<void> {
  // HELD + null,null → APPLIED; writes type + reportedAt + audit.
  {
    const f = fakeTx(heldSub());
    const r = await recordAuthorityHeldDecisionTx(f.tx, input(BillingAuthorityDecisionType.PROCEED_WITHOUT_ALLOCATION));
    ok("HELD → APPLIED", r.outcome === "APPLIED");
    ok("sets heldDecisionType", f.getSub().heldDecisionType === "PROCEED_WITHOUT_ALLOCATION");
    ok("sets heldDecisionReportedAt", f.getSub().heldDecisionReportedAt?.getTime() === REPORTED.getTime());
    ok("audit written (HELD_DECISION_REPORTED)", f.audits.length === 1 && f.audits[0].eventType === "BILLING_AUTHORITY_HELD_DECISION_REPORTED");
    ok("audit carries decisionType + correlation", f.audits[0].metadata.decisionType === "PROCEED_WITHOUT_ALLOCATION" && f.audits[0].metadata.correlationId === "corr-1");
  }
  // Replay SAME decision (already recorded) → NOOP, no extra audit.
  {
    const f = fakeTx(heldSub({ heldDecisionType: BillingAuthorityDecisionType.ABANDONED, heldDecisionReportedAt: REPORTED }));
    const r = await recordAuthorityHeldDecisionTx(f.tx, input(BillingAuthorityDecisionType.ABANDONED));
    ok("replay same → NOOP", r.outcome === "NOOP" && f.audits.length === 0);
  }
  // DIFFERENT decision already recorded → ConflictError.
  {
    const f = fakeTx(heldSub({ heldDecisionType: BillingAuthorityDecisionType.ABANDONED, heldDecisionReportedAt: REPORTED }));
    await expect("different decision already recorded → conflict", ConflictError, () => recordAuthorityHeldDecisionTx(f.tx, input(BillingAuthorityDecisionType.PROCEED_WITHOUT_ALLOCATION)));
  }
  // From non-HELD → ForbiddenError.
  {
    const f = fakeTx(heldSub({ status: BillingAuthoritySubmissionStatus.SUBMITTED }));
    await expect("non-HELD → forbidden", ForbiddenError, () => recordAuthorityHeldDecisionTx(f.tx, input(BillingAuthorityDecisionType.ABANDONED)));
  }
  // Conditional-miss then concurrent SAME decision present → NOOP (idempotent).
  {
    const f = fakeTx(heldSub(), { missConditionalOnce: true, concurrentOnMiss: BillingAuthorityDecisionType.PROCEED_WITHOUT_ALLOCATION });
    const r = await recordAuthorityHeldDecisionTx(f.tx, input(BillingAuthorityDecisionType.PROCEED_WITHOUT_ALLOCATION));
    ok("conditional-miss + concurrent same → NOOP (no double decision)", r.outcome === "NOOP");
  }
  // Conditional-miss then concurrent DIFFERENT decision → ConflictError (no overwrite).
  {
    const f = fakeTx(heldSub(), { missConditionalOnce: true, concurrentOnMiss: BillingAuthorityDecisionType.ABANDONED });
    await expect("conditional-miss + concurrent different → conflict", ConflictError, () => recordAuthorityHeldDecisionTx(f.tx, input(BillingAuthorityDecisionType.PROCEED_WITHOUT_ALLOCATION)));
  }
}

main().then(() => {
  if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
  console.log("\nAll held-decision transition tests passed.");
}).catch((e) => { console.error(e); process.exit(1); });
