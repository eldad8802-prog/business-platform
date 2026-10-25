import { notFound } from "next/navigation";

import { isGoogleLoginEnabled } from "@/lib/auth/google-oauth";
import GoogleDone from "./google-done";

/**
 * Where a linked Google sign-in lands: the callback set the httpOnly refresh cookie (the URL never carries a
 * token); this page turns it into the stored session and continues to the app. OFF → 404.
 */
export const dynamic = "force-dynamic";

export default function GoogleDonePage() {
  if (!isGoogleLoginEnabled()) notFound();
  return <GoogleDone />;
}
