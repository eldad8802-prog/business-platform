import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { CollectionInboxScreen } from "@/components/collection/inbox/collection-inbox-screen";

// Tab title in the interface language (Hebrew source "גבייה": lib/i18n/messages/he.ts → meta.titles.collection).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.collection") };
}

export default function CollectionPage() {
  return <CollectionInboxScreen />;
}
