/**
 * Service Desk — the activation (presentational). Decision 1: the activity types are pre-selected from the business
 * category; the owner changes them by hand. The first time it is two short steps (owner decision 2026-11-24): the field,
 * then what the business opens; from the settings both sit on one page.
 */
import { useState, type ReactNode } from "react";

import { canSave, PROFILE_ORDER, PROFILE_TEXT, SERVICE_TRACKS, TRACK_TEXT, type ServiceProfileKey, type SetupDraft } from "./setup-model";
import s from "./cases.module.css";

export type SetupViewProps = {
  back: ReactNode;
  draft: SetupDraft;
  suggestedKey: string;
  firstTime: boolean;
  onProfile: (k: ServiceProfileKey) => void;
  onTrack: (t: (typeof SERVICE_TRACKS)[number]) => void;
  busy: boolean;
  error: string | null;
  onSave: () => void;
};

export function SetupView(p: SetupViewProps) {
  const d = p.draft;
  const [step, setStep] = useState<1 | 2>(1);
  const showProfile = !p.firstTime || step === 1;
  const showTracks = !p.firstTime || step === 2;
  return (
    <main className={s.screen} data-page-intent="content" dir="rtl">
      <div className={s.wrap}>
        <header className={s.head}>
          {p.back}
          <div className={s.headTitles}>
            <h1 className={s.title}>{p.firstTime ? "הפעלת תיקונים ושירות" : "סוגי הפעילות"}</h1>
            <p className={s.subtitle}>{p.firstTime ? `שלב ${step} מתוך 2 · ` : ""}בחרנו מראש לפי תחום העסק. אפשר לשנות.</p>
          </div>
        </header>

        {showProfile ? <section className={s.infoCard} style={{ gap: 10 }} aria-labelledby="sd-setup-profile">
          <p className={s.infoTitle} id="sd-setup-profile">באיזה תחום העסק עובד?</p>
          <div className={s.choices} style={{ flexWrap: "wrap" }} role="radiogroup" aria-label="תחום העסק">
            {PROFILE_ORDER.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={d.key === k} className={s.choice} style={{ flex: "1 1 220px", textAlign: "start", display: "flex", flexDirection: "column", gap: 2, height: "auto", padding: "10px 14px" }}
                onClick={() => p.onProfile(k)}>
                <span>{PROFILE_TEXT[k].label}{k === p.suggestedKey ? <span className={s.sectionHint}> · מוצע לפי התחום</span> : null}</span>
                <span className={s.muted} style={{ fontWeight: 400 }}>{PROFILE_TEXT[k].hint}</span>
              </button>
            ))}
          </div>
        </section> : null}

        {showTracks ? <section className={s.infoCard} style={{ gap: 10, marginTop: 12 }} aria-labelledby="sd-setup-tracks">
          <p className={s.infoTitle} id="sd-setup-tracks">מה העסק פותח?</p>
          <ul className={s.list} aria-label="סוגי פעילות">
            {SERVICE_TRACKS.map((t) => (
              <li key={t}>
                <label className={s.row} style={{ display: "flex", gap: 12, cursor: "pointer", alignItems: "center" }}>
                  <input type="checkbox" checked={d.tracks.includes(t)} onChange={() => p.onTrack(t)} style={{ width: 24, height: 24, accentColor: "#7a2433", flex: "none" }} />
                  <span className={s.rowMain}><span className={s.rowCustomer}>{TRACK_TEXT[t].label}</span><span className={s.rowDesc}>{TRACK_TEXT[t].hint}</span></span>
                </label>
              </li>
            ))}
          </ul>
          <p className={s.muted}>הסוגים שבחרתם יופיעו ראשונים בפתיחת תיק. אפשר תמיד לפתוח גם סוג אחר.</p>
          {!canSave(d) ? <p className={s.rowReason} role="alert">בחרו לפחות סוג פעילות אחד.</p> : null}
        </section> : null}

        {p.error ? <p className={s.msg} data-tone="error" role="alert">{p.error}</p> : null}
        <div className={s.actionsRow} style={{ marginTop: 12 }}>
          {p.firstTime && step === 2 ? <button type="button" className={s.secondary} onClick={() => setStep(1)}>חזרה לתחום</button> : null}
          {p.firstTime && step === 1
            ? <button type="button" className={s.primary} onClick={() => setStep(2)}>המשך</button>
            : <button type="button" className={s.primary} disabled={p.busy || !canSave(d)} onClick={p.onSave}>{p.busy ? "שומר…" : p.firstTime ? "לשמור ולהתחיל" : "לשמור"}</button>}
        </div>
      </div>
    </main>
  );
}
