"use client";

/**
 * The calendar's reads. The appointments of the range on screen (reloaded when it changes and after every write —
 * cancelled ones too when the owner asks to see them), and what gives them names: the staff, the catalog's services
 * and the business's weekly hours. What is open on each day — the business's and each staff member's weekly hours and
 * exceptions (closed days, part-day closures, special hours) — is read for the range on screen, so the calendar shades
 * exactly what the free-slot search excludes. The customers' names come with the appointments themselves.
 *
 * Every source loads and fails on its own: names missing never hide an appointment, and a failed read is REPORTED
 * (`problems`) — never shown as "nothing here".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getAvailability,
  listAppointments,
  listServices,
  listStaff,
  CalendarApiError,
  type RuleWire,
  type ServiceWire,
} from "./calendar-client";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { NO_AVAILABILITY, type Availability, type AppointmentWire, type Names, type StaffWire } from "./calendar-model";

export type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; code: string; httpStatus: number };

export type Problem = "staff" | "services" | "availability";

const asError = (e: unknown) => (e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK"));

export function useCalendarData(range: { from: Date; to: Date } | null, opts: { includeCanceled?: boolean } = {}) {
  const [appointments, setAppointments] = useState<Load<AppointmentWire[]>>({ status: "loading" });
  const [staff, setStaff] = useState<StaffWire[]>([]);
  const [services, setServices] = useState<ServiceWire[]>([]);
  const [hours, setHours] = useState<RuleWire[]>([]);
  const [customers, setCustomers] = useState<Map<number, string>>(new Map());
  const [availability, setAvailability] = useState<Availability>(NO_AVAILABILITY);
  const [problems, setProblems] = useState<Set<Problem>>(new Set());
  const [availabilityReady, setAvailabilityReady] = useState(false);
  const [refTick, setRefTick] = useState(0);
  const fromIso = range?.from.toISOString() ?? null;
  const toIso = range?.to.toISOString() ?? null;
  const includeCanceled = opts.includeCanceled === true;
  const seq = useRef(0);

  const problem = useCallback((p: Problem, on: boolean) => {
    setProblems((cur) => {
      if (cur.has(p) === on) return cur;
      const next = new Set(cur);
      if (on) next.add(p); else next.delete(p);
      return next;
    });
  }, []);

  const loadAppointments = useCallback(async () => {
    if (!fromIso || !toIso) return;
    const mine = ++seq.current;
    try {
      const list = await listAppointments(new Date(fromIso), new Date(toIso), { includeCanceled });
      if (mine === seq.current) setAppointments({ status: "ready", value: list });
    } catch (e) {
      if (mine !== seq.current) return;
      const err = asError(e);
      setAppointments({ status: "error", code: err.code, httpStatus: err.status });
    }
  }, [fromIso, toIso, includeCanceled]);

  // A new range: its appointments replace the previous range's when they arrive (no blank flash in between).
  useEffect(() => {
    if (!fromIso || !toIso) return;
    let cancelled = false;
    const mine = ++seq.current;
    listAppointments(new Date(fromIso), new Date(toIso), { includeCanceled })
      .then((list) => {
        if (!cancelled && mine === seq.current) setAppointments({ status: "ready", value: list });
      })
      .catch((e) => {
        if (cancelled || mine !== seq.current) return;
        const err = asError(e);
        setAppointments({ status: "error", code: err.code, httpStatus: err.status });
      });
    return () => {
      cancelled = true;
    };
  }, [fromIso, toIso, includeCanceled]);

  // The catalogue and the staff: read once per mount, and again on "לנסות שוב".
  const started = fromIso !== null;
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    listStaff().then((v) => { if (!cancelled) { setStaff(v); problem("staff", false); } }).catch(() => { if (!cancelled) problem("staff", true); });
    listServices().then((v) => { if (!cancelled) { setServices(v); problem("services", false); } }).catch(() => { if (!cancelled) problem("services", true); });
    return () => {
      cancelled = true;
    };
  }, [started, refTick, problem]);

  // What is open: re-read when the range or the staff list changes (exceptions are read from the range's first day).
  const fromDay = fromIso ? jerusalemDayKey(new Date(fromIso)) : null;
  const staffKey = staff.map((m) => `${m.id}:${m.version}`).join(",");
  const loadAvailability = useCallback(async () => {
    if (!fromDay) return null;
    const ids = staffKey ? staffKey.split(",").map((x) => Number(x.split(":")[0])) : [];
    const [business, ...own] = await Promise.all([getAvailability(null, fromDay), ...ids.map((id) => getAvailability(id, fromDay).catch(() => null))]);
    const map = new Map<number, { rules: RuleWire[]; exceptions: typeof business.exceptions }>();
    own.forEach((x, i) => { if (x) map.set(ids[i], { rules: x.rules, exceptions: x.exceptions }); });
    return { availability: { business: { rules: business.rules, exceptions: business.exceptions }, staff: map } satisfies Availability, partial: own.some((x) => x === null) };
  }, [fromDay, staffKey]);

  useEffect(() => {
    let cancelled = false;
    loadAvailability()
      .then((v) => { if (!cancelled && v) { setAvailability(v.availability); setHours(v.availability.business.rules); setAvailabilityReady(true); problem("availability", v.partial); } })
      .catch(() => { if (!cancelled) problem("availability", true); });
    return () => { cancelled = true; };
  }, [loadAvailability, refTick, problem]);

  const names: Names = useMemo(
    () => ({
      customers: new Map([
        ...customers,
        ...(appointments.status === "ready"
          ? appointments.value.filter((a) => a.customerId !== null && a.customerName).map((a) => [a.customerId!, a.customerName!] as const)
          : []),
      ]),
      services: new Map(services.map((s) => [s.id, s.name])),
      staff: new Map(staff.map((s) => [s.id, s])),
    }),
    [customers, services, staff, appointments],
  );

  const rememberCustomer = useCallback((id: number, name: string) => {
    setCustomers((m) => new Map(m).set(id, name));
  }, []);

  /** Read everything again (after a failed read). */
  const retry = useCallback(() => { setRefTick((x) => x + 1); void loadAppointments(); }, [loadAppointments]);

  return { appointments, staff, services, hours, availability, availabilityReady, names, problems, retry, reload: loadAppointments, rememberCustomer };
}
