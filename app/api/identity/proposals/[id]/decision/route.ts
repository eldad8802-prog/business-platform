import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { decideProposal } from "@/lib/identity/entity-identity.service";

/**
 * M5 — the owner settles an identity question.
 *
 * This is the only endpoint in the system that can make two subjects the same entity on the strength
 * of a resemblance, and it can do it only because a person is on the other end of it. Everything the
 * matcher found on its own is inert until this is called.
 *
 * CONFIRMED retracts the subject's own anchor and writes a claim recorded as `OWNER_CONFIRMED`, with
 * the user id attached. Nothing is merged, combined or deleted: the previous party survives, the
 * retracted claim survives, and confirming can be undone by rejecting later.
 *
 * REJECTED is evidence in its own right, not a dismissal. It records who, when and — if they say —
 * why, and the resolver will not raise that pair again. Leaving a proposal alone is NOT a rejection
 * and never becomes one: the difference between "they said no" and "they never looked" is exactly the
 * kind of distinction a learning system loses first and needs most.
 *
 * The tenant and the actor both come from the session. Neither is a parameter.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const proposalId = Number(id);
  if (!Number.isInteger(proposalId) || proposalId <= 0) {
    return NextResponse.json({ error: "invalid proposal id" }, { status: 400 });
  }

  let body: { decision?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const decision = body.decision;
  if (decision !== "CONFIRMED" && decision !== "REJECTED") {
    return NextResponse.json(
      { error: "decision must be CONFIRMED or REJECTED" },
      { status: 400 }
    );
  }

  // Optional, as everywhere else an owner is asked for a reason. Requiring one produces "asdf"
  // rather than understanding, and the decision itself is already the signal that matters.
  const note =
    typeof body.note === "string" && body.note.trim().length > 0 ? body.note : undefined;

  try {
    const result = await decideProposal(
      user.businessId,
      proposalId,
      decision,
      user.id,
      note
    );
    if (!result.ok) {
      // Another tenant's proposal is reported as missing rather than forbidden, which is both the
      // correct status and the correct amount of information to give a caller who should not know
      // the row exists.
      const status = result.reason === "already_decided" ? 409 : 404;
      return NextResponse.json({ error: result.reason }, { status });
    }
    return NextResponse.json({ ok: true, state: result.state });
  } catch (error) {
    console.error(
      "POST /api/identity/proposals/[id]/decision error:",
      error instanceof Error ? error.name : "unknown"
    );
    return NextResponse.json({ error: "Failed to record decision" }, { status: 500 });
  }
}
