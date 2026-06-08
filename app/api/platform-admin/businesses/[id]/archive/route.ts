import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { archiveBusiness } from "@/lib/services/platform-admin/business-archive.service";

function parseBusinessId(raw: string): number {
  const id = Number(raw);
  if (!id || Number.isNaN(id) || !Number.isInteger(id) || id <= 0) {
    throw new ValidationError("Invalid business id");
  }
  return id;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const { id } = await context.params;
    const businessId = parseBusinessId(id);

    const result = await archiveBusiness({
      actorUserId: auth.id,
      businessId,
      req,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
