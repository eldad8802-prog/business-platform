"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { LandingRenderer } from "@/components/landing-renderer/LandingRenderer";
import type { ImageLoader } from "@/components/landing-renderer/sections";
import type { CompositionResult } from "@/lib/services/landing/composer/landing-composer";
import { STRATEGY_TITLES } from "@/lib/services/landing/landing-strategy-explain";
import type { RenderModel } from "@/lib/services/landing/renderer/render-model";
import { BLUEPRINT_MISSING_LABELS, COMPOSITION_STATUS_LABELS } from "./landing-labels";
import styles from "./landing-preview.module.css";

/**
 * P3-D — Owner Preview Toolbar above an isolated landing canvas (no Dubiz app chrome inside it).
 * The client sends ONLY the server-issued strategy id; the server recomposes through P3-C (rate limit,
 * single-flight and reuse window apply) and returns the server-built render model. Device switch only
 * changes the canvas width — the one responsive renderer adapts by container width.
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

export function LandingPreviewScreen() {
  useHideShellChrome(true);
  const strategyId = useSearchParams().get("strategy") ?? "";
  const [device, setDevice] = useState<Device>("DESKTOP");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
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

  const title = model ? STRATEGY_TITLES[model.strategyType as keyof typeof STRATEGY_TITLES] ?? model.strategyType : "תצוגה מקדימה";
  const width = DEVICE_WIDTH[device];

  return (
    <div className={styles.screen} dir="rtl">
      <header className={styles.toolbar} aria-label="כלי תצוגה מקדימה">
        <div className={styles.toolbarStart}>
          <Link href="/business/landing-strategy" className={styles.back}>→ לכיוונים</Link>
          <div className={styles.titleBlock}>
            <strong>{title}</strong>
            <span className={styles.badge}>תצוגה מקדימה · לא מפורסם</span>
          </div>
        </div>
        <div className={styles.devices} role="group" aria-label="גודל מסך">
          {(Object.keys(DEVICE_WIDTH) as Device[]).map((d) => (
            <button key={d} type="button" aria-pressed={device === d} className={device === d ? styles.deviceOn : styles.device} onClick={() => setDevice(d)}>
              {DEVICE_LABEL[d]}
            </button>
          ))}
        </div>
        <div className={styles.toolbarEnd}>
          {model && (
            <span className={model.readiness.publishReady ? styles.ready : styles.notReady}>
              {model.readiness.publishReady ? "יש את כל מה שצריך לפרסום" : `חסרים ${model.readiness.missingForPublication.length} פרטים לפרסום`}
            </span>
          )}
          <button type="button" className={styles.regen} disabled={busy || !strategyId} onClick={() => run(strategyId)}>
            {busy ? "מכינים…" : "יצירה מחדש"}
          </button>
        </div>
      </header>

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
          <div className={styles.frame} data-device={device} style={width ? { width: `min(100%, ${width}px)` } : undefined}>
            <LandingRenderer model={model} loadImage={loadImage} />
          </div>
        )}
      </div>
    </div>
  );
}
