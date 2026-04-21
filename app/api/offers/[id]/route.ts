import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const offerId = parseInt(id, 10);
    const businessId = 1;

    if (!Number.isInteger(offerId) || offerId <= 0) {
      return NextResponse.json({ error: "Invalid offer id" }, { status: 400 });
    }

    const offer = await prisma.offer.findFirst({
      where: {
        id: offerId,
        issuingBusinessId: businessId,
      },
      include: {
        coupons: true,
      },
    });

    if (!offer) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 });
    }

    return NextResponse.json({ offer }, { status: 200 });
  } catch (error) {
    console.error("Get Offer By Id Error:", error);

    return NextResponse.json(
      { error: "Failed to fetch offer" },
      { status: 500 }
    );
  }
}