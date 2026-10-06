/**
 * POST /api/integrations/commerce/woocommerce/callback — the store sends the approved REST keys (M7-B).
 *
 * Called by the STORE (no owner session): { key_id, user_id, consumer_key, consumer_secret, key_permissions }.
 * `user_id` is the sealed state Dubiz issued at start — the only thing that names the business; a forged,
 * expired or foreign state is refused. WooCommerce deletes the keys unless this answers exactly 200.
 */
import { NextResponse } from "next/server";
import { BodyTooLargeError, readBodyLimited } from "@/lib/intake/acquisition/http";
import { completeWooConnect } from "@/lib/intake/commerce/woocommerce-connect";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let raw: string;
  try {
    raw = await readBodyLimited(req, 16 * 1024);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ error: "too_large" }, { status: 413 });
    throw e;
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    const r = await completeWooConnect(body);
    return NextResponse.json(r.body, { status: r.status });
  } catch {
    console.error("[woocommerce-callback]", "failed");
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
