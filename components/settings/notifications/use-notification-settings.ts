"use client";

/**
 * The notification settings data for the three settings screens: GET once, then every change is optimistic and
 * rolled back when the server refuses or cannot be reached. The server's answer to a PATCH replaces the local view
 * (it is the effective settings after the write), so what the screen shows is what the engine will use.
 *
 * The actor is always the session's user (the routes never read a user id from the request).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { buildClientAuthHeaders } from "@/lib/client-session";
import type { CategoryDefinition } from "@/lib/notifications/catalog";
import type { EffectiveSettings } from "@/lib/notifications/preferences";

import {
  loadOutcome,
  preferenceBodyFor,
  preferenceUrl,
  withCategoryOverride,
  type Choice,
  type LoadOutcome,
  type SettingsView,
} from "./notification-settings-model";

const SETTINGS_URL = "/api/notifications/settings";

export type SaveNote = "idle" | "saving" | "saved" | "error";

export type NotificationSettingsApi = {
  state: LoadOutcome | "loading";
  view: SettingsView | null;
  note: SaveNote;
  reload: () => void;
  patchSettings: (patch: Partial<EffectiveSettings>) => Promise<boolean>;
  setChoice: (cat: CategoryDefinition, choice: Choice, value: boolean) => Promise<boolean>;
  reset: () => Promise<boolean>;
};

async function send(url: string, method: string, body?: unknown): Promise<{ status: number | null; json: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: buildClientAuthHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch {
    return { status: null, json: null };
  }
}

const ok = (s: number | null) => s !== null && s >= 200 && s < 300;

function isView(v: unknown): v is SettingsView {
  const o = v as SettingsView | null;
  return !!o && typeof o === "object" && !!o.settings && Array.isArray(o.categories) && Array.isArray(o.overrides);
}

export function useNotificationSettings(): NotificationSettingsApi {
  const [state, setState] = useState<LoadOutcome | "loading">("loading");
  const [view, setView] = useState<SettingsView | null>(null);
  const [note, setNote] = useState<SaveNote>("idle");
  const viewRef = useRef<SettingsView | null>(null);
  const [nonce, setNonce] = useState(0);

  const apply = useCallback((v: SettingsView | null) => {
    viewRef.current = v;
    setView(v);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await send(SETTINGS_URL, "GET");
      if (cancelled) return;
      const outcome = loadOutcome(r.status);
      if (outcome === "ready" && isView(r.json)) {
        apply(r.json);
        setState("ready");
      } else {
        setState(outcome === "ready" ? "error" : outcome);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce, apply]);

  const reload = useCallback(() => {
    setState("loading");
    setNonce((n) => n + 1);
  }, []);

  const patchSettings = useCallback(
    async (patch: Partial<EffectiveSettings>) => {
      const before = viewRef.current;
      if (!before) return false;
      apply({ ...before, settings: { ...before.settings, ...patch } });
      setNote("saving");
      const r = await send(SETTINGS_URL, "PATCH", patch);
      if (ok(r.status) && isView(r.json)) {
        apply(r.json);
        setNote("saved");
        return true;
      }
      // Roll back only what this change touched (another change may have landed meanwhile).
      const now = viewRef.current;
      if (now) {
        const restored = { ...now.settings };
        for (const k of Object.keys(patch) as (keyof EffectiveSettings)[]) {
          (restored as Record<string, unknown>)[k] = before.settings[k];
        }
        apply({ ...now, settings: restored });
      }
      setNote("error");
      return false;
    },
    [apply],
  );

  const setChoice = useCallback(
    async (cat: CategoryDefinition, choice: Choice, value: boolean) => {
      const before = viewRef.current;
      if (!before) return false;
      const body = preferenceBodyFor(cat, before.settings, before.overrides, choice, value);
      const previous = before.overrides;
      apply({ ...before, overrides: withCategoryOverride(previous, cat, body) });
      setNote("saving");
      const r = await send(preferenceUrl(cat.key), "PUT", body);
      if (ok(r.status)) {
        setNote("saved");
        return true;
      }
      const now = viewRef.current;
      if (now) {
        const key = `category:${cat.key}`;
        const prior = previous.find((p) => p.key === key);
        apply({ ...now, overrides: [...now.overrides.filter((p) => p.key !== key), ...(prior ? [prior] : [])] });
      }
      setNote("error");
      return false;
    },
    [apply],
  );

  const reset = useCallback(async () => {
    setNote("saving");
    const r = await send("/api/notifications/settings/reset", "POST");
    if (!ok(r.status)) {
      setNote("error");
      return false;
    }
    const fresh = await send(SETTINGS_URL, "GET");
    if (ok(fresh.status) && isView(fresh.json)) apply(fresh.json);
    setNote("idle");
    return true;
  }, [apply]);

  return { state, view, note, reload, patchSettings, setChoice, reset };
}
