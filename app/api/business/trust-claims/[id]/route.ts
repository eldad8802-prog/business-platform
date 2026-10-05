import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { retireTrustClaim, setTrustClaimPublicUse } from "@/lib/services/trust/trust-claim.service";
import { trustErrorResponse } from "@/lib/services/trust/trust-http";

async function claimId(params: Promise<{ id: string }>): Promise<number | null> {
  const { id } = await params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** P3-A — grant or withdraw public use of one claim. Granting is refused while the claim has an open issue. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = await claimId(params);
  if (id === null) return NextResponse.json({ error: "Invalid claim id" }, { status: 400 });
  try {
    const body = (await req.json()) as { publicUseApproved?: unknown };
    const claim = await tenantTx(user.businessId, (tx) =>
      setTrustClaimPublicUse({ businessId: user.businessId, userId: user.id, claimId: id, approved: body.publicUseApproved }, tx),
    );
    return NextResponse.json({ claim });
  } catch (error) {
    return trustErrorResponse(error, "PATCH /api/business/trust-claims/[id]");
  }
}

/** P3-A — retire a claim. The row stays as history; the runtime cannot delete it. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = await claimId(params);
  if (id === null) return NextResponse.json({ error: "Invalid claim id" }, { status: 400 });
  try {
    await tenantTx(user.businessId, (tx) => retireTrustClaim({ businessId: user.businessId, userId: user.id, claimId: id }, tx));
    return NextResponse.json({ retired: true });
  } catch (error) {
    return trustErrorResponse(error, "DELETE /api/business/trust-claims/[id]");
  }
}
