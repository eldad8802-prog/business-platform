import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { updateLearningFromAction } from "@/lib/learning/update-learning";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    const suggestionId = Number(body.suggestionId);
    const action = String(body.action || "").trim();

    if (!suggestionId || !action) {
      return NextResponse.json(
        { error: "suggestionId and action are required" },
        { status: 400 }
      );
    }

    // D2/P7-W4B: the whole read→transition→learning flow runs on one tenant
    // transaction; the mutation itself is atomic and tenant-scoped
    // (updateMany with businessId) — no id-only mutation window.
    const outcome = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const existingSuggestion = await tx.replySuggestion.findFirst({
            where: { id: suggestionId, businessId: user.businessId },
          });

          if (!existingSuggestion) {
            return { kind: "not_found" as const };
          }

          const now = new Date();
          let data: Record<string, unknown> = {};

          switch (action) {
            case "shown":
              data = {
                status:
                  existingSuggestion.status === "GENERATED"
                    ? "SHOWN"
                    : existingSuggestion.status,
                shownAt: existingSuggestion.shownAt ?? now,
              };
              break;

            case "selected":
              data = {
                // אם כבר נשלח, ה-status חייב להישאר SENT
                status: existingSuggestion.sentAt ? "SENT" : "SELECTED",
                selectedAt: existingSuggestion.selectedAt ?? now,
              };
              break;

            case "sent":
              data = {
                status: "SENT",
                sentAt: existingSuggestion.sentAt ?? now,
              };
              break;

            case "edited":
              if (existingSuggestion.sentAt) {
                return {
                  kind: "invalid" as const,
                  error: "Cannot mark suggestion as edited after it was sent",
                };
              }

              data = {
                wasEdited: true,
              };
              break;

            case "dismissed":
              data = {
                status: existingSuggestion.sentAt
                  ? existingSuggestion.status
                  : "DISMISSED",
                dismissedAt: existingSuggestion.dismissedAt ?? now,
              };
              break;

            case "customer_responded":
              if (!existingSuggestion.sentAt) {
                return {
                  kind: "invalid" as const,
                  error: "Cannot mark customer_responded before suggestion was sent",
                };
              }

              data = {
                customerResponded: true,
                customerRespondedAt: existingSuggestion.customerRespondedAt ?? now,
              };
              break;

            case "stage_advanced":
              if (!existingSuggestion.sentAt) {
                return {
                  kind: "invalid" as const,
                  error: "Cannot mark stage_advanced before suggestion was sent",
                };
              }

              data = {
                ledToStageAdvance: true,
              };
              break;

            default:
              return { kind: "invalid" as const, error: "Invalid action" };
          }

          await tx.replySuggestion.updateMany({
            where: { id: suggestionId, businessId: user.businessId },
            data,
          });

          await updateLearningFromAction(suggestionId, user.businessId, { tx });

          const updatedSuggestion = await tx.replySuggestion.findFirst({
            where: { id: suggestionId, businessId: user.businessId },
          });

          return { kind: "updated" as const, updatedSuggestion };
        })
    );

    if (outcome.kind === "not_found") {
      return NextResponse.json({ error: "Suggestion not found" }, { status: 404 });
    }
    if (outcome.kind === "invalid") {
      return NextResponse.json({ error: outcome.error }, { status: 400 });
    }

    return NextResponse.json(outcome.updatedSuggestion, { status: 200 });
  } catch (error: unknown) {
    console.error("REAL ERROR /api/reply-suggestion/action:", error);

    return NextResponse.json(
      {
        error: "Failed to update suggestion action",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
