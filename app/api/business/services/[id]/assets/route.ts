import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  linkServiceAsset,
  OfferingNotFoundError,
} from "@/lib/services/offering/business-service.service";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const serviceId = Number(id);
  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    return NextResponse.json({ error: "Invalid service id" }, { status: 400 });
  }

  try {
    const body = (await req.json()) as { assetId?: unknown };
    const assetId = Number(body.assetId);
    if (!Number.isInteger(assetId) || assetId <= 0) {
      return NextResponse.json({ error: "Invalid asset id" }, { status: 400 });
    }

    const linked = await tenantTx(user.businessId, (tx) =>
      linkServiceAsset(
        {
          businessId: user.businessId,
          businessServiceId: serviceId,
          businessAssetId: assetId,
        },
        tx
      )
    );

    return NextResponse.json({
      linkId: linked.link.id,
      publicUseApproved: linked.publicUseApproved,
    });
  } catch (error) {
    if (error instanceof OfferingNotFoundError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("POST /api/business/services/[id]/assets error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
