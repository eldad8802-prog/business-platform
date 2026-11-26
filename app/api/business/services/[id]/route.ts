import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  OfferingInputError,
  OfferingNotFoundError,
  updateBusinessService,
} from "@/lib/services/offering/business-service.service";
import { ServicePriceError, type ServicePriceModeName } from "@/lib/services/offering/service-price";

/**
 * PATCH /api/business/services/[id] — edit one catalog service of the signed-in business: its name, description and
 * length (Appointments milestone B follow-up; owner-approved), and — calendar daily use G11 — its price (priceMode +
 * priceAmount / priceMax, the POST's own fields and rules; an amount without a mode is refused) and `active`.
 * Featuring and fulfilment are not edited here.
 * Scoped by the business in the update itself: another business's id is 404, as an id that does not exist.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const serviceId = Number(id);
  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const body = (await req.json()) as {
      name?: unknown;
      description?: unknown;
      durationMinutes?: unknown;
      priceMode?: unknown;
      priceAmount?: unknown;
      priceMax?: unknown;
      active?: unknown;
    };
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      return NextResponse.json({ error: "name must be text" }, { status: 400 });
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
      return NextResponse.json({ error: "description must be text" }, { status: 400 });
    }
    if (body.durationMinutes !== undefined && body.durationMinutes !== null && typeof body.durationMinutes !== "number") {
      return NextResponse.json({ error: "durationMinutes must be a number of minutes" }, { status: 400 });
    }
    if (body.priceMode === undefined && (body.priceAmount !== undefined || body.priceMax !== undefined)) {
      return NextResponse.json({ error: "priceMode is required with a price" }, { status: 400 });
    }
    if (body.priceMode !== undefined && typeof body.priceMode !== "string") {
      return NextResponse.json({ error: "Unknown price mode" }, { status: 400 });
    }
    if (body.active !== undefined && typeof body.active !== "boolean") {
      return NextResponse.json({ error: "active must be true or false" }, { status: 400 });
    }

    const service = await tenantTx(user.businessId, (tx) =>
      updateBusinessService(
        {
          businessId: user.businessId,
          businessServiceId: serviceId,
          ...(body.name !== undefined ? { name: body.name as string } : {}),
          ...(body.description !== undefined ? { description: body.description as string | null } : {}),
          ...(body.durationMinutes !== undefined ? { durationMinutes: body.durationMinutes as number | null } : {}),
          ...(body.priceMode !== undefined
            ? {
                price: {
                  priceMode: body.priceMode as ServicePriceModeName,
                  priceAmount: body.priceAmount as number | string | null | undefined,
                  priceMax: body.priceMax as number | string | null | undefined,
                },
              }
            : {}),
          ...(body.active !== undefined ? { active: body.active as boolean } : {}),
        },
        tx
      )
    );

    return NextResponse.json({
      service: {
        id: service.id,
        name: service.name,
        description: service.description,
        durationMinutes: service.durationMinutes,
        priceMode: service.priceMode,
        priceAmount: service.priceAmount === null ? null : service.priceAmount.toString(),
        priceMax: service.priceMax === null ? null : service.priceMax.toString(),
        active: service.active,
      },
    });
  } catch (error) {
    if (error instanceof OfferingNotFoundError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (error instanceof OfferingInputError || error instanceof ServicePriceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    console.error("PATCH /api/business/services/[id] error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
