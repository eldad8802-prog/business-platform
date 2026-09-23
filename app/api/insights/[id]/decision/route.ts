import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { recordOwnerDecision } from "@/lib/knowledge/insight.service";

/**
 * M3 — the owner answers.
 *
 * This is the half of the loop that makes an insight worth generating. Everywhere else in this
 * codebase a dismissal is UI state that evaporates; here it is durable evidence with an actor, a
 * timestamp and the owner's own reason — and a dismissal is recorded with exactly the same weight as
 * an adoption, because a system that only keeps agreement learns half of what it is being told.
 *
 * Two things are deliberately NOT parameters: the tenant, which comes from the session, and the actor,
 * which comes from the session. The caller supplies only which insight and which answer.
 *
 * `recordOwnerDecision` predicates its update on BOTH the insight id and the businessId, so deciding
 * on another tenant's insight cannot succeed — it reports "not found", which is also the correct thing
 * to tell a caller who should not know the row exists.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const insightId = Number(id);
  if (!Number.isInteger(insightId) || insightId <= 0) {
    return NextResponse.json({ error: "invalid insight id" }, { status: 400 });
  }

  let body: { decision?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const decision = body.decision;
  if (decision !== "ADOPTED" && decision !== "DISMISSED") {
    return NextResponse.json(
      { error: "decision must be ADOPTED or DISMISSED" },
      { status: 400 }
    );
  }

  // A reason is optional on purpose. Requiring one would produce "asdf" rather than insight, and an
  // owner who simply does not want this is telling us something real by dismissing it at all.
  const note =
    typeof body.note === "string" && body.note.trim().length > 0
      ? body.note.trim().slice(0, 2000)
      : undefined;

  try {
    const result = await recordOwnerDecision(
      user.businessId,
      insightId,
      decision,
      user.id,
      note
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.reason ?? "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(
      "POST /api/insights/[id]/decision error:",
      error instanceof Error ? error.name : "unknown"
    );
    return NextResponse.json({ error: "Failed to record decision" }, { status: 500 });
  }
}
