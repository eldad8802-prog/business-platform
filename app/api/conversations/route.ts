import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { serializeInboxItem,
  PENDING_SUGGESTION_STATUSES,
} from "@/lib/inbox-view/inbox-item.serializer";
import { computeProductCatalogEnabled } from "@/lib/inbox-view/product-link-capability";
import { findStarterBotTerminalConversationFlags } from "@/lib/features/conversation/starter-bot";



export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { conversations, starterFlags, botProduct } = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const conversations = await tx.conversation.findMany({
      where: {
        businessId: user.businessId,
      },
      orderBy: {
        updatedAt: "desc",
      },
      include: {
        customer: true,
        lead: true,
        messages: {
          take: 1,
          orderBy: { createdAt: "desc" },
          select: {
            contentText: true,
            senderType: true,
            createdAt: true,
            direction: true,
            analysis: { select: { intent: true } },
          },
        },
        replySuggestions: {
          where: { status: { in: [...PENDING_SUGGESTION_STATUSES] } },
          take: 1,
          select: {
            id: true,
            status: true,
            createdAt: true,
            suggestionType: true,
          },
        },
      },
    });

          const conversationIds = conversations.map((c) => c.id);
          let starterFlags: Awaited<
            ReturnType<typeof findStarterBotTerminalConversationFlags>
          > | null = null;
          try {
            starterFlags = await findStarterBotTerminalConversationFlags(
              {
                businessId: user.businessId,
                conversationIds,
              },
              { tx }
            );
          } catch (e) {
            console.warn("inbox starter-bot terminal flags query failed:", e);
          }

          const botProduct = await tx.businessBotSettings.findUnique({
            where: { businessId: user.businessId },
            select: {
              productLinkEnabled: true,
              productLinkUrl: true,
              productLinkIntro: true,
            },
          });

          return { conversations, starterFlags, botProduct };
        })
    );

    const starterBotHandoffIds: ReadonlySet<number> =
      starterFlags?.handoffConversationIds ?? new Set();
    const starterBotCompletedIds: ReadonlySet<number> =
      starterFlags?.completedConversationIds ?? new Set();

    let productCatalogEnabled = false;
    let productLinkPrefill: { intro: string | null; url: string } | null = null;
    productCatalogEnabled = computeProductCatalogEnabled(botProduct);
    if (productCatalogEnabled && botProduct?.productLinkUrl) {
      productLinkPrefill = {
        intro: botProduct.productLinkIntro ?? null,
        url: botProduct.productLinkUrl.trim(),
      };
    }

    const now = new Date();
    const items = conversations.map((conversation) =>
      serializeInboxItem({
        conversation,
        now,
        starterBot: {
          hasTerminalHandoff: starterBotHandoffIds.has(conversation.id),
          hasTerminalCompleted:
            starterBotCompletedIds.has(conversation.id) &&
            !starterBotHandoffIds.has(conversation.id),
        },
        productCatalogEnabled,
      })
    );

    return NextResponse.json(
      {
        success: true,
        conversations,
        items,
        productLinkPrefill,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("GET /api/conversations error:", error);

    return NextResponse.json(
      {
        error: "Failed to fetch conversations",
        details: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));

    const conversation = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.conversation.create({
            data: {
              businessId: user.businessId,
              customerId: body.customerId ?? null,
              leadId: body.leadId ?? null,
              channel: body.channel ?? "WHATSAPP",
              status: "OPEN",
              currentStage: "NEW",
              startedAt: new Date(),
            },
            include: {
              customer: true,
              lead: true,
            },
          })
        )
    );

    return NextResponse.json(
      {
        success: true,
        conversation,
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error("POST /api/conversations error:", error);

    return NextResponse.json(
      {
        error: "Failed to create conversation",
        details: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}