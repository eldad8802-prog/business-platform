import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { appendOwnerDecision, loadOwnerRecommendations } from "@/lib/knowledge/outcomes/outcome-store";
import { ownerRecommendationsEnabled } from "@/lib/knowledge/outcomes/owner-surface.service";
import {
  NOT_NOW_DEFAULT_DAYS,
  NOT_NOW_MAX_DAYS,
  REASON_CODES,
  type DecisionKind,
} from "@/lib/knowledge/outcomes/outcome.contract";

/**
 * M9 — the owner answers a recommendation. APPEND-ONLY; the owner's answer is authority, never inferred.
 *
 * Called by the owner recommendation surface (/recommendations), behind the platform feature
 * `owner_recommendations` (default OFF): when the feature is off for the business, a decision is refused
 * (403). Only a recommendation the surface can show — one whose WHY was captured durably — can be decided:
 * the owner answers what they were shown, never a recommendation they could not see (404 otherwise).
 *
 * The tenant and the actor come from the session, never from the body. The caller names the version it
 * is answering: a decision about v1 is never applied to v2 (409). A retry with the same
 * `Idempotency-Key` returns the same decision instead of recording a second one.
 *
 * There is no free-text field. A reason, when the owner gives one, is one of a fixed set of codes.
 */
const DAY = 86_400_000;
const DECISIONS: readonly DecisionKind[] = ["ACCEPT", "REJECT", "MODIFY", "NOT_NOW"];

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const recommendationId = Number(id);
  if (!Number.isInteger(recommendationId) || recommendationId <= 0) {
    return NextResponse.json({ error: "invalid recommendation id" }, { status: 400 });
  }

  let body: { decision?: unknown; recommendationVersion?: unknown; targets?: unknown; reasonCode?: unknown; deferDays?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const decision = body.decision as DecisionKind;
  if (!DECISIONS.includes(decision)) {
    return NextResponse.json({ error: "decision must be ACCEPT, REJECT, MODIFY or NOT_NOW" }, { status: 400 });
  }
  const version = Number(body.recommendationVersion);
  if (!Number.isInteger(version) || version < 1) {
    return NextResponse.json({ error: "recommendationVersion is required" }, { status: 400 });
  }
  const reasonCode = body.reasonCode == null ? null : String(body.reasonCode);
  if (reasonCode != null && !(REASON_CODES as readonly string[]).includes(reasonCode)) {
    return NextResponse.json({ error: "unknown reasonCode" }, { status: 400 });
  }
  let targets: number[] | null = null;
  if (decision === "MODIFY") {
    if (!Array.isArray(body.targets) || body.targets.length === 0 || !body.targets.every((t) => Number.isInteger(t) && (t as number) > 0)) {
      return NextResponse.json({ error: "MODIFY requires targets: a non-empty list of target ids" }, { status: 400 });
    }
    targets = body.targets as number[];
  }
  let deferUntil: Date | null = null;
  if (decision === "NOT_NOW") {
    const days = body.deferDays == null ? NOT_NOW_DEFAULT_DAYS : Number(body.deferDays);
    if (!Number.isInteger(days) || days < 1 || days > NOT_NOW_MAX_DAYS) {
      return NextResponse.json({ error: `deferDays must be 1..${NOT_NOW_MAX_DAYS}` }, { status: 400 });
    }
    deferUntil = new Date(Date.now() + days * DAY);
  }
  const header = req.headers.get("idempotency-key");
  if (header != null && !/^[A-Za-z0-9_-]{8,128}$/.test(header)) {
    return NextResponse.json({ error: "invalid Idempotency-Key" }, { status: 400 });
  }

  try {
    if (!(await ownerRecommendationsEnabled(user.businessId))) {
      return NextResponse.json({ error: "FEATURE_DISABLED" }, { status: 403 });
    }
    const shown = await loadOwnerRecommendations(user.businessId, new Date(), { id: recommendationId });
    if (shown.items.length === 0) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

    const result = await appendOwnerDecision(user.businessId, recommendationId, user.id, {
      recommendationVersion: version, decision, modification: targets ? { targets } : null, reasonCode, deferUntil,
      idempotencyKey: header ?? randomUUID(),
    }, new Date());
    if (!result.ok) {
      const status = result.code === "NOT_FOUND" ? 404 : result.code === "INVALID_MODIFICATION" ? 400 : 409;
      return NextResponse.json({ error: result.code }, { status });
    }
    return NextResponse.json({ ok: true, decisionId: result.decisionId, duplicate: result.duplicate });
  } catch (error) {
    console.error("POST /api/outcomes/recommendations/[id]/decision error:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Failed to record decision" }, { status: 500 });
  }
}
