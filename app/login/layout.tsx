import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import type { ReactNode } from "react";

// The login page is a client component and cannot export metadata; this server
// layout carries the tab title ("התחברות · Dubiz") and passes children through.
// Tab title in the interface language (Hebrew source "התחברות": lib/i18n/messages/he.ts → meta.titles.login).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.login") };
}

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
