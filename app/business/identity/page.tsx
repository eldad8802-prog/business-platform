import type { Metadata } from "next";

import { IdentityScreen } from "@/components/business/identity/landing/IdentityScreen";

export const metadata: Metadata = { title: "הנוכחות הדיגיטלית של העסק" };

/**
 * What Dubiz knows about the business, on its way to a future landing page. The canonical read
 * model is BusinessIdentityContext (P3-A); the screen re-organises it into four chapters and keeps
 * every authority rule: owner statements, separate public-use approval, re-validated suggestions,
 * internal-first trust claims. Nothing is published.
 */
export default function BusinessIdentityPage() {
  return <IdentityScreen />;
}
