import { prisma } from "@/lib/prisma";
import {
  rankActiveCoupons,
  type ActiveCouponCard,
} from "./active-coupons.rank";

type GeoPoint = { lat: number; lng: number };

type GetActiveCouponsInput = {
  limit: number;
  /** Caller's reference point (opt-in). When present, distance is computed for businesses that have geo. */
  near?: GeoPoint | null;
};

function clampLimit(limit: number) {
  if (!Number.isFinite(limit)) return 6;
  return Math.max(1, Math.min(24, Math.floor(limit)));
}

/** Valid lat/lng only; anything out of range is treated as "no reference point". */
function sanitizeNear(near?: GeoPoint | null): GeoPoint | null {
  if (!near) return null;
  const { lat, lng } = near;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** Great-circle distance in km (Haversine). */
function haversineKm(a: GeoPoint, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - a.lat);
  const dLng = toRad(bLng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** "120 מ׳" under 1 km, otherwise "1.2 ק״מ". */
function distanceLabel(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} מ׳`;
  return `${km.toFixed(1)} ק״מ`;
}

export async function getActiveCoupons(
  input: Partial<GetActiveCouponsInput> = {}
): Promise<ActiveCouponCard[]> {
  const limit = clampLimit(input.limit ?? 6);
  const near = sanitizeNear(input.near);
  const now = new Date();

  const coupons = await prisma.coupon.findMany({
    where: {
      status: "ACTIVE",
      expiresAt: {
        gt: now,
      },
    },
    select: {
      id: true,
      publicId: true,
      issuedAt: true,
      expiresAt: true,
      offer: {
        select: {
          id: true,
          title: true,
          customerBenefitText: true,
          description: true,
          imageUrl: true,
        },
      },
      issuingBusiness: {
        select: {
          id: true,
          name: true,
          profile: {
            select: {
              category: true,
              subCategory: true,
              businessModel: true,
              city: true,
              openingHours: true,
              latitude: true,
              longitude: true,
              billingAddress: true,
              billingPhone: true,
            },
          },
        },
      },
    },
    orderBy: {
      issuedAt: "desc",
    },
    take: 200,
  });

  const cards: ActiveCouponCard[] = coupons.map((coupon) => {
    const profile = coupon.issuingBusiness.profile;

    // Distance is computed here and only the RESULT is kept — raw lat/lng never
    // leaves the service (not placed on `business`, not returned in the DTO).
    let distanceKm: number | undefined;
    let distanceLabelText: string | undefined;
    if (
      near &&
      typeof profile?.latitude === "number" &&
      typeof profile?.longitude === "number"
    ) {
      const km = haversineKm(near, profile.latitude, profile.longitude);
      if (Number.isFinite(km)) {
        distanceKm = km;
        distanceLabelText = distanceLabel(km);
      }
    }

    return {
      publicId: coupon.publicId,
      issuedAt: coupon.issuedAt.toISOString(),
      expiresAt: coupon.expiresAt.toISOString(),
      business: {
        id: coupon.issuingBusiness.id,
        name: coupon.issuingBusiness.name,
        city: profile?.city ?? undefined,
        address: profile?.billingAddress ?? undefined,
        phone: profile?.billingPhone ?? undefined,
        category: profile?.category ?? undefined,
        subCategory: profile?.subCategory ?? undefined,
        businessModel: profile?.businessModel ?? undefined,
        openingHours: profile?.openingHours ?? undefined,
      },
      offer: {
        id: coupon.offer.id,
        title: coupon.offer.title,
        customerBenefitText: coupon.offer.customerBenefitText,
        description: coupon.offer.description ?? null,
        imageUrl: coupon.offer.imageUrl ?? null,
      },
      distanceKm,
      distanceLabel: distanceLabelText,
    };
  });

  const ranked = rankActiveCoupons(cards, now);
  const out = ranked.slice(0, limit);

  // Derived popularity: total redemptions per issuing business (existing data, no schema).
  const bizIds = [...new Set(out.map((c) => c.business.id))];
  if (bizIds.length > 0) {
    const grouped = await prisma.redemptionEvent.groupBy({
      by: ["issuingBusinessId"],
      where: { issuingBusinessId: { in: bizIds } },
      _count: { _all: true },
    });
    const counts = new Map(grouped.map((g) => [g.issuingBusinessId, g._count._all]));
    for (const c of out) c.redemptionCount = counts.get(c.business.id) ?? 0;
  }

  return out;
}

