import { NextRequest, NextResponse } from "next/server";
import { decideRecoveryAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { prismaAccountDeletionStore } from "@/lib/services/account/account-deletion.prisma-store";
import { sweepStrandedErasures } from "@/lib/services/account/erasure-job";

/**
 * SEC-E / H-5 — the account-erasure SWEEPER.
 *
 * Every business whose deletion was requested (quarantined, DELETION_REQUESTED) and not
 * finished gets its next due erasure attempt here. Before this existed, an erasure that
 * failed after the quarantine stayed half-done forever: the owner's session died with
 * the quarantine, so nobody could retry, and nothing else ever looked.
 *
 * AUTHENTICATION is the scheduler's: the same CRON_SECRET bearer contract as the
 * settlement-recovery and knowledge-derive routes (`decideRecoveryAuth`), FAIL-CLOSED —
 * no secret, or a placeholder shorter than 32 characters, and the route answers 503
 * without touching anything. There is no session, no UI, and no tenant input: the work
 * list comes from the database (quarantined businesses only), never from the request.
 *
 * The sweeper cannot START a deletion. It only resumes erasures a sole-user-gated owner
 * request already quarantined; a business that is not quarantined is refused by the job.
 *
 * BOUNDED: at most `batch` attempts per invocation (default 10, max 50); each attempt is
 * claimed with a unique key in the erasure ledger, so overlapping sweeps — or a sweep
 * racing the owner's own request — cannot run the same attempt twice.
 *
 * THE RESPONSE CARRIES NO PERSONAL DATA: business ids, statuses, stage names and
 * PII-free error classes only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  const decision = decideRecoveryAuth(req.headers.get("authorization"), process.env.CRON_SECRET);
  if (decision === "NOT_CONFIGURED") {
    return NextResponse.json({ error: "erasure_sweep_not_configured" }, { status: 503 });
  }
  if (decision !== "AUTHORIZED") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rawBatch = Number(new URL(req.url).searchParams.get("batch") ?? "10");
  const batch = Number.isInteger(rawBatch) && rawBatch > 0 ? Math.min(rawBatch, 50) : 10;

  try {
    const result = await sweepStrandedErasures(prismaAccountDeletionStore, { batch });
    return NextResponse.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error(
      JSON.stringify({ event: "account_erasure_sweep_failed", error: error instanceof Error ? error.name : "Error" })
    );
    return NextResponse.json({ ok: false, error: "erasure_sweep_failed" }, { status: 500 });
  }
}

/** Vercel Cron issues GET with `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
