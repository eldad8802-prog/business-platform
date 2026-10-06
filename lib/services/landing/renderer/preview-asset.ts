import { tenantTx } from "@/lib/tenant/tenant-tx";

/**
 * P3-D · Which asset may the owner's landing preview stream? Exactly one rule, used by the route and the
 * tenant tests: the asset belongs to the SESSION business (tenant transaction + explicit check), it is
 * publicUseApproved, and its storage key lies under that business's own prefix. Anything else → null.
 * The key never leaves the server.
 */
export async function resolvePreviewAsset(businessId: number, assetId: number): Promise<{ storageKey: string } | null> {
  if (!Number.isInteger(businessId) || businessId <= 0 || !Number.isInteger(assetId) || assetId <= 0) return null;
  const asset = await tenantTx(businessId, (tx) =>
    tx.businessAsset.findFirst({ where: { id: assetId, businessId }, select: { businessId: true, storageKey: true, publicUseApproved: true } }),
  );
  if (!asset || asset.businessId !== businessId || !asset.publicUseApproved) return null;
  const key = asset.storageKey ?? "";
  if (!key.startsWith(`biz/${businessId}/`)) return null;
  return { storageKey: key };
}
