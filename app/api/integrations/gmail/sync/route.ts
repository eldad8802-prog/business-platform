import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { discoverGmailAttachments } from "@/lib/services/integrations/gmail/gmail-discovery.service";
import { isGmailServiceError } from "@/lib/services/integrations/gmail/gmail-errors";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
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

    // Translate known integration failures into clear, actionable states so the
    // UI can guide the user (reconnect / retry) instead of showing a dead 500.
    if (isGmailServiceError(error)) {
      return NextResponse.json(
        { error: error.userMessage, code: error.code },
        { status: error.httpStatus }
      );
    }

    return NextResponse.json(
      { error: "אירעה תקלה בלתי צפויה בסריקת ה-Gmail. נסה שוב.", code: "unexpected" },
      { status: 500 }
    );
  }
}

