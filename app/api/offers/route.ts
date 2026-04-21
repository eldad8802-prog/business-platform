import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createOffer, getOffersByBusiness } from "@/lib/services/offer.service";
import { handleError } from "@/lib/handle-error";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const offers = await getOffersByBusiness(user.businessId);

    return NextResponse.json({ offers }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: any = {};

    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description =
      typeof body.description === "string" ? body.description.trim() : null;
    const customerBenefitText =
      typeof body.customerBenefitText === "string"
        ? body.customerBenefitText.trim()
        : "";
    const validUntilRaw = body.validUntil;
    const validUntil = new Date(validUntilRaw);

    const offer = await createOffer({
      businessId: user.businessId,
      title,
      description,
      customerBenefitText,
      validUntil,
    });

    return NextResponse.json({ offer }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}