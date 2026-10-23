import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import type { ReactNode } from "react";

// The register page is a client component and cannot export metadata; this
// server layout carries the tab title ("הרשמה · Dubiz") and passes children.
// Tab title in the interface language (Hebrew source "הרשמה": lib/i18n/messages/he.ts → meta.titles.register).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.register") };
}

export default function RegisterLayout({ children }: { children: ReactNode }) {
  return children;
}
