/**
 * D2 / PRIVILEGED-WRITE-2 — the platform-admin feature-access WRITE path.
 *
 * The single privileged writer of `BusinessFeatureAccess`. It runs entirely
 * inside one control-plane transaction:
 *
 *   authorized PLATFORM_ADMIN (route boundary)
 *     → withControlPlaneTransaction(targetBusinessId)
 *       → GUC = targetBusinessId, control-plane role
 *         → validate target + read current state
 *         → single upsert-by-count (never DELETE — INHERIT is a stored state)
 *         → affected-row assertion
 *         → PlatformAuditEvent append
 *
 * Three properties this file is responsible for:
 *  1. No context-less transaction. A bare `prisma.$transaction` here would,
 *     under FORCE RLS, write zero rows in silence while still committing a
 *     success audit. Every statement runs on the control-plane client with the
 *     target GUC set.
 *  2. No DELETE. Clearing an override writes `state = INHERIT`, which the
 *     resolver already treats as "no effective override" — so the control-plane
 *     role needs no DELETE privilege at all, and the un-override action keeps
 *     its reason and actor instead of destroying them.
 *  3. Mutation and audit are atomic. They are the same transaction on the same
 *     connection under the same role; either both commit or neither does.
 *
 * The actor is a parameter produced by `requirePlatformAdmin` at the route. It
 * is never read from the body/query, and the DB role is not proof of it.
 */
import {
  BusinessFeatureAccessState,
  type BusinessFeatureAccess,
} from "@prisma/client";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import {
  assertAffected,
  withControlPlaneTransaction,
} from "@/lib/services/control-plane/control-plane-transaction";
import { PLATFORM_SYSTEM_BUSINESS_NAME } from "@/lib/services/platform-admin/constants";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { createPlatformAuditEventTx } from "@/lib/services/platform-admin/platform-audit.service";
import {
  getPlatformFeatureCatalogEntry,
  isPlatformFeatureKey,
} from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccessFromInputs } from "@/lib/services/feature-access/resolve-feature-access";
import type {
  BusinessFeatureOverrideState,
  UpdateBusinessFeatureAccessResponse,
} from "@/lib/services/feature-access/feature-access.types";
import { buildPlatformAdminBusinessFeatureItem } from "./platform-business-features.service";

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

function toDbState(
  state: BusinessFeatureOverrideState
): BusinessFeatureAccessState {
  if (state === "ENABLED") {
    return BusinessFeatureAccessState.ENABLED;
  }
  if (state === "DISABLED") {
    return BusinessFeatureAccessState.DISABLED;
  }
  return BusinessFeatureAccessState.INHERIT;
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
  // Pure, DB-free validation first: an invalid request must never open a
  // privileged connection.
  if (!isPlatformFeatureKey(input.featureKey)) {
    throw new NotFoundError("Feature not found");
  }

  const featureKey = input.featureKey;
  const catalogEntry = getPlatformFeatureCatalogEntry(featureKey);

  if (!catalogEntry.mutable) {
    throw new ForbiddenError("Feature is not mutable", "FEATURE_NOT_MUTABLE");
  }

  if (
    input.state !== "ENABLED" &&
    input.state !== "DISABLED" &&
    input.state !== "INHERIT"
  ) {
    throw new ValidationError("Invalid state");
  }

  const reason = validateReason(input.reason);
  const dbState = toDbState(input.state);

  return withControlPlaneTransaction(input.businessId, async (tx) => {
    const business = await tx.business.findFirst({
      where: {
        id: input.businessId,
        name: { not: PLATFORM_SYSTEM_BUSINESS_NAME },
      },
      select: { id: true, name: true },
    });

    if (!business) {
      throw new NotFoundError("Business not found");
    }

    const currentRow = await tx.businessFeatureAccess.findUnique({
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

    // Upsert by affected count. `updateMany`/`createMany` return real row
    // counts, which is what makes the fail-loud assertion possible: under FORCE
    // RLS a missing or wrong GUC yields 0 and we refuse to continue.
    const updated = await tx.businessFeatureAccess.updateMany({
      where: { businessId: input.businessId, featureKey },
      data: {
        state: dbState,
        reason,
        updatedByUserId: input.actorUserId,
      },
    });

    if (updated.count === 0) {
      const created = await tx.businessFeatureAccess.createMany({
        data: [
          {
            businessId: input.businessId,
            featureKey,
            state: dbState,
            reason,
            updatedByUserId: input.actorUserId,
          },
        ],
      });
      assertAffected(created.count, "BusinessFeatureAccess insert");
    } else {
      assertAffected(updated.count, "BusinessFeatureAccess update");
    }

    // Effective state AFTER the write, read inside the same transaction so the
    // response can never describe a state this transaction did not commit.
    const policy = await tx.platformFeaturePolicy.findUnique({
      where: { featureKey },
      select: { globalEnabled: true, emergencyDisabled: true },
    });
    const override = await tx.businessFeatureAccess.findUnique({
      where: {
        businessId_featureKey: {
          businessId: input.businessId,
          featureKey,
        },
      },
      select: { state: true },
    });

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
        affectedRows: 1,
      },
      req: input.req,
    });

    return {
      changed: true,
      generatedAt: new Date().toISOString(),
      business: {
        id: business.id,
        name: business.name,
      },
      feature: buildPlatformAdminBusinessFeatureItem(catalogEntry, accessAfter),
    };
  });
}
