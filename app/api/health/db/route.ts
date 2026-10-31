import { NextRequest, NextResponse } from "next/server";

import { decideMonitorAuth, NO_STORE_HEADERS, probeDatabases } from "@/lib/ops/db-health";
import { prisma } from "@/lib/prisma";
import { authDb } from "@/lib/prisma-auth";
import { safeErrorSummary } from "@/lib/security/log-safe-error";

/**
 * Database availability for the external uptime monitor (lib/ops/db-health.ts). `SELECT 1` on the runtime client
 * and on the client login uses — no table, no write. Only a caller holding HEALTH_MONITOR_SECRET (Bearer) reaches
 * the database; everyone else is answered before any query. Fixed codes only, never cached.
 *
 *   200 {status:"ok", ...}      both connections answered
 *   503 {status:"down", ...}    at least one did not (checks.* = unreachable | timeout | rejected | not_configured | error)
 *   401 {error:"unauthorized"}  wrong or missing credential
 *   503 {error:"monitor_not_configured"}  no usable HEALTH_MONITOR_SECRET — the route is inert
 *
 * /api/health stays the static liveness answer; this route is the readiness one.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const decision = decideMonitorAuth(req.headers.get("authorization"), process.env);
  if (decision === "NOT_CONFIGURED") {
    return NextResponse.json({ error: "monitor_not_configured" }, { status: 503, headers: NO_STORE_HEADERS });
  }
  if (decision !== "AUTHORIZED") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });
  }

  const { report, failures } = await probeDatabases({
    runtime: () => prisma.$queryRaw`SELECT 1`,
    auth: () => authDb().$queryRaw`SELECT 1`,
  });
  for (const f of failures) {
    console.error("[health-db] check failed", { check: f.check, code: report.checks[f.check], ...safeErrorSummary(f.cause) });
  }
  return NextResponse.json(report, { status: report.status === "ok" ? 200 : 503, headers: NO_STORE_HEADERS });
}
