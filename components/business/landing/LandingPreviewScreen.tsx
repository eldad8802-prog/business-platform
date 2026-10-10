"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { LandingRenderer } from "@/components/landing-renderer/LandingRenderer";
import type { ImageLoader } from "@/components/landing-renderer/sections";
import type { CompositionResult } from "@/lib/services/landing/composer/landing-composer";
import { STRATEGY_TITLES } from "@/lib/services/landing/landing-strategy-explain";
import type { LandingVersionDetail } from "@/lib/services/landing/persistence/landing-page.service";
import type { RenderModel } from "@/lib/services/landing/renderer/render-model";
import { BLUEPRINT_MISSING_LABELS, COMPOSITION_STATUS_LABELS, VERSION_BADGE } from "./landing-labels";
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
const DEVICE_LABEL: Record<Device, string> = { MOBILE: "נייד", TABLET: "טאבלט", DESKTOP: "מחשב" };

type Payload = { result: CompositionResult | null; renderModel: RenderModel | null; renderError: string | null; error: string | null };

function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function compose(strategyId: string): Promise<Payload> {
  try {
    const res = await fetch("/api/business/landing-blueprint", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId }),
    });
    if (res.status === 409) return { result: null, renderModel: null, renderError: null, error: "הכיוון הזה כבר לא קיים בעסק (המידע השתנה). חזרו לכיוונים ובחרו שוב." };
    if (res.status === 429) return { result: null, renderModel: null, renderError: null, error: "נוצרו הרבה טיוטות בזמן קצר. נסו שוב בעוד כמה דקות." };
    if (!res.ok) return { result: null, renderModel: null, renderError: null, error: "לא הצלחנו להכין את התצוגה המקדימה כרגע." };
    const body = (await res.json()) as { result: CompositionResult; renderModel: RenderModel | null; renderError: string | null };
    return { ...body, error: null };
  } catch {
    return { result: null, renderModel: null, renderError: null, error: "לא הצלחנו להכין את התצוגה המקדימה כרגע." };
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

const strategyTitle = (t: string) => STRATEGY_TITLES[t as keyof typeof STRATEGY_TITLES] ?? t;

export function LandingPreviewScreen() {
  useHideShellChrome(true);
  const params = useSearchParams();
  const versionParam = params.get("version");
  const versionId = versionParam && /^\d{1,10}$/.test(versionParam) ? Number(versionParam) : null;
  return versionParam !== null ? <SavedVersionPreview versionId={versionId} /> : <StrategyPreview strategyId={params.get("strategy") ?? ""} />;
}

function DeviceSwitch({ device, onChange }: { device: Device; onChange: (d: Device) => void }) {
  return (
    <div className={styles.devices} role="group" aria-label="גודל מסך">
      {(Object.keys(DEVICE_WIDTH) as Device[]).map((d) => (
        <button key={d} type="button" aria-pressed={device === d} className={device === d ? styles.deviceOn : styles.device} onClick={() => onChange(d)}>
          {DEVICE_LABEL[d]}
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
    void compose(id).then((p) => {
      inFlight.current = false;
      setBusy(false);
      setPayload(p);
    });
  }, []);

  useEffect(() => {
    if (!strategyId) return;
    let cancelled = false;
    inFlight.current = true;
    void compose(strategyId).then((p) => {
      inFlight.current = false;
      if (!cancelled) setPayload(p);
    });
    return () => {
      cancelled = true;
    };
  }, [strategyId]);

  const model = payload?.renderModel ?? null;
  useEffect(() => {
    if (model) document.title = `תצוגה מקדימה · ${model.meta.title}`;
  }, [model]);

  // P3-E: only the strategy id is sent; the server stores ITS canonical composition and the owner is taken
  // to the saved version, so what is approved later is exactly what was stored.
  const save = async () => {
    if (saving || inFlight.current) return;
    setSaving(true);
    setSaveError(null);
    const r = await saveLandingDraft(strategyId);
    setSaving(false);
    if (r.ok) router.push(`/business/landing-preview?version=${r.data.version.id}`);
    else setSaveError(landingErrorMessage(r));
  };

  const title = model ? strategyTitle(model.strategyType) : "תצוגה מקדימה";

  return (
    <div className={styles.screen} dir="rtl">
      <header className={styles.toolbar} aria-label="כלי תצוגה מקדימה">
        <div className={styles.toolbarStart}>
          <Link href="/business/landing-strategy" className={styles.back}>→ לכיוונים</Link>
          <div className={styles.titleBlock}>
            <strong>{title}</strong>
            <span className={styles.badge}>תצוגה מקדימה פרטית · עדיין לא נשמרה</span>
          </div>
        </div>
        <DeviceSwitch device={device} onChange={setDevice} />
        <div className={styles.toolbarEnd}>
          {model && (
            <span className={model.readiness.publishReady ? styles.ready : styles.notReady}>
              {model.readiness.publishReady ? "יש את כל מה שצריך לפרסום" : `חסרים ${model.readiness.missingForPublication.length} פרטים לפרסום`}
            </span>
          )}
          <button type="button" className={styles.regen} disabled={busy || saving || !strategyId} onClick={() => run(strategyId)}>
            {busy ? "מכינים…" : "יצירה מחדש"}
          </button>
          {model && (
            <button type="button" className={styles.save} disabled={busy || saving} onClick={() => void save()}>
              {saving ? "שומרים…" : "שמירה כגרסה"}
            </button>
          )}
        </div>
      </header>

      {saveError && <p className={styles.alert} role="alert">{saveError}</p>}

      {model && model.readiness.missingForPublication.length > 0 && (
        <details className={styles.missing}>
          <summary>מה חסר כדי לפרסם את הדף</summary>
          <ul>{model.readiness.missingForPublication.map((m) => <li key={m}>{BLUEPRINT_MISSING_LABELS[m] ?? BLUEPRINT_MISSING_LABELS[m.replace(/^ASSET:/, "")] ?? m}</li>)}</ul>
          <Link href="/business/identity">להשלמת הפרטים ←</Link>
        </details>
      )}

      <div className={styles.stage}>
        {!strategyId ? (
          <p className={styles.state}>לא נבחר כיוון. <Link href="/business/landing-strategy">לבחירת כיוון ←</Link></p>
        ) : !payload ? (
          <p className={styles.state}>מכינים את התצוגה המקדימה…</p>
        ) : payload.error ? (
          <p className={styles.state}>{payload.error}</p>
        ) : !model ? (
          <p className={styles.state}>
            {payload.renderError
              ? "הטיוטה נוצרה, אבל לא ניתן להציג אותה בבטחה, ולכן היא לא מוצגת."
              : COMPOSITION_STATUS_LABELS[payload.result?.compositionStatus ?? "FAILED"] ?? "לא ניתן להציג תצוגה מקדימה."}
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
    } else setError(landingErrorMessage(r));
  }, []);
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
    if (model && v) document.title = `גרסה ${v.versionNumber} · ${model.meta.title}`;
  }, [model, v]);

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
      setNotice(landingErrorMessage(r));
      return;
    }
    if (kind === "approve") {
      // The server's answer is the truth: show it at once, then reload today's readiness.
      const approved = r.data.version;
      setDetail((d) => (d ? { ...d, version: approved } : d));
      setNotice(`גרסה ${v.versionNumber} היא עכשיו הגרסה המאושרת שלך.`);
      await load(v.id);
    } else {
      const created = r.data.version;
      setNotice(`נוצרה גרסה ${created.versionNumber} מתוך גרסה ${v.versionNumber}, והיא עכשיו הגרסה המאושרת.`);
      window.history.replaceState(null, "", `/business/landing-preview?version=${created.id}`);
      await load(created.id);
    }
  };

  const canApprove = !!v && v.isCurrentDraft && v.status === "DRAFT";
  const canRestore = !!v && v.authority === "OWNER_APPROVED" && !v.isCurrentApproved;

  return (
    <div className={styles.screen} dir="rtl">
      <header className={styles.toolbar} aria-label="כלי תצוגה מקדימה">
        <div className={styles.toolbarStart}>
          <Link href="/business/landing" className={styles.back}>→ לגרסאות</Link>
          <div className={styles.titleBlock}>
            <strong>{v ? `גרסה ${v.versionNumber} · ${strategyTitle(v.strategyType)}` : "גרסה שמורה"}</strong>
            <span className={styles.badgeRow}>
              {v && (
                <span className={v.status === "APPROVED" ? styles.badgeApproved : v.status === "DRAFT" ? styles.badgeDraft : styles.badgePast}>
                  {VERSION_BADGE[v.status] ?? v.status}
                </span>
              )}
              {v?.rollbackSourceVersionNumber ? <span className={styles.badgePast}>{`שחזור של גרסה ${v.rollbackSourceVersionNumber}`}</span> : null}
              <span className={styles.badge}>תצוגה מקדימה פרטית</span>
            </span>
          </div>
        </div>
        <DeviceSwitch device={device} onChange={setDevice} />
        <div className={styles.toolbarEnd}>
          {canApprove && (
            <button type="button" className={styles.save} disabled={busy} onClick={() => setConfirming({ kind: "approve", key: newActionKey() })}>אישור הגרסה</button>
          )}
          {canRestore && (
            <button type="button" className={styles.regen} disabled={busy} onClick={() => setConfirming({ kind: "rollback", key: newActionKey() })}>שחזור כגרסה המאושרת</button>
          )}
        </div>
      </header>

      {confirming && v && (
        <div className={styles.confirm} role="group" aria-label="אישור פעולה">
          <p>
            {confirming.kind === "approve"
              ? `לאשר את גרסה ${v.versionNumber} כגרסה שבחרת?`
              : `ניצור גרסה חדשה המבוססת על גרסה ${v.versionNumber} ונגדיר אותה כגרסה המאושרת.`}
          </p>
          <div className={styles.confirmActions}>
            <button type="button" className={styles.save} disabled={busy} onClick={() => void act()}>{busy ? "רגע…" : confirming.kind === "approve" ? "כן, לאשר" : "כן, לשחזר"}</button>
            <button type="button" className={styles.regen} disabled={busy} onClick={() => setConfirming(null)}>חזרה</button>
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
          <p className={styles.state}>הגרסה לא נמצאה. <Link href="/business/landing">לגרסאות ←</Link></p>
        ) : error ? (
          <p className={styles.state}>{error}</p>
        ) : !detail ? (
          <p className={styles.state}>טוענים את הגרסה…</p>
        ) : !model ? (
          <p className={styles.state}>את הגרסה הזו לא ניתן להציג בבטחה (היא נשמרה בפורמט שכבר לא נתמך או שאינו תקין), ולכן היא לא מוצגת.</p>
        ) : (
          <Canvas model={model} device={device} />
        )}
      </div>
    </div>
  );
}
