import { tenantTx } from "@/lib/tenant/tenant-tx";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { logRouteError } from "@/lib/security/route-error";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // CUTOVER-2A: read inside the tenant transaction. On the global client this
    // carries no `app.current_business_id`, and under the restricted runtime a
    // context-less SELECT returns ZERO rows WITHOUT raising — the inbox would look
    // empty rather than fail.
    const conversations = await tenantTx(user.businessId, (tx) =>
      tx.conversation.findMany({
        where: {
          businessId: user.businessId,
        },
        orderBy: {
          updatedAt: "desc",
        },
        include: {
          customer: true,
          lead: true,
        },
      })
    );

    return NextResponse.json({
      success: true,
      conversations,
    });
  } catch (error: any) {
    logRouteError("GET /api/conversations", error);

    return NextResponse.json(
      {
        error: "Failed to fetch conversations",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await req.json();

    const customerId = body.customerId ?? null;
    const leadId = body.leadId ?? null;

    const conversation = await tenantTx(user.businessId, async (tx) => {
      // Tenant integrity: a body-supplied id must belong to THIS business.
      // One answer for every miss, so this is not an existence oracle.
      if (
        customerId != null &&
        !(await tx.customer.findFirst({
          where: { id: customerId, businessId: user.businessId },
          select: { id: true },
        }))
      ) {
        return null;
      }
      if (
        leadId != null &&
        !(await tx.lead.findFirst({
          where: { id: leadId, businessId: user.businessId },
          select: { id: true },
        }))
      ) {
        return null;
      }

      const created = await tx.conversation.create({
        data: {
          businessId: user.businessId,
          customerId,
          leadId,
          channel: body.channel ?? "WHATSAPP",
          status: "OPEN",
          currentStage: "NEW",
          startedAt: new Date(),
        },
        include: {
          customer: true,
          lead: true,
        },
      });

      // M5.5 sensor, same transaction.
      await recordSensor(
        {
          businessId: user.businessId,
          sensor: "CONVERSATION_OPENED_MANUALLY",
          entityId: created.id,
          actor: { type: "OWNER_USER", userId: user.id },
          source: "OWNER_UI",
          payload: {
            channel: created.channel,
            linkedCustomer: created.customerId != null,
            linkedLead: created.leadId != null,
          },
          idempotencyKey: `conversation:${created.id}:opened_manually`,
        },
        { tx }
      );

      return created;
    });

    if (!conversation) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    return NextResponse.json(
      {
        success: true,
        conversation,
      },
      { status: 201 }
    );
  } catch (error: any) {
    logRouteError("POST /api/conversations", error);

    return NextResponse.json(
      {
        error: "Failed to create conversation",
      },
      { status: 500 }
    );
  }
}