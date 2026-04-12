import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { updateLearningFromAction } from "@/lib/learning/update-learning";

export async function POST(req: Request) {
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

    const existingSuggestion = await prisma.replySuggestion.findUnique({
      where: { id: suggestionId },
    });

    if (!existingSuggestion) {
      return NextResponse.json(
        { error: "Suggestion not found" },
        { status: 404 }
      );
    }

    const now = new Date();
    let data: Record<string, unknown> = {};

    switch (action) {
      case "shown":
        data = {
          status: existingSuggestion.status === "GENERATED" ? "SHOWN" : existingSuggestion.status,
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
          return NextResponse.json(
            { error: "Cannot mark suggestion as edited after it was sent" },
            { status: 400 }
          );
        }

        data = {
          wasEdited: true,
        };
        break;

      case "dismissed":
        data = {
          status: existingSuggestion.sentAt ? existingSuggestion.status : "DISMISSED",
          dismissedAt: existingSuggestion.dismissedAt ?? now,
        };
        break;

      case "customer_responded":
        if (!existingSuggestion.sentAt) {
          return NextResponse.json(
            { error: "Cannot mark customer_responded before suggestion was sent" },
            { status: 400 }
          );
        }

        data = {
          customerResponded: true,
          customerRespondedAt: existingSuggestion.customerRespondedAt ?? now,
        };
        break;

      case "stage_advanced":
        if (!existingSuggestion.sentAt) {
          return NextResponse.json(
            { error: "Cannot mark stage_advanced before suggestion was sent" },
            { status: 400 }
          );
        }

        data = {
          ledToStageAdvance: true,
        };
        break;

      default:
        return NextResponse.json(
          { error: "Invalid action" },
          { status: 400 }
        );
    }

    const updatedSuggestion = await prisma.replySuggestion.update({
      where: { id: suggestionId },
      data,
    });

    await updateLearningFromAction(suggestionId);

    return NextResponse.json(updatedSuggestion, { status: 200 });
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