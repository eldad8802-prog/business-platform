import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import type { ReactNode } from "react";

// Metadata-only wrapper for the home section so the browser tab reads
// "בית · Dubiz". The home page itself is a client component and cannot export
// metadata; this server layout carries the title and passes children through
// unchanged (no chrome — the (shell) layout already provides it).
// Tab title in the interface language (Hebrew source "בית": lib/i18n/messages/he.ts → meta.titles.home).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.home") };
}

export default function HomeSectionLayout({ children }: { children: ReactNode }) {
  return children;
}
