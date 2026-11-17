import { notFound } from "next/navigation";

import { isIssuerDeclarationEnabled } from "@/lib/billing/issuer-declaration/config";
import ConfirmScreen from "./confirm-screen";

/**
 * Where the emailed link lands (`/billing/issuer-declaration/confirm#t=…`, lib/auth/email-link.ts). Opening it
 * changes nothing: the page reads the token from the fragment, asks what it is, shows the statement, and waits for
 * an explicit confirmation by the signed-in account. OFF → 404.
 */
export const dynamic = "force-dynamic";

export default function IssuerDeclarationConfirmPage() {
  if (!isIssuerDeclarationEnabled()) notFound();
  return <ConfirmScreen />;
}
