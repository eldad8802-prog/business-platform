import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CustomerThreadScreen } from "@/components/collection/thread/customer-thread-screen";

export const metadata = { title: "תיק גבייה" };

export default async function CustomerCollectionThreadPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return (
    <Suspense fallback={null}>
      <CustomerThreadScreen customerId={id} />
    </Suspense>
  );
}
