import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { discoverGmailAttachments } from "@/lib/services/integrations/gmail/gmail-discovery.service";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const maxMessagesRaw = req.nextUrl.searchParams.get("maxMessages");
    const maxMessages = maxMessagesRaw ? Number(maxMessagesRaw) : undefined;

    const summary = await discoverGmailAttachments({
      businessId: user.businessId,
      maxMessages,
    });

    return NextResponse.json({
      success: true,
      scannedMessages: summary.scannedMessages,
      foundAttachments: summary.foundAttachments,
      attachments: summary.attachments,
    });
  } catch (error) {
    console.error("GMAIL_SYNC_DISCOVERY_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

