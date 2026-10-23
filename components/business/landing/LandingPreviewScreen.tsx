"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { LandingRenderer } from "@/components/landing-renderer/LandingRenderer";
import type { ImageLoader } from "@/components/landing-renderer/sections";
import type { CompositionResult } from "@/lib/services/landing/composer/landing-composer";
import type { LandingVersionDetail } from "@/lib/services/landing/persistence/landing-page.service";
import type { RenderModel } from "@/lib/services/landing/renderer/render-model";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
import { useLandingLabels } from "./landing-labels";
import { ReadinessNote } from "./LandingVersionsScreen";
import { approveLandingDraft, fetchLandingVersion, landingErrorMessage, newActionKey, rollbackToVersion, saveLandingDraft } from "./landing-versions-api";
import styles from "./landing-preview.module.css";

/**
 * P3-D — Owner Preview Toolbar above an isolated landing canvas (no Dubiz app chrome inside it).
 * Two sources, never mixed:
 *   ?strategy=<server id>  a FRESH composition: the client sends only the strategy id; the server recomposes
 *                          through P3-C (rate limit, single-flight, reuse window). P3-E: "save as a version"
 *                          stores the server's canonical composition — never anything from this page.
 *   ?version=<id>          P3-E: a SAVED version of this business, rendered deterministically on the server
 *                          from its immutable snapshot and today's approved facts / assets. No composer, no
 *                          model call. An unsupported or damaged snapshot fails closed.
 * Device switch only changes the canvas width — the one responsive renderer adapts by container width.
 */

type Device = "MOBILE" | "TABLET" | "DESKTOP";
const DEVICE_WIDTH: Record<Device, number | null> = { MOBILE: 390, TABLET: 768, DESKTOP: null };
const DEVICE_LABEL: Record<Device, MessageKey> = { MOBILE: "content.identity.preview.device.MOBILE", TABLET: "content.identity.preview.device.TABLET", DESKTOP: "content.identity.preview.device.DESKTOP" };

type Payload = { result: CompositionResult | null; renderModel: RenderModel | null; renderError: string | null; error: string | null };

function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function compose(t: Translator, strategyId: string): Promise<Payload> {
  try {
    const res = await fetch("/api/business/landing-blueprint", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId }),
    });
    if (res.status === 409) return { result: null, renderModel: null, renderError: null, error: t("content.identity.preview.errorStrategyGone") };
    if (res.status === 429) return { result: null, renderModel: null, renderError: null, error: t("content.identity.preview.errorRateLimited") };
    if (!res.ok) return { result: null, renderModel: null, renderError: null, error: t("content.identity.preview.errorGeneric") };
    const body = (await res.json()) as { result: CompositionResult; renderModel: RenderModel | null; renderError: string | null };
    return { ...body, error: null };
  } catch {
    return { result: null, renderModel: null, renderError: null, error: t("content.identity.preview.errorGeneric") };
  }
}

/** Owner-only images: Bearer fetch → object URL (the endpoint enforces tenant + public-use approval). */
const loadImage: ImageLoader = async (src) => {
  if (!src.startsWith("/api/business/landing-preview/asset/")) return null;
  try {
    const res = await fetch(src, { headers: authHeaders(), cache: "no-store" });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
};


export function LandingPreviewScreen() {
  useHideShellChrome(true);
  const params = useSearchParams();
  const versionParam = params.get("version");
  const versionId = versionParam && /^\d{1,10}$/.test(versionParam) ? Number(versionParam) : null;
  return versionParam !== null ? <SavedVersionPreview versionId={versionId} /> : <StrategyPreview strategyId={params.get("strategy") ?? ""} />;
}

function DeviceSwitch({ device, onChange }: { device: Device; onChange: (d: Device) => void }) {
  const { t } = useI18n();
  return (
    <div className={styles.devices} role="group" aria-label={t("content.identity.preview.deviceAria")}>
      {(Object.keys(DEVICE_WIDTH) as Device[]).map((d) => (
        <button key={d} type="button" aria-pressed={device === d} className={device === d ? styles.deviceOn : styles.device} onClick={() => onChange(d)}>
          {t(DEVICE_LABEL[d])}
        </button>
      ))}
    </div>
  );
}

function Canvas({ model, device }: { model: RenderModel; device: Device }) {
  const width = DEVICE_WIDTH[device];
  return (
    <div className={styles.frame} data-device={device} style={width ? { width: `min(100%, ${width}px)` } : undefined}>
      <LandingRenderer model={model} loadImage={loadImage} />
    </div>
  );
}

/* ───────────────────────────── ?strategy= — a fresh composition ───────────────────────────── */

function StrategyPreview({ strategyId }: { strategyId: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const { BLUEPRINT_MISSING_LABELS, COMPOSITION_STATUS_LABELS, strategyTitle } = useLandingLabels();
  const [device, setDevice] = useState<Device>("DESKTOP");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const run = useCallback((id: string) => {
    if (inFlight.current) return; // the server also single-flights
    inFlight.current = true;
    setBusy(true);
    void compose(t, id).then((p) => {
      inFlight.current = false;
      setBusy(false);
      setPayload(p);
    });
  }, [t]);

  useEffect(() => {
    if (!strategyId) return;
    let cancelled = false;
    inFlight.current = true;
    void compose(t, strategyId).then((p) => {
      inFlight.current = false;
      if (!cancelled) setPayload(p);
    });
    return () => {
      cancelled = true;
    };
  }, [strategyId, t]);

  const model = payload?.renderModel ?? null;
  useEffect(() => {
    if (model) document.title = t("content.identity.preview.docTitle", { title: model.meta.title });
  }, [model, t]);

  // P3-E: only the strategy id is sent; the server stores ITS canonical composition and the owner is taken
  // to the saved version, so what is approved later is exactly what was stored.
  const save = async () => {
    if (saving || inFlight.current) return;
    setSaving(true);
    setSaveError(null);
    const r = await saveLandingDraft(strategyId);
    setSaving(false);
    if (r.ok) router.push(`/business/landing-preview?version=${r.data.version.id}`);
    else setSaveError(landingErrorMessage(t, r));
  };

  const title = model ? strategyTitle(model.strategyType) : t("content.identity.preview.title");

  return (
    <div className={styles.screen}>
      <header className={styles.toolbar} aria-label={t("content.identity.preview.toolbarAria")}>
        <div className={styles.toolbarStart}>
          <Link href="/business/landing-strategy" className={styles.back}>{t("content.identity.preview.backToStrategies")}</Link>
          <div className={styles.titleBlock}>
            <strong>{title}</strong>
            <span className={styles.badge}>{t("content.identity.preview.badgeUnsaved")}</span>
          </div>
        </div>
        <DeviceSwitch device={device} onChange={setDevice} />
        <div className={styles.toolbarEnd}>
          {model && (
            <span className={model.readiness.publishReady ? styles.ready : styles.notReady}>
              {model.readiness.publishReady ? t("content.identity.preview.publishReady") : t("content.identity.preview.missingCount", { count: model.readiness.missingForPublication.length })}
            </span>
          )}
          <button type="button" className={styles.regen} disabled={busy || saving || !strategyId} onClick={() => run(strategyId)}>
            {busy ? t("content.identity.preview.preparing") : t("content.identity.preview.regenerate")}
          </button>
          {model && (
            <button type="button" className={styles.save} disabled={busy || saving} onClick={() => void save()}>
              {saving ? t("content.identity.preview.saving") : t("content.identity.preview.saveAsVersion")}
            </button>
          )}
        </div>
      </header>

      {saveError && <p className={styles.alert} role="alert">{saveError}</p>}

      {model && model.readiness.missingForPublication.length > 0 && (
        <details className={styles.missing}>
          <summary>{t("content.identity.preview.missingSummary")}</summary>
          <ul>{model.readiness.missingForPublication.map((m) => <li key={m}>{BLUEPRINT_MISSING_LABELS[m] ?? BLUEPRINT_MISSING_LABELS[m.replace(/^ASSET:/, "")] ?? m}</li>)}</ul>
          <Link href="/business/identity">{t("content.identity.preview.completeDetails")}</Link>
        </details>
      )}

      <div className={styles.stage}>
        {!strategyId ? (
          <p className={styles.state}>{t("content.identity.preview.noStrategy")} <Link href="/business/landing-strategy">{t("content.identity.preview.chooseStrategy")}</Link></p>
        ) : !payload ? (
          <p className={styles.state}>{t("content.identity.preview.preparingPreview")}</p>
        ) : payload.error ? (
          <p className={styles.state}>{payload.error}</p>
        ) : !model ? (
          <p className={styles.state}>
            {payload.renderError
              ? t("content.identity.preview.renderRefused")
              : COMPOSITION_STATUS_LABELS[payload.result?.compositionStatus ?? "FAILED"] ?? t("content.identity.preview.cannotPreview")}
          </p>
        ) : (
          <Canvas model={model} device={device} />
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────── ?version= — a saved version (no composer) ───────────────────────────── */

function SavedVersionPreview({ versionId }: { versionId: number | null }) {
  const { t, locale } = useI18n();
  const { VERSION_BADGE, strategyTitle } = useLandingLabels();
  const [device, setDevice] = useState<Device>("DESKTOP");
  const [detail, setDetail] = useState<LandingVersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ kind: "approve" | "rollback"; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);

  const apply = useCallback((r: Awaited<ReturnType<typeof fetchLandingVersion>>) => {
    if (r.ok) {
      setDetail(r.data);
      setError(null);
    } else setError(landingErrorMessage(t, r));
  }, [t]);
  const load = useCallback(async (id: number) => apply(await fetchLandingVersion(id)), [apply]);

  useEffect(() => {
    if (versionId === null) return;
    let cancelled = false;
    void fetchLandingVersion(versionId).then((r) => {
      if (!cancelled) apply(r);
    });
    return () => {
      cancelled = true;
    };
  }, [versionId, apply]);

  const model = detail?.renderModel ?? null;
  const v = detail?.version ?? null;
  useEffect(() => {
    if (model && v) document.title = t("content.identity.preview.docTitleVersion", { n: v.versionNumber, title: model.meta.title });
  }, [model, v, t]);

  const act = async () => {
    if (!confirming || !v || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const kind = confirming.kind;
    const r = kind === "approve" ? await approveLandingDraft(v.id) : await rollbackToVersion(v.id, confirming.key);
    inFlight.current = false;
    setBusy(false);
    setConfirming(null);
    if (!r.ok) {
      setNotice(landingErrorMessage(t, r));
      return;
    }
    if (kind === "approve") {
      // The server's answer is the truth: show it at once, then reload today's readiness.
      const approved = r.data.version;
      setDetail((d) => (d ? { ...d, version: approved } : d));
      setNotice(t("content.identity.versions.noticeApproved", { n: v.versionNumber }));
      await load(v.id);
    } else {
      const created = r.data.version;
      setNotice(t("content.identity.versions.noticeRestored", { created: created.versionNumber, n: v.versionNumber }));
      window.history.replaceState(null, "", `/business/landing-preview?version=${created.id}`);
      await load(created.id);
    }
  };

  const canApprove = !!v && v.isCurrentDraft && v.status === "DRAFT";
  const canRestore = !!v && v.authority === "OWNER_APPROVED" && !v.isCurrentApproved;

  return (
    <div className={styles.screen}>
      <header className={styles.toolbar} aria-label={t("content.identity.preview.toolbarAria")}>
        <div className={styles.toolbarStart}>
          <Link href="/business/landing" className={styles.back}>{t("content.identity.preview.backToVersions")}</Link>
          <div className={styles.titleBlock}>
            <strong>{v ? t("content.identity.preview.versionTitle", { n: v.versionNumber, strategy: strategyTitle(v.strategyType) }) : t("content.identity.preview.savedVersion")}</strong>
            <span className={styles.badgeRow}>
              {v && (
                <span className={v.status === "APPROVED" ? styles.badgeApproved : v.status === "DRAFT" ? styles.badgeDraft : styles.badgePast}>
                  {VERSION_BADGE[v.status] ?? v.status}
                </span>
              )}
              {v?.rollbackSourceVersionNumber ? <span className={styles.badgePast}>{t("content.identity.preview.restoreOf", { n: v.rollbackSourceVersionNumber })}</span> : null}
              <span className={styles.badge}>{t("content.identity.preview.badgePrivate")}</span>
            </span>
          </div>
        </div>
        <DeviceSwitch device={device} onChange={setDevice} />
        <div className={styles.toolbarEnd}>
          {canApprove && (
            <button type="button" className={styles.save} disabled={busy} onClick={() => setConfirming({ kind: "approve", key: newActionKey() })}>{t("content.identity.versions.approve")}</button>
          )}
          {canRestore && (
            <button type="button" className={styles.regen} disabled={busy} onClick={() => setConfirming({ kind: "rollback", key: newActionKey() })}>{t("content.identity.versions.restore")}</button>
          )}
        </div>
      </header>

      {confirming && v && (
        <div className={styles.confirm} role="group" aria-label={t("content.identity.versions.confirmAria")}>
          <p>
            {/* Hebrew stays literal: landing-persistence.verify (P29) pins this wording in the screen's source. */}
            {locale !== "he"
              ? t(confirming.kind === "approve" ? "content.identity.versions.confirmApprove" : "content.identity.versions.confirmRollback", { n: v.versionNumber })
              : confirming.kind === "approve"
                ? `לאשר את גרסה ${v.versionNumber} כגרסה שבחרת?`
                : `ניצור גרסה חדשה המבוססת על גרסה ${v.versionNumber} ונגדיר אותה כגרסה המאושרת.`}
          </p>
          <div className={styles.confirmActions}>
            <button type="button" className={styles.save} disabled={busy} onClick={() => void act()}>{busy ? t("content.identity.versions.wait") : confirming.kind === "approve" ? t("content.identity.versions.yesApprove") : t("content.identity.versions.yesRestore")}</button>
            <button type="button" className={styles.regen} disabled={busy} onClick={() => setConfirming(null)}>{t("content.identity.versions.cancel")}</button>
          </div>
        </div>
      )}

      {notice && <p className={styles.alert} role="status">{notice}</p>}

      {detail?.currentReadiness && (
        <div className={styles.missing}>
          <ReadinessNote readiness={detail.currentReadiness} />
        </div>
      )}

      <div className={styles.stage}>
        {versionId === null ? (
          <p className={styles.state}>{t("content.identity.preview.versionNotFound")} <Link href="/business/landing">{t("content.identity.preview.toVersions")}</Link></p>
        ) : error ? (
          <p className={styles.state}>{error}</p>
        ) : !detail ? (
          <p className={styles.state}>{t("content.identity.preview.loadingVersion")}</p>
        ) : !model ? (
          <p className={styles.state}>{t("content.identity.preview.versionUnrenderable")}</p>
        ) : (
          <Canvas model={model} device={device} />
        )}
      </div>
    </div>
  );
}
