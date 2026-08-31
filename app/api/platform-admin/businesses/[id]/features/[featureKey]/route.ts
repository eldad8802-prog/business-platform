import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import {
  ServiceUnavailableError,
  ValidationError,
} from "@/lib/errors";
import { isFeatureAccessMutationsEnabled } from "@/lib/services/feature-access/feature-access-mutations";
import type { BusinessFeatureOverrideState } from "@/lib/services/feature-access/feature-access.types";
import { updateBusinessFeatureAccess } from "@/lib/services/platform-admin/update-business-feature-access.service";

function parseBusinessId(raw: string): number {
  const id = Number(raw);
  if (!id || Number.isNaN(id) || !Number.isInteger(id) || id <= 0) {
    throw new ValidationError("Invalid business id");
  }
  return id;
}

function parseBody(body: unknown): {
  state: BusinessFeatureOverrideState;
  reason: string;
} {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Invalid request body");
  }

  const record = body as Record<string, unknown>;
  const state = record.state;
  const reason = record.reason;

  if (state !== "ENABLED" && state !== "DISABLED" && state !== "INHERIT") {
    throw new ValidationError("Invalid state");
  }

  if (typeof reason !== "string") {
    throw new ValidationError("Reason is required");
  }

  return { state, reason };
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string; featureKey: string }> }
) {
  try {
    if (!isFeatureAccessMutationsEnabled()) {
      throw new ServiceUnavailableError();
    }

    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const { id, featureKey } = await context.params;
    const businessId = parseBusinessId(id);
    const rawBody: unknown = await req.json();
    const { state, reason } = parseBody(rawBody);

    const result = await updateBusinessFeatureAccess({
      actorUserId: auth.id,
      businessId,
      featureKey,
      state,
      reason,
      req,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
