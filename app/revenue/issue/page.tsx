import { redirect } from "next/navigation";

/**
 * Legacy issue screen — issuance is now folded into the creation flow
 * (the "published" moment inside the Marketing Center). Route old links there.
 */
export default function RevenueIssuePage() {
  redirect("/revenue");
}
