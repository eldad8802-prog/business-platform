import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { discoverGmailAttachments } from "@/lib/services/integrations/gmail/gmail-discovery.service";
import { GmailReauthRequiredError } from "@/lib/services/integrations/gmail/gmail-errors";
import { isGmailConnectionOwnedByBusiness } from "@/lib/services/integrations/gmail/gmail-connection.service";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
    }

    const maxMessagesRaw = req.nextUrl.searchParams.get("maxMessages");
    const maxMessages = maxMessagesRaw ? Number(maxMessagesRaw) : undefined;

    // Optional account selection. When provided it must be a valid, owned Gmail
    // connection; otherwise the discovery service falls back to the first
    // connected account (unchanged single-account behavior).
    let connectionId: number | undefined;
    const connectionIdRaw = req.nextUrl.searchParams.get("connectionId");
    if (connectionIdRaw != null && connectionIdRaw !== "") {
      const parsed = Number(connectionIdRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return NextResponse.json({ error: "connectionId לא תקין" }, { status: 400 });
      }
      const owned = await runWithTenantContext({ businessId: user.businessId }, () => isGmailConnectionOwnedByBusiness({
        businessId: user.businessId,
        connectionId: parsed,
      }));
      if (!owned) {
        return NextResponse.json({ error: "החשבון לא נמצא" }, { status: 404 });
      }
      connectionId = parsed;
    }

    const summary = await runWithTenantContext({ businessId: user.businessId }, () => discoverGmailAttachments({
      businessId: user.businessId,
      connectionId,
      maxMessages,
    }));

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

