"use client";

/**
 * "תזכורות לטלפון" — the one place push is switched on (owner-approved plan 2026-10-21). It says plainly what this
 * device needs (iPhone: add to the home screen first), asks for permission only on a tap, and says that a reminder
 * is sent at the chosen time even in quiet hours. Hidden once push is on (a small "כבוי" link stays available).
 *
 * Inside the Android app there is no web push: the card reads the app's own push state and the server's answer for
 * this login session instead (AppReminderCard, features/tasks/reminder-phone-note.ts) — never the browser check.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Capacitor } from "@capacitor/core";

import { buildClientAuthHeaders } from "@/lib/client-session";
import { isPushConfigured, isPushOptedIn, permissionStatus } from "@/lib/native/push-notifications";
import { disablePush, enablePush, pushState, pushSupport, type PushState } from "@/lib/push/push-client";

import {
  APP_REMINDER_COPY,
  APP_REMINDER_SETTINGS_HREF,
  APP_REMINDER_SETTINGS_LABEL,
  appReminderNote,
  serverDeviceFrom,
  type AppReminderNote,
  type ServerDevice,
} from "./reminder-phone-note";

import s from "./tasks.module.css";

function insideApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

async function serverDevice(): Promise<ServerDevice> {
  try {
    const res = await fetch("/api/push/devices", { cache: "no-store", headers: buildClientAuthHeaders() });
    return serverDeviceFrom(res.status, res.ok ? await res.json().catch(() => null) : null);
  } catch {
    return serverDeviceFrom(null, null);
  }
}

/** Inside the Android app: the app's push state + the server's registration for this session. Read-only. */
function AppReminderCard() {
  const [note, setNote] = useState<AppReminderNote | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const configured = await isPushConfigured();
      const permission = configured ? await permissionStatus().catch(() => "unavailable" as const) : "unavailable";
      const server = configured && permission === "granted" ? await serverDevice() : "unknown";
      if (!cancelled) setNote(appReminderNote({ configured, permission, optedIn: isPushOptedIn(), server }));
    })().catch(() => !cancelled && setNote("check_failed"));
    return () => {
      cancelled = true;
    };
  }, []);
  if (!note) return null;
  const copy = APP_REMINDER_COPY[note];
  return (
    <div className={`${s.fact} ${s.factNeutral}`} role="note" style={{ margin: "4px 0 8px" }} data-testid="tasks-app-reminder-note" data-state={note}>
      {copy.text}
      {copy.settingsLink ? (
        <>
          {" "}
          <Link href={APP_REMINDER_SETTINGS_HREF}>{APP_REMINDER_SETTINGS_LABEL}</Link>
        </>
      ) : null}
    </div>
  );
}

export function PushCard() {
  return insideApp() ? <AppReminderCard /> : <BrowserPushCard />;
}

function BrowserPushCard() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [support] = useState<ReturnType<typeof pushSupport> | null>(() => (typeof window === "undefined" ? null : pushSupport()));

  useEffect(() => {
    let cancelled = false;
    pushState()
      .then((x) => !cancelled && setState(x))
      .catch(() => !cancelled && setState("unavailable"));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading" || !support) return null;

  if (state === "on") {
    return (
      <p className={s.hint} style={{ margin: "4px 0 8px" }}>
        תזכורות לטלפון פעילות במכשיר הזה.{" "}
        <button type="button" className={`${s.btn} ${s.ghost}`} disabled={busy} onClick={async () => { setBusy(true); setState(await disablePush()); setBusy(false); }}>
          כיבוי
        </button>
      </p>
    );
  }

  let body: React.ReactNode;
  if (support.kind === "ios-needs-install") {
    body = (
      <>
        <strong>באייפון:</strong> כדי לקבל תזכורות גם כשדוביז סגורה, יש להוסיף את דוביז למסך הבית — ב־Safari: כפתור השיתוף ←
        &quot;הוסף למסך הבית&quot;, ואז לפתוח את דוביז מהאייקון ולהפעיל כאן. (נדרש iOS 16.4 ומעלה.)
      </>
    );
  } else if (support.kind === "ios-too-old") {
    body = <>תזכורות לטלפון באייפון דורשות iOS 16.4 ומעלה. התזכורות יופיעו בתוך דוביז ובפעמון.</>;
  } else if (state === "denied") {
    body = <>ההתראות חסומות בדפדפן הזה. אפשר לאפשר אותן בהגדרות האתר בדפדפן, ואז לחזור לכאן.</>;
  } else if (state === "unavailable") {
    body = <>במכשיר או בדפדפן הזה אין התראות לטלפון. התזכורות יופיעו בתוך דוביז ובפעמון.</>;
  } else {
    body = (
      <>
        קבל את התזכורות שקבעת גם כשדוביז סגורה. התזכורת נשלחת בדיוק בשעה שבחרת — גם בשעות השקטות.{" "}
        <button type="button" className={`${s.btn} ${s.pri}`} disabled={busy} onClick={async () => { setBusy(true); setState(await enablePush()); setBusy(false); }}>
          {busy ? "מפעיל…" : "הפעלת תזכורות לטלפון"}
        </button>
      </>
    );
  }
  return (
    <div className={`${s.fact} ${s.factNeutral}`} role="note" style={{ margin: "4px 0 8px" }}>
      {body}
    </div>
  );
}
