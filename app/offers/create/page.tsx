import { redirect } from "next/navigation";

/**
 * Legacy coupon-creation wizard — superseded by the new experience.
 * Creation now lives inside the Marketing Center (/revenue). Route old links there.
 */
export default function OfferCreatePage() {
  redirect("/revenue");
}
