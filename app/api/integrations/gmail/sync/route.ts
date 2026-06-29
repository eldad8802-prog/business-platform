import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { discoverGmailAttachments } from "@/lib/services/integrations/gmail/gmail-discovery.service";
import { GmailReauthRequiredError } from "@/lib/services/integrations/gmail/gmail-errors";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
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
    if (error instanceof GmailReauthRequiredError) {
      console.warn("GMAIL_SYNC_REAUTH_REQUIRED:", error.reason);
      return NextResponse.json(
        {
          error: "החיבור ל-Gmail פג. יש לחבר מחדש כדי להמשיך.",
          needsReconnect: true,
        },
        { status: 409 }
      );
    }
    console.error("GMAIL_SYNC_DISCOVERY_ERROR:", error);
    return NextResponse.json(
      { error: "שגיאה בסריקת המיילים. נסה שוב מאוחר יותר." },
      { status: 500 }
    );
  }
}

