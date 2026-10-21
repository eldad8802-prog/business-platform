import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import type { ReactNode } from "react";

// Tab title in the interface language (Hebrew source "שכחתי סיסמה": lib/i18n/messages/he.ts → meta.titles.forgotPassword).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.forgotPassword") };
}

export default function ForgotPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
