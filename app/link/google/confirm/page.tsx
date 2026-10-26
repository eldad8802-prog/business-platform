import { notFound } from "next/navigation";

import { isGoogleLoginEnabled } from "@/lib/auth/google-oauth";
import GoogleLinkConfirm from "./google-link-confirm";

/**
 * "Continue with Google", milestone 3 — where the emailed link lands (`/link/google/confirm#t=…`). Opening it
 * changes NOTHING: the page reads the token from the URL fragment (never sent to a server in a URL), asks the
 * server what it is, and waits for an explicit click — and that click links only in the browser holding the
 * Google ticket the link was requested under. A mail scanner opening the link links nothing. OFF → 404.
 */
export const dynamic = "force-dynamic";

export default function GoogleLinkConfirmPage() {
  if (!isGoogleLoginEnabled()) notFound();
  return <GoogleLinkConfirm />;
}
