import { redirect } from "next/navigation";

/** Legacy: creating a collection happens at /collection/new (customer-first). */
export default async function PaymentsNewRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const key of ["customerId", "invoiceId"]) {
    const v = sp[key];
    if (typeof v === "string" && /^\d+$/.test(v)) qs.set(key, v);
  }
  const suffix = qs.toString();
  redirect(`/collection/new${suffix ? `?${suffix}` : ""}`);
}
