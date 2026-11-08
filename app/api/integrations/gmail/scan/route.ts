import { NextRequest, NextResponse } from "next/server";
import { getServerI18n } from "@/lib/i18n/server";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { loadGmailAccess } from "@/lib/services/integrations/gmail/gmail-discovery.service";
import {
  GmailReauthRequiredError,
  GmailScanConnectionMismatchError,
} from "@/lib/services/integrations/gmail/gmail-errors";
import { isGmailConnectionOwnedByBusiness } from "@/lib/services/integrations/gmail/gmail-connection.service";
import {
  issueGmailScanCursor,
  verifyGmailScanCursor,
} from "@/lib/services/integrations/gmail/gmail-scan-cursor";
import {
  GMAIL_SCAN_PAGE_SIZE,
  GMAIL_SCAN_SESSION_CAP,
  GmailScanListError,
  planAfterPage,
  scanGmailPage,
} from "@/lib/services/integrations/gmail/gmail-scan-page.service";
import { parseGmailScanWindow } from "@/lib/services/email-import/scan-window";
import { parseRejectedTypeCounts } from "@/lib/services/email-import/rejected-types";

export const runtime = "nodejs";

// Extended Gmail scan, one page per request (2026-11-09 B3-a). The legacy
// /api/integrations/gmail/sync is unchanged; nothing calls this route yet.
//
//   GET ?window=30|90|365[&connectionId=N][&cursor=…]
//
// The cursor is the only way to continue: it is sealed and signed by this
// server, bound to the business, user, Gmail account and window, and good for
// 30 minutes. A page that could not be read in full never advances — the
// response then carries `retryCursor` for the SAME page instead of
// `nextCursor`.

const RESTART = "תוצאות הסריקה הקודמות אינן תקפות עוד. התחל סריקה מחדש.";

function cursorRefused(reason: string) {
  console.warn("GMAIL_SCAN_CURSOR_REFUSED:", reason);
  return NextResponse.json({ error: RESTART, code: "scan_cursor_invalid", reason }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const { t } = await getServerI18n();
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: t("api.common.unauthenticated") }, { status: 401 });
    }

    const decision = await checkRateLimit({ bucket: "GMAIL_SCAN", user: user.id, business: user.businessId });
    if (!decision.allowed) return buildRateLimitResponse(decision);

    const window = parseGmailScanWindow(req.nextUrl.searchParams.get("window"));
    if (window === "invalid") {
      return NextResponse.json({ error: "טווח החיפוש אינו נתמך.", code: "scan_window_invalid" }, { status: 400 });
    }

    let connectionId: number | undefined;
    const connectionIdRaw = req.nextUrl.searchParams.get("connectionId");
    if (connectionIdRaw != null && connectionIdRaw !== "") {
      const parsed = Number(connectionIdRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return NextResponse.json({ error: t("api.gmail.invalidConnectionId") }, { status: 400 });
      }
      connectionId = parsed;
    }

    // The cursor is checked before the database or Google is touched.
    const cursorRaw = req.nextUrl.searchParams.get("cursor");
    let pageToken: string | null = null;
    let scannedBefore = 0;
    let expectConnectionId: number | undefined;
    if (cursorRaw != null) {
      const verified = verifyGmailScanCursor(cursorRaw, {
        businessId: user.businessId,
        userId: user.id,
        window,
        connectionId,
      });
      if (!verified.ok) return cursorRefused(verified.reason);
      if (verified.facts.scanned >= GMAIL_SCAN_SESSION_CAP) return cursorRefused("cap_reached");
      pageToken = verified.facts.pageToken;
      scannedBefore = verified.facts.scanned;
      expectConnectionId = verified.facts.connectionId;
    }

    if (connectionId !== undefined) {
      const owned = await runWithTenantContext({ businessId: user.businessId }, () => isGmailConnectionOwnedByBusiness({
        businessId: user.businessId,
        connectionId: connectionId as number,
      }));
      if (!owned) {
        return NextResponse.json({ error: t("api.gmail.accountNotFound") }, { status: 404 });
      }
    }

    const access = await runWithTenantContext({ businessId: user.businessId }, () => loadGmailAccess({
      businessId: user.businessId,
      connectionId,
      expectConnectionId,
    }));

    const cursorFor = (token: string | null, scanned: number) =>
      issueGmailScanCursor({
        businessId: user.businessId,
        userId: user.id,
        connectionId: access.connectionId,
        window,
        pageToken: token,
        scanned,
      });

    let page;
    try {
      page = await scanGmailPage({
        accessToken: access.accessToken,
        window,
        pageToken,
        pageSize: Math.min(GMAIL_SCAN_PAGE_SIZE, GMAIL_SCAN_SESSION_CAP - scannedBefore),
      });
    } catch (error) {
      if (!(error instanceof GmailScanListError)) throw error;
      console.warn("GMAIL_SCAN_LIST_FAILED:", error.kind);
      if (error.kind === "unauthorized") {
        return NextResponse.json({ error: t("api.gmail.reconnectRequired"), needsReconnect: true }, { status: 409 });
      }
      // Nothing on this page was read: the same page, again, when the owner chooses.
      return NextResponse.json(
        {
          error: error.kind === "throttled"
            ? "Gmail ביקש להאט. נסה להמשיך בעוד רגע."
            : "לא ניתן היה לקרוא את Gmail כרגע. נסה להמשיך בעוד רגע.",
          code: error.kind === "throttled" ? "gmail_throttled" : "gmail_unavailable",
          pageComplete: false,
          retryCursor: cursorFor(pageToken, scannedBefore),
        },
        { status: error.kind === "throttled" ? 503 : 502 }
      );
    }

    // An incomplete page never advances (planAfterPage).
    const plan = planAfterPage({
      complete: page.complete,
      listedMessages: page.listedMessages,
      nextPageToken: page.nextPageToken,
      scannedBefore,
    });
    const nextCursor = plan.advanceTo !== null ? cursorFor(plan.advanceTo, plan.scannedTotal) : null;
    const retryCursor = plan.retrySamePage ? cursorFor(pageToken, scannedBefore) : null;
    const rejectedByType = parseRejectedTypeCounts(page.rejectedByType);

    // Numbers and fixed codes only — no address, filename, subject, id or token.
    console.info(
      "GMAIL_SCAN_PAGE:",
      JSON.stringify({
        window,
        scannedBefore,
        listed: page.listedMessages,
        read: page.readMessages,
        gone: page.goneMessages,
        failed: page.failedMessages,
        skipped: page.skippedMessages,
        retries: page.retries,
        throttled: page.throttled,
        attachmentParts: page.attachmentParts,
        unsupportedType: page.unsupportedType,
        found: page.attachments.length,
        complete: page.complete,
        capReached: plan.capReached,
        hasMore: plan.hasMore,
      })
    );

    return NextResponse.json({
      success: true,
      window,
      pageComplete: page.complete,
      scannedMessages: page.listedMessages,
      scannedTotal: plan.scannedTotal,
      failedMessages: page.failedMessages + page.skippedMessages,
      capReached: plan.capReached,
      hasMore: plan.hasMore,
      nextCursor,
      retryCursor,
      foundAttachments: page.attachments.length,
      attachmentParts: page.attachmentParts,
      unsupportedType: page.unsupportedType,
      rejectedByType,
      attachments: page.attachments,
    });
  } catch (error) {
    if (error instanceof GmailScanConnectionMismatchError) {
      return cursorRefused("wrong_connection");
    }
    if (error instanceof GmailReauthRequiredError) {
      console.warn("GMAIL_SCAN_REAUTH_REQUIRED:", error.reason);
      return NextResponse.json({ error: t("api.gmail.reconnectRequired"), needsReconnect: true }, { status: 409 });
    }
    console.error("GMAIL_SCAN_ERROR:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: t("api.gmail.syncFailed") }, { status: 500 });
  }
}
