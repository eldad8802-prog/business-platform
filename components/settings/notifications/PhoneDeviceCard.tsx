"use client";

/**
 * "בטלפון הזה" — this device's part of phone notifications (approved design, screens 1 and 4).
 *
 *  - Android app with push: the permission is asked ONLY from the person's tap (requestPushPermission); the state
 *    after a refusal, the permanent refusal (phone settings instructions — no reliable way to open the app's system
 *    settings exists in this app, so no such button), and a build without Firebase (never offer enabling).
 *  - Dubiz app without push in its build (older Android build, iOS): "not available in this version".
 *  - A browser: phone notifications are the Android app's; the browser option (lib/push/push-client.ts — the
 *    engine sends to these subscriptions too) only where it really works.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";

import { useNotificationT } from "./copy/notification-copy";
import {
  PUSH_STATUS_EVENT,
  REGISTER_TIMEOUT_MS,
  isNativePushAvailable,
  isPushConfigured,
  isPushOptedIn,
  permissionStatus,
  registerDevice,
  requestPushPermission,
  type PushRegistrationStatus,
} from "@/lib/native/push-notifications";
import { buildClientAuthHeaders } from "@/lib/client-session";
import { disablePush, enablePush, pushState, pushSupport } from "@/lib/push/push-client";

import { deviceState, type DeviceInputs, type NativePermission } from "./notification-settings-model";
import s from "./notification-settings.module.css";

type Env = "native" | "app-without-push" | "browser";

function detectEnv(): Env {
  if (isNativePushAvailable()) return "native";
  try {
    if (Capacitor.isNativePlatform()) return "app-without-push";
  } catch {
    /* not inside the app */
  }
  return "browser";
}

/**
 * This browser's state, offered only where it really works: pushState() reports a blocked permission before it
 * asks whether this deployment can send to browsers at all, so "blocked" is shown only when sending is configured.
 */
async function browserPushState(): Promise<"on" | "off" | "denied" | "unavailable"> {
  try {
    if (pushSupport().kind !== "supported") return "unavailable";
    const state = await pushState();
    if (state !== "denied") return state;
    const res = await fetch("/api/push/subscriptions", { cache: "no-store", headers: buildClientAuthHeaders() });
    const cfg = res.ok ? ((await res.json()) as { configured?: boolean }) : null;
    return cfg?.configured ? "denied" : "unavailable";
  } catch {
    return "unavailable";
  }
}

type Registration = "idle" | "connecting" | "connected" | "failed";

function registrationOf(status: PushRegistrationStatus): Registration | "not_configured" | "permission" {
  if (status === "registered" || status === "unchanged") return "connected";
  if (status === "not_configured") return "not_configured";
  if (status === "permission_not_granted") return "permission";
  return "failed";
}

export function PhoneDeviceCard() {
  const t = useNotificationT();
  const [inputs, setInputs] = useState<DeviceInputs | null>(null);
  const [busy, setBusy] = useState(false);
  const [browserFailed, setBrowserFailed] = useState(false);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readNative = useCallback(async (patch: Partial<Extract<DeviceInputs, { kind: "native" }>> = {}) => {
    const [configured, permission] = await Promise.all([isPushConfigured(), permissionStatus()]);
    setInputs((prev) => {
      const p = prev && prev.kind === "native" ? prev : null;
      const optedIn = isPushOptedIn();
      const registration: Registration =
        p?.registration && p.registration !== "idle"
          ? p.registration
          : permission === "granted" && optedIn
            ? "connected"
            : "idle";
      return {
        kind: "native",
        configured,
        permission: permission as NativePermission,
        optedIn,
        askedThisVisit: p?.askedThisVisit ?? false,
        registration,
        ...patch,
      };
    });
  }, []);

  useEffect(() => {
    const env = detectEnv();
    let cancelled = false;
    if (env === "app-without-push") {
      void Promise.resolve().then(() => !cancelled && setInputs({ kind: "app-without-push" }));
      return () => {
        cancelled = true;
      };
    }
    if (env === "browser") {
      browserPushState().then((browserPush) => !cancelled && setInputs({ kind: "browser", browserPush }));
      return () => {
        cancelled = true;
      };
    }
    void Promise.resolve().then(() => {
      if (!cancelled) void readNative();
    });
    // Registration outcomes (the client emits them; never a token).
    const onStatus = (e: Event) => {
      const status = (e as CustomEvent<{ status: PushRegistrationStatus }>).detail?.status;
      if (!status) return;
      const r = registrationOf(status);
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
      setInputs((prev) => {
        if (!prev || prev.kind !== "native") return prev;
        if (r === "not_configured") return { ...prev, configured: false, registration: "idle" };
        if (r === "permission") return { ...prev, registration: "idle" };
        return { ...prev, optedIn: isPushOptedIn(), registration: r };
      });
    };
    // Back from the phone's settings: read the permission again.
    const onVisible = () => {
      if (document.visibilityState === "visible") void readNative();
    };
    window.addEventListener(PUSH_STATUS_EVENT, onStatus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener(PUSH_STATUS_EVENT, onStatus);
      document.removeEventListener("visibilitychange", onVisible);
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    };
  }, [readNative]);

  /** The person's tap — the only place the system permission dialog can appear. */
  async function ask() {
    setBusy(true);
    try {
      const state = await requestPushPermission();
      if (state === "granted") {
        // requestPushPermission connects the phone; the outcome arrives as a status event. Never wait forever.
        setInputs((prev) => (prev && prev.kind === "native" ? { ...prev, permission: "granted", optedIn: true, askedThisVisit: true, registration: "connecting" } : prev));
        if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
        fallbackTimer.current = setTimeout(() => {
          setInputs((prev) => (prev && prev.kind === "native" && prev.registration === "connecting" ? { ...prev, registration: "failed" } : prev));
        }, REGISTER_TIMEOUT_MS + 5000);
      } else {
        await readNative({ askedThisVisit: true, registration: "idle" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function retryConnect() {
    setBusy(true);
    setInputs((prev) => (prev && prev.kind === "native" ? { ...prev, registration: "connecting" } : prev));
    try {
      const r = registrationOf(await registerDevice());
      if (r === "not_configured") await readNative({ configured: false, registration: "idle" });
      else if (r === "permission") await readNative({ registration: "idle" });
      else setInputs((prev) => (prev && prev.kind === "native" ? { ...prev, registration: r } : prev));
    } finally {
      setBusy(false);
    }
  }

  async function toggleBrowser(on: boolean) {
    setBusy(true);
    setBrowserFailed(false);
    try {
      const next = on ? await enablePush() : await disablePush();
      if (on && next !== "on" && next !== "denied") setBrowserFailed(true);
      setInputs({ kind: "browser", browserPush: next });
    } catch {
      setBrowserFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!inputs) return null;
  const state = deviceState(inputs);
  const text = "text-sm leading-6 text-[var(--dz-text-primary)]";
  const muted = "mt-1 text-xs leading-5 text-[var(--dz-text-secondary)]";

  const permissionLine = (granted: boolean) => (
    <p className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
      <span className="font-bold text-[var(--dz-text-primary)]">{t("notifications.phone.permissionLabel")}</span>
      <span className="font-bold text-[var(--dz-text-secondary)]" data-testid="notif-permission">
        {granted ? t("notifications.phone.permissionGranted") : t("notifications.phone.permissionOff")}
      </span>
    </p>
  );

  let body: ReactNode;
  switch (state) {
    case "native-not-configured":
    case "app-not-configured":
      body = (
        <>
          <p className={text}>{t("notifications.phone.notConfigured")}</p>
          <p className={muted}>{t("notifications.phone.notConfiguredHint")}</p>
        </>
      );
      break;
    case "native-ask":
    case "native-ask-again":
      body = (
        <>
          <p className={text}>{state === "native-ask" ? t("notifications.phone.askIntro") : t("notifications.phone.askAgainReason")}</p>
          <button type="button" className={`${s.button} ${s.buttonPrimary} mt-3`} disabled={busy} onClick={ask}>
            {t("notifications.phone.askButton")}
          </button>
          {state === "native-ask" ? <p className={muted}>{t("notifications.phone.askHint")}</p> : null}
        </>
      );
      break;
    case "native-denied":
      body = (
        <>
          {permissionLine(false)}
          <p className={`${text} mt-2 font-bold`}>{t("notifications.phone.deniedTitle")}</p>
          <p className={muted}>{t("notifications.phone.deniedHowTo")}</p>
          <p className={muted}>{t("notifications.phone.deniedStillInApp")}</p>
        </>
      );
      break;
    case "native-connecting":
    case "native-connected":
      body = (
        <>
          {permissionLine(true)}
          <p className={`${muted} mt-2`} role="status">
            {state === "native-connecting" ? t("notifications.phone.connecting") : t("notifications.phone.connected")}
          </p>
        </>
      );
      break;
    case "native-connect-failed":
      body = (
        <>
          {permissionLine(true)}
          <p className={`${s.note} ${s.noteError}`} role="alert">
            {t("notifications.phone.connectFailed")}
          </p>
          <button type="button" className={`${s.button} mt-3`} disabled={busy} onClick={retryConnect}>
            {t("notifications.phone.connectRetry")}
          </button>
        </>
      );
      break;
    default: {
      // The browser.
      body = (
        <>
          <p className={text}>{t("notifications.phone.appOnly")}</p>
          {state === "browser-off" || state === "browser-on" || state === "browser-blocked" ? (
            <div className="mt-3 border-t border-[var(--dz-border-subtle)] pt-3">
              <p className="text-sm font-bold text-[var(--dz-text-primary)]">{t("notifications.phone.browserTitle")}</p>
              {state === "browser-blocked" ? (
                <p className={muted}>{t("notifications.phone.browserBlocked")}</p>
              ) : state === "browser-on" ? (
                <>
                  <p className={muted}>{t("notifications.phone.browserOn")}</p>
                  <button type="button" className={`${s.button} mt-3`} disabled={busy} onClick={() => toggleBrowser(false)}>
                    {t("notifications.phone.browserDisable")}
                  </button>
                </>
              ) : (
                <>
                  <p className={muted}>{t("notifications.phone.browserHelp")}</p>
                  <button type="button" className={`${s.button} ${s.buttonPrimary} mt-3`} disabled={busy} onClick={() => toggleBrowser(true)}>
                    {t("notifications.phone.browserEnable")}
                  </button>
                </>
              )}
              {browserFailed ? (
                <p className={`${s.note} ${s.noteError}`} role="alert">
                  {t("notifications.phone.browserFailed")}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      );
    }
  }

  return (
    <div className="mt-3 rounded-2xl bg-[var(--dz-background)] px-3 py-3" data-testid="notif-device" data-state={state}>
      <p className="mb-2 text-xs font-bold text-[var(--dz-text-muted)]">{t("notifications.phone.deviceTitle")}</p>
      {body}
    </div>
  );
}
