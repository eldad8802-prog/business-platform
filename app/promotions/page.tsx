import { redirect } from "next/navigation";

/** Legacy "מבצעים" wrapper — superseded by the Marketing Center (/revenue). */
export default function PromotionsPage() {
  redirect("/revenue");
}
