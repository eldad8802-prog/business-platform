import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CorporateHeader } from "@/components/corporate/CorporateHeader";
import { CorporateFooter } from "@/components/corporate/CorporateFooter";
import { marketingVars } from "@/components/corporate/marketing-tokens";
import { SkipLink } from "@/components/ui/accessibility";

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
  // Explicit machine-readable declaration of the application name, matching the
  // Google OAuth consent-screen app name. Renders <meta name="application-name">.
  applicationName: "Dubiz",
  description:
    "Dubiz מרכזת את היום־יום של העסק שלך — לקוחות, כסף ומסמכים — מהוואטסאפ, מהמייל ומהמסמכים שכבר יש לך. מופעל על ידי PRO MAX GROUP.",
};

export default function CorporateLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div
      style={marketingVars}
      className="flex min-h-screen flex-col bg-[var(--mkt-page)] text-[var(--mkt-ink)]"
    >
      {/*
        First focusable element on every public page, so a keyboard user can jump
        past the sticky header and the nav straight to the content. `SkipLink`
        already existed as a primitive but was mounted nowhere in `app/` — the
        public site is where it matters most (WCAG 2.4.1 Bypass Blocks).
      */}
      <SkipLink />
      <CorporateHeader />
      {/* tabIndex={-1} makes the skip target programmatically focusable — without
          it the browser moves the viewport but not the focus ring. */}
      <main id="main-content" tabIndex={-1} className="flex-1">
        {children}
      </main>
      <CorporateFooter />
    </div>
  );
}
