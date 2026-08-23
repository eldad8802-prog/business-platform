import { redirect } from "next/navigation";

/**
 * Legacy offers list — superseded by "הקופונים שלי" (/revenue).
 *
 * Every other legacy coupon surface (`/offers/create`, `/promotions`,
 * `/promotions/coupons`, `/revenue/issue`) already redirects here; this one was
 * missed and stayed reachable by direct URL. It was the only UI able to mint
 * additional coupons onto an existing offer via the legacy issue endpoint,
 * which is how one offer could end up with several live tokens the owner's
 * management screen treated as unrelated rows.
 *
 * The old screen is kept alongside as `page.legacy-list.tsx` (not a routable
 * filename) rather than deleted, so nothing is lost.
 */
export default function OffersPage() {
  redirect("/revenue");
}
