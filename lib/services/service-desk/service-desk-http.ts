/**
 * Service Desk 1.3a — the HTTP edge shared by every /api/service-desk route. SERVER-ONLY.
 *
 *   - authenticated user of a business only (401); the business and the user come from the session, never from the
 *     request (owner decision ש5: every action runs as the signed-in business owner, no staff accounts);
 *   - the access mode (service-desk-gate.ts): NONE ⇒ 404 for every route, as if it did not exist; READ_ONLY ⇒ reads
 *     only — every write route answers 403 READ_ONLY before any work; FULL ⇒ reads and writes;
 *   - writes that journal carry an `Idempotency-Key` header (a UUIDv7, checked by the service);
 *   - ServiceDeskError ⇒ its status + a stable code; anything else ⇒ 500 with no detail.
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";

import { resolveServiceDeskMode, type ServiceDeskMode } from "./service-desk-gate";
import { ServiceDeskError } from "./service-desk-errors";
import type { ServiceDeskPrincipal } from "./service-case.service";

export type ServiceDeskRequestContext = { principal: ServiceDeskPrincipal; mode: Exclude<ServiceDeskMode, "NONE"> };
export type RouteKind = "read" | "write";

const NO_STORE = { "Cache-Control": "no-store" };

export async function serviceDeskRoute(
  req: Request,
  kind: RouteKind,
  handler: (ctx: ServiceDeskRequestContext) => Promise<Response>,
  deps: { mode?: (businessId: number) => Promise<ServiceDeskMode>; user?: (req: Request) => Promise<{ id: number; businessId: number | null } | null> } = {},
): Promise<Response> {
  try {
    const user = await (deps.user ?? getCurrentUser)(req);
    if (!user || !user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    const mode = await (deps.mode ?? resolveServiceDeskMode)(user.businessId);
    if (mode === "NONE") return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    if (kind === "write" && mode !== "FULL") throw new ServiceDeskError("READ_ONLY");
    const principal: ServiceDeskPrincipal = { businessId: user.businessId, userId: user.id };
    return await runWithTenantContext({ businessId: user.businessId }, () => handler({ principal, mode }));
  } catch (e) {
    return serviceDeskError(e);
  }
}

export function serviceDeskError(e: unknown): Response {
  if (e instanceof ServiceDeskError) {
    return NextResponse.json(
      { error: e.code, ...(Object.keys(e.details).length ? { details: e.details } : {}) },
      { status: e.status, headers: NO_STORE },
    );
  }
  console.error("[service-desk] unexpected error", e instanceof Error ? e.name : "unknown");
  return NextResponse.json({ error: "INTERNAL" }, { status: 500, headers: NO_STORE });
}

export function idempotencyKeyOf(req: Request): string {
  const key = req.headers.get("idempotency-key");
  if (!key) throw new ServiceDeskError("IDEMPOTENCY_KEY_INVALID", { header: "missing" });
  return key;
}

export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new ServiceDeskError("INVALID_INPUT", { field: "body" });
  }
}

/** A route id: a positive integer, or 404 (never a hint about another business's ids). */
export function positiveId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ServiceDeskError("NOT_FOUND");
  return n;
}

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * The request body, read with a running byte cap: past `max` the stream is cancelled and null returned. Content-Length is
 * never trusted alone (a chunked body has none), so nothing past the cap is ever buffered.
 */
export async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** Headers for serving a stored private image: never cached, never sniffed, never run as a document. */
export const PRIVATE_IMAGE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Disposition": "inline",
  "Content-Security-Policy": "sandbox; default-src 'none'",
} as const;
