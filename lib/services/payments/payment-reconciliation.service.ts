/**
 * M1 — INBOUND RECONCILIATION.
 *
 * The webhook is a signal, and signals get lost, arrive before the provider has
 * decided, or fail to verify. Reconciliation does not wait for one: on a
 * schedule it asks the provider's AUTHORITY about every request that is not yet
 * known to be paid, and hands each answer to the same canonical path the
 * webhook uses (`resolvePaymentAuthoritatively`). There is no second recording
 * path and no second settlement.
 *
 *   for each candidate tenant (routing hint, ACTIVE only):
 *     inside that tenant: requests issued to a provider, not PAID, in window
 *     → resolvePaymentAuthoritatively(request, "RECONCILIATION")
 *
 * IDEMPOTENT. Asking twice changes nothing: the money row is UNIQUE on
 * (provider, providerTransactionId), the settlement opens with it, and a
 * request already PAID is no longer a candidate.
 *
 * CONCURRENT-SAFE. A webhook, a manual call and an overlapping run may all ask
 * about one payment at once; the database unique decides which records it and
 * every other caller reads the winner back.
 *
 * TENANT-SAFE. The only cross-tenant read is the routing index's list of
 * businesses (the sanctioned pre-context surface). Every request is found and
 * resolved inside its own tenant context under FORCE RLS.
 *
 * BOUNDED. A time window, a per-run and per-tenant cap, and a time budget; the
 * rest waits for the next run. Tenants, and each tenant's candidates, are
 * sampled in a fresh random order every run. A clock-derived rotation had
 * systematic blind spots (a 10-minute schedule stepping through a rotation
 * seeded by the minute revisits the same offsets); random sampling gives every
 * candidate the same chance each run. A strict "least recently asked first"
 * order would need a durable per-request timestamp — a schema change, proposed
 * separately rather than made here.
 *
 * OBSERVABLE. The run returns counts only, and `healthy` is false when anything
 * failed, a provider could not be asked, or the provider's answer was
 * anomalous — so a failing reconciliation cannot look like a quiet one.
 */

import { runWithTenantContext } from "@/lib/tenant/context";
import { isPaymentProviderEnabled } from "./providers/provider-availability";
import type { PaymentProviderAdapter } from "./providers/payment-provider.types";
import type { PaymentProvider, PaymentRequestRecord } from "./payments.types";
import {
  resolvePaymentAuthoritatively,
  type AuthoritativeResolution,
  type AuthoritativeVerificationDeps,
} from "./payment-verification.service";

export interface PaymentReconciliationDeps extends AuthoritativeVerificationDeps {
  resolveProvider: (provider: PaymentProvider) => PaymentProviderAdapter;
  /** Candidate tenants. Production reads the routing index. */
  listBusinessIds: () => Promise<number[]>;
}

export interface PaymentReconciliationOptions {
  /** How far back a request is still worth asking about. */
  windowDays?: number;
  /** Requests younger than this are left to the checkout and its webhook. */
  minAgeMs?: number;
  maxChecks?: number;
  maxPerBusiness?: number;
  /** How many candidates per tenant are read before sampling picks from them. */
  candidateScan?: number;
  timeBudgetMs?: number;
  /** Test seam: the random source for sampling. */
  random?: () => number;
}

export interface PaymentReconciliationReport {
  businessesScanned: number;
  candidates: number;
  checked: number;
  /** A payment nobody had recorded — discovered and recorded by this run. */
  recorded: number;
  /** Of `recorded`: money that arrived after the request was closed. */
  paidAfterClosed: number;
  /** Already recorded (by a webhook or an earlier run) — nothing new written. */
  alreadyRecorded: number;
  /** Of `alreadyRecorded`: a stale request status brought up to PAID. */
  statusRepaired: number;
  /** The provider says no money moved (FAILED / CANCELLED). */
  verifiedNotPaid: number;
  /** The provider has no outcome yet. */
  pending: number;
  verificationErrors: number;
  noActiveConnection: number;
  anomalies: {
    paidWithoutTransactionId: number;
    paidWithoutVerifiedAmount: number;
    transactionConflict: number;
    amountMismatch: number;
    currencyMismatch: number;
    /** CardCom answered about a different payment or terminal. */
    providerAnswerMismatch: number;
  };
  /** Candidates whose provider is disabled or cannot be asked. */
  skipped: number;
  /** Unexpected errors (database, code). */
  failed: number;
  stoppedEarly: boolean;
  healthy: boolean;
}

const DEFAULTS = {
  windowDays: 30,
  minAgeMs: 2 * 60_000,
  maxChecks: 25,
  maxPerBusiness: 10,
  candidateScan: 2000,
  timeBudgetMs: 40_000,
};

/** A fresh uniformly random order (Fisher–Yates). */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function emptyReconciliationReport(): PaymentReconciliationReport {
  return {
    businessesScanned: 0,
    candidates: 0,
    checked: 0,
    recorded: 0,
    paidAfterClosed: 0,
    alreadyRecorded: 0,
    statusRepaired: 0,
    verifiedNotPaid: 0,
    pending: 0,
    verificationErrors: 0,
    noActiveConnection: 0,
    anomalies: {
      paidWithoutTransactionId: 0,
      paidWithoutVerifiedAmount: 0,
      transactionConflict: 0,
      amountMismatch: 0,
      currencyMismatch: 0,
      providerAnswerMismatch: 0,
    },
    skipped: 0,
    failed: 0,
    stoppedEarly: false,
    healthy: true,
  };
}

function tally(report: PaymentReconciliationReport, r: AuthoritativeResolution): void {
  switch (r.kind) {
    case "SIGNAL_ONLY":
      report.skipped++;
      return;
    case "RECORDED":
      if (r.outcome === "PAID") {
        report.recorded++;
        if (r.paidAfterClosedStatus) report.paidAfterClosed++;
        if (r.amountMismatch) report.anomalies.amountMismatch++;
        if (r.currencyMismatch) report.anomalies.currencyMismatch++;
      } else {
        report.verifiedNotPaid++;
      }
      return;
    case "ALREADY_RECORDED":
      report.alreadyRecorded++;
      if (r.statusRepaired) report.statusRepaired++;
      return;
    case "NO_CHANGE":
      report.verifiedNotPaid++;
      return;
    case "UNRESOLVED":
      switch (r.reason) {
        case "PROVIDER_OUTCOME_PENDING":
          report.pending++;
          return;
        case "VERIFICATION_ERROR":
          report.verificationErrors++;
          return;
        case "NO_ACTIVE_CONNECTION":
          report.noActiveConnection++;
          return;
        case "PAID_WITHOUT_PROVIDER_TRANSACTION_ID":
          report.anomalies.paidWithoutTransactionId++;
          return;
        case "PAID_WITHOUT_VERIFIED_AMOUNT":
          report.anomalies.paidWithoutVerifiedAmount++;
          return;
        case "PROVIDER_TRANSACTION_CONFLICT":
          report.anomalies.transactionConflict++;
          return;
        case "PROVIDER_ANSWER_MISMATCH":
          report.anomalies.providerAnswerMismatch++;
          return;
      }
  }
}

/**
 * Healthy means: nothing failed, the provider could be asked every time, and
 * nothing it answered was anomalous. A pending outcome is not unhealthy — it
 * is simply not decided yet. A missing connection is reported, not alarmed: an
 * owner may disconnect a provider while old requests are still in the window.
 */
export function isReconciliationHealthy(report: PaymentReconciliationReport): boolean {
  const a = report.anomalies;
  return (
    report.failed === 0 &&
    report.verificationErrors === 0 &&
    a.paidWithoutTransactionId === 0 &&
    a.paidWithoutVerifiedAmount === 0 &&
    a.transactionConflict === 0 &&
    a.amountMismatch === 0 &&
    a.currencyMismatch === 0 &&
    a.providerAnswerMismatch === 0
  );
}

export async function runPaymentReconciliation(
  deps: PaymentReconciliationDeps,
  options: PaymentReconciliationOptions = {}
): Promise<PaymentReconciliationReport> {
  const now = deps.now ?? (() => new Date());
  const windowDays = options.windowDays ?? DEFAULTS.windowDays;
  const minAgeMs = options.minAgeMs ?? DEFAULTS.minAgeMs;
  const maxChecks = options.maxChecks ?? DEFAULTS.maxChecks;
  const maxPerBusiness = options.maxPerBusiness ?? DEFAULTS.maxPerBusiness;
  const candidateScan = options.candidateScan ?? DEFAULTS.candidateScan;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULTS.timeBudgetMs;
  const startedAt = Date.now();
  const report = emptyReconciliationReport();
  const outOfBudget = () =>
    report.checked >= maxChecks || Date.now() - startedAt > timeBudgetMs;

  const at = now();
  const createdAfter = new Date(at.getTime() - windowDays * 24 * 60 * 60_000);
  const createdBefore = new Date(at.getTime() - minAgeMs);
  const random = options.random ?? Math.random;

  let businessIds: number[];
  try {
    businessIds = await deps.listBusinessIds();
  } catch {
    report.failed++;
    report.healthy = false;
    return report;
  }

  for (const businessId of shuffle(businessIds, random)) {
    if (outOfBudget()) {
      report.stoppedEarly = true;
      break;
    }
    try {
      // The same gate the webhook applies at the tenant boundary: never create
      // operational state for a business that is being erased.
      if ((await deps.store.getBusinessLifecycle(businessId)) !== "ACTIVE") continue;
    } catch {
      report.failed++;
      continue;
    }
    report.businessesScanned++;

    await runWithTenantContext({ businessId }, async () => {
      let candidates: PaymentRequestRecord[];
      try {
        candidates = await deps.store.listReconciliationCandidates(businessId, {
          createdAfter,
          createdBefore,
          limit: candidateScan,
        });
      } catch {
        report.failed++;
        return;
      }
      report.candidates += candidates.length;

      const picked = shuffle(candidates, random).slice(0, maxPerBusiness);
      for (const request of picked) {
        if (outOfBudget()) {
          report.stoppedEarly = true;
          return;
        }
        let adapter: PaymentProviderAdapter;
        try {
          if (!isPaymentProviderEnabled(request.provider)) {
            report.skipped++;
            continue;
          }
          adapter = deps.resolveProvider(request.provider);
        } catch {
          report.skipped++;
          continue;
        }
        if (typeof adapter.getPaymentStatus !== "function") {
          report.skipped++;
          continue;
        }

        report.checked++;
        try {
          const resolution = await resolvePaymentAuthoritatively(
            {
              request,
              adapter,
              source: "RECONCILIATION",
              rawPayload: {
                source: "RECONCILIATION",
                verifiedAt: now().toISOString(),
              },
            },
            deps
          );
          tally(report, resolution);
        } catch (error) {
          report.failed++;
          console.error("[payment-reconciliation] request failed", {
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    });
  }

  if (report.checked >= maxChecks) report.stoppedEarly = true;
  report.healthy = isReconciliationHealthy(report);
  return report;
}
