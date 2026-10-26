"use client";

/**
 * The calendar's reads. The appointments of the range on screen (reloaded when it changes and after every write),
 * and what gives them names: the staff, the catalog's services and the business's weekly hours. What is open on each
 * day — the business's and each staff member's weekly hours and exceptions (closed days, part-day closures, special
 * hours) — is read for the range on screen, so the calendar shades exactly what the free-slot search excludes. The customers' names come with the appointments themselves (one read for the whole range).
 * Every source loads and fails on its own: names missing never hide an appointment.
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

export function useCalendarData(range: { from: Date; to: Date } | null) {
  const [appointments, setAppointments] = useState<Load<AppointmentWire[]>>({ status: "loading" });
  const [staff, setStaff] = useState<StaffWire[]>([]);
  const [services, setServices] = useState<ServiceWire[]>([]);
  const [hours, setHours] = useState<RuleWire[]>([]);
  const [customers, setCustomers] = useState<Map<number, string>>(new Map());
  const [availability, setAvailability] = useState<Availability>(NO_AVAILABILITY);
  const fromIso = range?.from.toISOString() ?? null;
  const toIso = range?.to.toISOString() ?? null;
  const seq = useRef(0);

  const loadAppointments = useCallback(async () => {
    if (!fromIso || !toIso) return;
    const mine = ++seq.current;
    try {
      const list = await listAppointments(new Date(fromIso), new Date(toIso));
      if (mine === seq.current) setAppointments({ status: "ready", value: list });
    } catch (e) {
      if (mine !== seq.current) return;
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      setAppointments({ status: "error", code: err.code, httpStatus: err.status });
    }
  }, [fromIso, toIso]);

  const loadStaff = useCallback(() => listStaff().then(setStaff).catch(() => undefined), []);

  // A new range: its appointments replace the previous range's when they arrive (no blank flash in between).
  useEffect(() => {
    if (!fromIso || !toIso) return;
    let cancelled = false;
    const mine = ++seq.current;
    listAppointments(new Date(fromIso), new Date(toIso))
      .then((list) => {
        if (!cancelled && mine === seq.current) setAppointments({ status: "ready", value: list });
      })
      .catch((e) => {
        if (cancelled || mine !== seq.current) return;
        const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
        setAppointments({ status: "error", code: err.code, httpStatus: err.status });
      });
    return () => {
      cancelled = true;
    };
  }, [fromIso, toIso]);

  useEffect(() => {
    if (!fromIso) return;
    let cancelled = false;
    listStaff().then((v) => { if (!cancelled) setStaff(v); }).catch(() => undefined);
    listServices().then((v) => { if (!cancelled) setServices(v); }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // the catalogue, staff and names are read once per mount; the range only reloads appointments
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromIso !== null]);

  // What is open: re-read when the range or the staff list changes (exceptions are read from the range's first day).
  const fromDay = fromIso ? jerusalemDayKey(new Date(fromIso)) : null;
  const staffKey = staff.filter((m) => m.active).map((m) => `${m.id}:${m.version}`).join(",");
  const loadAvailability = useCallback(async () => {
    if (!fromDay) return null;
    const ids = staffKey ? staffKey.split(",").map((x) => Number(x.split(":")[0])) : [];
    const [business, ...own] = await Promise.all([getAvailability(null, fromDay), ...ids.map((id) => getAvailability(id, fromDay).catch(() => null))]);
    const map = new Map<number, { rules: RuleWire[]; exceptions: typeof business.exceptions }>();
    own.forEach((x, i) => { if (x) map.set(ids[i], { rules: x.rules, exceptions: x.exceptions }); });
    return { business: { rules: business.rules, exceptions: business.exceptions }, staff: map } satisfies Availability;
  }, [fromDay, staffKey]);

  useEffect(() => {
    let cancelled = false;
    loadAvailability().then((v) => { if (!cancelled && v) { setAvailability(v); setHours(v.business.rules); } }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [loadAvailability]);

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

  return { appointments, staff, services, hours, availability, names, reload: loadAppointments, reloadStaff: loadStaff, rememberCustomer };
}
