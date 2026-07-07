/**
 * Coupon feature — client data layer (Stage 1 integration).
 * Wires the new design package to the EXISTING backend only. No new APIs.
 *   - GET  /api/revenue/coupons/active        (public marketplace list, ≤6 ranked)
 *   - GET  /api/revenue/coupons/[publicId]/code (token + qrValue)
 *   - POST /api/offers                        (createOffer — the builder's sentence)
 *   - POST /api/offers/[id]/coupon            (issue a coupon = "published")
 */

import type { PublicCoupon, CouponDraft, CatKey, CatFamily } from "@/components/coupon/coupon-model";
import { couponTitle } from "@/components/coupon/coupon-model";
import type { CouponThema } from "@/lib/design/coupon-consumer";

/** Business category → filter family (food / beauty / health / other). */
function categoryFamily(cat?: string, sub?: string, model?: string): CatFamily {
  const s = `${cat || ""} ${sub || ""} ${model || ""}`.toLowerCase();
  if (/food|restaurant|cafe|coffee|bakery|pizza|sushi|מסעד|קפה|אוכל|מאפ|פיצה|סושי|\bבר\b/.test(s)) return "food";
  if (/beaut|hair|cosmet|nails|barber|spa|ספר|תספורת|יופי|קוסמט|טיפוח|ציפור/.test(s)) return "beauty";
  if (/clinic|medical|health|fitness|gym|dental|physio|רפוא|קליניק|בריאות|כושר|טיפול|שיניים|פיזיו/.test(s)) return "health";
  return "other";
}
/** Family → celebratory thema + ticket icon. */
function visualForFamily(fam: CatFamily): { thema: CouponThema; cat: CatKey } {
  switch (fam) {
    case "food": return { thema: "orange", cat: "pizza" };
    case "beauty": return { thema: "pink", cat: "spark" };
    case "health": return { thema: "teal", cat: "activity" };
    default: return { thema: "purple", cat: "gem" };
  }
}

function fmtValid(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `תקף עד ${d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" })}`;
}

function getToken(): string | null {
  return typeof window !== "undefined" ? localStorage.getItem("token") : null;
}

/** Short human backup code from a token (display only). */
export function shortCode(token?: string | null): string {
  if (!token) return "";
  const clean = token.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const a = clean.slice(0, 4);
  const b = clean.slice(4, 8);
  return b ? `${a} · ${b}` : a;
}

type ActiveCard = {
  publicId: string;
  issuedAt: string;
  expiresAt: string;
  business: { id: number; name: string; city?: string; address?: string; phone?: string; category?: string; subCategory?: string; businessModel?: string; openingHours?: string };
  offer: { id: number; title: string; customerBenefitText: string; description: string | null; imageUrl: string | null };
  redemptionCount?: number;
  distanceKm?: number;
  distanceLabel?: string;
};

export type GeoPoint = { lat: number; lng: number };

/** Cross-business active coupons → design `PublicCoupon[]` (real business fields).
 *  `near` (opt-in) makes the server compute a real display distance per business. */
export async function fetchActiveCoupons(limit = 24, near?: GeoPoint | null): Promise<PublicCoupon[]> {
  try {
    const geo = near ? `&lat=${encodeURIComponent(near.lat)}&lng=${encodeURIComponent(near.lng)}` : "";
    const res = await fetch(`/api/revenue/coupons/active?limit=${limit}${geo}`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    const cards: ActiveCard[] = Array.isArray(data?.coupons) ? data.coupons : [];
    return cards.map((c) => {
      const fam = categoryFamily(c.business?.category, c.business?.subCategory, c.business?.businessModel);
      const vis = visualForFamily(fam);
      return {
        id: c.publicId,
        business: {
          name: c.business?.name || "עסק",
          city: c.business?.city || "",
          address: c.business?.address || "",
          hours: c.business?.openingHours || "",
          logo: (c.business?.name || "·").trim().charAt(0) || "·",
          thema: vis.thema,
          phone: c.business?.phone || undefined,
        },
        category: vis.cat,
        catFamily: fam,
        benefit: c.offer?.customerBenefitText || c.offer?.title || "הטבה",
        description: c.offer?.description || "",
        valid: fmtValid(c.expiresAt),
        expiresAt: c.expiresAt,
        popularity: c.redemptionCount ?? 0,
        distance: c.distanceLabel || undefined,
        distanceKm: typeof c.distanceKm === "number" ? c.distanceKm : undefined,
      };
    });
  } catch {
    return [];
  }
}

/** Public coupon status (drives the expired/redeemed states when opened directly). */
export async function fetchCouponStatus(publicId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/revenue/coupons/${publicId}`, { cache: "no-store" });
    if (!res.ok) return null;
    const d = await res.json();
    return d?.coupon?.status ?? null;
  } catch {
    return null;
  }
}

/** Token + QR for a coupon (used by "קבל קופון" / share). */
export async function fetchCouponCode(publicId: string): Promise<{ token: string; qrValue: string } | null> {
  try {
    const res = await fetch(`/api/revenue/coupons/${publicId}/code`, { cache: "no-store" });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d?.qrValue) return null;
    return { token: d.token, qrValue: d.qrValue };
  } catch {
    return null;
  }
}

export type PublishResult = {
  offerId?: number;
  publicId?: string;
  qrValue?: string;
  token?: string;
} | null;

function validityDays(v: string): number {
  if (v === "שבוע") return 7;
  if (v === "חודש") return 30;
  return 14; // שבועיים (default)
}

/**
 * Publish = createOffer (the composed sentence) → issue a coupon.
 * Everything the Builder/Terms built collapses into the existing fields:
 * `customerBenefitText`/`title`/`description`/`validUntil`. No new schema.
 */
export async function publishDraft(draft: CouponDraft): Promise<PublishResult> {
  const token = getToken();
  if (!token) return null;

  const until = new Date();
  until.setDate(until.getDate() + validityDays(draft.validity));
  until.setHours(23, 59, 59, 999);

  const benefit = couponTitle(draft);
  const descParts = [draft.description?.trim(), draft.conditions.length ? draft.conditions.join(" · ") : ""].filter(Boolean);
  const description = descParts.length ? descParts.join(" · ") : undefined;

  try {
    const offRes = await fetch("/api/offers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: benefit, customerBenefitText: benefit, description, validUntil: until.toISOString() }),
    });
    if (!offRes.ok) return null;
    const off = await offRes.json();
    const offerId: number | undefined = off?.offer?.id;
    if (!offerId) return null;

    const cpRes = await fetch(`/api/offers/${offerId}/coupon`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!cpRes.ok) return { offerId };
    const cp = await cpRes.json();
    return {
      offerId,
      publicId: cp?.coupon?.publicId,
      qrValue: cp?.coupon?.qrValue,
      token: cp?.coupon?.token,
    };
  } catch {
    return null;
  }
}
