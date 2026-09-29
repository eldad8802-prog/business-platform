import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { runWithTenantContext } from "@/lib/tenant/context";
import { decideProposal } from "@/lib/intake/identity/proposals";

/**
 * POST /api/intake/identity-proposals/:id — the OWNER decides an identity
 * proposal (Business Intake M4):
 *   { action: "confirm" | "reject" | "undo", expectedFingerprint?: string }
 *
 * confirm is staleness-checked (409 when the evidence moved on); undo reverses a
 * confirmed link and exactly the domain effects it applied. Tenant = the
 * session user's business; the proposal id is looked up inside that tenant only.
 */
const ACTIONS = new Set(["confirm", "reject", "undo"]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await ctx.params;
    const proposalId = Number(id);
    if (!Number.isInteger(proposalId) || proposalId <= 0) {
      return NextResponse.json({ error: "invalid proposal id" }, { status: 400 });
    }
    let body: { action?: unknown; expectedFingerprint?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "invalid body" }, { status: 400 });
    }
    if (typeof body.action !== "string" || !ACTIONS.has(body.action)) {
      return NextResponse.json({ error: "action must be confirm, reject or undo" }, { status: 400 });
    }
    const expectedFingerprint =
      typeof body.expectedFingerprint === "string" && /^sha256:[0-9a-f]{64}$/.test(body.expectedFingerprint)
        ? body.expectedFingerprint
        : undefined;

    const outcome = await runWithTenantContext({ businessId: user.businessId }, () =>
      decideProposal({
        businessId: user.businessId,
        proposalId,
        action: body.action as "confirm" | "reject" | "undo",
        userId: user.id,
        expectedFingerprint,
      })
    );
    switch (outcome.status) {
      case "not_found":
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      case "invalid_state":
        return NextResponse.json({ error: "invalid_state", state: outcome.state }, { status: 409 });
      case "stale":
        return NextResponse.json({ error: "stale", why: outcome.why }, { status: 409 });
      default:
        return NextResponse.json({ ok: true, status: outcome.status });
    }
  } catch (error) {
    return handleError(error);
  }
}
