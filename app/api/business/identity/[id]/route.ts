import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  retireIdentityStatement,
  setIdentityPublicUse,
} from "@/lib/services/identity/identity-statement.service";
import { identityErrorResponse } from "@/lib/services/identity/identity-http";

async function statementId(params: Promise<{ id: string }>): Promise<number | null> {
  const { id } = await params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** P2 — grant or withdraw public-use approval on one claim-like statement. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = await statementId(params);
  if (id === null) return NextResponse.json({ error: "Invalid statement id" }, { status: 400 });
  try {
    const body = (await req.json()) as { publicUseApproved?: unknown };
    if (typeof body.publicUseApproved !== "boolean") {
      return NextResponse.json({ error: "publicUseApproved must be true or false" }, { status: 400 });
    }
    const approved = body.publicUseApproved;
    const statement = await tenantTx(user.businessId, (tx) =>
      setIdentityPublicUse({ businessId: user.businessId, userId: user.id, statementId: id, approved }, tx),
    );
    return NextResponse.json({ statement });
  } catch (error) {
    return identityErrorResponse(error, "PATCH /api/business/identity/[id]");
  }
}

/** P2 — retire a statement. The row stays as history; the runtime role cannot delete it. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = await statementId(params);
  if (id === null) return NextResponse.json({ error: "Invalid statement id" }, { status: 400 });
  try {
    await tenantTx(user.businessId, (tx) =>
      retireIdentityStatement({ businessId: user.businessId, userId: user.id, statementId: id }, tx),
    );
    return NextResponse.json({ retired: true });
  } catch (error) {
    return identityErrorResponse(error, "DELETE /api/business/identity/[id]");
  }
}
