"use client";

import { useCallback, useEffect, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import {
  WarmButton,
  WarmCard,
  WarmPill,
  type WarmPillTone,
} from "@/components/ui/warm/warm-primitives";
import { ComingSoonPill } from "@/components/ui/coming-soon/ComingSoonPill";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { MessageKey } from "@/lib/i18n/translate";

/**
 * Israel Tax Authority ("חשבוניות ישראל") connection card — Settings › Connections.
 *
 * Exposes and drives the existing, untouched OAuth mechanism:
 *   GET /api/taxes/authority/status              → safe connection DTO (no secrets)
 *   GET /api/taxes/oauth/connect (JSON mode)     → { authorizeUrl } to navigate to ITA
 *
 * Connect/reconnect follows the app's canonical OAuth-start pattern (same as
 * Gmail): fetch our own connect route in JSON mode — which authenticates via the
 * Bearer token and sets the OAuth state cookies on the response — then do a full
 * browser navigation to the returned ITA authorize URL. No OAuth redirect is
 * ever fetched or parsed here.
 *
 * States: not-configured (quiet) · disconnected · connected · expired/revoked/error.
 * No secrets or tokens are ever rendered.
 */

const W = TOKEN.warm;

type UiStatus =
  | "NOT_CONFIGURED"
  | "DISCONNECTED"
  | "CONNECTED"
  | "EXPIRED"
  | "REVOKED"
  | "ERROR";

type AuthorityStatusDto = {
  environment: "SANDBOX" | "PRODUCTION";
  status: UiStatus;
  connectedAt: string | null;
  expiresAt: string | null;
  canConnect: boolean;
  canReconnect: boolean;
};

function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

const STATUS_LABEL: Record<UiStatus, MessageKey> = {
  NOT_CONFIGURED: "account.settings.connections.authority.status.notConfigured",
  DISCONNECTED: "account.settings.connections.authority.status.disconnected",
  CONNECTED: "account.settings.connections.authority.status.connected",
  EXPIRED: "account.settings.connections.authority.status.expired",
  REVOKED: "account.settings.connections.authority.status.revoked",
  ERROR: "account.settings.connections.authority.status.error",
};

const STATUS_TONE: Record<UiStatus, WarmPillTone> = {
  NOT_CONFIGURED: "waiting",
  DISCONNECTED: "waiting",
  CONNECTED: "verified",
  EXPIRED: "late",
  REVOKED: "late",
  ERROR: "late",
};

const ENVIRONMENT_LABEL: Record<AuthorityStatusDto["environment"], string> = {
  SANDBOX: "Sandbox",
  PRODUCTION: "Production",
};

function formatDate(iso: string | null, locale: Locale): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(intlTag(locale), {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}

/** Pure read of the one-time OAuth callback result from the URL (no mutation). */
function getCallbackResultFromUrl(): "connected" | "error" | null {
  if (typeof window === "undefined") return null;
  const result = new URLSearchParams(window.location.search).get("authority");
  return result === "connected" || result === "error" ? result : null;
}

/** Strips the one-time callback params from the URL (idempotent side effect). */
function cleanCallbackParamsFromUrl(): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("authority") && !params.has("reason")) return;
  params.delete("authority");
  params.delete("reason");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    window.location.pathname + (query ? `?${query}` : "") + window.location.hash
  );
}

export function AuthorityConnectionCard() {
  const { t, locale } = useI18n();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<AuthorityStatusDto | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // Initial notice/error are derived once from the OAuth callback result in the
  // URL (pure read). The URL itself is cleaned in the mount effect below.
  const [error, setError] = useState<string | null>(() =>
    getCallbackResultFromUrl() === "error"
      ? t("account.settings.connections.authority.callbackError")
      : null
  );
  const [notice, setNotice] = useState<string | null>(() =>
    getCallbackResultFromUrl() === "connected"
      ? t("account.settings.connections.authority.callbackConnected")
      : null
  );

  const load = useCallback(async () => {
    // No synchronous setState here — the card mounts in its loading state and
    // every state write below happens after the fetch resolves.
    try {
      const token = getAuthToken();
      const res = await fetch("/api/taxes/authority/status", {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
      });
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        authority?: AuthorityStatusDto;
      };
      if (data.authority) {
        setStatus(data.authority);
      } else {
        setLoadFailed(true);
      }
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    cleanCallbackParamsFromUrl();
    void load();
  }, [load]);

  async function startConnect() {
    if (connecting) return;
    setConnecting(true);
    setError(null);
    setNotice(null);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/taxes/oauth/connect", {
        headers: {
          accept: "application/json",
          "x-authority-connect-mode": "json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      const data = (await res.json().catch(() => ({}))) as {
        authorizeUrl?: string;
        error?: string;
      };
      if (!res.ok || !data.authorizeUrl) {
        throw new Error(data.error || t("account.settings.connections.authority.openFailed"));
      }
      // Full browser navigation to the ITA authorize URL (not fetched/parsed).
      window.location.href = data.authorizeUrl;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("account.settings.connections.authority.connectError")
      );
      setConnecting(false);
    }
  }

  const uiStatus = status?.status ?? null;
  const showConnect = status?.canConnect ?? false;
  const showReconnect = status?.canReconnect ?? false;
  const isNotConfigured = uiStatus === "NOT_CONFIGURED" || loadFailed;
  const connectedDate = formatDate(status?.connectedAt ?? null, locale);
  const expiresDate = formatDate(status?.expiresAt ?? null, locale);

  return (
    <WarmCard padding={18}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <h3
              style={{
                margin: 0,
                fontSize: 15,
                fontWeight: TOKEN.weight.semibold,
                color: W.ink,
              }}
            >
              {t("account.settings.connections.authority.title")}
            </h3>
            <p style={{ margin: 0, fontSize: 12.5, color: W.muted, lineHeight: 1.5 }}>
              {t("account.settings.connections.authority.description")}
            </p>
          </div>
          {/* Not configured reads "בקרוב", like the connect buttons it stands in for. */}
          {!loading && uiStatus === "NOT_CONFIGURED" && !loadFailed ? (
            <ComingSoonPill />
          ) : !loading && uiStatus && !loadFailed ? (
            <WarmPill tone={STATUS_TONE[uiStatus]}>
              {t(STATUS_LABEL[uiStatus])}
            </WarmPill>
          ) : null}
        </div>

        {loading ? (
          <p style={{ margin: 0, fontSize: 13, color: W.muted2 }}>{t("common.loading")}</p>
        ) : isNotConfigured ? (
          <p style={{ margin: 0, fontSize: 13, color: W.muted, lineHeight: 1.6 }}>
            {t("account.settings.connections.authority.notConfigured")}
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {uiStatus === "CONNECTED" || uiStatus === "EXPIRED" ? (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "4px 18px",
                  fontSize: 12.5,
                  color: W.muted,
                }}
              >
                {status ? (
                  <span>
                    {t("account.settings.connections.authority.environment")}{" "}
                    <span style={{ color: W.ink }}>
                      {ENVIRONMENT_LABEL[status.environment]}
                    </span>
                  </span>
                ) : null}
                {connectedDate ? <span>{t("account.settings.connections.authority.connectedOn", { date: connectedDate })}</span> : null}
                {expiresDate ? <span>{t("account.settings.connections.authority.validUntil", { date: expiresDate })}</span> : null}
              </div>
            ) : null}

            {uiStatus === "REVOKED" || uiStatus === "ERROR" ? (
              <p
                style={{ margin: 0, fontSize: 12.5, color: W.muted, lineHeight: 1.6 }}
              >
                {uiStatus === "REVOKED"
                  ? t("account.settings.connections.authority.revokedBody")
                  : t("account.settings.connections.authority.errorBody")}
              </p>
            ) : null}

            {/* The Tax Authority connection is not open yet: its buttons stay, inactive, marked "בקרוב". */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {showConnect ? (
                <WarmButton height={42} onClick={startConnect} disabled>
                  {t("account.settings.connections.authority.connect")}
                </WarmButton>
              ) : null}
              {showReconnect ? (
                <WarmButton height={42} onClick={startConnect} disabled>
                  {t("account.settings.connections.authority.reconnect")}
                </WarmButton>
              ) : null}
              {showConnect || showReconnect ? <ComingSoonPill /> : null}
            </div>
          </div>
        )}

        {notice ? (
          <p style={{ margin: 0, fontSize: 12.5, color: W.tealDeep }}>{notice}</p>
        ) : null}
        {error ? (
          <p style={{ margin: 0, fontSize: 12.5, color: W.clay }}>{error}</p>
        ) : null}
      </div>
    </WarmCard>
  );
}
