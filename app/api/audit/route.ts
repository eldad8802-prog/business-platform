import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { ValidationError } from "@/lib/errors";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);

    const eventType = searchParams.get("eventType");
    const entityType = searchParams.get("entityType");
    const pageParam = searchParams.get("page") ?? "1";
    const limitParam = searchParams.get("limit") ?? "20";

    const page = Number(pageParam);
    const limit = Number(limitParam);

    if (Number.isNaN(page) || page < 1) {
      throw new ValidationError("page must be a positive number");
    }

    if (Number.isNaN(limit) || limit < 1 || limit > 100) {
      throw new ValidationError("limit must be a number between 1 and 100");
    }

    const skip = (page - 1) * limit;

    const where = {
      businessId: user.businessId,
      ...(eventType ? { eventType } : {}),
      ...(entityType ? { entityType } : {}),
    };

    // Sequential inside one tenant transaction (a TenantTx must not run
    // concurrent queries).
    const { events, total } = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const eventRows = await tx.learningEvent.findMany({
            where,
            orderBy: {
              createdAt: "desc",
            },
            skip,
            take: limit,
          });
          const count = await tx.learningEvent.count({ where });
          return { events: eventRows, total: count };
        })
    );

    return NextResponse.json(
      {
        events,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}