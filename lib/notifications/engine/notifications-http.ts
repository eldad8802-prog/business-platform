/**
 * The notification engine's session routes — one door (settings, the test push, devices). SERVER-ONLY.
 *
 * The actor is the SESSION's user and business, never an id from the request. While `notifications_engine` is OFF
 * for the business the routes do not exist (404), like every other flagged module.
 */
import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";

import { notificationsEngineEnabled } from "./engine-gate";

export type EngineActor = { businessId: number; userId: number; sessionId: string | null };

export const NO_STORE = { "Cache-Control": "no-store" } as const;
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/** The session's actor, or the response to return (401 / 404). */
export async function engineActor(req: Request): Promise<EngineActor | Response> {
  const ctx = await getAuthContext(req);
  if (!ctx?.user?.businessId) return json({ error: "Unauthorized" }, 401);
  if (!(await notificationsEngineEnabled(ctx.user.businessId))) return json({ error: "Not found" }, 404);
  return { businessId: ctx.user.businessId, userId: ctx.user.id, sessionId: ctx.sessionId };
}

export async function readJson(req: Request): Promise<unknown> {
  const raw = await req.text().catch(() => "");
  if (raw.length > 8_192) return Symbol.for("too-large");
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
