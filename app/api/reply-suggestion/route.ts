import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";


// POST generate suggestions
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageId = body.messageId;

    if (!messageId) {
      return NextResponse.json(
        { error: "messageId is required" },
        { status: 400 }
      );
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId },
    });

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

    const created = await Promise.all(
      suggestions.map((s, index) =>
        prisma.replySuggestion.create({
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
      )
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