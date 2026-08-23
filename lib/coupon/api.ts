/**
 * Coupon feature — client data layer.
 *
 *   - GET  /api/revenue/coupons/active          (public marketplace list, ranked)
 *   - GET  /api/revenue/coupons/[publicId]      (public coupon status)
 *   - GET  /api/revenue/coupons/[publicId]/code (issuer-only token + QR)
 *   - GET  /api/revenue/coupons/mine            (owner's coupons)
 *   - GET  /api/revenue/coupons/my-business     (owner's real identity)
 *   - POST /api/revenue/coupons                 (atomic publish)
 *   - POST /api/revenue/coupons/[publicId]/disable | /enable
 *
 * Every mutation here returns a discriminated outcome rather than a value that
 * happens to be truthy. `publishDraft` used to `return { offerId }` when the
 * coupon call failed — a truthy object the wizard read as success (COUPON-01).
 */

import type { PublicCoupon, CouponDraft, CatKey, CatFamily } from "@/components/coupon/coupon-model";
import { categoryFamily } from "@/components/coupon/coupon-model";
import type { CouponThema } from "@/lib/design/coupon-consumer";

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

function authHeaders(json = false): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Human backup code (COUPON-04 / Phase 4).
 *
 * The coupon's real code IS its `token` — a server-generated UUID, unique by
 * database constraint, never chosen by the business. This renders the first 8
 * characters as two upper-case groups for reading aloud at a counter. It is a
 * *display* of the token, not a second identifier: redemption always takes the
 * full token, so there is no shorter string that could collide.
 */
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

/** Cross-business active coupons → design `PublicCoupon[]` (real business fields). */
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
          // Real values or null — never a plausible-looking stand-in (COUPON-04).
          name: c.business?.name || null,
          city: c.business?.city || null,
          address: c.business?.address || null,
          hours: c.business?.openingHours || null,
          logo: (c.business?.name || "·").trim().charAt(0) || "·",
          thema: vis.thema,
          phone: c.business?.phone || null,
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

/** Token + QR for a coupon. Issuer-only server-side; non-issuers resolve to null. */
export async function fetchCouponCode(publicId: string): Promise<{ token: string; qrValue: string } | null> {
  try {
    const res = await fetch(`/api/revenue/coupons/${publicId}/code`, {
      cache: "no-store",
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d?.qrValue) return null;
    return { token: d.token, qrValue: d.qrValue };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------ owner identity ---- */

export type BusinessIdentity = {
  id: number;
  name: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  openingHours: string | null;
  category: string | null;
  subCategory: string | null;
  businessModel: string | null;
  nameMissing: boolean;
  incomplete: string[];
};

export async function fetchMyBusiness(): Promise<BusinessIdentity | null> {
  try {
    const res = await fetch("/api/revenue/coupons/my-business", {
      cache: "no-store",
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d?.business ?? null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- my coupons ----- */

export type MyCoupon = {
  publicId: string;
  benefit: string;
  description: string | null;
  state: "ACTIVE" | "REDEEMED" | "EXPIRED" | "DISABLED";
  issuedAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  createdAt: string;
  offerId: number;
  redemptionCount: number;
};

/** Distinguishes "no coupons yet" from "could not load" so the UI can say which. */
export type MyCouponsOutcome =
  | { ok: true; coupons: MyCoupon[] }
  | { ok: false; message: string };

export async function fetchMyCoupons(): Promise<MyCouponsOutcome> {
  try {
    const res = await fetch("/api/revenue/coupons/mine", {
      cache: "no-store",
      headers: authHeaders(),
    });
    if (res.status === 401) return { ok: false, message: "יש להתחבר כדי לראות את הקופונים שלך" };
    if (!res.ok) return { ok: false, message: "לא הצלחנו לטעון את הקופונים שלך" };
    const d = await res.json();
    return { ok: true, coupons: Array.isArray(d?.coupons) ? d.coupons : [] };
  } catch {
    return { ok: false, message: "אין חיבור לשרת" };
  }
}

export type MutationOutcome =
  | { ok: true; state: MyCoupon["state"] }
  | {
      ok: false;
      message: string;
      /**
       * True when the SERVER answered and refused (e.g. "הקופון כבר מומש"),
       * false when the request never got there.
       *
       * The distinction matters: a server refusal means our on-screen state is
       * provably stale and should be re-read immediately. A network failure
       * means the opposite — re-reading would fail too, and would replace a
       * precise per-coupon message with an empty list and a generic error.
       */
      serverResponded: boolean;
    };

async function couponAction(publicId: string, action: "disable" | "enable"): Promise<MutationOutcome> {
  try {
    const res = await fetch(`/api/revenue/coupons/${publicId}/${action}`, {
      method: "POST",
      headers: authHeaders(),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: d?.error || "הפעולה נכשלה", serverResponded: true };
    }
    return { ok: true, state: d.state };
  } catch {
    return { ok: false, message: "אין חיבור לשרת", serverResponded: false };
  }
}

export const disableCoupon = (publicId: string) => couponAction(publicId, "disable");
export const enableCoupon = (publicId: string) => couponAction(publicId, "enable");

/* ------------------------------------------------------------- publish ---- */

export type PublishedCoupon = {
  offerId: number;
  publicId: string;
  token: string;
  qrValue: string;
  benefit: string;
  description: string | null;
  expiresAt: string;
  status: "ACTIVE";
};

/**
 * A publish either fully happened or did not happen at all. There is no partial
 * outcome to represent, because the server writes the Offer and the Coupon in
 * one transaction.
 */
export type PublishOutcome =
  | { ok: true; coupon: PublishedCoupon }
  | { ok: false; message: string; fields?: { field: string; message: string }[] };

export type PublishResult = PublishOutcome;

export async function publishDraft(draft: CouponDraft): Promise<PublishOutcome> {
  if (!getToken()) {
    return { ok: false, message: "יש להתחבר כדי לפרסם קופון" };
  }

  // Only an owner-authored title is sent. If they never touched the field — or
  // typed something and then cleared it — this is empty and the server composes
  // the canonical sentence itself.
  const title = draft.titleEdited ? draft.title.trim() : "";

  try {
    const res = await fetch("/api/revenue/coupons", {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        benefitType: draft.benefitType,
        value: draft.value,
        scope: draft.scope,
        title,
        description: draft.description,
        minPurchaseEnabled: draft.minPurchaseEnabled,
        minPurchase: draft.minPurchase,
        newCustomersOnly: draft.newCustomersOnly,
        validUntilDate: draft.validUntilDate,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return {
        ok: false,
        message: data?.error || "פרסום הקופון נכשל",
        fields: Array.isArray(data?.fields) ? data.fields : undefined,
      };
    }

    if (!data?.coupon?.publicId) {
      // Defensive: a 2xx without a coupon is a contract violation, not a success.
      return { ok: false, message: "פרסום הקופון נכשל" };
    }

    return { ok: true, coupon: data.coupon as PublishedCoupon };
  } catch {
    return { ok: false, message: "אין חיבור לשרת. הקופון לא פורסם." };
  }
}
