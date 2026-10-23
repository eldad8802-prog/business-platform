import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import type { ReactNode } from "react";

// Tab title in the interface language (Hebrew source "אימות כתובת האימייל": lib/i18n/messages/he.ts → meta.titles.verifyEmail).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.verifyEmail"), referrer: "no-referrer" };
}

export default function VerifyEmailLayout({ children }: { children: ReactNode }) {
  return children;
}
