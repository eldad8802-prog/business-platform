import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { Suspense } from "react";
import { CollectionCreateScreen } from "@/components/collection/new/collection-create-screen";

// Tab title in the interface language (Hebrew source "גבייה חדשה": lib/i18n/messages/he.ts → meta.titles.collectionNew).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.collectionNew") };
}

export default function CollectionNewPage() {
  return (
    <Suspense fallback={null}>
      <CollectionCreateScreen />
    </Suspense>
  );
}
