import {
  BusinessFeatureAccessState,
  type BusinessFeatureAccess,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { PLATFORM_SYSTEM_BUSINESS_NAME } from "@/lib/services/platform-admin/constants";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { createPlatformAuditEventTx } from "@/lib/services/platform-admin/platform-audit.service";
import {
  getPlatformFeatureCatalogEntry,
  isPlatformFeatureKey,
} from "./platform-feature-catalog";
import { buildPlatformAdminBusinessFeatureItem } from "./platform-admin-business-features.service";
import {
  resolveFeatureAccess,
  resolveFeatureAccessFromInputs,
} from "./resolve-feature-access";
import type {
  BusinessFeatureOverrideState,
  UpdateBusinessFeatureAccessResponse,
} from "./feature-access.types";

const REASON_MIN_LENGTH = 10;
const REASON_MAX_LENGTH = 500;

export type UpdateBusinessFeatureAccessInput = {
  actorUserId: number;
  businessId: number;
  featureKey: string;
  state: BusinessFeatureOverrideState;
  reason: string;
  req?: Request;
};

function parseOverrideState(
  state: BusinessFeatureAccessState | null | undefined
): BusinessFeatureOverrideState {
  if (state === BusinessFeatureAccessState.ENABLED) {
    return "ENABLED";
  }
  if (state === BusinessFeatureAccessState.DISABLED) {
    return "DISABLED";
  }
  return "INHERIT";
}

function hasEffectiveOverride(
  row: Pick<BusinessFeatureAccess, "state"> | null
): boolean {
  if (!row) {
    return false;
  }
  return (
    row.state === BusinessFeatureAccessState.ENABLED ||
    row.state === BusinessFeatureAccessState.DISABLED
  );
}

function isNoOp(
  row: Pick<BusinessFeatureAccess, "state"> | null,
  requested: BusinessFeatureOverrideState
): boolean {
  if (requested === "INHERIT") {
    return !hasEffectiveOverride(row);
  }
  if (!row) {
    return false;
  }
  return row.state === requested;
}

function validateReason(raw: string): string {
  const reason = raw.trim();
  if (reason.length < REASON_MIN_LENGTH) {
    throw new ValidationError(
      `Reason must be at least ${REASON_MIN_LENGTH} characters`
    );
  }
  if (reason.length > REASON_MAX_LENGTH) {
    throw new ValidationError(
      `Reason must be at most ${REASON_MAX_LENGTH} characters`
    );
  }
  return reason;
}

export async function updateBusinessFeatureAccess(
  input: UpdateBusinessFeatureAccessInput
): Promise<UpdateBusinessFeatureAccessResponse> {
  if (!isPlatformFeatureKey(input.featureKey)) {
    throw new NotFoundError("Feature not found");
  }

  const featureKey = input.featureKey;
  const catalogEntry = getPlatformFeatureCatalogEntry(featureKey);

  if (!catalogEntry.mutable) {
    throw new ForbiddenError("Feature is not mutable", "FEATURE_NOT_MUTABLE");
  }

  const reason = validateReason(input.reason);

  if (
    input.state !== "ENABLED" &&
    input.state !== "DISABLED" &&
    input.state !== "INHERIT"
  ) {
    throw new ValidationError("Invalid state");
  }

  const business = await prisma.business.findFirst({
    where: {
      id: input.businessId,
      name: { not: PLATFORM_SYSTEM_BUSINESS_NAME },
    },
    select: { id: true, name: true },
  });

  if (!business) {
    throw new NotFoundError("Business not found");
  }

  const currentRow = await prisma.businessFeatureAccess.findUnique({
    where: {
      businessId_featureKey: {
        businessId: input.businessId,
        featureKey,
      },
    },
    select: { state: true },
  });

  const oldState = parseOverrideState(currentRow?.state);

  if (isNoOp(currentRow, input.state)) {
    throw new ConflictError("NO_CHANGE");
  }

  await prisma.$transaction(async (tx) => {
    const rowInTx = await tx.businessFeatureAccess.findUnique({
      where: {
        businessId_featureKey: {
          businessId: input.businessId,
          featureKey,
        },
      },
      select: { state: true },
    });

    if (isNoOp(rowInTx, input.state)) {
      throw new ConflictError("NO_CHANGE");
    }

    if (input.state === "INHERIT") {
      await tx.businessFeatureAccess.deleteMany({
        where: {
          businessId: input.businessId,
          featureKey,
        },
      });
    } else {
      const dbState =
        input.state === "ENABLED"
          ? BusinessFeatureAccessState.ENABLED
          : BusinessFeatureAccessState.DISABLED;

      await tx.businessFeatureAccess.upsert({
        where: {
          businessId_featureKey: {
            businessId: input.businessId,
            featureKey,
          },
        },
        create: {
          businessId: input.businessId,
          featureKey,
          state: dbState,
          reason,
          updatedByUserId: input.actorUserId,
        },
        update: {
          state: dbState,
          reason,
          updatedByUserId: input.actorUserId,
        },
      });
    }

    const [policy, override] = await Promise.all([
      tx.platformFeaturePolicy.findUnique({
        where: { featureKey },
        select: { globalEnabled: true, emergencyDisabled: true },
      }),
      tx.businessFeatureAccess.findUnique({
        where: {
          businessId_featureKey: {
            businessId: input.businessId,
            featureKey,
          },
        },
        select: { state: true },
      }),
    ]);

    const accessAfter = resolveFeatureAccessFromInputs({
      featureKey,
      catalogDefaultEnabled: catalogEntry.defaultEnabled,
      policy,
      override,
    });

    await createPlatformAuditEventTx(tx, {
      actorUserId: input.actorUserId,
      action: PLATFORM_AUDIT_ACTIONS.FEATURE_ACCESS_UPDATED,
      targetType: "BUSINESS",
      targetId: String(input.businessId),
      metadata: {
        businessId: input.businessId,
        featureKey,
        oldState,
        newState: input.state,
        reason,
        effectiveAllowedAfter: accessAfter.allowed,
        reasonCodeAfter: accessAfter.reasonCode,
      },
      req: input.req,
    });
  });

  const access = await resolveFeatureAccess(input.businessId, featureKey);

  return {
    changed: true,
    generatedAt: new Date().toISOString(),
    business: {
      id: business.id,
      name: business.name,
    },
    feature: buildPlatformAdminBusinessFeatureItem(catalogEntry, access),
  };
}
