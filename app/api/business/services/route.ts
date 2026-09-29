import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  createBusinessService,
  listOfferings,
  OfferingInputError,
} from "@/lib/services/offering/business-service.service";
import { ServicePriceError, type ServicePriceModeName } from "@/lib/services/offering/service-price";
import type { ServiceFulfillment } from "@prisma/client";

export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const offerings = await tenantTx(user.businessId, (tx) => listOfferings(user.businessId, tx));
  return NextResponse.json({ offerings });
}

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = (await req.json()) as {
      name?: unknown;
      description?: unknown;
      priceMode?: unknown;
      priceAmount?: unknown;
      priceMax?: unknown;
      durationMinutes?: unknown;
      categoryLabel?: unknown;
      featuredByOwner?: unknown;
      fulfillment?: unknown;
    };

    const service = await tenantTx(user.businessId, (tx) =>
      createBusinessService(
        {
          businessId: user.businessId,
          name: typeof body.name === "string" ? body.name : "",
          description: typeof body.description === "string" ? body.description : null,
          price: {
            priceMode: body.priceMode as ServicePriceModeName,
            priceAmount: body.priceAmount as number | string | null | undefined,
            priceMax: body.priceMax as number | string | null | undefined,
          },
          durationMinutes:
            body.durationMinutes === undefined || body.durationMinutes === null
              ? null
              : Number(body.durationMinutes),
          categoryLabel: typeof body.categoryLabel === "string" ? body.categoryLabel : null,
          featuredByOwner: body.featuredByOwner === true,
          fulfillment: body.fulfillment as ServiceFulfillment | undefined,
        },
        tx
      )
    );

    return NextResponse.json({ service });
  } catch (error) {
    if (error instanceof OfferingInputError || error instanceof ServicePriceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    console.error("POST /api/business/services error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
