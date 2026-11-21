"use client";

/**
 * Activity packs — choosing what the business works on (owner-approved design, phase 2).
 *
 *   mode "setup":    two screens after signup — 1. the category (the 12 existing onboarding categories + the
 *                    sub-category), 2. the packs, pre-ticked from the category. Both skippable ("דילוג, אבחר אחר
 *                    כך"): skipping stores nothing and the Home stays exactly as it is.
 *   mode "settings": the packs screen alone (Settings → תחומי הפעילות), to add / remove packs and change the main one.
 *
 * Display only: saving the packs never turns a feature on and never removes data — a pack that is taken away only
 * stops being put forward; its tool stays reachable from "הכלים שלי". The category is saved through the existing
 * profile endpoint (the business model is kept when the business already has one; otherwise derived from the packs).
 * The server answers 404 while `activity_packs` is OFF for the business, and the screen then says so calmly.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import {
  ACTIVITY_PACK_KEYS,
  businessModelFor,
  suggestionFor,
  type ActivityPackKey,
  type ActivitySelection,
} from "@/lib/activity-packs/activity-packs";
import { BUSINESS_CATEGORY_OPTIONS } from "@/lib/business/business-categories";
import { buildClientAuthHeaders } from "@/lib/client-session";
import type { MessageKey } from "@/lib/i18n/translate";
import { invalidateCachedJson } from "@/lib/ui/cached-json";
import { useFeatureState } from "@/lib/ui/use-feature-enabled";

const ACTIVITY_URL = "/api/business/activity";
const PROFILE_URL = "/api/business/profile";
const CAPS_URL = "/api/business/capabilities";

type ProfileWire = { profile?: { category?: string | null; subCategory?: string | null; businessModel?: string | null } | null };

type LoadState = "loading" | "ready" | "failed" | "unavailable";

export function ActivityPicker({ mode, onDone, onSkip }: { mode: "setup" | "settings"; onDone: () => void; onSkip?: () => void }) {
  const { t } = useI18n();
  const serviceDesk = useFeatureState("service_desk");

  const [load, setLoad] = useState<LoadState>("loading");
  const [nonce, setNonce] = useState(0);
  const [step, setStep] = useState<1 | 2>(mode === "setup" ? 1 : 2);
  const [category, setCategory] = useState<string | null>(null);
  const [subCategory, setSubCategory] = useState<string | null>(null);
  const [savedProfile, setSavedProfile] = useState<ProfileWire["profile"]>(null);
  const [selected, setSelected] = useState<ActivityPackKey[]>([]); // primary first
  const [hadSelection, setHadSelection] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"" | "failed">("");
  const [savedNote, setSavedNote] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const headers = buildClientAuthHeaders();
    Promise.all([
      fetch(ACTIVITY_URL, { headers, cache: "no-store" }),
      fetch(PROFILE_URL, { headers, cache: "no-store" }).then((r) => (r.ok ? (r.json() as Promise<ProfileWire>) : null)).catch(() => null),
    ])
      .then(async ([res, profile]) => {
        if (cancelled) return;
        if (res.status === 404) return setLoad("unavailable");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { selection: ActivitySelection | null };
        if (cancelled) return;
        const p = profile?.profile ?? null;
        setSavedProfile(p);
        setCategory(p?.category ?? null);
        setSubCategory(p?.subCategory ?? null);
        if (body.selection) {
          setSelected([body.selection.primary, ...body.selection.additional]);
          setHadSelection(true);
        }
        setLoad("ready");
      })
      .catch(() => !cancelled && setLoad("failed"));
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const categoryOption = useMemo(() => BUSINESS_CATEGORY_OPTIONS.find((c) => c.value === category) ?? null, [category]);

  // Entering the packs screen without a saved choice: pre-tick what the category suggests (nothing is stored yet).
  const goToPacks = useCallback(() => {
    if (!hadSelection) {
      const s = suggestionFor(category, subCategory);
      setSelected(s ? [s.primary, ...s.additional] : []);
    }
    setStep(2);
  }, [category, subCategory, hadSelection]);

  const toggle = (p: ActivityPackKey) => {
    setSavedNote(false);
    setSelected((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  };
  const makePrimary = (p: ActivityPackKey) => {
    setSavedNote(false);
    setSelected((cur) => [p, ...cur.filter((x) => x !== p)]);
  };

  const save = async () => {
    if (selected.length === 0 || saving) return;
    setSaving(true);
    setError("");
    const selection: ActivitySelection = { primary: selected[0], additional: selected.slice(1) };
    try {
      const headers = { ...buildClientAuthHeaders(), "Content-Type": "application/json" };
      const res = await fetch(ACTIVITY_URL, { method: "PUT", headers, body: JSON.stringify(selection) });
      if (!res.ok) throw new Error(String(res.status));
      // The category the owner picked on screen 1, through the existing profile endpoint (setup only, when changed).
      if (mode === "setup" && category && subCategory && (category !== savedProfile?.category || subCategory !== savedProfile?.subCategory)) {
        const businessModel = savedProfile?.businessModel || businessModelFor(selection);
        await fetch(PROFILE_URL, { method: "POST", headers, body: JSON.stringify({ category, subCategory, businessModel }) }).catch(() => undefined);
        invalidateCachedJson(PROFILE_URL);
      }
      invalidateCachedJson(CAPS_URL);
      setHadSelection(true);
      if (mode === "settings") setSavedNote(true);
      onDone();
    } catch {
      setError("failed");
    } finally {
      setSaving(false);
    }
  };

  const packText = (p: ActivityPackKey, part: "name" | "desc"): string => {
    const key = p === "SERVICE" && serviceDesk !== true ? "SERVICE_OFF" : p;
    return t(`account.settings.activityPacks.pack.${key}.${part}` as MessageKey);
  };

  return (
    <div className="ap">
      <style>{AP_CSS}</style>
      {load === "loading" ? (
        <p className="ap-lead" role="status">…</p>
      ) : load === "unavailable" ? (
        <p className="ap-lead" role="status">{t("account.settings.activityPacks.notAvailable")}</p>
      ) : load === "failed" ? (
        <div className="ap-note" role="status">
          <span>{t("account.settings.activityPacks.loadFailed")}</span>
          <button type="button" className="ap-textbtn" onClick={() => { setLoad("loading"); setNonce((n) => n + 1); }}>
            {t("account.settings.activityPacks.retry")}
          </button>
        </div>
      ) : step === 1 ? (
        <>
          <div className="ap-step">{t("account.settings.activityPacks.stepOf", { n: 1 })}</div>
          <h1 className="ap-title">{t("account.settings.activityPacks.categoryTitle")}</h1>
          <p className="ap-lead">{t("account.settings.activityPacks.categoryLead")}</p>
          <div className="ap-cats" role="group" aria-label={t("account.settings.activityPacks.categoryTitle")}>
            {BUSINESS_CATEGORY_OPTIONS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`ap-cat${category === c.value ? " is-sel" : ""}`}
                aria-pressed={category === c.value}
                onClick={() => {
                  setCategory(c.value);
                  if (c.value !== category) setSubCategory(c.subCategories.length === 1 ? c.subCategories[0].value : null);
                }}
              >
                <CategoryGlyph value={c.value} />
                <span>{t(c.labelKey)}</span>
              </button>
            ))}
          </div>
          {categoryOption && categoryOption.subCategories.length > 1 ? (
            <>
              <div className="ap-label">{t("account.settings.activityPacks.subTitle")}</div>
              <div className="ap-subs" role="group" aria-label={t("account.settings.activityPacks.subTitle")}>
                {categoryOption.subCategories.map((s) => (
                  <button key={s.value} type="button" className={`ap-sub${subCategory === s.value ? " is-sel" : ""}`} aria-pressed={subCategory === s.value} onClick={() => setSubCategory(s.value)}>
                    {t(s.labelKey)}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <div className="ap-foot">
            <button type="button" className="ap-btn" onClick={goToPacks}>
              {t("account.settings.activityPacks.next")}
            </button>
            {onSkip ? (
              <button type="button" className="ap-skip" onClick={onSkip}>
                {t("account.settings.activityPacks.skip")}
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {mode === "setup" ? <div className="ap-step">{t("account.settings.activityPacks.stepOf", { n: 2 })}</div> : null}
          {mode === "setup" ? <h1 className="ap-title">{t("account.settings.activityPacks.packsTitle")}</h1> : null}
          <p className="ap-lead">
            {mode === "setup" && suggestionFor(category, subCategory) && !hadSelection
              ? t("account.settings.activityPacks.packsLeadSuggested")
              : t("account.settings.activityPacks.packsLead")}
          </p>
          <div className="ap-packs" role="group" aria-label={t("account.settings.activityPacks.packsTitle")}>
            {ACTIVITY_PACK_KEYS.map((p) => {
              const on = selected.includes(p);
              const primary = selected[0] === p;
              return (
                <div key={p} className={`ap-pack${on ? " is-sel" : ""}`}>
                  <button type="button" className="ap-pack-main" role="checkbox" aria-checked={on} onClick={() => toggle(p)}>
                    <span className="ap-pack-ico" aria-hidden>
                      <PackGlyph pack={p} />
                    </span>
                    <span className="ap-pack-body">
                      <span className="ap-pack-name">
                        {packText(p, "name")}
                        {primary ? <span className="ap-badge">{t("account.settings.activityPacks.primaryBadge")}</span> : null}
                      </span>
                      <span className="ap-pack-desc">{packText(p, "desc")}</span>
                    </span>
                    <span className={`ap-check${on ? " is-on" : ""}`} aria-hidden>
                      {on ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg> : null}
                    </span>
                  </button>
                  {on && !primary ? (
                    <button type="button" className="ap-textbtn ap-make" onClick={() => makePrimary(p)}>
                      {t("account.settings.activityPacks.makePrimary")}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {error ? (
            <p className="ap-error" role="alert">{t("account.settings.activityPacks.failed")}</p>
          ) : savedNote ? (
            <p className="ap-saved" role="status">{t("account.settings.activityPacks.saved")}</p>
          ) : null}
          <div className="ap-foot">
            <p className="ap-footnote">{t("account.settings.activityPacks.footNote")}</p>
            <button type="button" className="ap-btn" disabled={selected.length === 0 || saving} onClick={save}>
              {saving ? t("account.settings.activityPacks.saving") : mode === "setup" ? t("account.settings.activityPacks.start") : t("account.settings.activityPacks.save")}
            </button>
            {mode === "setup" && onSkip ? (
              <button type="button" className="ap-skip" onClick={onSkip}>
                {t("account.settings.activityPacks.skip")}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- glyphs -- */

const SVG = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function PackGlyph({ pack }: { pack: ActivityPackKey }) {
  switch (pack) {
    case "APPOINTMENTS":
      return <svg {...SVG}><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /></svg>;
    case "SERVICE":
      return <svg {...SVG}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z" /></svg>;
    case "INVENTORY":
      return <svg {...SVG}><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></svg>;
    case "LEADS":
      return <svg {...SVG}><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6" /></svg>;
    case "ORDERS":
      return <svg {...SVG}><rect x="5" y="4" width="14" height="18" rx="2" /><path d="M9 2h6v4H9zM9 12h6M9 16h4" /></svg>;
  }
}

function CategoryGlyph({ value }: { value: string }) {
  const p = { ...SVG, width: 24, height: 24, "aria-hidden": true };
  switch (value) {
    case "Beauty":
      return <svg {...p}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M8.1 8.1 20 20M8.1 15.9 20 4" /></svg>;
    case "Food":
      return <svg {...p}><path d="M7 2v20M4 2v6a3 3 0 0 0 6 0V2M17 2c-2 2-3 5-3 8h3v12" /></svg>;
    case "Fitness":
      return <svg {...p}><path d="M6 7v10M18 7v10M3 9v6M21 9v6M6 12h12" /></svg>;
    case "Home Services":
      return <svg {...p}><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg>;
    case "Events":
      return <svg {...p}><path d="M3 21l5-14 9 9z" /><path d="M14 3v2M19 5l-1 1M21 10h-2" /></svg>;
    case "Retail":
      return <svg {...p}><path d="M5 8h14l-1 13H6z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></svg>;
    case "Automotive":
      return <svg {...p}><path d="M5 17h14v-5l-2-5H7l-2 5z" /><circle cx="8" cy="17" r="2" /><circle cx="16" cy="17" r="2" /></svg>;
    case "Device Repair":
      return <svg {...p}><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></svg>;
    case "Installations":
      return <svg {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z" /></svg>;
    case "IT Services":
      return <svg {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>;
    case "Professional Services":
      return <svg {...p}><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5h6v2" /></svg>;
    default:
      return <svg {...p} fill="currentColor" stroke="none"><circle cx="6" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18" cy="12" r="1.6" /></svg>;
  }
}

/* ------------------------------------------------------------------- css -- */

// HOME v4 tokens (features/home/v4/home-v4.tsx HOME_V4_CSS) — the approved look, nothing new.
const AP_CSS = `
.ap { --ap-teal:#2F615C; --ap-teal-deep:#1F4A46; --ap-ink:#23302B; --ap-muted:#566159; --ap-line:#E3E5DD; --ap-card:#FFFDF8;
  display:flex; flex-direction:column; gap:14px; color:var(--ap-ink); font-family:var(--font-rubik),'Heebo',system-ui,sans-serif; line-height:1.35; }
.ap *, .ap *::before, .ap *::after { box-sizing:border-box; }
.ap-step { font-size:13px; font-weight:600; color:var(--ap-muted); }
.ap-title { margin:0; font-size:26px; font-weight:700; letter-spacing:-.3px; line-height:1.2; }
.ap-lead { margin:0; font-size:15px; color:var(--ap-muted); line-height:1.45; }
.ap-cats { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:8px; }
.ap-cat { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; min-height:80px; padding:8px 4px; border-radius:18px; border:1px solid var(--ap-line); background:var(--ap-card); font:inherit; font-size:14px; font-weight:600; color:var(--ap-ink); cursor:pointer; text-align:center; }
.ap-cat svg { color:var(--ap-teal); }
.ap-cat.is-sel { border-color:var(--ap-teal); background:#EEF5F1; color:#1C5451; }
.ap-label { font-size:14px; font-weight:600; margin-top:2px; }
.ap-subs { display:flex; flex-wrap:wrap; gap:8px; }
.ap-sub { min-height:40px; padding:0 14px; border-radius:999px; border:1px solid var(--ap-line); background:var(--ap-card); font:inherit; font-size:14px; color:var(--ap-ink); cursor:pointer; }
.ap-sub.is-sel { border-color:#BFD7D2; background:#E6EFEC; color:#1C5451; font-weight:600; }
.ap-packs { display:flex; flex-direction:column; gap:8px; }
.ap-pack { border-radius:20px; border:1px solid var(--ap-line); background:var(--ap-card); }
.ap-pack.is-sel { border-color:var(--ap-teal); background:#EEF5F1; }
.ap-pack-main { display:flex; gap:12px; align-items:flex-start; width:100%; padding:12px 14px; border:0; background:transparent; font:inherit; color:inherit; text-align:start; cursor:pointer; border-radius:20px; }
.ap-pack-ico { flex-shrink:0; width:42px; height:42px; border-radius:14px; display:flex; align-items:center; justify-content:center; background:#E3EEE7; color:var(--ap-teal); }
.ap-pack-body { flex:1; min-width:0; }
.ap-pack-name { display:flex; align-items:center; gap:8px; font-size:16px; font-weight:700; }
.ap-pack-desc { display:block; margin-top:2px; font-size:13.5px; color:var(--ap-muted); line-height:1.4; }
.ap-check { flex-shrink:0; width:24px; height:24px; margin-top:2px; border-radius:8px; border:1.5px solid #D2D5C9; background:#FFFFFF; display:flex; align-items:center; justify-content:center; color:#FFFFFF; }
.ap-check.is-on { background:var(--ap-teal); border-color:var(--ap-teal); }
.ap-badge { font-size:12px; font-weight:600; padding:3px 10px; border-radius:999px; background:var(--ap-teal); color:#FFFFFF; }
.ap-make { margin:-6px 70px 6px 0; }
.ap-foot { display:flex; flex-direction:column; gap:4px; margin-top:6px; }
.ap-footnote { margin:0 0 4px; font-size:13px; color:var(--ap-muted); text-align:center; }
.ap-btn { min-height:52px; border-radius:999px; border:0; background:var(--ap-teal); color:#FFFFFF; font:inherit; font-size:16px; font-weight:600; cursor:pointer; box-shadow:0 8px 18px -12px rgba(31,74,70,.8); }
.ap-btn:disabled { opacity:.5; cursor:default; }
.ap-btn:active:not(:disabled) { background:var(--ap-teal-deep); }
.ap-skip, .ap-textbtn { min-height:44px; padding:0 4px; border:0; background:transparent; color:var(--ap-muted); font:inherit; font-size:14px; text-decoration:underline; text-underline-offset:3px; cursor:pointer; }
.ap-note { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border-radius:14px; background:#F8F1EE; color:#7A3E2E; font-size:14px; }
.ap-error { margin:0; font-size:14px; color:#9B4634; }
.ap-saved { margin:0; font-size:14px; color:#1E6A4A; }
.ap a:focus-visible, .ap button:focus-visible { outline:2px solid var(--ap-teal); outline-offset:2px; }
`;
