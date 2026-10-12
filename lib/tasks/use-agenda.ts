"use client";

/**
 * Daily Tasks — the agenda as both surfaces read it (the task centre and the secretary's "היום שלי"), with the
 * sync cycle of spec 8.7:
 *
 *   1. GET /api/tasks/agenda (read-only);
 *   2. when the list is not COMPLETE or the last sync is old, POST /api/tasks/sync with a fresh key;
 *   3. OK with a new syncVersion → reload once and tell the other tabs (BroadcastChannel); same version → nothing;
 *   4. failure → retry with the SAME key after 5s, 30s and 2m, then stop (the server's SYNC_FAILED banner offers
 *      a manual "נסה שוב") — never a tight loop;
 *   5. IN_PROGRESS → wait Retry-After and reload, without starting another sync;
 *   6. a tab that comes back to the foreground reloads.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchAgenda, postSync, uuidV7, type AgendaResponse } from "./tasks-client";

const CHANNEL = "dubiz-tasks";
const STALE_SYNC_MS = 2 * 60 * 1000;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

export type AgendaState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; agenda: AgendaResponse; syncing: boolean };

export function useAgenda(enabled = true) {
  const [state, setState] = useState<AgendaState>({ status: "loading" });
  const versionRef = useRef<number>(-1);
  const syncKeyRef = useRef<string | null>(null);
  const attemptsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const mountedRef = useRef(true);
  const runSyncRef = useRef<(manual?: boolean) => Promise<void>>(async () => {});

  const load = useCallback(async (): Promise<AgendaResponse | null> => {
    try {
      const agenda = await fetchAgenda();
      if (!mountedRef.current) return null;
      versionRef.current = agenda.syncVersion;
      setState((prev) => ({ status: "ready", agenda, syncing: prev.status === "ready" ? prev.syncing : false }));
      return agenda;
    } catch {
      if (mountedRef.current) setState((prev) => (prev.status === "ready" ? prev : { status: "error" }));
      return null;
    }
  }, []);

  const setSyncing = (syncing: boolean) => setState((prev) => (prev.status === "ready" ? { ...prev, syncing } : prev));

  const runSync = useCallback(async (manual = false) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (manual || !syncKeyRef.current) {
      syncKeyRef.current = uuidV7();
      attemptsRef.current = 0;
    }
    setSyncing(true);
    try {
      const answer = await postSync(syncKeyRef.current!);
      syncKeyRef.current = null;
      attemptsRef.current = 0;
      if (answer.status === "IN_PROGRESS") {
        timerRef.current = setTimeout(() => void load().then(() => setSyncing(false)), answer.retryAfterSeconds * 1000);
        return;
      }
      if (answer.syncVersion !== versionRef.current) {
        await load();
        channelRef.current?.postMessage({ syncVersion: answer.syncVersion });
      }
      setSyncing(false);
    } catch {
      const delay = RETRY_DELAYS_MS[attemptsRef.current];
      attemptsRef.current += 1;
      if (delay !== undefined) {
        timerRef.current = setTimeout(() => void runSyncRef.current(false), delay);
      } else {
        syncKeyRef.current = null;
        await load(); // the server now reports SYNC_FAILED
        setSyncing(false);
      }
    }
  }, [load]);
  useEffect(() => {
    runSyncRef.current = runSync;
  }, [runSync]);

  const needsSync = (a: AgendaResponse) =>
    !a.integrity.every((i) => i === "COMPLETE") || !a.lastSyncAt || Date.now() - new Date(a.lastSyncAt).getTime() > STALE_SYNC_MS;

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) return;
    // Loading the agenda IS the external sync this effect exists for; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().then((a) => {
      if (a && needsSync(a)) void runSync(false);
    });
    try {
      channelRef.current = new BroadcastChannel(CHANNEL);
      channelRef.current.onmessage = (e: MessageEvent<{ syncVersion?: number; changed?: boolean }>) => {
        if (e.data?.changed || (typeof e.data?.syncVersion === "number" && e.data.syncVersion !== versionRef.current)) void load();
      };
    } catch {
      channelRef.current = null;
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      channelRef.current?.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, load, runSync]);

  /** After an owner action: reload here and tell the other tabs. */
  const refresh = useCallback(async () => {
    await load();
    channelRef.current?.postMessage({ changed: true });
  }, [load]);

  return { state, refresh, retrySync: () => runSync(true) };
}
