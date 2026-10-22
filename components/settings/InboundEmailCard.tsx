"use client";

import { useCallback, useEffect, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { MessageKey } from "@/lib/i18n/translate";

/**
 * "ייבוא מסמכים במייל" — the owner-facing settings surface.
 *
 * # What this screen is careful not to say
 *
 * It never tells the owner that mail is already arriving. The receiving side
 * does not exist yet, so a screen that said "forward invoices here" would be
 * promising a service that silently drops everything. The address is presented
 * as something to keep, and the copy stays in the future tense until intake is
 * real.
 *
 * All lifecycle decisions are the server's. This component renders what it is
 * told and asks for actions by name; it never computes whether an address is
 * still usable, because a second opinion about that is a second rule.
 */

type AddressView = {
  id: number;
  address: string | null;
  preview: string;
  status: "ACTIVE" | "RETIRING" | "REVOKED";
  graceUntil: string | null;
  expired: boolean;
};

type SenderView = {
  id: number;
  email: string;
  status: "PENDING_VERIFICATION" | "VERIFIED" | "REVOKED";
};

type Settings = {
  current: AddressView | null;
  retiring: AddressView[];
  senders: SenderView[];
  addressUnreadable: boolean;
  suggestedSenderEmail: string | null;
};

const SENDER_STATUS_LABEL: Record<SenderView["status"], MessageKey> = {
  PENDING_VERIFICATION: "account.settings.connections.inboundEmail.senderStatus.pending",
  VERIFIED: "account.settings.connections.inboundEmail.senderStatus.verified",
  REVOKED: "account.settings.connections.inboundEmail.senderStatus.revoked",
};

function formatDate(iso: string | null, locale: Locale): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(intlTag(locale), {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export function InboundEmailCard() {
  const { t, locale } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [senderEmail, setSenderEmail] = useState("");
  const [confirmRotate, setConfirmRotate] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/inbound-email/settings", { cache: "no-store" });
      if (!res.ok) {
        // 404 is what a disabled feature looks like from here.
        setSettings(null);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as Settings;
      setSettings(data);
      setSenderEmail((prev) => (prev.length > 0 ? prev : data.suggestedSenderEmail ?? ""));
    } catch {
      setError(t("account.settings.connections.inboundEmail.loadError"));
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? t("account.settings.connections.inboundEmail.actionFailed"));
        } else {
          await load();
        }
      } catch {
        setError(t("account.settings.connections.inboundEmail.actionFailed"));
      }
      setBusy(false);
    },
    [load, t]
  );

  if (loading) return null;
  // The feature is off, or unreachable. Say nothing rather than showing a
  // surface that cannot work.
  if (!settings) return null;

  const current = settings.current;

  return (
    <section className="rounded-2xl border border-black/10 bg-white p-4 shadow-sm">
      <h2 className="mb-1 text-base font-semibold">{t("account.settings.connections.inboundEmail.pageTitle")}</h2>
      <p className="mb-4 text-sm text-black/60">
        {t("account.settings.connections.inboundEmail.intro")}
      </p>

      {settings.addressUnreadable ? (
        <p className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">
          {t("account.settings.connections.inboundEmail.addressUnreadable")}
        </p>
      ) : null}

      {current ? (
        <div className="mb-4">
          <div className="mb-1 text-sm font-medium">{t("account.settings.connections.inboundEmail.addressLabel")}</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-xl bg-black/5 px-3 py-2 text-sm">
              {current.address ?? current.preview}
            </code>
            <button
              type="button"
              disabled={!current.address}
              className="shrink-0 rounded-xl border border-black/10 px-3 py-2 text-sm"
              onClick={() => {
                if (!current.address) return;
                void navigator.clipboard?.writeText(current.address);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? t("account.settings.connections.inboundEmail.copied") : t("account.settings.connections.inboundEmail.copy")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy || settings.addressUnreadable}
          className="mb-4 rounded-xl bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          onClick={() => void post("/api/inbound-email/address", { action: "initialize" })}
        >
          {t("account.settings.connections.inboundEmail.create")}
        </button>
      )}

      {settings.retiring.length > 0 ? (
        <div className="mb-4 space-y-2">
          <div className="text-sm font-medium">{t("account.settings.connections.inboundEmail.previous")}</div>
          {settings.retiring.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 rounded-xl bg-black/5 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm">{a.address ?? a.preview}</div>
                <div className="text-xs text-black/60">
                  {a.expired ? t("account.settings.connections.inboundEmail.expired") : t("account.settings.connections.inboundEmail.validUntil", { date: formatDate(a.graceUntil, locale) })}
                </div>
              </div>
              <button
                type="button"
                disabled={busy}
                className="shrink-0 rounded-lg border border-black/10 px-2 py-1 text-xs"
                onClick={() =>
                  void post("/api/inbound-email/address", { action: "revoke", addressId: a.id })
                }
              >
                {t("account.settings.connections.inboundEmail.revokeNow")}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {current ? (
        <div className="mb-6">
          {confirmRotate ? (
            <div className="rounded-xl border border-black/10 p-3">
              <p className="mb-2 text-sm">{t("account.settings.connections.inboundEmail.rotateNote")}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-xl bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  onClick={async () => {
                    await post("/api/inbound-email/address", { action: "rotate" });
                    setConfirmRotate(false);
                  }}
                >
                  {t("account.settings.connections.inboundEmail.rotateConfirm")}
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-black/10 px-3 py-1.5 text-sm"
                  onClick={() => setConfirmRotate(false)}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setConfirmRotate(true)}
            >
              {t("account.settings.connections.inboundEmail.rotate")}
            </button>
          )}
        </div>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t("account.settings.connections.inboundEmail.senders")}</h3>
        <div className="mb-3 flex gap-2">
          <input
            type="email"
            dir="ltr"
            value={senderEmail}
            onChange={(e) => setSenderEmail(e.target.value)}
            placeholder="name@example.com"
            className="flex-1 rounded-xl border border-black/10 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={busy || senderEmail.trim().length === 0}
            className="shrink-0 rounded-xl bg-black px-3 py-2 text-sm text-white disabled:opacity-50"
            onClick={() => void post("/api/inbound-email/senders", { action: "add", email: senderEmail })}
          >
            {t("account.settings.connections.inboundEmail.addSender")}
          </button>
        </div>

        {settings.senders.length === 0 ? (
          <p className="text-sm text-black/60">{t("account.settings.connections.inboundEmail.noSenders")}</p>
        ) : (
          <ul className="space-y-2">
            {settings.senders.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 rounded-xl bg-black/5 px-3 py-2"
              >
                <div className="min-w-0">
                  <div dir="ltr" className="truncate text-start text-sm">
                    {s.email}
                  </div>
                  <div className="text-xs text-black/60">{t(SENDER_STATUS_LABEL[s.status])}</div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-black/10 px-2 py-1 text-xs"
                  onClick={() =>
                    void post("/api/inbound-email/senders", { action: "revoke", senderId: s.id })
                  }
                >
                  {t("account.settings.connections.inboundEmail.revoke")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
    </section>
  );
}
