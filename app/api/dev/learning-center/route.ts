import { NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import {
  getLearningCenterOverview,
  resolveWindow,
} from "@/lib/services/learning-center/learning-center-data";
import type { TimeWindowKey } from "@/lib/services/learning-center/learning-center.types";

export const runtime = "nodejs";

const WINDOW_KEYS: TimeWindowKey[] = ["all", "24h", "7d", "30d", "custom"];

function parseWindowKey(raw: string | null): TimeWindowKey {
  return WINDOW_KEYS.includes(raw as TimeWindowKey)
    ? (raw as TimeWindowKey)
    : "all";
}

/**
 * Internal Learning Center overview — READ-ONLY, platform-admin only.
 * Returns aggregated metrics (LearningCenterOverview). It never returns secrets,
 * raw OCR geometry, or reasoning blobs — only counts/rates/derived ids. No writes.
 */
export async function GET(req: Request) {
  const gate = await requirePlatformAdminOrResponse(req);
  if (gate instanceof NextResponse) return gate;

  const url = new URL(req.url);
  const key = parseWindowKey(url.searchParams.get("window"));
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  try {
    const window = resolveWindow(key, from, to);
    const overview = await getLearningCenterOverview(window);
    return NextResponse.json(overview);
  } catch (error) {
    console.error("[learning-center] overview failed:", error);
    return NextResponse.json(
      { error: "Failed to compute learning center overview" },
      { status: 500 }
    );
  }
}
