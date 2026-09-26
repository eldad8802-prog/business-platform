/**
 * SEC-E / H-5 — THE ACCOUNT ERASURE JOB: durable, resumable, provably convergent.
 *
 * `lib/tenant/business-lifecycle.ts` has cited this file as "the erasure worker" since
 * AD-2A. It did not exist. The erasure ran inside the DELETE request; a failure after
 * the quarantine committed returned HTTP 500, and the next request from the same user
 * was a 401 — the quarantine had killed the session that was the only way to retry.
 * No cron, no sweeper, no record of how far it got. The business stayed half-erased,
 * quarantined, forever.
 *
 * THE LIFECYCLE THIS FILE RUNS
 *
 *   REQUEST      the owner asks (DELETE /api/account, sole-user gate)
 *   QUARANTINE   Business.deletionRequestedAt — the durable fact that erasure is owed.
 *                Committed before anything else; from then on nothing but the
 *                erasure authority can write to the tenant.
 *   DURABLE WORK the ERASURE LEDGER (erasure-ledger.prisma.ts) — one attempt row per
 *                try, claimed with a unique idempotency key (so two workers can never
 *                run the same attempt), carrying the stage it reached, a PII-free error
 *                CLASS, and when the next attempt is due.
 *   STAGES       each idempotent / state-convergent, re-run from the top on every
 *                attempt, with the destructive-once ones (provider revoke, authority
 *                revoke) recorded so a retry never repeats them:
 *
 *                  AUTHORITY_REVOKE   sessions + token generation (auth plane)
 *                  PURGE              objects first (CRM, content prefix), then rows
 *                  SESSION_ERASE      device history rows
 *                  PROVIDER_REVOKE    Google / Meta, with the plaintext token, BEFORE
 *                                     the ciphertext is destroyed; outcome recorded
 *                  CREDENTIAL_DESTROY secrets + connection identifiers
 *                  VERIFY             post-conditions read back; any residual blocks
 *                  FINALIZE           evidence, then PURGED (terminal, closed)
 *
 *   SWEEPER      /api/account/erasure-sweep (CRON_SECRET, fail-closed) finds every
 *                business that is DELETION_REQUESTED and not PURGED and runs the next
 *                due attempt. It never STARTS a deletion: a business that is not
 *                already quarantined is refused (NOT_QUARANTINED), so neither the ledger
 *                nor the sweeper is authority to erase anyone.
 *
 * The request path still attempts completion synchronously. If a stage fails, the
 * request gets 202 ("accepted, continuing") instead of a 500 nobody can retry, and the
 * sweeper finishes the job.
 *
 * This module is DB-free: the store, its ledger and the providers are injected, which
 * is how the fault-injection battery drives every stage into failure for real.
 */
import type { AccountDeletionStore } from "@/lib/services/account/account-deletion.service";
import { revokeGoogleGmailToken } from "@/lib/services/integrations/gmail/gmail-token-revoke.service";
import { unsubscribeWabaFromApp } from "@/lib/services/integrations/whatsapp/graph.service";

export type ErasureStage =
  | "CLAIM"
  | "AUTHORITY_REVOKE"
  | "PURGE"
  | "SESSION_ERASE"
  | "PROVIDER_REVOKE"
  | "CREDENTIAL_DESTROY"
  | "VERIFY"
  | "FINALIZE";

/**
 * What happened at the PROVIDER, stated no more strongly than it is known.
 *
 *   REVOKED                     the provider confirmed the revoke/unsubscribe.
 *   REVOKE_FAILED_LOCAL_DELETED the provider did NOT confirm (error, unreadable token,
 *                               retries exhausted). Only our local copy is destroyed;
 *                               the grant may still be live at the provider.
 *   NOT_SUPPORTED               no provider-side revoke exists for this grant in this
 *                               codebase (ITA, payment providers, Meta token itself).
 *                               Only our local copy is destroyed.
 *
 * Never report provider deletion when only local deletion happened.
 */
export type ProviderRevokeOutcome = "REVOKED" | "REVOKE_FAILED_LOCAL_DELETED" | "NOT_SUPPORTED";

export type ProviderOutcomeRecord = {
  provider: string;
  action: string;
  connectionId: number;
  outcome: ProviderRevokeOutcome;
  /** A fixed, PII-free code (never a provider message). */
  reason: string | null;
};

/** The provider calls. Real ones by default; fakes in every test — never a real provider. */
export type ProviderRevokers = {
  revokeGoogleToken(token: string): Promise<{ ok: boolean; code: string }>;
  unsubscribeMetaWaba(input: { wabaId: string; accessToken: string }): Promise<{ ok: boolean; code: string }>;
};

export const DEFAULT_PROVIDER_REVOKERS: ProviderRevokers = {
  async revokeGoogleToken(token) {
    const r = await revokeGoogleGmailToken(token);
    return r.ok ? { ok: true, code: "ok" } : { ok: false, code: r.reason };
  },
  async unsubscribeMetaWaba(input) {
    const r = await unsubscribeWabaFromApp(input);
    return r.ok ? { ok: true, code: "ok" } : { ok: false, code: safeCode(r.code) };
  },
};

export type ErasureTrigger = "request" | "sweeper";

export type ErasureClaim =
  | { kind: "CLAIMED"; attempt: number }
  | { kind: "BUSY"; attempt: number; leaseUntil: string }
  | { kind: "NOT_DUE"; attempt: number; nextAttemptAt: string };

export type ErasureAttemptResult =
  | { outcome: "COMPLETED"; at: string }
  | { outcome: "FAILED"; at: string; stage: ErasureStage; errorClass: string; nextAttemptAt: string };

/**
 * The durable record. Implemented on the tenant's own `LearningEvent` rows under the
 * erasure authority (erasure-ledger.prisma.ts), with a unique idempotency key per fact.
 */
export interface ErasureLedger {
  /** The REQUEST, recorded once: who asked, and when. Idempotent. */
  recordRequested(businessId: number, input: { requestedByUserId: number; at: Date }): Promise<void>;
  readRequestedBy(businessId: number): Promise<number | null>;
  /**
   * Claim the next attempt. Exactly one concurrent caller can claim attempt N (unique
   * key). BUSY while an unfinished attempt's lease is live; NOT_DUE while a failed
   * attempt's backoff has not elapsed (only when `respectBackoff`).
   */
  claimAttempt(
    businessId: number,
    input: { now: Date; trigger: ErasureTrigger; leaseMs: number; respectBackoff: boolean }
  ): Promise<ErasureClaim>;
  recordAttemptResult(businessId: number, attempt: number, result: ErasureAttemptResult): Promise<void>;
  /** Destructive-once steps (e.g. AUTHORITY_REVOKED): recorded so a retry does not repeat them. */
  hasStep(businessId: number, step: string): Promise<boolean>;
  recordStep(businessId: number, step: string, at: Date): Promise<void>;
  readProviderOutcomes(businessId: number): Promise<ProviderOutcomeRecord[]>;
  /** Idempotent per (provider, action, connectionId): the FIRST recorded outcome stands. */
  recordProviderOutcome(businessId: number, record: ProviderOutcomeRecord, at: Date): Promise<void>;
}

export type ErasureRunResult =
  | { status: "COMPLETED"; attempt: number }
  | { status: "FAILED"; attempt: number; stage: ErasureStage; errorClass: string; nextAttemptAt: string }
  | { status: "BUSY"; attempt: number }
  | { status: "NOT_DUE"; attempt: number; nextAttemptAt: string }
  | { status: "ALREADY_PURGED" }
  | { status: "NOT_QUARANTINED" }
  | { status: "NOT_FOUND" };

/** A lease long enough for one full run inside a serverless invocation. */
export const ERASURE_LEASE_MS = 5 * 60_000;
/** Provider revokes are retried this many attempts before the outcome is recorded as failed. */
export const MAX_PROVIDER_REVOKE_ATTEMPTS = 3;
/** Attempts at or above this are logged for an operator (the job itself never gives up). */
export const STRANDED_ALERT_ATTEMPTS = 5;

/** Exponential backoff: 5 min, 10, 20 … capped at 6 h. */
export function erasureBackoffMs(attempt: number): number {
  const base = 5 * 60_000;
  return Math.min(base * 2 ** Math.max(0, attempt - 1), 6 * 60 * 60_000);
}

/** A stage failed; carries only the stage and a PII-free class. */
export class ErasureStageError extends Error {
  readonly stage: ErasureStage;
  readonly errorClass: string;
  constructor(stage: ErasureStage, errorClass: string) {
    super(`account erasure failed at ${stage} (${errorClass})`);
    this.name = "ErasureStageError";
    this.stage = stage;
    this.errorClass = errorClass;
  }
}

/**
 * The PII-free CLASS of an error. Never the message: provider and database messages
 * quote values (an email address, a phone number, a row). Only a type name, a
 * Prisma/PostgreSQL code, or a fixed label from this module survive into the ledger.
 */
export function classifyErasureError(error: unknown): string {
  if (error instanceof ErasureStageError) return error.errorClass;
  if (error && typeof error === "object") {
    const e = error as { name?: unknown; code?: unknown; meta?: { code?: unknown } };
    const name = typeof e.name === "string" ? e.name : "Error";
    const sqlstate = e.meta && typeof e.meta.code === "string" ? e.meta.code : null;
    const code = typeof e.code === "string" ? e.code : null;
    if (sqlstate && /^[0-9A-Z]{5}$/.test(sqlstate)) return safeCode(`DB_${code ?? "RAW"}_${sqlstate}`);
    if (code && /^P\d{4}$/.test(code)) return safeCode(`DB_${code}`);
    if (/^Storage/.test(name)) return safeCode(`STORAGE_${name}`);
    return safeCode(`${name}${code ? `_${code}` : ""}`);
  }
  return "UNKNOWN";
}

function safeCode(raw: string): string {
  return String(raw).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
}

type RunOptions = {
  trigger: ErasureTrigger;
  now?: Date;
  /** Who asked. Falls back to the ledger's REQUEST record, then the business's sole user. */
  actorUserId?: number;
  providers?: ProviderRevokers;
  /** The sweeper respects backoff; a direct resume by the requester does not. */
  respectBackoff?: boolean;
};

/**
 * Run ONE attempt of the erasure of `businessId` to completion or to its first failed
 * stage. Never throws for a stage failure — it records it and returns FAILED — so a
 * sweeper can move on to the next business. It throws only if the ledger itself cannot
 * be reached to claim the attempt (nothing has run; the caller decides).
 */
export async function runAccountErasure(
  store: AccountDeletionStore,
  businessId: number,
  opts: RunOptions
): Promise<ErasureRunResult> {
  const now = opts.now ?? new Date();
  const providers = opts.providers ?? DEFAULT_PROVIDER_REVOKERS;
  const ledger = store.ledger;

  const business = await store.getBusiness(businessId);
  if (!business) return { status: "NOT_FOUND" };
  if (business.state === "PURGED") return { status: "ALREADY_PURGED" };
  // The ledger and the sweeper are never authority to START an erasure. Only the
  // quarantine — which only the sole-user-gated request can commit — is.
  if (business.state !== "DELETION_REQUESTED") return { status: "NOT_QUARANTINED" };

  const claim = await ledger.claimAttempt(businessId, {
    now,
    trigger: opts.trigger,
    leaseMs: ERASURE_LEASE_MS,
    respectBackoff: opts.respectBackoff ?? opts.trigger === "sweeper",
  });
  if (claim.kind === "BUSY") return { status: "BUSY", attempt: claim.attempt };
  if (claim.kind === "NOT_DUE") return { status: "NOT_DUE", attempt: claim.attempt, nextAttemptAt: claim.nextAttemptAt };
  const attempt = claim.attempt;

  let stage: ErasureStage = "AUTHORITY_REVOKE";
  try {
    // ── AUTHORITY_REVOKE — the account's own credentials, first ─────────────
    stage = "AUTHORITY_REVOKE";
    if (!(await ledger.hasStep(businessId, "AUTHORITY_REVOKED"))) {
      await store.revokeAccountAuthority(businessId, now);
      await ledger.recordStep(businessId, "AUTHORITY_REVOKED", now);
    }

    // ── PURGE — objects first, then rows (existing, idempotent) ─────────────
    stage = "PURGE";
    await store.purgeOperationalData(businessId);

    // ── SESSION_ERASE — the device history ──────────────────────────────────
    stage = "SESSION_ERASE";
    await store.eraseAccountSessions(businessId);

    // ── PROVIDER_REVOKE — before the plaintext is destroyed ──────────────────
    stage = "PROVIDER_REVOKE";
    await revokeProviderGrants(store, businessId, { attempt, now, providers });

    // ── CREDENTIAL_DESTROY — only once every grant has a recorded outcome ────
    stage = "CREDENTIAL_DESTROY";
    await store.destroyIntegrationCredentials(businessId, now);

    // ── VERIFY — read the post-conditions back ──────────────────────────────
    stage = "VERIFY";
    const residual = await store.verifyErased(businessId);
    if (residual.length > 0) {
      throw new ErasureStageError("VERIFY", safeCode(`RESIDUAL:${[...residual].sort().join("+")}`));
    }

    // ── FINALIZE — evidence, then the terminal transition ───────────────────
    stage = "FINALIZE";
    const actor = await resolveActor(store, businessId, opts.actorUserId);
    await store.finalizeAndAudit(businessId, actor, now);
  } catch (error) {
    const errorClass = classifyErasureError(error);
    const failedStage = error instanceof ErasureStageError ? error.stage : stage;
    const nextAttemptAt = new Date(now.getTime() + erasureBackoffMs(attempt)).toISOString();
    try {
      await ledger.recordAttemptResult(businessId, attempt, {
        outcome: "FAILED",
        at: now.toISOString(),
        stage: failedStage,
        errorClass,
        nextAttemptAt,
      });
    } catch {
      // The attempt row exists with a lease; when the lease lapses the next claim
      // proceeds. Nothing is lost by failing to write the result.
    }
    console.error(
      JSON.stringify({
        event: attempt >= STRANDED_ALERT_ATTEMPTS ? "account_erasure_stranded" : "account_erasure_attempt_failed",
        businessId,
        attempt,
        stage: failedStage,
        errorClass,
        nextAttemptAt,
      })
    );
    return { status: "FAILED", attempt, stage: failedStage, errorClass, nextAttemptAt };
  }

  try {
    await ledger.recordAttemptResult(businessId, attempt, { outcome: "COMPLETED", at: now.toISOString() });
  } catch {
    // The business is PURGED; the lifecycle, not the ledger, is the terminal fact.
  }
  return { status: "COMPLETED", attempt };
}

async function resolveActor(
  store: AccountDeletionStore,
  businessId: number,
  explicit: number | undefined
): Promise<number> {
  if (explicit !== undefined) return explicit;
  const recorded = await store.ledger.readRequestedBy(businessId);
  if (recorded !== null) return recorded;
  // A deletion stranded before the ledger existed has no REQUEST record. The sole-user
  // gate guaranteed exactly one user at request time, so that user is the requester.
  const users = await store.listActiveUserIds(businessId);
  if (users.length === 0) throw new ErasureStageError("FINALIZE", "NO_REQUESTER");
  return Math.min(...users);
}

/**
 * PROVIDER_REVOKE. For every grant without a recorded outcome: call the provider once,
 * record the truth. A transient failure keeps the ciphertext (the job throws, the
 * attempt fails, CREDENTIAL_DESTROY does not run) until MAX_PROVIDER_REVOKE_ATTEMPTS,
 * after which the outcome is recorded REVOKE_FAILED_LOCAL_DELETED and the local copy is
 * destroyed anyway — erasure must converge, and it must not lie about how.
 */
async function revokeProviderGrants(
  store: AccountDeletionStore,
  businessId: number,
  ctx: { attempt: number; now: Date; providers: ProviderRevokers }
): Promise<void> {
  const ledger = store.ledger;
  const done = new Set(
    (await ledger.readProviderOutcomes(businessId)).map((o) => `${o.provider}:${o.action}:${o.connectionId}`)
  );
  const grants = await store.readProviderGrants(businessId);
  const pending: string[] = [];
  const record = (r: ProviderOutcomeRecord) => ledger.recordProviderOutcome(businessId, r, ctx.now);
  const exhausted = ctx.attempt >= MAX_PROVIDER_REVOKE_ATTEMPTS;

  for (const g of grants) {
    const key = `${g.provider}:${g.action}:${g.connectionId}`;
    if (done.has(key)) continue;
    const base = { provider: g.provider, action: g.action, connectionId: g.connectionId };

    if (g.provider === "ita" || g.provider === "payment") {
      await record({ ...base, outcome: "NOT_SUPPORTED", reason: "no_provider_revoke_api" });
      continue;
    }
    if (g.token === null) {
      await record({ ...base, outcome: "REVOKE_FAILED_LOCAL_DELETED", reason: "token_unreadable" });
      if (g.provider === "meta") {
        await recordMetaTokenNotSupported(ledger, businessId, g.connectionId, done, ctx.now);
      }
      continue;
    }

    let result: { ok: boolean; code: string };
    if (g.provider === "google") {
      result = await ctx.providers.revokeGoogleToken(g.token);
    } else if (g.provider === "meta") {
      if (!g.wabaId) {
        await record({ ...base, outcome: "REVOKE_FAILED_LOCAL_DELETED", reason: "waba_unknown" });
        await recordMetaTokenNotSupported(ledger, businessId, g.connectionId, done, ctx.now);
        continue;
      }
      result = await ctx.providers.unsubscribeMetaWaba({ wabaId: g.wabaId, accessToken: g.token });
    } else {
      await record({ ...base, outcome: "NOT_SUPPORTED", reason: "unknown_provider" });
      continue;
    }

    if (result.ok) {
      await record({ ...base, outcome: "REVOKED", reason: null });
    } else if (exhausted) {
      await record({ ...base, outcome: "REVOKE_FAILED_LOCAL_DELETED", reason: safeCode(`retries_exhausted:${result.code}`) });
    } else {
      pending.push(key);
      continue;
    }
    if (g.provider === "meta") {
      await recordMetaTokenNotSupported(ledger, businessId, g.connectionId, done, ctx.now);
    }
  }

  if (pending.length > 0) {
    throw new ErasureStageError("PROVIDER_REVOKE", `PROVIDER_REVOKE_PENDING:${pending.length}`);
  }
}

/** Meta documents no revoke for the Embedded Signup business token itself. Said so, once. */
async function recordMetaTokenNotSupported(
  ledger: ErasureLedger,
  businessId: number,
  connectionId: number,
  done: Set<string>,
  at: Date
): Promise<void> {
  const key = `meta:token_invalidate:${connectionId}`;
  if (done.has(key)) return;
  await ledger.recordProviderOutcome(
    businessId,
    { provider: "meta", action: "token_invalidate", connectionId, outcome: "NOT_SUPPORTED", reason: "no_documented_token_revoke" },
    at
  );
  done.add(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// The sweeper
// ─────────────────────────────────────────────────────────────────────────────

export type SweepResult = {
  scanned: number;
  results: { businessId: number; status: ErasureRunResult["status"]; stage?: ErasureStage; errorClass?: string }[];
};

/**
 * Find every stranded erasure (DELETION_REQUESTED, not PURGED) and run the next due
 * attempt of each, bounded. Businesses are handled one at a time so one failure cannot
 * stop the rest; the unique attempt key makes concurrent sweepers (or a sweeper racing
 * a request) safe — the loser sees BUSY and moves on.
 */
export async function sweepStrandedErasures(
  store: AccountDeletionStore,
  opts: { now?: Date; batch?: number; providers?: ProviderRevokers } = {}
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const batch = Math.max(1, Math.min(opts.batch ?? 10, 50));
  const ids = await store.listStrandedErasures(batch * 5);
  const results: SweepResult["results"] = [];
  let ran = 0;
  for (const businessId of ids) {
    if (ran >= batch) break;
    let r: ErasureRunResult;
    try {
      r = await runAccountErasure(store, businessId, { trigger: "sweeper", now, providers: opts.providers });
    } catch (error) {
      results.push({ businessId, status: "FAILED", stage: "CLAIM", errorClass: classifyErasureError(error) });
      ran++;
      continue;
    }
    if (r.status === "COMPLETED" || r.status === "FAILED") ran++;
    results.push({
      businessId,
      status: r.status,
      ...(r.status === "FAILED" ? { stage: r.stage, errorClass: r.errorClass } : {}),
    });
  }
  return { scanned: ids.length, results };
}
