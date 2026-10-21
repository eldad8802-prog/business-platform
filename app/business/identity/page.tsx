import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";

import { IdentityScreen } from "@/components/business/identity/landing/IdentityScreen";

// Tab title in the interface language (Hebrew source "הנוכחות הדיגיטלית של העסק": lib/i18n/messages/he.ts → meta.titles.identity).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.identity") };
}

/**
 * What Dubiz knows about the business, on its way to a future landing page. The canonical read
 * model is BusinessIdentityContext (P3-A); the screen re-organises it into four chapters and keeps
 * every authority rule: owner statements, separate public-use approval, re-validated suggestions,
 * internal-first trust claims. Nothing is published.
 */
export default function BusinessIdentityPage() {
  return <IdentityScreen />;
}
