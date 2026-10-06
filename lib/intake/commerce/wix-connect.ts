/**
 * M7-B — connecting a Wix store: the owner installs the Dubiz Wix app (its install link, WIX_APP_INSTALL_URL),
 * Wix opens the app's dashboard page in Dubiz with the installation's instance id, and the owner — signed in to
 * Dubiz — confirms. Dubiz binds the installation to THEIR business only after proving it is a live installation
 * of Dubiz's own app: an access token can be minted for it (client credentials + instance id) and the
 * installation's own GET /apps/v1/instance names the same instance id.
 *
 * OWNERSHIP: the instance id alone proves nothing (it is not a secret — it appears in URLs). Dubiz therefore
 * accepts ONLY Wix's signed `instance` parameter ("<signature>.<payload>", HMAC-SHA256 with the app secret),
 * which only Wix can produce for the site the owner is actually in. A bare id is REFUSED (fail closed). Whether
 * Wix still appends the signed `instance` to an OAuth app's external dashboard page is UNVERIFIED on the pages
 * read — it is the first thing the real-provider proof (E17) checks; if it does not, binding stays closed until
 * an equally strong proof exists. Re-connecting the same installation replaces this business's binding; an
 * installation live on another business is refused (one live mapping per instance).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { sourceGate } from "@/lib/intake/acquisition/gate";
import { createSignedConnection, revokeConnection, type ConnectionView } from "@/lib/intake/acquisition/connection.service";
import { getWixInstance, mintWixToken, WixApiError, wixAppConfig, WIX_SOURCE } from "./wix";

export function wixInstallUrl(): string | null {
  const u = process.env.WIX_APP_INSTALL_URL?.trim();
  return u && /^https:\/\/[^\s]+$/.test(u) ? u : null;
}

/** The instance id from Wix's SIGNED `instance` parameter only (a bare id is refused). */
export function instanceIdFrom(param: unknown, appSecret: string): string | null {
  if (typeof param !== "string" || param.length > 4096) return null;
  const v = param.trim();
  const [sig, payload, extra] = v.split(".");
  if (extra !== undefined) return null;
  if (!sig || !payload) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  const given = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { instanceId?: unknown };
    return typeof j.instanceId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(j.instanceId) ? j.instanceId : null;
  } catch {
    return null;
  }
}

export type WixConnectResult =
  | { ok: true; connection: ConnectionView }
  | { ok: false; status: 400 | 403 | 409 | 502 | 503; error: string };

export async function completeWixConnect(businessId: number, instanceParam: unknown): Promise<WixConnectResult> {
  const cfg = wixAppConfig();
  if (!cfg) return { ok: false, status: 503, error: "unavailable" };
  const gate = await sourceGate(businessId, WIX_SOURCE);
  if (!gate.ok) return { ok: false, status: 403, error: "source_not_enabled" };
  const instanceId = instanceIdFrom(instanceParam, cfg.appSecret);
  if (!instanceId) return { ok: false, status: 400, error: "instance_invalid" };
  let siteName: string | null;
  try {
    const token = await mintWixToken(instanceId);
    const inst = await getWixInstance(token);
    if (inst.instanceId !== instanceId) return { ok: false, status: 400, error: "instance_invalid" };
    siteName = inst.siteName;
  } catch (e) {
    if (e instanceof WixApiError && (e.code === "not_installed" || e.code === "unauthorized")) return { ok: false, status: 400, error: "app_not_installed" };
    return { ok: false, status: 502, error: "wix_unavailable" };
  }
  const previous = await withTenantTransaction((tx) =>
    tx.acquisitionConnection.findMany({ where: { sourceKey: WIX_SOURCE, externalResourceId: instanceId, status: { not: "REVOKED" } }, select: { id: true } })
  );
  for (const p of previous) await revokeConnection(p.id);
  try {
    const { connection } = await createSignedConnection({
      businessId,
      userId: null,
      sourceKey: WIX_SOURCE,
      label: siteName ?? "Wix",
      externalResourceId: instanceId,
      // Wix authenticates with the app's JWT (no per-store secret); the bundle keeps the reconcile cursor.
      extraSecrets: { cursor: new Date().toISOString() },
    });
    return { ok: true, connection };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, status: 409, error: "store_connected_to_another_business" };
    throw e;
  }
}
