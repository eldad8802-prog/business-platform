/**
 * Outbound execution — Accounts Payable Phase 6.
 *
 * Asking a provider to move money to a supplier. PROVIDER-INDEPENDENT, and
 * honest about the state of the world:
 *
 *   NO OUTBOUND PROVIDER IS CONNECTED TO DUBIZ.
 *
 * CardCom, Tranzila, PayPal, PayPlus and SUMIT are INBOUND collection: they take
 * a customer's card; none of their integrations here can pay a supplier. Being
 * able to collect is not being able to pay out, and this module never treats one
 * as the other. In Production the registry below is empty, `listOutboundProviders`
 * says so, and `requestExecution` refuses. The owner's path is "הכן תשלום" →
 * approve → pay in their own bank → report it (Phase 4), or confirm the bank
 * line (Phase 5).
 *
 * # The contract an adapter must meet
 *
 *   submit(request)   send the FROZEN request; return a provider reference and
 *                     SUBMITTED / ACKNOWLEDGED, or a failure. Idempotent on
 *                     `request.idempotencyKey`.
 *   getStatus(ref)    what the provider says now.
 *
 * # The rules this layer enforces for any adapter
 *
 *   - the owner explicitly confirms: only an APPROVED (or FAILED, to retry)
 *     preparation can be executed, and the request repeats `confirm: true`
 *   - the frozen snapshot must still match (amount, source, destination and
 *     their fingerprints) — no silent destination substitution
 *   - idempotent across browser, server and provider retries: the idempotency
 *     key is unique in the database, and one LIVE attempt per preparation
 *   - coordinates are opened server-side only for the adapter call, never
 *     logged, never returned
 *   - ACKNOWLEDGED is not settlement. Only SETTLED records the canonical Payment,
 *     through the same `completePreparationInTx` every other path uses
 *   - FAILED never marks anything paid
 *
 * # Test adapter
 *
 * `OUTBOUND_TEST_ADAPTER=1` registers an in-memory adapter for the DB suite. It
 * refuses to register when NODE_ENV is "production" — it can never move money
 * because it has nowhere to send it, and it cannot even appear in Production.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  PayablesConflictError,
  PayablesNotFoundError,
  PayablesValidationError,
} from "@/lib/services/payables/payables-core";
import {
  assertExecutionTransition,
  assertPreparationTransition,
  type ExecutionStatusValue,
  type PreparationStatusValue,
} from "@/lib/services/payables/payables-p46-core";
import { openBankCoordinates, type BankCoordinates } from "@/lib/services/payables/payables-bank-crypto";
import { isUniqueViolation } from "@/lib/services/payables/payables-bank-account.service";
import {
  assertFrozenSnapshotInTx,
  completePreparationInTx,
} from "@/lib/services/payables/payables-preparation.service";
import { writeAudit } from "@/lib/services/payables/payables.service";

type Tx = Prisma.TransactionClient;

/* ─────────────────────────────── adapters ─────────────────────────────── */

export type OutboundRequest = {
  idempotencyKey: string;
  amount: string;
  currency: string;
  destination: BankCoordinates & { beneficiaryName: string };
  reference: string | null;
};

export type OutboundSubmitResult =
  | { ok: true; providerReference: string; status: "SUBMITTED" | "ACKNOWLEDGED" }
  | { ok: false; failureCode: string; failureMessage: string };

export type OutboundStatusResult =
  | { status: "SUBMITTED" | "ACKNOWLEDGED" }
  | { status: "SETTLED"; settledAt: Date }
  | { status: "FAILED"; failureCode: string; failureMessage: string };

export interface OutboundProviderAdapter {
  id: string;
  displayName: string;
  submit(request: OutboundRequest): Promise<OutboundSubmitResult>;
  getStatus(providerReference: string): Promise<OutboundStatusResult>;
}

const registry = new Map<string, OutboundProviderAdapter>();

/**
 * The deterministic in-memory adapter the DB suite drives. Its outcomes are set
 * by the test through `testAdapterScript`, so every branch of the state machine
 * is exercised against a real database.
 */
export const testAdapterScript: {
  nextSubmit: OutboundSubmitResult | null;
  statuses: Map<string, OutboundStatusResult>;
  submitted: OutboundRequest[];
} = { nextSubmit: null, statuses: new Map(), submitted: [] };

function registerTestAdapterIfAllowed(): void {
  if (process.env.OUTBOUND_TEST_ADAPTER !== "1") return;
  if (process.env.NODE_ENV === "production") return;
  if (registry.has("test-adapter")) return;
  registry.set("test-adapter", {
    id: "test-adapter",
    displayName: "Test adapter (never production)",
    async submit(request) {
      testAdapterScript.submitted.push(request);
      const scripted = testAdapterScript.nextSubmit;
      testAdapterScript.nextSubmit = null;
      return scripted ?? { ok: true, providerReference: `test-${request.idempotencyKey}`, status: "ACKNOWLEDGED" };
    },
    async getStatus(ref) {
      return testAdapterScript.statuses.get(ref) ?? { status: "ACKNOWLEDGED" };
    },
  });
}

function adapters(): Map<string, OutboundProviderAdapter> {
  registerTestAdapterIfAllowed();
  return registry;
}

/** What the screen may offer. Empty in Production today — and it says so. */
export function listOutboundProviders(): Array<{ id: string; displayName: string }> {
  return [...adapters().values()].map((a) => ({ id: a.id, displayName: a.displayName }));
}

/* ─────────────────────────────── request ──────────────────────────────── */

async function lockPrep(tx: Tx, businessId: number, id: number) {
  const locked = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT "id" FROM "PaymentPreparation" WHERE "id" = ${id} AND "businessId" = ${businessId} FOR UPDATE`;
  if (locked.length === 0) throw new PayablesNotFoundError("Payment preparation not found");
  const prep = await tx.paymentPreparation.findFirst({ where: { id, businessId } });
  if (!prep) throw new PayablesNotFoundError("Payment preparation not found");
  return prep;
}

/**
 * Ask a provider to execute an approved prepared payment. `idempotencyKey` comes
 * from the browser (one per confirmation); a retry with the same key returns the
 * same execution and never submits twice.
 */
export async function requestExecution(input: {
  businessId: number;
  actorUserId?: number | null;
  preparationId: number;
  provider: string;
  idempotencyKey: string;
  confirm: boolean;
}) {
  if (input.confirm !== true) {
    throw new PayablesValidationError("Executing a payment needs the owner's explicit confirmation");
  }
  const key = input.idempotencyKey.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new PayablesValidationError("idempotencyKey is invalid");
  const adapter = adapters().get(input.provider);
  if (!adapter) {
    throw new PayablesValidationError(
      "No outbound payment provider is connected. Pay from your bank and report the payment as done",
    );
  }

  // Phase 1 — persist the frozen request (or find the retry), in one transaction.
  let executionId: number;
  let request: OutboundRequest | null = null;
  try {
    const out = await withTenantTransaction(async (tx) => {
      const existing = await tx.outboundExecution.findFirst({
        where: { businessId: input.businessId, idempotencyKey: key },
        select: { id: true, preparationId: true },
      });
      if (existing) {
        if (existing.preparationId !== input.preparationId) {
          throw new PayablesConflictError("This idempotency key belongs to a different payment");
        }
        return { id: existing.id, replay: true, request: null };
      }

      const prep = await lockPrep(tx, input.businessId, input.preparationId);
      if (prep.method !== "BANK_TRANSFER" || !prep.destinationId) {
        throw new PayablesValidationError("Only a prepared bank transfer can be sent to a provider");
      }
      assertPreparationTransition(prep.status as PreparationStatusValue, "SUBMITTED");
      const snapshot = await assertFrozenSnapshotInTx(tx, prep);

      const destination = await tx.paymentDestination.findFirst({
        where: { id: prep.destinationId, businessId: input.businessId },
        select: {
          beneficiaryName: true,
          coordinatesEncrypted: true,
          coordinatesIv: true,
          coordinatesTag: true,
          encryptionKeyId: true,
          fingerprint: true,
        },
      });
      const coords = destination ? openBankCoordinates(destination, input.businessId, "PAYMENT_DESTINATION") : null;
      if (!destination || !coords) {
        throw new PayablesValidationError("The destination account details cannot be read; nothing was sent");
      }

      const row = await tx.outboundExecution.create({
        data: {
          businessId: input.businessId,
          preparationId: prep.id,
          provider: adapter.id,
          idempotencyKey: key,
          amount: prep.amount,
          currency: prep.currency,
          sourceFingerprint: snapshot.sourceFingerprint,
          destinationFingerprint: snapshot.destinationFingerprint!,
          approvalHash: prep.approvalHash!,
          requestedByUserId: input.actorUserId ?? null,
        },
        select: { id: true },
      });
      await tx.paymentPreparation.update({ where: { id: prep.id }, data: { status: "SUBMITTED" as never } });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        commitmentId: prep.commitmentId,
        installmentId: prep.installmentId,
        eventType: "EXECUTION_REQUESTED",
        summary: `Execution of a prepared payment of ${prep.amount.toFixed(2)} ${prep.currency} requested from ${adapter.id} (not settled)`,
        metadata: { preparationId: prep.id, executionId: row.id, provider: adapter.id },
      });
      return {
        id: row.id,
        replay: false,
        request: {
          idempotencyKey: key,
          amount: prep.amount.toFixed(2),
          currency: prep.currency,
          destination: { ...coords, beneficiaryName: destination.beneficiaryName },
          reference: prep.reference,
        } as OutboundRequest,
      };
    });
    executionId = out.id;
    request = out.request;
    if (out.replay) return getExecution({ businessId: input.businessId, executionId });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PayablesConflictError("Another execution of this payment is already in progress");
    }
    throw error;
  }

  // Phase 2 — talk to the provider OUTSIDE any transaction (network I/O must not
  // hold a row lock), then record what it said.
  let result: OutboundSubmitResult;
  try {
    result = await adapter.submit(request!);
  } catch {
    result = { ok: false, failureCode: "ADAPTER_ERROR", failureMessage: "The provider could not be reached" };
  }
  request = null; // the only plaintext copy of the coordinates, dropped

  await withTenantTransaction(async (tx) => {
    const exec = await tx.outboundExecution.findFirst({
      where: { id: executionId, businessId: input.businessId },
      select: { id: true, status: true, preparationId: true },
    });
    if (!exec) throw new PayablesNotFoundError("Execution not found");
    if (result.ok) {
      assertExecutionTransition(exec.status as ExecutionStatusValue, "SUBMITTED");
      await tx.outboundExecution.update({
        where: { id: exec.id },
        data: {
          status: result.status as never,
          providerReference: result.providerReference,
          submittedAt: new Date(),
          ...(result.status === "ACKNOWLEDGED" ? { acknowledgedAt: new Date() } : {}),
        },
      });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        eventType: "EXECUTION_UPDATED",
        summary: `Provider accepted the instruction (${result.status}) — not settled`,
        metadata: { executionId: exec.id, status: result.status },
      });
    } else {
      await failExecutionInTx(tx, input.businessId, input.actorUserId, exec.id, exec.preparationId, result.failureCode, result.failureMessage);
    }
  });
  return getExecution({ businessId: input.businessId, executionId });
}

async function failExecutionInTx(
  tx: Tx,
  businessId: number,
  actorUserId: number | null | undefined,
  executionId: number,
  preparationId: number,
  failureCode: string,
  failureMessage: string,
) {
  await tx.outboundExecution.update({
    where: { id: executionId },
    data: {
      status: "FAILED" as never,
      failedAt: new Date(),
      failureCode: failureCode.slice(0, 60),
      failureMessage: failureMessage.slice(0, 300),
    },
  });
  // The preparation returns to the owner: nothing was paid.
  await tx.paymentPreparation.update({ where: { id: preparationId }, data: { status: "FAILED" as never } });
  await writeAudit(tx, {
    businessId,
    actorUserId,
    eventType: "EXECUTION_FAILED",
    summary: `Payment execution failed — nothing was paid`,
    metadata: { executionId, preparationId, failureCode: failureCode.slice(0, 60) },
  });
}

/* ─────────────────────────────── refresh ──────────────────────────────── */

/**
 * Ask the provider where an execution stands and record it. SETTLED is the only
 * status that records the canonical Payment — through the same convergence
 * point as every other path, keyed `prep:<id>`, with PAYMENT_PROVIDER evidence.
 */
export async function refreshExecution(input: { businessId: number; actorUserId?: number | null; executionId: number }) {
  const current = await withTenantTransaction((tx) =>
    tx.outboundExecution.findFirst({
      where: { id: input.executionId, businessId: input.businessId },
      select: { id: true, provider: true, providerReference: true, status: true, preparationId: true },
    }),
  );
  if (!current) throw new PayablesNotFoundError("Execution not found");
  if (!["SUBMITTED", "ACKNOWLEDGED"].includes(current.status) || !current.providerReference) {
    return getExecution({ businessId: input.businessId, executionId: current.id });
  }
  const adapter = adapters().get(current.provider);
  if (!adapter) throw new PayablesValidationError("The provider of this execution is no longer connected");
  const status = await adapter.getStatus(current.providerReference);

  await withTenantTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "OutboundExecution" WHERE "id" = ${current.id} FOR UPDATE`;
    const exec = await tx.outboundExecution.findFirst({ where: { id: current.id, businessId: input.businessId } });
    if (!exec || exec.status === "SETTLED" || exec.status === "FAILED") return;
    if (status.status === "SETTLED") {
      assertExecutionTransition(exec.status as ExecutionStatusValue, "SETTLED");
      const completed = await completePreparationInTx(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        preparationId: exec.preparationId,
        paidAt: status.settledAt,
        source: "PROVIDER_SETTLED",
        externalReference: exec.providerReference,
        evidence: { kind: "PAYMENT_PROVIDER", note: `Settled by ${exec.provider} (provider reference recorded on the execution)` },
      });
      await tx.outboundExecution.update({
        where: { id: exec.id },
        data: { status: "SETTLED" as never, settledAt: status.settledAt, paymentId: completed.paymentId },
      });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        paymentId: completed.paymentId,
        eventType: "EXECUTION_SETTLED",
        summary: `Provider reports the payment settled — recorded as the canonical payment`,
        metadata: { executionId: exec.id, preparationId: exec.preparationId },
      });
    } else if (status.status === "FAILED") {
      await failExecutionInTx(tx, input.businessId, input.actorUserId, exec.id, exec.preparationId, status.failureCode, status.failureMessage);
    } else if (status.status === "ACKNOWLEDGED" && exec.status === "SUBMITTED") {
      await tx.outboundExecution.update({ where: { id: exec.id }, data: { status: "ACKNOWLEDGED" as never, acknowledgedAt: new Date() } });
    }
  });
  return getExecution({ businessId: input.businessId, executionId: current.id });
}

export async function getExecution(input: { businessId: number; executionId: number }) {
  const row = await withTenantTransaction((tx) =>
    tx.outboundExecution.findFirst({
      where: { id: input.executionId, businessId: input.businessId },
      select: {
        id: true,
        preparationId: true,
        provider: true,
        status: true,
        amount: true,
        currency: true,
        providerReference: true,
        failureCode: true,
        failureMessage: true,
        requestedAt: true,
        submittedAt: true,
        acknowledgedAt: true,
        settledAt: true,
        failedAt: true,
        paymentId: true,
      },
    }),
  );
  if (!row) throw new PayablesNotFoundError("Execution not found");
  return { ...row, amount: row.amount.toFixed(2) };
}

/** A fresh key for one confirmation, for callers that do not bring their own. */
export function newExecutionKey(): string {
  return `exec-${randomUUID()}`;
}
