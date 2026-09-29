/**
 * An in-memory ErasureLedger with the SAME claim semantics as erasure-ledger.prisma.ts
 * (unique attempt keys, leases, backoff, first-outcome-wins). For DB-free unit tests of
 * the orchestrator and the job; the real ledger is exercised in the SEC-E battery.
 * Not imported by production code.
 */
import type {
  ErasureAttemptResult,
  ErasureClaim,
  ErasureLedger,
  ProviderOutcomeRecord,
} from "@/lib/services/account/erasure-job";

type Attempt = { attempt: number; leaseUntil: string; trigger: string };

export function createMemoryErasureLedger() {
  const requested = new Map<number, number>();
  const attempts = new Map<number, Attempt[]>();
  const results = new Map<number, Map<number, ErasureAttemptResult>>();
  const steps = new Map<number, Set<string>>();
  const outcomes = new Map<number, Map<string, ProviderOutcomeRecord>>();
  const ledger: ErasureLedger = {
    async recordRequested(b, input) {
      if (!requested.has(b)) requested.set(b, input.requestedByUserId);
    },
    async readRequestedBy(b) {
      return requested.get(b) ?? null;
    },
    async claimAttempt(b, input): Promise<ErasureClaim> {
      const list = attempts.get(b) ?? [];
      const last = list.length;
      const now = input.now.getTime();
      if (last > 0) {
        const res = results.get(b)?.get(last);
        if (!res) {
          const lease = list[last - 1].leaseUntil;
          if (Date.parse(lease) > now) return { kind: "BUSY", attempt: last, leaseUntil: lease };
        } else if (res.outcome === "FAILED" && input.respectBackoff && Date.parse(res.nextAttemptAt) > now) {
          return { kind: "NOT_DUE", attempt: last, nextAttemptAt: res.nextAttemptAt };
        }
      }
      list.push({ attempt: last + 1, trigger: input.trigger, leaseUntil: new Date(now + input.leaseMs).toISOString() });
      attempts.set(b, list);
      return { kind: "CLAIMED", attempt: last + 1 };
    },
    async recordAttemptResult(b, attempt, result) {
      const m = results.get(b) ?? new Map();
      if (!m.has(attempt)) m.set(attempt, result);
      results.set(b, m);
    },
    async hasStep(b, step) {
      return steps.get(b)?.has(step) ?? false;
    },
    async recordStep(b, step) {
      const s = steps.get(b) ?? new Set();
      s.add(step);
      steps.set(b, s);
    },
    async readProviderOutcomes(b) {
      return [...(outcomes.get(b)?.values() ?? [])];
    },
    async recordProviderOutcome(b, r) {
      const m = outcomes.get(b) ?? new Map();
      const k = `${r.provider}:${r.action}:${r.connectionId}`;
      if (!m.has(k)) m.set(k, r);
      outcomes.set(b, m);
    },
  };
  return { ledger, attempts, results, steps, outcomes, requested };
}
