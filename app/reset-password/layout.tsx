import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import type { ReactNode } from "react";

// The link's secret lives in the URL fragment; `no-referrer` keeps even the page URL out of any
// request this page makes to another origin.
// Tab title in the interface language (Hebrew source "בחירת סיסמה חדשה": lib/i18n/messages/he.ts → meta.titles.resetPassword).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.resetPassword"), referrer: "no-referrer" };
}

export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
