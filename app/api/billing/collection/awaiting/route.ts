/**
 * GET /api/billing/collection/awaiting
 *
 * Who owes this business money right now, and since when.
 *
 * Read-only. There is no POST, PATCH or DELETE on this route by design: the
 * collection screen reads billing state, it never changes it. Issuing,
 * numbering, crediting and settlement all keep their existing owners.
 */

import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { prisma } from "@/lib/prisma";
import { loadAwaitingPaymentList } from "@/lib/services/billing/collection/awaiting-payment.loader";
import { serializeAwaitingPaymentList } from "@/lib/services/billing/collection/awaiting-payment.serializer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [list, business] = await Promise.all([
      loadAwaitingPaymentList(user.businessId),
      prisma.business.findUnique({
        where: { id: user.businessId },
        select: { name: true },
      }),
    ]);

    return NextResponse.json({
      ...serializeAwaitingPaymentList(list),
      // The message signs off as the business, and it is composed in the
      // browser from the pure template — so the name travels with the list.
      businessName: business?.name ?? "",
    });
  } catch (error) {
    return handleError(error);
  }
}
