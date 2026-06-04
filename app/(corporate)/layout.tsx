import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CorporateHeader } from "@/components/corporate/CorporateHeader";
import { CorporateFooter } from "@/components/corporate/CorporateFooter";

/**
 * Nested layout for the Dubiz Corporate / Marketing area.
 *
 * This is NOT a root layout — the global <html>/<body>, fonts and RTL
 * direction come from app/layout.tsx. This layout only adds the public
 * marketing chrome (header + footer) and is fully isolated from the
 * authenticated app shell, login, auth, and existing routes.
 */
export const metadata: Metadata = {
  title: { default: "Dubiz", template: "%s · Dubiz" },
  description:
    "Dubiz — מערכת ההפעלה לעסק שלך. שיחות, מסמכים, חשבוניות, מלאי ותובנות במקום אחד. מופעל על ידי PRO MAX GROUP.",
};

export default function CorporateLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-[#f8f6f1] text-[#1f2937]">
      <CorporateHeader />
      <main className="flex-1">{children}</main>
      <CorporateFooter />
    </div>
  );
}
