"use client";

/**
 * Logout control for Settings.
 *
 * Signing out ends THIS device's session on the server and only then clears
 * the local copy. It used to clear the local copy whatever the server said, so
 * a 500 or a dead network told the person they were signed out while the
 * server still honoured the session.
 *
 * Now a failed sign-out keeps the person signed in and says so, with two
 * choices: try again, or clear this device anyway — which is said to be
 * unconfirmed, and finished by the login screen once the server can be reached.
 *
 * The button is disabled while the request is in flight so a double click cannot
 * fire two revocations, and the copy says what is happening.
 */

import { useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import {
  forgetDeviceWithPendingRevoke,
  goToLoginAfterLocalClear,
  signOutAndRedirect,
  type SignOutOutcome,
} from "@/lib/client-session";

export function LogoutButton() {
  const { t } = useI18n();
  const [signingOut, setSigningOut] = useState(false);
  const [failure, setFailure] = useState<Extract<SignOutOutcome, "server_failed" | "offline"> | null>(null);

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    setFailure(null);
    const outcome = await signOutAndRedirect();
    if (outcome === "server_failed" || outcome === "offline") {
      // Still signed in, truthfully. Nothing local was cleared.
      setFailure(outcome);
      setSigningOut(false);
    }
  }

  function handleClearAnyway() {
    forgetDeviceWithPendingRevoke();
    goToLoginAfterLocalClear();
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={handleLogout}
        disabled={signingOut}
        aria-busy={signingOut}
        className="min-h-11 rounded-2xl bg-[var(--dz-app-chrome)] px-4 text-sm font-bold text-[var(--dz-text-on-brand)] disabled:opacity-70"
      >
        {signingOut
          ? t("account.settings.logout.signingOut")
          : failure
            ? t("account.settings.logout.retry")
            : t("account.settings.logout.label")}
      </button>
      {failure ? (
        <div role="alert" className="flex flex-col gap-2 text-sm leading-6 text-[var(--dz-text-muted)]">
          <p>
            {failure === "offline"
              ? t("account.settings.logout.failedOffline")
              : t("account.settings.logout.failedServer")}
          </p>
          <button
            type="button"
            onClick={handleClearAnyway}
            className="min-h-11 self-start rounded-2xl border border-[var(--dz-border)] px-4 text-sm font-bold"
          >
            {t("account.settings.logout.clearAnyway")}
          </button>
          <p className="text-xs">{t("account.settings.logout.clearAnywayHint")}</p>
        </div>
      ) : null}
    </div>
  );
}
