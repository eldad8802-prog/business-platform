"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Locale } from "@/lib/i18n/config";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

import { Action, Field, stamp } from "./LeadSourcesPanel";

/**
 * Settings → Connections → "חנויות ושיחות" (M7-B / M7-C).
 *
 * The owner connects their online store (WooCommerce, Wix) and their phone system (CloudTalk, Voicenter):
 * orders and calls appear in Dubiz next to the customer — an order is never a lead, a call is not automatically
 * a lead, nothing moves stock, payments or documents. Everything goes through /api/integrations/*; no key,
 * secret or token is ever shown back (Voicenter's address is shown ONCE, right after it is created; CloudTalk's
 * secret and API key are typed in and only "saved" is ever shown).
 *
 * A source that is not switched on for the business is shown as "coming soon", and Wix is connectable only when
 * the Dubiz Wix app is configured — never a button that cannot work.
 */

type SourceKey = "commerce.woocommerce" | "commerce.wix" | "telephony.cloudtalk" | "telephony.voicenter";
type Connection = {
  id: number;
  sourceKey: string;
  status: "ACTIVE" | "PAUSED" | "ERROR" | "REVOKED";
  label: string | null;
  keyHint: string | null;
  lastEventAt: string | null;
  lastErrorCode: string | null;
  endpointUrl: string | null;
  activity: { lastTestAt: string | null; lastDeliveryAt: string | null; deliveries30d: number } | null;
  /** CloudTalk: which of its two values the owner has saved (flags only). */
  setup: { signingSecret: boolean; apiKey: boolean } | null;
  /** M7-C — the owner's names for their own phone lines ({"<digits>": "<name>"}). */
  lineLabels?: Record<string, string> | null;
};
type Overview = {
  sources: Record<string, boolean>;
  wix?: { available: boolean; installUrl: string | null };
  connections: Connection[];
};

const SOURCES: { key: SourceKey; title: MessageKey; description: MessageKey; none: MessageKey }[] = [
  { key: "commerce.woocommerce", title: "account.settings.connections.stores.sources.woocommerce.title", description: "account.settings.connections.stores.sources.woocommerce.description", none: "account.settings.connections.stores.noOrderYet" },
  { key: "commerce.wix", title: "account.settings.connections.stores.sources.wix.title", description: "account.settings.connections.stores.sources.wix.description", none: "account.settings.connections.stores.noOrderYet" },
  { key: "telephony.cloudtalk", title: "account.settings.connections.stores.sources.cloudtalk.title", description: "account.settings.connections.stores.sources.calls.description", none: "account.settings.connections.stores.noCallYet" },
  { key: "telephony.voicenter", title: "account.settings.connections.stores.sources.voicenter.title", description: "account.settings.connections.stores.sources.calls.description", none: "account.settings.connections.stores.noCallYet" },
];

const STATUS: Record<Connection["status"], { label: MessageKey; tone: string }> = {
  ACTIVE: { label: "account.settings.connections.stores.status.active", tone: "bg-[var(--dz-success-bg-soft)] text-[var(--dz-success)]" },
  PAUSED: { label: "account.settings.connections.stores.status.paused", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
  ERROR: { label: "account.settings.connections.stores.status.error", tone: "bg-[var(--dz-danger-bg-soft)] text-[var(--dz-danger)]" },
  REVOKED: { label: "account.settings.connections.stores.status.revoked", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
};

/** What the owner can do about a provider-side problem (lastErrorCode → plain words). */
const HEALTH: Record<string, MessageKey> = {
  WOO_KEYS_REVOKED: "account.settings.connections.stores.health.wooKeysRevoked",
  WOO_STORE_UNREACHABLE: "account.settings.connections.stores.health.wooUnreachable",
  WOO_STORE_ERROR: "account.settings.connections.stores.health.wooError",
  WOO_WEBHOOK_SETUP_FAILED: "account.settings.connections.stores.health.wooWebhookSetupFailed",
  WOO_RECONCILE_FAILED: "account.settings.connections.stores.health.reconcileFailed",
  WIX_APP_UNINSTALLED: "account.settings.connections.stores.health.wixUninstalled",
  WIX_RECONCILE_FAILED: "account.settings.connections.stores.health.reconcileFailed",
};

const ERRORS: Record<string, MessageKey> = {
  source_not_enabled: "account.settings.connections.stores.errors.sourceNotEnabled",
  unavailable: "account.settings.connections.stores.errors.unavailable",
  invalid_store_url: "account.settings.connections.stores.errors.invalidStoreUrl",
  signing_secret_invalid: "account.settings.connections.stores.errors.signingSecretInvalid",
  api_key_invalid: "account.settings.connections.stores.errors.apiKeyInvalid",
  nothing_to_set: "account.settings.connections.stores.errors.nothingToSet",
};

const has = (map: Record<string, MessageKey>, code: string | null | undefined): code is string =>
  !!code && Object.prototype.hasOwnProperty.call(map, code);

async function api<T>(tr: Translator, path: string, body?: unknown): Promise<T> {
  let t: string | null = null;
  try {
    t = localStorage.getItem("token");
  } catch {
    t = null;
  }
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(tr(has(ERRORS, json.error) ? ERRORS[json.error] : "account.settings.connections.common.genericError"));
  return json;
}

function when(c: Connection, none: MessageKey, t: Translator, locale: Locale): string {
  const last = c.activity?.lastDeliveryAt ?? c.lastEventAt;
  if (!last) return t(none);
  const n = c.activity?.deliveries30d ?? 0;
  const at = stamp(last, locale);
  return n > 0 ? t("account.settings.connections.stores.lastUpdateWithCount", { at, count: n }) : t("account.settings.connections.stores.lastUpdate", { at });
}

export function StoresAndCallsPanel() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [storeUrl, setStoreUrl] = useState("");
  const [voicenterUrl, setVoicenterUrl] = useState<{ connectionId: number; url: string } | null>(null);

  const load = useCallback(() => api<Overview>(t, "/api/integrations/acquisition").then(setData, (e: unknown) => setError(e instanceof Error ? e.message : t("account.settings.connections.stores.loadError"))), [t]);
  useEffect(() => {
    let live = true;
    api<Overview>(t, "/api/integrations/acquisition").then(
      (d) => live && setData(d),
      (e: unknown) => live && setError(e instanceof Error ? e.message : t("account.settings.connections.stores.loadError"))
    );
    return () => {
      live = false;
    };
  }, [t]);

  async function run(tag: string, fn: () => Promise<void>) {
    setBusy(tag);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("account.settings.connections.common.genericError"));
    } finally {
      setBusy(null);
    }
  }

  const connectWoo = () =>
    run("create:woo", async () => {
      if (!storeUrl.trim()) throw new Error(t(ERRORS.invalid_store_url));
      const r = await api<{ authorizeUrl: string }>(t, "/api/integrations/commerce/woocommerce", { storeUrl: storeUrl.trim() });
      window.location.assign(r.authorizeUrl);
    });

  const createLine = (sourceKey: "telephony.cloudtalk" | "telephony.voicenter") =>
    run(`create:${sourceKey}`, async () => {
      const r = await api<{ connection: Connection; key?: string }>(t, "/api/integrations/acquisition", { sourceKey });
      if (sourceKey === "telephony.voicenter" && r.connection.endpointUrl) setVoicenterUrl({ connectionId: r.connection.id, url: r.connection.endpointUrl });
    });

  const act = (c: Connection, action: "pause" | "resume" | "revoke" | "rotate") =>
    run(`${action}:${c.id}`, async () => {
      if (action === "revoke" && !window.confirm(t("account.settings.connections.stores.confirmRevoke"))) return;
      if (action === "rotate" && !window.confirm(t("account.settings.connections.stores.confirmRotate"))) return;
      const r = await api<{ connection: Connection; key?: string }>(t, `/api/integrations/acquisition/${c.id}`, { action });
      if (r.key && r.connection.endpointUrl) setVoicenterUrl({ connectionId: c.id, url: r.connection.endpointUrl.replace("<key>", r.key) });
    });

  if (!data) {
    return (
      <section className="rounded-[24px] dz-mist p-4 shadow-sm">
        <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.stores.title")}</h2>
        <p className="mt-1 text-xs text-[var(--dz-text-muted)]">{error ?? t("common.loading")}</p>
      </section>
    );
  }

  return (
    <section className="rounded-[24px] dz-mist p-4 shadow-sm md:col-span-2">
      <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.stores.title")}</h2>
      <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
        {t("account.settings.connections.stores.intro")}
      </p>
      {error ? <p className="mt-3 rounded-2xl bg-[var(--dz-danger-bg-soft)] px-3 py-2 text-xs font-bold text-[var(--dz-danger)]">{error}</p> : null}

      <div className="mt-3 space-y-3">
        {SOURCES.map((s) => {
          const enabled = !!data.sources[s.key];
          const available = enabled && (s.key !== "commerce.wix" || !!data.wix?.available);
          const live = data.connections.filter((c) => c.sourceKey === s.key && c.status !== "REVOKED");
          return (
            <div key={s.key} className="rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-bold text-[var(--dz-text-primary)]">{t(s.title)}</h3>
                {!available ? (
                  <span className="rounded-full bg-[var(--dz-surface-muted)] px-3 py-1 text-xs font-bold text-[var(--dz-text-muted)]">{t("account.settings.connections.common.soon")}</span>
                ) : !live.length ? (
                  <span className="rounded-full bg-[var(--dz-surface-muted)] px-3 py-1 text-xs font-bold text-[var(--dz-text-muted)]">{t("account.settings.connections.status.disconnected")}</span>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">{t(s.description)}</p>

              {live.map((c) => (
                <div key={c.id} className="mt-3 rounded-2xl bg-[var(--dz-surface-muted)] px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold text-[var(--dz-text-primary)]">{c.label ?? t(s.title)}</div>
                      <div className="text-[11px] text-[var(--dz-text-muted)]">{when(c, s.none, t, locale)}</div>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${STATUS[c.status].tone}`}>{t(STATUS[c.status].label)}</span>
                  </div>
                  {c.status === "ERROR" && c.lastErrorCode ? (
                    <p className="mt-1 text-[11px] font-bold text-[var(--dz-danger)]">{t(has(HEALTH, c.lastErrorCode) ? HEALTH[c.lastErrorCode] : "account.settings.connections.stores.health.generic")}</p>
                  ) : null}
                  {c.sourceKey === "telephony.cloudtalk" ? <CloudTalkSetup c={c} onSaved={load} /> : null}
                  {s.key.startsWith("telephony.") ? <LineNames c={c} onSaved={load} /> : null}
                  {c.sourceKey === "telephony.voicenter" && c.endpointUrl ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-bold text-[var(--dz-text-muted)]">{t("account.settings.connections.stores.voicenter.howSummary")}</summary>
                      <p className="mt-1 text-[11px] leading-5 text-[var(--dz-text-muted)]">
                        {t("account.settings.connections.stores.voicenter.howBody")}
                      </p>
                    </details>
                  ) : null}
                  {voicenterUrl?.connectionId === c.id ? (
                    <div className="mt-3 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-3">
                      <p className="text-xs font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.stores.voicenter.copyNow")}</p>
                      <p className="mt-1 text-[11px] leading-5 text-[var(--dz-text-muted)]">{t("account.settings.connections.stores.voicenter.sendToSupport")}</p>
                      <Field label={t("account.settings.connections.stores.voicenter.urlLabel")} value={voicenterUrl.url} />
                      <div className="mt-3">
                        <Action onClick={() => setVoicenterUrl(null)} primary>{t("account.settings.connections.common.savedDone")}</Action>
                      </div>
                    </div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {c.sourceKey === "telephony.voicenter" ? <Action onClick={() => act(c, "rotate")} busy={busy === `rotate:${c.id}`}>{t("account.settings.connections.stores.voicenter.newUrl")}</Action> : null}
                    {c.status === "PAUSED" ? (
                      <Action onClick={() => act(c, "resume")} busy={busy === `resume:${c.id}`}>{t("account.settings.connections.common.resume")}</Action>
                    ) : (
                      <Action onClick={() => act(c, "pause")} busy={busy === `pause:${c.id}`}>{t("account.settings.connections.common.pause")}</Action>
                    )}
                    <Action onClick={() => act(c, "revoke")} busy={busy === `revoke:${c.id}`} danger>{t("account.settings.connections.common.revoke")}</Action>
                  </div>
                </div>
              ))}

              {available && s.key === "commerce.woocommerce" ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    dir="ltr"
                    value={storeUrl}
                    onChange={(e) => setStoreUrl(e.target.value)}
                    placeholder={t("account.settings.connections.stores.woo.placeholder")}
                    aria-label={t("account.settings.connections.stores.woo.ariaLabel")}
                    className="min-w-0 flex-1 rounded-full border border-[var(--dz-border)] bg-[var(--dz-surface)] px-3 py-1 text-xs"
                  />
                  <Action onClick={connectWoo} busy={busy === "create:woo"} primary>{live.length ? t("account.settings.connections.common.reconnect") : t("account.settings.connections.stores.woo.connect")}</Action>
                </div>
              ) : null}
              {available && s.key === "commerce.wix" && data.wix?.installUrl ? (
                <div className="mt-3">
                  <p className="mb-2 text-[11px] leading-5 text-[var(--dz-text-muted)]">{t("account.settings.connections.stores.wix.installNote")}</p>
                  <a href={data.wix.installUrl} target="_blank" rel="noreferrer" className="inline-block rounded-full bg-[var(--dz-text-primary)] px-4 py-1 text-xs font-bold text-[var(--dz-surface)]">
                    {t("account.settings.connections.stores.wix.install")}
                  </a>
                </div>
              ) : null}
              {available && (s.key === "telephony.cloudtalk" || s.key === "telephony.voicenter") && !live.length ? (
                <div className="mt-3">
                  <Action onClick={() => createLine(s.key as "telephony.cloudtalk" | "telephony.voicenter")} busy={busy === `create:${s.key}`} primary>
                    {t("account.settings.connections.stores.connectNamed", { name: t(s.title) })}
                  </Action>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The owner's names for their own numbers ("קו קמפיין גוגל"): calls on that line are attributed to it. */
function LineNames({ c, onSaved }: { c: Connection; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const current = c.lineLabels ?? {};
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      await api(t, `/api/integrations/acquisition/${c.id}`, { action: "set_line_labels", lineLabels: next });
      setNumber("");
      setName("");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("account.settings.connections.common.genericError"));
    } finally {
      setBusy(false);
    }
  }

  const input = "min-w-0 flex-1 rounded-full border border-[var(--dz-border)] bg-[var(--dz-surface)] px-3 py-1 text-xs";
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[11px] font-bold text-[var(--dz-text-muted)]">{Object.keys(current).length ? t("account.settings.connections.stores.lines.summaryCount", { count: Object.keys(current).length }) : t("account.settings.connections.stores.lines.summary")}</summary>
      <p className="mt-1 text-[11px] leading-5 text-[var(--dz-text-muted)]">{t("account.settings.connections.stores.lines.help")}</p>
      {Object.entries(current).map(([digits, label]) => (
        <div key={digits} className="mt-1 flex items-center justify-between gap-2 text-xs">
          <span dir="ltr">{digits}</span>
          <span className="flex-1 truncate">{label}</span>
          <Action onClick={() => { const next = { ...current }; delete next[digits]; void save(next); }} busy={busy} danger>{t("account.settings.connections.stores.lines.remove")}</Action>
        </div>
      ))}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input dir="ltr" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="03-555-0000" aria-label={t("account.settings.connections.stores.lines.numberLabel")} className={input} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("account.settings.connections.stores.lines.nameLabel")} aria-label={t("account.settings.connections.stores.lines.nameLabel")} className={input} />
        <Action onClick={() => void save({ ...current, [number]: name })} busy={busy}>{t("account.settings.connections.stores.lines.add")}</Action>
      </div>
      {error ? <p className="mt-1 text-[11px] font-bold text-[var(--dz-danger)]">{error}</p> : null}
    </details>
  );
}

/** CloudTalk: the endpoint address to paste into CloudTalk, then its signing secret and API key back into Dubiz. */
function CloudTalkSetup({ c, onSaved }: { c: Connection; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const [secret, setSecret] = useState("");
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!c.setup?.signingSecret && !!c.setup?.apiKey;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { action: "set_credentials" };
      if (secret.trim()) body.signingSecret = secret.trim();
      if (keyId.trim() || keySecret.trim()) {
        body.apiKeyId = keyId.trim();
        body.apiKeySecret = keySecret.trim();
      }
      await api(t, `/api/integrations/acquisition/${c.id}`, body);
      setSecret("");
      setKeyId("");
      setKeySecret("");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("account.settings.connections.common.genericError"));
    } finally {
      setBusy(false);
    }
  }

  const input = "min-w-0 w-full rounded-full border border-[var(--dz-border)] bg-[var(--dz-surface)] px-3 py-1 text-xs";
  return (
    <details className="mt-2" open={!ready}>
      <summary className="cursor-pointer text-[11px] font-bold text-[var(--dz-text-muted)]">{ready ? t("account.settings.connections.stores.cloudtalk.ready") : t("account.settings.connections.stores.cloudtalk.todo")}</summary>
      <ol className="mt-2 list-decimal space-y-1 ps-4 text-[11px] leading-5 text-[var(--dz-text-muted)]">
        <li>{t("account.settings.connections.stores.cloudtalk.step1")}</li>
        <li>{t("account.settings.connections.stores.cloudtalk.step2")}</li>
      </ol>
      {c.endpointUrl ? <Field label={t("account.settings.connections.stores.cloudtalk.webhookUrl")} value={c.endpointUrl} /> : null}
      <div className="mt-2 space-y-2">
        <div className="text-[11px] font-bold text-[var(--dz-text-muted)]">Signing secret {c.setup?.signingSecret ? t("account.settings.connections.stores.cloudtalk.saved") : ""}</div>
        <input dir="ltr" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="whsec_…" aria-label="Signing secret" className={input} />
        <div className="text-[11px] font-bold text-[var(--dz-text-muted)]">{t("account.settings.connections.stores.cloudtalk.apiKey")} {c.setup?.apiKey ? t("account.settings.connections.stores.cloudtalk.saved") : ""}</div>
        <input dir="ltr" autoComplete="off" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="API key ID" aria-label="API key ID" className={input} />
        <input dir="ltr" type="password" autoComplete="off" value={keySecret} onChange={(e) => setKeySecret(e.target.value)} placeholder="API key secret" aria-label="API key secret" className={input} />
        {error ? <p className="text-[11px] font-bold text-[var(--dz-danger)]">{error}</p> : null}
        <Action onClick={save} busy={busy} primary>{t("account.settings.connections.stores.cloudtalk.save")}</Action>
      </div>
      <p className="mt-2 text-[11px] text-[var(--dz-text-muted)]">{t("account.settings.connections.stores.cloudtalk.encryptedNote")}</p>
    </details>
  );
}
