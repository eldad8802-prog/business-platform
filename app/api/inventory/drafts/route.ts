import { NextRequest, NextResponse } from "next/server";
import { InventoryDraftStatus, InventoryUnitType } from "@prisma/client";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { findInventoryMatches } from "@/lib/services/inventory/inventory-matching.service";
import { decideInventoryAction } from "@/lib/services/inventory/inventory-decision.service";
import { getInventoryAuthenticatedUserBasic as getAuthenticatedUser } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryUnauthorizedError,
  InventoryValidationError,
} from "@/lib/services/inventory/inventory.errors";

function handleError(error: unknown) {
  if (error instanceof InventoryUnauthorizedError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  if (error instanceof InventoryValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (error instanceof InventoryError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error("Inventory drafts route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

function parseUnitType(value: unknown): InventoryUnitType | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== "string") {
    throw new InventoryValidationError("Invalid unitType");
  }

  const normalized = value.trim().toUpperCase();

  if (
    !Object.values(InventoryUnitType).includes(
      normalized as InventoryUnitType
    )
  ) {
    throw new InventoryValidationError("Invalid unitType");
  }

  return normalized as InventoryUnitType;
}

function parseOptionalConfidence(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new InventoryValidationError(
      "confidenceScore must be a valid number"
    );
  }

  return parsed;
}

function parseDraftStatus(value: string): InventoryDraftStatus {
  const normalized = value.trim().toUpperCase();

  if (
    !Object.values(InventoryDraftStatus).includes(
      normalized as InventoryDraftStatus
    )
  ) {
    throw new InventoryValidationError("Invalid status");
  }

  return normalized as InventoryDraftStatus;
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const body = await request.json();

    const { draft, matches, decision } = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const created = await tx.inventoryDraft.create({
            data: {
              businessId: user.businessId,
              imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : null,
              detectedName:
                typeof body.detectedName === "string" ? body.detectedName : null,
              detectedCategory:
                typeof body.detectedCategory === "string"
                  ? body.detectedCategory
                  : null,
              detectedBarcode:
                typeof body.detectedBarcode === "string"
                  ? body.detectedBarcode
                  : null,
              detectedUnitType: parseUnitType(body.detectedUnitType),
              confidenceScore: parseOptionalConfidence(body.confidenceScore),
              status: InventoryDraftStatus.PENDING_REVIEW,
              createdByUserId: user.id,
            },
          });

          const matchList = await findInventoryMatches(
            { businessId: user.businessId, draft: created },
            { tx }
          );
          return {
            draft: created,
            matches: matchList,
            decision: decideInventoryAction(matchList),
          };
        })
    );

    return NextResponse.json(
      {
        success: true,
        draft,
        matches,
        decision,
      },
      { status: 201 }
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);

    const statusParam = request.nextUrl.searchParams.get("status");

    const where: {
      businessId: number;
      status?: InventoryDraftStatus;
    } = {
      businessId: user.businessId,
    };

    if (statusParam) {
      where.status = parseDraftStatus(statusParam);
    }

    // One tenant transaction; sequential enrichment (a TenantTx must not run
    // concurrent queries).
    const draftsWithMatchesAndDecision = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const drafts = await tx.inventoryDraft.findMany({
            where,
            orderBy: {
              createdAt: "desc",
            },
          });

          const enriched = [];
          for (const draft of drafts) {
            if (draft.status !== InventoryDraftStatus.PENDING_REVIEW) {
              enriched.push({ ...draft, matches: [], decision: null });
              continue;
            }
            const matches = await findInventoryMatches(
              { businessId: user.businessId, draft },
              { tx }
            );
            enriched.push({
              ...draft,
              matches,
              decision: decideInventoryAction(matches),
            });
          }
          return enriched;
        })
    );

    return NextResponse.json({
      success: true,
      drafts: draftsWithMatchesAndDecision,
    });
  } catch (error) {
    return handleError(error);
  }
}