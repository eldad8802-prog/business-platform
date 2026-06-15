import { redirect } from "next/navigation";

export default function LegacyAddRedirect() {
  redirect("/inventory/supplier-purchases/new");
}
