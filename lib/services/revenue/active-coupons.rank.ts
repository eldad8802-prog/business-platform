export type ActiveCouponCard = {
  publicId: string;
  issuedAt: string;
  expiresAt: string;
  business: {
    id: number;
    name: string;
    city?: string;
    address?: string;
  };
  offer: {
    id: number;
    title: string;
    customerBenefitText: string;
    description: string | null;
    imageUrl?: string | null;
  };
};

function safeLen(value: unknown): number {
  return typeof value === "string" ? value.trim().length : 0;
}

export function rankActiveCoupons(
  coupons: ActiveCouponCard[],
  now: Date = new Date()
): ActiveCouponCard[] {
  const nowMs = now.getTime();

  return [...coupons]
    .map((c) => {
      let score = 0;

      const issuedMs = new Date(c.issuedAt).getTime();
      const expiresMs = new Date(c.expiresAt).getTime();

      // Recency (prefer newer coupons)
      if (!Number.isNaN(issuedMs)) {
        const ageHours = (nowMs - issuedMs) / (1000 * 60 * 60);
        if (ageHours < 24) score += 20;
        else if (ageHours < 72) score += 10;
        else if (ageHours < 168) score += 5; // < 7 days
      }

      // Expiry proximity: prefer coupons that expire soon but not expired.
      // This helps surface "use it before it's gone" items.
      if (!Number.isNaN(expiresMs)) {
        const hoursToExpire = (expiresMs - nowMs) / (1000 * 60 * 60);
        if (hoursToExpire > 0) {
          if (hoursToExpire <= 24) score += 18;
          else if (hoursToExpire <= 72) score += 12;
          else if (hoursToExpire <= 168) score += 6;
          else score += 2;
        }
      }

      // Text richness (prefer clearer / fuller cards)
      score += Math.min(10, Math.floor(safeLen(c.offer.title) / 12));
      score += Math.min(10, Math.floor(safeLen(c.offer.customerBenefitText) / 14));
      score += Math.min(6, Math.floor(safeLen(c.offer.description) / 24));

      // Business metadata helps search/discovery
      if (safeLen(c.business.city) > 0) score += 2;
      if (safeLen(c.business.name) > 8) score += 2;

      return { c, score };
    })
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;

      // tie-breaker: newer issuedAt first
      const aIssued = new Date(a.c.issuedAt).getTime();
      const bIssued = new Date(b.c.issuedAt).getTime();
      return (Number.isNaN(bIssued) ? 0 : bIssued) - (Number.isNaN(aIssued) ? 0 : aIssued);
    })
    .map(({ c }) => c);
}

