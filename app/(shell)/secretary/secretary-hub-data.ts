"use client";

/**
 * The hub's extra reads, beside the briefing the page already holds. Every one is an existing GET; each loads
 * on its own and fails on its own, so a slow or failed source never blocks the Secretary.
 *
 *   - tasks: GET /api/tasks/agenda — read only (no sync is started here; the task centre keeps that), and only
 *     once daily_tasks is known to be ON. OFF stays OFF: nothing is fetched and the hub says so.
 *   - obligations: GET /api/obligations?includeClosed=1 — the calendar's due dates, open and closed.
 *   - summary: GET /api/business-cost/summary — the day cost and the forecast dates.
 *   - appointments: GET /api/appointments — a month back and a month ahead (the API's 62-day range), only once
 *     appointments is known to be ON. OFF stays OFF: nothing is fetched (Appointments milestone B).
 *
 * `stamp` (the briefing's generatedAt) reloads all three after any change the page made.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchBusinessCostSummary, type BusinessCostSummaryApi } from "@/lib/business-cost/business-cost-client";
import { fetchObligations, type ObligationApi } from "@/lib/obligations/secretary-client";
import { fetchAgenda } from "@/lib/tasks/tasks-client";
import { useFeatureState } from "@/lib/ui/use-feature-enabled";
import { listAppointments } from "@/features/calendar/calendar-client";
import { appointmentsWindow, ownTasks, type HubAppointment, type HubTask } from "./secretary-hub-model";

export const HUB_OBLIGATION_LIMIT = 200;

export type HubData = {
  tasks: HubTask[] | "loading" | "unavailable" | "off";
  obligations: { list: ObligationApi[]; truncated: boolean } | "loading" | "unavailable";
  summary: BusinessCostSummaryApi | "loading" | "unavailable";
  appointments: HubAppointment[] | "loading" | "unavailable" | "off";
  reloadTasks: () => Promise<void>;
};


export function useHubData(stamp: string): HubData {
  const tasksOn = useFeatureState("daily_tasks");
  const [tasks, setTasks] = useState<HubData["tasks"]>("loading");
  const [obligations, setObligations] = useState<HubData["obligations"]>("loading");
  const [summary, setSummary] = useState<HubData["summary"]>("loading");
  const appointmentsOn = useFeatureState("appointments");
  const [appointments, setAppointments] = useState<HubData["appointments"]>("loading");

  useEffect(() => {
    if (!appointmentsOn) return;
    let cancelled = false;
    const { from, to } = appointmentsWindow(new Date());
    listAppointments(from, to)
      .then((list) => {
        // Each appointment carries its customer's name (the same read): no customer list, no per-customer reads.
        if (!cancelled) setAppointments(list);
      })
      .catch(() => {
        if (!cancelled) setAppointments("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [appointmentsOn, stamp]);

  const loadTasks = useCallback(
    () =>
      fetchAgenda()
        .then((agenda) => setTasks(ownTasks(agenda)))
        .catch(() => setTasks("unavailable")),
    [],
  );

  useEffect(() => {
    if (!tasksOn) return;
    let cancelled = false;
    fetchAgenda()
      .then((agenda) => {
        if (!cancelled) setTasks(ownTasks(agenda));
      })
      .catch(() => {
        if (!cancelled) setTasks("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [tasksOn, stamp]);

  useEffect(() => {
    const controller = new AbortController();
    const token = typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    (token ? fetchObligations(token, true, HUB_OBLIGATION_LIMIT + 1) : Promise.reject(new Error("no session")))
      .then((r) => {
        if (!controller.signal.aborted) {
          setObligations({ list: r.obligations.slice(0, HUB_OBLIGATION_LIMIT), truncated: r.obligations.length > HUB_OBLIGATION_LIMIT });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setObligations("unavailable");
      });
    fetchBusinessCostSummary(controller.signal)
      .then((s) => {
        if (!controller.signal.aborted) setSummary(s);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSummary("unavailable");
      });
    return () => controller.abort();
  }, [stamp]);

  // daily_tasks OFF stays OFF: nothing was fetched, and the hub says so.
  return {
    tasks: tasksOn === false ? "off" : tasks,
    obligations,
    summary,
    // appointments OFF stays OFF the same way.
    appointments: appointmentsOn === false ? "off" : appointments,
    reloadTasks: loadTasks,
  };
}
