import { tenantTx } from "@/lib/tenant/tenant-tx";

/**
 * The public marketing fields of an issuing business's profile, for the public
 * coupon surfaces (home feed, coupon detail page).
 *
 * `BusinessProfile` is FORCE RLS. Reading it as a nested relation on the bare client
 * matches zero rows, so every public coupon showed no city, address, phone, category
 * or hours — and no distance, because latitude/longitude were missing too — with no
 * error anywhere. Each profile is therefore read inside ITS OWN business's tenant
 * transaction. The ids come from server-side coupon rows, never from the request,
 * and only the fields below — the ones already shown on a public coupon — are read.
 */
export const PUBLIC_BUSINESS_PROFILE_SELECT = {
  category: true,
  subCategory: true,
  businessModel: true,
  city: true,
  openingHours: true,
  latitude: true,
  longitude: true,
  billingAddress: true,
  billingPhone: true,
} as const;

export type PublicBusinessProfile = {
  category: string | null;
  subCategory: string | null;
  businessModel: string | null;
  city: string | null;
  openingHours: string | null;
  latitude: number | null;
  longitude: number | null;
  billingAddress: string | null;
  billingPhone: string | null;
};

/** Bounded so a busy feed cannot take more than a few pool connections at once. */
const CONCURRENCY = 4;

export async function loadPublicBusinessProfiles(
  businessIds: readonly number[]
): Promise<Map<number, PublicBusinessProfile>> {
  const ids = [...new Set(businessIds)].filter((id) => Number.isInteger(id) && id > 0);
  const out = new Map<number, PublicBusinessProfile>();
  let next = 0;

  async function worker() {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const profile = await tenantTx(id, (tx) =>
          tx.businessProfile.findUnique({
            where: { businessId: id },
            select: PUBLIC_BUSINESS_PROFILE_SELECT,
          })
        );
        if (profile) out.set(id, profile);
      } catch (error) {
        // A public page still renders without the optional business details; it must
        // not fail because one issuer's profile could not be read.
        console.error("public business profile read failed:", { businessId: id, error });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return out;
}
