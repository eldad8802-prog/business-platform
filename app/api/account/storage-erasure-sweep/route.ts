import { NextRequest, NextResponse } from "next/server";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { sweepAccountStorageErasures } from "@/lib/services/account/account-storage-erasure";
import { answerStorageErasureSweep } from "@/lib/services/account/account-storage-erasure-sweep-request";

/**
 * The shared cron of the account deletion object stage: resumes every module's open storage erasure job
 * (ACCOUNT_STORAGE_ERASURES — business documents, Service Desk) for businesses being or already deleted, until storage
 * confirms each one. Authenticated by CRON_SECRET through decideCronAuth, never by a user session; it takes no
 * business from the caller.
 *
 * Inert until the owner's gate: unless ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED is exactly "true" it answers 200 without
 * touching the database or storage. Answers counts only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  const answer = await answerStorageErasureSweep(decision, process.env.ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED, sweepAccountStorageErasures);
  return NextResponse.json(answer.body, { status: answer.status, headers: { "Cache-Control": "no-store" } });
}

// Vercel Cron issues GET; a deliberate manual run may POST. Same handler.
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
