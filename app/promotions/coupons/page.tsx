import { redirect } from "next/navigation";

/** Legacy coupons list — superseded by the Marketing Center (/revenue). */
export default function CouponsHomePage() {
  redirect("/revenue");
}
