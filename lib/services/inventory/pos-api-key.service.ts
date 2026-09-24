/**
 * sec(C) / M-14(a) — POS API key resolution without cross-tenant table access.
 *
 * The POS ingest route authenticates an external system by the SHA-256 of its key
 * before any tenant is known. Reading `POSApiKey` directly for that needs SELECT on
 * every tenant's keys, which is exactly what FORCE RLS on the table would remove.
 * The narrow SECURITY DEFINER function `sec_c_pos_api_key_lookup(hash)` answers only
 * "which key row, which business, which source, active?" for one exact hash.
 *
 * The `lastUsedAt` stamp then runs inside the resolved tenant's transaction.
 */
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export type PosApiKeyRow = {
  id: number;
  businessId: number;
  source: string;
  active: boolean;
};

function isUndefinedFunction(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string }; message?: string } | null;
  return (
    e?.meta?.code === "42883" ||
    e?.code === "42883" ||
    /function public\.sec_c_pos_api_key_lookup\(.*\) does not exist/.test(String(e?.message ?? ""))
  );
}

export async function lookupPosApiKey(keyHash: string): Promise<PosApiKeyRow | null> {
  if (typeof keyHash !== "string" || keyHash.length === 0) return null;
  try {
    const rows = await prisma.$queryRaw<
      { key_id: number; business_id: number; key_source: string; key_active: boolean }[]
    >`SELECT key_id, business_id, key_source, key_active FROM public.sec_c_pos_api_key_lookup(${keyHash})`;
    const r = rows[0];
    return r
      ? { id: r.key_id, businessId: r.business_id, source: r.key_source, active: r.key_active }
      : null;
  } catch (error) {
    // ONLY a database the sec(C) migration has not reached (the table has no RLS
    // there, so the direct read is today's behaviour). Anything else propagates.
    if (!isUndefinedFunction(error)) throw error;
    console.error("[pos] key lookup function missing — using direct lookup");
    return prisma.pOSApiKey.findUnique({
      where: { keyHash },
      select: { id: true, businessId: true, source: true, active: true },
    });
  }
}

/** Best-effort usage stamp, inside the key's own tenant. Never throws. */
export async function touchPosApiKey(businessId: number, keyId: number): Promise<void> {
  try {
    await tenantTx(businessId, (tx) =>
      tx.pOSApiKey.updateMany({
        where: { id: keyId, businessId },
        data: { lastUsedAt: new Date() },
      })
    );
  } catch {
    // usage stamp only
  }
}
