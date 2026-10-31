"use client";

import { useCallback, useEffect, useState } from "react";
import { loadFacebookSdk } from "@/components/whatsapp/facebook-sdk";
import { ComingSoonPill } from "@/components/ui/coming-soon/ComingSoonPill";
import { webFormSnippet } from "@/lib/intake/acquisition/web-form-snippet";
import { useI18n } from "@/components/i18n/I18nProvider";
import { DEFAULT_LOCALE, intlTag, type Locale } from "@/lib/i18n/config";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

/**
 * Settings → Connections → "מקורות לידים" (M6).
 *
 * The owner connects where leads come from — a form on their website, Google Ads lead forms,
 * Facebook / Instagram Lead Ads — and every lead lands in the same Leads list. Everything here goes
 * through /api/integrations/acquisition/*; no business id, key hash or token is ever shown or kept
 * in the browser. A new key is shown ONCE, right after it is created.
 *
 * A source that is not switched on for the business is shown as "not available yet", and Meta is
 * connectable only when Dubiz's Meta app is approved and configured (meta.available) — never a
 * button that cannot work.
 */

type SourceKey = "web.form" | "google.lead_form" | "meta.lead_ads";
type Connection = {
  id: number;
  sourceKey: SourceKey;
  status: "ACTIVE" | "PAUSED" | "ERROR" | "REVOKED";
  /** B2 — computed server-side; PLATFORM_DISABLED while the platform has this source off (the record is untouched). */
  effectiveStatus?: "ACTIVE" | "PAUSED" | "ERROR" | "REVOKED" | "PLATFORM_DISABLED";
  label: string | null;
  keyHint: string | null;
  allowedOrigins: string[];
  lastEventAt: string | null;
  lastErrorCode: string | null;
  endpointUrl: string | null;
  /** What actually reached Dubiz: the provider's test, the last real lead, leads in 30 days. */
  activity: { lastTestAt: string | null; lastDeliveryAt: string | null; deliveries30d: number } | null;
};
type MetaLogin = { appId: string; configId: string; graphVersion: string };
type Overview = {
  sources: Record<SourceKey, boolean>;
  meta?: { available: boolean; login: MetaLogin | null };
  connections: Connection[];
};
type Secret = { connectionId: number; url: string; key: string };
type MetaPick = { handle: string; pages: { id: string; name: string; canAdvertise: boolean }[] };

const SOURCES: { key: SourceKey; title: MessageKey; description: MessageKey }[] = [
  { key: "web.form", title: "account.settings.connections.leads.sources.webForm.title", description: "account.settings.connections.leads.sources.webForm.description" },
  { key: "google.lead_form", title: "account.settings.connections.leads.sources.google.title", description: "account.settings.connections.leads.sources.google.description" },
  { key: "meta.lead_ads", title: "account.settings.connections.leads.sources.meta.title", description: "account.settings.connections.leads.sources.meta.description" },
];

const STATUS: Record<NonNullable<Connection["effectiveStatus"]>, { label: MessageKey; tone: string }> = {
  ACTIVE: { label: "account.settings.connections.leads.status.active", tone: "bg-[var(--dz-success-bg-soft)] text-[var(--dz-success)]" },
  PAUSED: { label: "account.settings.connections.leads.status.paused", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
  ERROR: { label: "account.settings.connections.leads.status.error", tone: "bg-[var(--dz-danger-bg-soft)] text-[var(--dz-danger)]" },
  REVOKED: { label: "account.settings.connections.leads.status.revoked", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
  PLATFORM_DISABLED: { label: "account.settings.connections.common.platformDisabled", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
};

/** The routes' error codes → what the owner reads. */
const ERRORS: Record<string, MessageKey> = {
  source_not_enabled: "account.settings.connections.leads.errors.sourceNotEnabled",
  unavailable: "account.settings.connections.leads.errors.unavailable",
  page_not_managed: "account.settings.connections.leads.errors.pageNotManaged",
  advertise_task_required: "account.settings.connections.leads.errors.advertiseTaskRequired",
  page_connected_to_another_business: "account.settings.connections.leads.errors.pageTaken",
  handle_expired: "account.settings.connections.leads.errors.handleExpired",
  token_invalid: "account.settings.connections.leads.errors.tokenInvalid",
  permission_missing: "account.settings.connections.leads.errors.permissionMissing",
  provider_error: "account.settings.connections.leads.errors.providerError",
};

function errorKey(code: string | undefined): MessageKey {
  return code && Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : "account.settings.connections.common.genericError";
}

function token(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

async function api<T>(tr: Translator, path: string, body?: unknown): Promise<T> {
  const t = token();
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(tr(errorKey(json.error)));
  return json;
}

export function stamp(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  return new Date(iso).toLocaleString(intlTag(locale), { dateStyle: "short", timeStyle: "short" });
}

function when(c: Connection, t: Translator, locale: Locale): string {
  const last = c.activity?.lastDeliveryAt ?? null;
  if (!last) return t("account.settings.connections.leads.noLeadsYet");
  const n = c.activity?.deliveries30d ?? 0;
  const at = stamp(last, locale);
  return n > 0 ? t("account.settings.connections.leads.lastLeadWithCount", { at, count: n }) : t("account.settings.connections.leads.lastLead", { at });
}

export function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden className={done ? "text-[var(--dz-success)]" : "text-[var(--dz-text-muted)]"}>{done ? "✓" : "○"}</span>
      <span className={done ? "text-[var(--dz-text-primary)]" : "text-[var(--dz-text-muted)]"}>{children}</span>
    </li>
  );
}

/**
 * Google Ads — the three activation steps, each answered from what Dubiz received: the endpoint
 * exists, Google's own "Send test data" arrived (the URL and key are right — a test never becomes a
 * lead), and the first real lead arrived.
 */
function GoogleActivation({ c }: { c: Connection }) {
  const { t, locale } = useI18n();
  const test = c.activity?.lastTestAt ?? null;
  const lead = c.activity?.lastDeliveryAt ?? null;
  return (
    <ol className="mt-2 space-y-1 text-[11px] leading-5" aria-label={t("account.settings.connections.leads.google.stepsLabel")}>
      <Step done>{t("account.settings.connections.leads.google.step1")}</Step>
      <Step done={!!test || !!lead}>
        {test
          ? t("account.settings.connections.leads.google.testReceived", { at: stamp(test, locale) })
          : lead
            ? t("account.settings.connections.leads.google.connectionOk")
            : t("account.settings.connections.leads.google.step2Todo")}
      </Step>
      <Step done={!!lead}>{lead ? t("account.settings.connections.leads.google.firstLead", { at: stamp(lead, locale) }) : t("account.settings.connections.leads.google.waitingFirstLead")}</Step>
    </ol>
  );
}

function originOf(input: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
    return u.origin;
  } catch {
    return null;
  }
}

function Copy({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 rounded-full border border-[var(--dz-border)] px-3 py-1 text-xs font-bold text-[var(--dz-text-primary)]"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? t("account.settings.connections.common.copied") : (label ?? t("account.settings.connections.common.copy"))}
    </button>
  );
}

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2">
      <div className="text-[11px] font-bold text-[var(--dz-text-muted)]">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <code dir="ltr" className="min-w-0 flex-1 truncate rounded-xl bg-[var(--dz-surface-muted)] px-3 py-2 text-xs">{value}</code>
        <Copy text={value} />
      </div>
    </div>
  );
}


function WebFormInstall({ url }: { url: string }) {
  const { t } = useI18n();
  return (
    <div className="mt-2">
      <ol className="list-decimal space-y-1 ps-4 text-xs leading-5 text-[var(--dz-text-muted)]">
        <li>{t("account.settings.connections.leads.webForm.step1")}</li>
        <li>{t("account.settings.connections.leads.webForm.step2")}</li>
        <li>{t("account.settings.connections.leads.webForm.step3")}</li>
      </ol>
      <div className="mt-2 flex flex-wrap gap-2">
        <Copy text={webFormSnippet(url)} label={t("account.settings.connections.leads.webForm.copyForm")} />
      </div>
    </div>
  );
}

function SecretBox({ source, secret, onDone }: { source: SourceKey; secret: Secret; onDone: () => void }) {
  const { t } = useI18n();
  const developerNote =
    `Send each form submission as an HTTP POST (JSON or form-encoded) to:\n${secret.url}\n` +
    `Header: Authorization: Bearer ${secret.key}\n` +
    `Fields: name, phone, email, message (any other field is kept as an answer); ` +
    `optional submission_id (prevents duplicates), page_url, utm_source/utm_medium/utm_campaign, gclid, fbclid.`;
  if (source === "web.form") {
    return (
      <div className="mt-3 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-3">
        <p className="text-xs font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.leads.secret.formReady")}</p>
        <WebFormInstall url={secret.url} />
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-bold text-[var(--dz-text-muted)]">{t("account.settings.connections.leads.secret.developerSummary")}</summary>
          <p className="mt-2 text-[11px] leading-5 text-[var(--dz-text-muted)]">{t("account.settings.connections.leads.secret.developerNote")}</p>
          <Field label={t("account.settings.connections.common.address")} value={secret.url} />
          <Field label={t("account.settings.connections.common.secretKey")} value={secret.key} />
          <div className="mt-2"><Copy text={developerNote} label={t("account.settings.connections.leads.secret.copyDeveloperNote")} /></div>
        </details>
        <div className="mt-3">
          <button type="button" onClick={onDone} className="rounded-full bg-[var(--dz-text-primary)] px-4 py-1 text-xs font-bold text-[var(--dz-surface)]">
            {t("account.settings.connections.leads.secret.done")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-3">
      <p className="text-xs font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.leads.secret.copyNow")}</p>
      <ol className="mt-2 list-decimal space-y-1 ps-4 text-xs leading-5 text-[var(--dz-text-muted)]">
        <li>{t("account.settings.connections.leads.secret.googleStep1")}</li>
        <li>{t("account.settings.connections.leads.secret.googleStep2")}</li>
        <li>{t("account.settings.connections.leads.secret.googleStep3")}</li>
      </ol>
      <Field label={t("account.settings.connections.common.address")} value={secret.url} />
      <Field label={t("account.settings.connections.common.secretKey")} value={secret.key} />
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onDone} className="rounded-full bg-[var(--dz-text-primary)] px-4 py-1 text-xs font-bold text-[var(--dz-surface)]">
          {t("account.settings.connections.common.savedDone")}
        </button>
      </div>
    </div>
  );
}

export function LeadSourcesPanel() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [siteInput, setSiteInput] = useState("");
  const [metaPick, setMetaPick] = useState<MetaPick | null>(null);

  const load = useCallback(
    () =>
      api<Overview>(t, "/api/integrations/acquisition").then(setData, (e: unknown) =>
        setError(e instanceof Error ? e.message : t("account.settings.connections.leads.loadError"))
      ),
    [t]
  );
  useEffect(() => {
    let live = true;
    api<Overview>(t, "/api/integrations/acquisition").then(
      (d) => live && setData(d),
      (e: unknown) => live && setError(e instanceof Error ? e.message : t("account.settings.connections.leads.loadError"))
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

  const create = (sourceKey: "web.form" | "google.lead_form") =>
    run(`create:${sourceKey}`, async () => {
      const site = sourceKey === "web.form" ? originOf(siteInput) : null;
      if (sourceKey === "web.form" && !siteInput.trim()) throw new Error(t("account.settings.connections.leads.site.required"));
      if (sourceKey === "web.form" && !site) throw new Error(t("account.settings.connections.leads.site.invalid"));
      const r = await api<{ connection: Connection; key: string }>(t, "/api/integrations/acquisition", {
        sourceKey,
        ...(site ? { allowedOrigins: [site] } : {}),
      });
      setSecret({ connectionId: r.connection.id, url: r.connection.endpointUrl ?? "", key: r.key });
    });

  const saveSite = (c: Connection, input: string) =>
    run(`site:${c.id}`, async () => {
      const site = originOf(input);
      if (!input.trim() || !site) throw new Error(t("account.settings.connections.leads.site.invalid"));
      await api(t, `/api/integrations/acquisition/${c.id}`, { action: "set_origins", allowedOrigins: [site] });
    });

  const act = (c: Connection, action: "rotate" | "pause" | "resume" | "revoke") =>
    run(`${action}:${c.id}`, async () => {
      if (action === "revoke" && !window.confirm(t("account.settings.connections.leads.confirmRevoke"))) return;
      if (action === "rotate" && !window.confirm(t("account.settings.connections.leads.confirmRotate"))) return;
      const r = await api<{ connection: Connection; key?: string }>(t, `/api/integrations/acquisition/${c.id}`, { action });
      if (r.key) setSecret({ connectionId: c.id, url: r.connection.endpointUrl ?? "", key: r.key });
    });

  const metaLogin = () =>
    run("meta:login", async () => {
      const login = data?.meta?.login;
      if (!login) throw new Error(t(ERRORS.unavailable));
      const fb = await loadFacebookSdk(login);
      const code = await new Promise<string>((resolve, reject) =>
        fb.login(
          (resp) => (resp.authResponse?.code ? resolve(resp.authResponse.code) : reject(new Error(t("account.settings.connections.leads.meta.loginCancelled")))),
          { config_id: login.configId, response_type: "code", override_default_response_type: true }
        )
      );
      const r = await api<MetaPick>(t, "/api/integrations/acquisition/meta/pages", { code });
      if (!r.pages.length) throw new Error(t("account.settings.connections.leads.meta.noPages"));
      setMetaPick(r);
    });

  const metaConnect = (pageId: string) =>
    run(`meta:connect:${pageId}`, async () => {
      if (!metaPick) return;
      await api(t, "/api/integrations/acquisition/meta/connect", { handle: metaPick.handle, pageId });
      setMetaPick(null);
    });

  if (!data) {
    return (
      <section className="rounded-[24px] dz-mist p-4 shadow-sm">
        <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.leads.title")}</h2>
        <p className="mt-1 text-xs text-[var(--dz-text-muted)]">{error ?? t("common.loading")}</p>
      </section>
    );
  }

  return (
    <section className="rounded-[24px] dz-mist p-4 shadow-sm md:col-span-2">
      <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.leads.title")}</h2>
      <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
        {t("account.settings.connections.leads.intro")}
      </p>
      {error ? (
        <p className="mt-3 rounded-2xl bg-[var(--dz-danger-bg-soft)] px-3 py-2 text-xs font-bold text-[var(--dz-danger)]">{error}</p>
      ) : null}

      <div className="mt-3 space-y-3">
        {SOURCES.map((s) => {
          const enabled = data.sources[s.key];
          const metaReady = s.key !== "meta.lead_ads" || !!data.meta?.available;
          const live = data.connections.filter((c) => c.sourceKey === s.key && c.status !== "REVOKED");
          const available = enabled && metaReady;
          return (
            <div key={s.key} className="rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-bold text-[var(--dz-text-primary)]">{t(s.title)}</h3>
                {!available ? (
                  <span className="rounded-full bg-[var(--dz-surface-muted)] px-3 py-1 text-xs font-bold text-[var(--dz-text-muted)]">
                    {/* B2 — a source the owner already connected is not "coming soon": the platform turned it off. */}
                    {!enabled && live.length
                      ? t("account.settings.connections.common.platformDisabled")
                      : s.key === "meta.lead_ads" && enabled ? t("account.settings.connections.leads.meta.awaitingApproval") : t("account.settings.connections.common.soon")}
                  </span>
                ) : !live.length ? (
                  <span className="rounded-full bg-[var(--dz-surface-muted)] px-3 py-1 text-xs font-bold text-[var(--dz-text-muted)]">{t("account.settings.connections.status.disconnected")}</span>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">{t(s.description)}</p>
              {!available && s.key === "meta.lead_ads" ? (
                <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                  {t("account.settings.connections.leads.meta.pendingNote")}
                </p>
              ) : null}

              {live.map((c) => (
                <div key={c.id} className="mt-3 rounded-2xl bg-[var(--dz-surface-muted)] px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold text-[var(--dz-text-primary)]">
                        {c.label ?? t(s.title)}
                        {c.allowedOrigins.length ? <span className="font-normal text-[var(--dz-text-muted)]"> · {c.allowedOrigins.map((o) => o.replace(/^https?:\/\//, "")).join(", ")}</span> : null}
                      </div>
                      <div className="text-[11px] text-[var(--dz-text-muted)]">{when(c, t, locale)}</div>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${STATUS[c.effectiveStatus ?? c.status].tone}`}>{t(STATUS[c.effectiveStatus ?? c.status].label)}</span>
                  </div>
                  {c.effectiveStatus === "PLATFORM_DISABLED" ? (
                    <p className="mt-1 text-[11px] leading-5 text-[var(--dz-text-muted)]">{t("account.settings.connections.common.platformDisabledLeadsNote")}</p>
                  ) : null}
                  {c.sourceKey === "google.lead_form" && c.status === "ACTIVE" ? <GoogleActivation c={c} /> : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {c.sourceKey === "meta.lead_ads" && c.status === "ERROR" && available ? (
                      <Action onClick={metaLogin} busy={busy === "meta:login"} comingSoon>{t("account.settings.connections.common.reconnect")}</Action>
                    ) : null}
                    {c.sourceKey !== "meta.lead_ads" ? (
                      <>
                        <Action onClick={() => act(c, "rotate")} busy={busy === `rotate:${c.id}`}>{t("account.settings.connections.leads.newKey")}</Action>
                        {c.status === "PAUSED" ? (
                          <Action onClick={() => act(c, "resume")} busy={busy === `resume:${c.id}`}>{t("account.settings.connections.common.resume")}</Action>
                        ) : (
                          <Action onClick={() => act(c, "pause")} busy={busy === `pause:${c.id}`}>{t("account.settings.connections.common.pause")}</Action>
                        )}
                      </>
                    ) : null}
                    <Action onClick={() => act(c, "revoke")} busy={busy === `revoke:${c.id}`} danger>{t("account.settings.connections.common.revoke")}</Action>
                  </div>
                  {c.endpointUrl && c.status !== "PAUSED" && c.sourceKey === "web.form" ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-bold text-[var(--dz-text-muted)]">{t("account.settings.connections.leads.webForm.pasteSummary")}</summary>
                      <WebFormInstall url={c.endpointUrl} />
                      <SiteEditor current={c.allowedOrigins} busy={busy === `site:${c.id}`} onSave={(v) => saveSite(c, v)} />
                    </details>
                  ) : c.endpointUrl && c.status !== "PAUSED" ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-bold text-[var(--dz-text-muted)]">{t("account.settings.connections.leads.endpointSummary")}</summary>
                      <Field label={t("account.settings.connections.common.address")} value={c.endpointUrl} />
                      <p className="mt-1 text-[11px] text-[var(--dz-text-muted)]">{t("account.settings.connections.leads.keyHint", { hint: c.keyHint ?? "…" })}</p>
                    </details>
                  ) : null}
                  {secret?.connectionId === c.id ? <SecretBox source={s.key} secret={secret} onDone={() => setSecret(null)} /> : null}
                </div>
              ))}

              {available && s.key === "web.form" ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    dir="ltr"
                    value={siteInput}
                    onChange={(e) => setSiteInput(e.target.value)}
                    placeholder={t("account.settings.connections.leads.site.placeholder")}
                    aria-label={t("account.settings.connections.leads.site.ariaLabel")}
                    className="min-w-0 flex-1 rounded-full border border-[var(--dz-border)] bg-[var(--dz-surface)] px-3 py-1 text-xs"
                  />
                  <Action onClick={() => create("web.form")} busy={busy === "create:web.form"} primary>
                    {live.length ? t("account.settings.connections.leads.connectAnotherForm") : t("account.settings.connections.leads.connectForm")}
                  </Action>
                </div>
              ) : null}
              {available && s.key === "google.lead_form" ? (
                <div className="mt-3">
                  <Action onClick={() => create("google.lead_form")} busy={busy === "create:google.lead_form"} primary>
                    {live.length ? t("account.settings.connections.leads.connectAnotherForm") : t("account.settings.connections.leads.connectGoogle")}
                  </Action>
                </div>
              ) : null}
              {available && s.key === "meta.lead_ads" && !metaPick ? (
                <div className="mt-3">
                  <Action onClick={metaLogin} busy={busy === "meta:login"} primary comingSoon>
                    {live.length ? t("account.settings.connections.leads.meta.connectAnotherPage") : t("account.settings.connections.leads.meta.login")}
                  </Action>
                </div>
              ) : null}
              {s.key === "meta.lead_ads" && metaPick ? (
                <div className="mt-3 space-y-2">
                  <p className="text-xs font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.leads.meta.whichPage")}</p>
                  {metaPick.pages.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 rounded-2xl bg-[var(--dz-surface-muted)] px-3 py-2">
                      <span className="truncate text-xs">{p.name}</span>
                      {p.canAdvertise ? (
                        <Action onClick={() => metaConnect(p.id)} busy={busy === `meta:connect:${p.id}`} primary>{t("account.settings.connections.leads.meta.connect")}</Action>
                      ) : (
                        <span className="text-[11px] text-[var(--dz-text-muted)]">{t("account.settings.connections.leads.meta.noAdvertisePermission")}</span>
                      )}
                    </div>
                  ))}
                  <button type="button" onClick={() => setMetaPick(null)} className="text-[11px] font-bold text-[var(--dz-text-muted)]">{t("common.cancel")}</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SiteEditor({ current, busy, onSave }: { current: string[]; busy: boolean; onSave: (v: string) => void }) {
  const { t } = useI18n();
  // One line per site: the www / bare twin the server adds is not shown twice.
  const shown = current
    .map((o) => o.replace(/^https?:\/\//, ""))
    .filter((h) => !h.startsWith("www.") || !current.includes(`https://${h.slice(4)}`));
  const [value, setValue] = useState("");
  return (
    <div className="mt-3">
      <div className="text-[11px] font-bold text-[var(--dz-text-muted)]">{t("account.settings.connections.leads.site.current", { sites: shown.join(", ") || "—" })}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          dir="ltr"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("account.settings.connections.leads.site.newPlaceholder")}
          aria-label={t("account.settings.connections.leads.site.newAriaLabel")}
          className="min-w-0 flex-1 rounded-full border border-[var(--dz-border)] bg-[var(--dz-surface)] px-3 py-1 text-xs"
        />
        <Action onClick={() => onSave(value)} busy={busy}>{t("account.settings.connections.leads.site.save")}</Action>
      </div>
    </div>
  );
}

export function Action({
  children,
  onClick,
  busy,
  primary,
  danger,
  comingSoon = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  primary?: boolean;
  danger?: boolean;
  /** Not open yet (the Facebook / Instagram connection): inactive, with "בקרוב" beside it. */
  comingSoon?: boolean;
}) {
  const { t } = useI18n();
  if (comingSoon) {
    return (
      <span className="inline-flex items-center gap-2">
        <button type="button" disabled aria-disabled className="cursor-not-allowed rounded-full border border-[var(--dz-border)] px-4 py-1 text-xs font-bold text-[var(--dz-text-muted)]">
          {children}
        </button>
        <ComingSoonPill />
      </span>
    );
  }
  const tone = primary
    ? "bg-[var(--dz-text-primary)] text-[var(--dz-surface)]"
    : danger
      ? "border border-[var(--dz-border)] text-[var(--dz-danger)]"
      : "border border-[var(--dz-border)] text-[var(--dz-text-primary)]";
  return (
    <button type="button" disabled={busy} onClick={onClick} className={`rounded-full px-4 py-1 text-xs font-bold disabled:opacity-60 ${tone}`}>
      {busy ? t("account.settings.connections.common.busy") : children}
    </button>
  );
}
