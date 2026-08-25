import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// POST generate suggestions
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const messageId = body.messageId;

    if (!messageId) {
      return NextResponse.json(
        { error: "messageId is required" },
        { status: 400 }
      );
    }

    const message = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.message.findFirst({
            where: { id: messageId, businessId: user.businessId },
          })
        )
    );

    if (!message) {
      return NextResponse.json(
        { error: "Message not found" },
        { status: 404 }
      );
    }

    const text = message.contentText || "";

    let suggestions: {
      text: string;
      strategy: string;
      tone: string;
    }[] = [];

    if (text.includes("כמה") || text.includes("מחיר")) {
      suggestions = [
        {
          text: "היי 😊 בשמחה! המחיר משתנה לפי סוג הטיפול, רוצה שאדייק לך?",
          strategy: "price_anchor",
          tone: "friendly",
        },
        {
          text: "בשמחה! מה בדיוק תרצי לעשות כדי לתת מחיר מדויק?",
          strategy: "clarify_need",
          tone: "professional",
        },
      ];
    } else {
      suggestions = [
        {
          text: "היי 😊 איך אפשר לעזור?",
          strategy: "open",
          tone: "friendly",
        },
      ];
    }

    // Sequential creates on ONE tenant transaction (never Promise.all on an
    // interactive tx).
    const created = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const rows = [];
          for (const [index, s] of suggestions.entries()) {
            rows.push(
              await tx.replySuggestion.create({
                data: {
                  businessId: message.businessId,
            conversationId: message.conversationId,
            messageId: message.id,

            suggestionType: "AUTO",
            strategyType: s.strategy,
            variantType: "default",
            variantIndex: index,

                  text: s.text,
                  strategyLabel: s.strategy,
                  toneLabel: s.tone,

                  status: "GENERATED",
                },
              })
            );
          }
          return rows;
        })
    );

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to generate suggestions" },
      { status: 500 }
    );
  }
}