/**
 * M6 — the pre-tenant resolvers: the ONLY way an inbound acquisition request reaches a business.
 *
 * Each asks one SECURITY DEFINER function (migration 20261008090000) "which business owns this exact
 * key", by equality on a unique value. Nothing here reads a businessId from a request, enumerates
 * connections, or falls back to a default tenant. A database error PROPAGATES (never "not found"),
 * so the webhook answers non-2xx and the provider redelivers.
 */
import { prisma } from "@/lib/prisma";
import { hashKey, PUBLIC_ID_PATTERN } from "./keys";

export type ResolvedConnection = { connectionId: number; businessId: number };

/** Google webhook / website server post: endpoint + shared key. */
export async function resolveKeyedConnection(
  sourceKey: "google.lead_form" | "web.form",
  publicId: string,
  key: string
): Promise<ResolvedConnection | null> {
  if (!PUBLIC_ID_PATTERN.test(publicId) || typeof key !== "string" || key.length < 8 || key.length > 200) return null;
  const keyHash = hashKey(key);
  const rows = await prisma.$queryRaw<{ connection_id: number; business_id: number }[]>`SELECT connection_id, business_id FROM public.m6_acquisition_resolve_keyed(${sourceKey}, ${publicId}, ${keyHash})`;
  return rows.length === 1 ? { connectionId: rows[0].connection_id, businessId: rows[0].business_id } : null;
}

/** Website browser post: endpoint → business + the origins its owner allowed. */
export async function resolvePublicConnection(
  sourceKey: "web.form" | "google.lead_form",
  publicId: string
): Promise<(ResolvedConnection & { allowedOrigins: string[] }) | null> {
  if (!PUBLIC_ID_PATTERN.test(publicId)) return null;
  const rows = await prisma.$queryRaw<{ connection_id: number; business_id: number; allowed_origins: string[] }[]>`SELECT connection_id, business_id, allowed_origins FROM public.m6_acquisition_resolve_public(${sourceKey}, ${publicId})`;
  return rows.length === 1
    ? { connectionId: rows[0].connection_id, businessId: rows[0].business_id, allowedOrigins: rows[0].allowed_origins ?? [] }
    : null;
}

/** Meta webhook: the Page id (inside a payload Meta signed) → the business that connected it. */
export async function resolveResourceConnection(
  sourceKey: "meta.lead_ads",
  resourceId: string
): Promise<ResolvedConnection | null> {
  if (typeof resourceId !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(resourceId)) return null;
  const rows = await prisma.$queryRaw<{ connection_id: number; business_id: number }[]>`SELECT connection_id, business_id FROM public.m6_acquisition_resolve_resource(${sourceKey}, ${resourceId})`;
  return rows.length === 1 ? { connectionId: rows[0].connection_id, businessId: rows[0].business_id } : null;
}

/** Intake sweeper: every business that may hold receipts of this source. Ids only. */
export async function listAcquisitionTenants(sourceKey: string): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ m6_acquisition_tenants: number }[]>`SELECT m6_acquisition_tenants FROM public.m6_acquisition_tenants(${sourceKey})`;
  return rows.map((r) => Number(r.m6_acquisition_tenants));
}
