import type {
  IssueOffer,
  IssuedCoupon,
  CreateCouponResponse,
} from "./issue.types";

/* =========================
   TYPES
========================= */

export type CouponListItem = {
  id: number;
  title: string;
  description: string;
  city: string;
  createdAt?: string | null;
  expiresAt?: string | null;
  status?: string | null;
};

/* =========================
   FORMATTERS
========================= */

export function formatIssueDate(value: string | null | undefined): string {
  if (!value) {
    return "ללא תאריך";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "תאריך לא תקין";
  }

  return date.toLocaleString("he-IL");
}

export function getOfferSummary(
  title: string,
  description?: string | null
): string {
  if (description && description.trim().length > 0) {
    return description.trim();
  }

  return title;
}

/* =========================
   API CALLS
========================= */

export async function fetchOffers(token: string): Promise<IssueOffer[]> {
  const res = await fetch("/api/offers", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error("Failed to fetch offers");
  }

  const data = await res.json();

  return Array.isArray(data.offers) ? data.offers : [];
}

export async function createCoupon(
  offerId: number,
  token: string
): Promise<IssuedCoupon> {
  const res = await fetch(`/api/offers/${offerId}/coupon`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error("Failed to create coupon");
  }

  const data: CreateCouponResponse = await res.json();

  return data.coupon;
}

/* =========================
   COUPON FETCH (UPDATED)
========================= */

export async function fetchCoupons(
  token: string
): Promise<CouponListItem[]> {
  const res = await fetch("/api/offers", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error("Failed to fetch offers");
  }

  const data = await res.json();
  const offers = Array.isArray(data.offers) ? data.offers : [];

  return offers.map((offer: any) => ({
    id: offer.id,

    title: offer.title || "קופון ללא כותרת",

    description:
      offer.description?.trim() ||
      offer.customerBenefitText?.trim() ||
      "ללא תיאור",

    // 🔥 כאן החידוש — עיר אמיתית מה־BusinessProfile
    city:
  offer.issuingBusiness?.profile?.city ||
  offer.issuingBusiness?.profile?.address ||
  "",
    createdAt: offer.createdAt || null,
    expiresAt: offer.validUntil || null,

    status: offer.isActive ? "ACTIVE" : "INACTIVE",
  }));
}

/* =========================
   RANKING ENGINE
========================= */

export function rankCoupons(
  coupons: CouponListItem[]
): CouponListItem[] {
  return [...coupons]
    .map((coupon) => {
      let score = 0;

      // פעיל
      if (coupon.status === "ACTIVE" || !coupon.status) {
        score += 30;
      }

      // תוקף
      if (coupon.expiresAt) {
        const expires = new Date(coupon.expiresAt).getTime();

        if (!Number.isNaN(expires) && expires > Date.now()) {
          score += 25;
        }
      }

      // עדכניות
      if (coupon.createdAt) {
        const created = new Date(coupon.createdAt).getTime();

        if (!Number.isNaN(created)) {
          const ageHours =
            (Date.now() - created) / (1000 * 60 * 60);

          if (ageHours < 24) score += 20;
          else if (ageHours < 72) score += 10;
        }
      }

      // איכות טקסט
      if (coupon.title && coupon.title.length > 10) score += 10;
      if (coupon.description && coupon.description.length > 20) score += 10;

      return {
        ...coupon,
        _score: score,
      };
    })
    .sort((a, b) => {
      const scoreDiff = (b as any)._score - (a as any)._score;

      if (scoreDiff !== 0) return scoreDiff;

      const aCreated = a.createdAt
        ? new Date(a.createdAt).getTime()
        : 0;

      const bCreated = b.createdAt
        ? new Date(b.createdAt).getTime()
        : 0;

      return bCreated - aCreated;
    })
    .map(({ _score, ...coupon }) => coupon);
}