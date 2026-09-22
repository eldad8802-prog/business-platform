import { redirect } from "next/navigation";

/** Legacy: the collection product lives at /collection. */
export default function PaymentsIndexRedirect() {
  redirect("/collection");
}
