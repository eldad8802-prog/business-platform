"use client";

import { useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

/** The route's error codes → what the owner reads. */
const ERRORS: Record<string, MessageKey> = {
  source_not_enabled: "account.settings.connections.wix.errors.sourceNotEnabled",
  unavailable: "account.settings.connections.wix.errors.unavailable",
  instance_invalid: "account.settings.connections.wix.errors.instanceInvalid",
  app_not_installed: "account.settings.connections.wix.errors.appNotInstalled",
  wix_unavailable: "account.settings.connections.wix.errors.wixUnavailable",
  store_connected_to_another_business: "account.settings.connections.wix.errors.storeTaken",
};

/** The owner confirms binding the Wix store they just installed Dubiz on (signed `instance` from Wix). */
export function WixConnectConfirm({ instance }: { instance: string | null }) {
  const { t: tr } = useI18n();
  const [state, setState] = useState<"idle" | "busy" | "done" | "signin">("idle");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  async function connect() {
    setError(null);
    let t: string | null = null;
    try {
      t = localStorage.getItem("token");
    } catch {
      t = null;
    }
    if (!t) {
      setState("signin");
      return;
    }
    setState("busy");
    const res = await fetch("/api/integrations/commerce/wix", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ instance }),
      cache: "no-store",
    }).catch(() => null);
    const json = (await res?.json().catch(() => ({}))) as { error?: string; connection?: { label: string | null } };
    if (res?.status === 401) return setState("signin");
    if (!res?.ok) {
      setState("idle");
      const code = json.error ?? "";
      return setError(tr(Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : "account.settings.connections.wix.errors.generic"));
    }
    setName(json.connection?.label ?? null);
    setState("done");
  }

  if (!instance) {
    return <p className="text-sm text-[var(--dz-text-muted)]">{tr("account.settings.connections.wix.noInstance")}</p>;
  }
  return (
    <div className="space-y-3 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-4 text-sm">
      {state === "done" ? (
        <p className="text-[var(--dz-success)]">{name ? tr("account.settings.connections.wix.doneNamed", { name }) : tr("account.settings.connections.wix.done")}</p>
      ) : (
        <>
          <p className="text-[var(--dz-text-primary)]">{tr("account.settings.connections.wix.confirm")}</p>
          {state === "signin" && (
            <p className="text-[var(--dz-text-muted)]">
              {tr("account.settings.connections.wix.signinNeeded")}{" "}
              <a className="underline" href="/login" target="_blank" rel="noreferrer">{tr("account.settings.connections.wix.signinLink")}</a>{tr("account.settings.connections.wix.signinAfter")}
            </p>
          )}
          {error && <p className="text-[var(--dz-danger)]">{error}</p>}
          <button
            type="button"
            onClick={connect}
            disabled={state === "busy"}
            className="rounded-full bg-[var(--dz-text-primary)] px-4 py-1 text-xs font-bold text-[var(--dz-surface)] disabled:opacity-60"
          >
            {state === "busy" ? tr("account.settings.connections.wix.connecting") : tr("account.settings.connections.wix.connect")}
          </button>
        </>
      )}
    </div>
  );
}
