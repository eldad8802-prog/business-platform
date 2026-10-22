import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CustomerThreadScreen } from "@/components/collection/thread/customer-thread-screen";

// Tab title in the interface language (Hebrew source "תיק גבייה": lib/i18n/messages/he.ts → meta.titles.collectionThread).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.collectionThread") };
}

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
