import { prisma } from "@/lib/prisma";
import { UnauthorizedError, NotFoundError } from "@/lib/errors";

/**
 * The issuing business as it appears on its own coupon (COUPON-04).
 *
 * The wizard's live preview used to render a hardcoded demo identity —
 * "העסק שלך" / "הכתובת שלך" / "תל אביב" / "א׳–ה׳ 8:00–18:00" — which looked
 * exactly like production data and would have been printed onto a real coupon.
 * This reads the canonical identity instead: `Business.name` plus the public
 * fields of `BusinessProfile`.
 *
 * Absent fields come back as `null`, never as invented text. The UI hides what
 * is null; `nameMissing` is what gates publishing, because a coupon with no
 * business name on it is not something a customer can act on.
 */

export type CouponBusinessIdentity = {
  id: number;
  name: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  openingHours: string | null;
  category: string | null;
  subCategory: string | null;
  businessModel: string | null;
  /** Publishing is blocked while true — the one genuinely required field. */
  nameMissing: boolean;
  /** Fields the owner could still fill in, surfaced as a soft nudge. */
  incomplete: string[];
};

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function getCouponBusinessIdentity(
  businessId: number
): Promise<CouponBusinessIdentity> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new UnauthorizedError();
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      profile: {
        select: {
          city: true,
          openingHours: true,
          billingAddress: true,
          billingPhone: true,
          category: true,
          subCategory: true,
          businessModel: true,
        },
      },
    },
  });

  if (!business) {
    throw new NotFoundError("Business not found");
  }

  const profile = business.profile;
  const name = clean(business.name);
  const city = clean(profile?.city);
  const address = clean(profile?.billingAddress);
  const openingHours = clean(profile?.openingHours);

  const incomplete: string[] = [];
  if (!city) incomplete.push("city");
  if (!address) incomplete.push("address");
  if (!openingHours) incomplete.push("openingHours");

  return {
    id: business.id,
    name,
    city,
    address,
    phone: clean(profile?.billingPhone),
    openingHours,
    category: clean(profile?.category),
    subCategory: clean(profile?.subCategory),
    businessModel: clean(profile?.businessModel),
    nameMissing: name === null,
    incomplete,
  };
}
