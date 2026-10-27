import { notFound } from "next/navigation";

import { isGoogleLoginEnabled } from "@/lib/auth/google-oauth";
import GoogleLinkForm from "./google-link-form";

/**
 * "Continue with Google", milestone 3 — the person came back from Google with the address of an EXISTING,
 * unlinked Dubiz account. Nothing is linked and nobody is signed in: this screen asks for proof that they own
 * the account (its password, or a single-use link to its inbox). Only the LINK ticket in this browser's
 * httpOnly cookie exists until then. OFF → 404.
 */
export const dynamic = "force-dynamic";

export default function GoogleLinkPage() {
  if (!isGoogleLoginEnabled()) notFound();
  return <GoogleLinkForm />;
}
