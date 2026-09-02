import { tenantTx } from "@/lib/tenant/tenant-tx";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

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
    console.error("GET /api/conversations error:", error);

    return NextResponse.json(
      {
        error: "Failed to fetch conversations",
        details: error?.message || String(error),
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

    const conversation = await tenantTx(user.businessId, (tx) =>
      tx.conversation.create({
        data: {
          businessId: user.businessId,
          customerId: body.customerId ?? null,
          leadId: body.leadId ?? null,
          channel: body.channel ?? "WHATSAPP",
          status: "OPEN",
          currentStage: "NEW",
          startedAt: new Date(),
        },
        include: {
          customer: true,
          lead: true,
        },
      })
    );

    return NextResponse.json(
      {
        success: true,
        conversation,
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error("POST /api/conversations error:", error);

    return NextResponse.json(
      {
        error: "Failed to create conversation",
        details: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}