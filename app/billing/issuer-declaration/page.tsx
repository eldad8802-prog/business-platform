import { notFound } from "next/navigation";

import { isIssuerDeclarationEnabled } from "@/lib/billing/issuer-declaration/config";
import DeclarationScreen from "./declaration-screen";

/** The issuer declaration screen (#1081): details status, the statement, and "send me the confirmation link". OFF → 404. */
export const dynamic = "force-dynamic";

export default function IssuerDeclarationPage() {
  if (!isIssuerDeclarationEnabled()) notFound();
  return <DeclarationScreen />;
}
