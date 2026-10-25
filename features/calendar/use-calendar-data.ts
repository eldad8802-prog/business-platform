"use client";

/**
 * The calendar's reads. The appointments of the range on screen (reloaded when it changes and after every write),
 * and what gives them names: the staff, the catalog's services, the business's weekly hours (the shaded closed time)
 * and the customers' names — the 100 most recent in one read, any other one by its own card, each fetched once.
 * Every source loads and fails on its own: names missing never hide an appointment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  customerName,
  getAvailability,
  listAppointments,
  listServices,
  listStaff,
  searchCustomers,
  CalendarApiError,
  type RuleWire,
  type ServiceWire,
} from "./calendar-client";
import type { AppointmentWire, Names, StaffWire } from "./calendar-model";

export type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; code: string; httpStatus: number };

export function useCalendarData(range: { from: Date; to: Date } | null) {
  const [appointments, setAppointments] = useState<Load<AppointmentWire[]>>({ status: "loading" });
  const [staff, setStaff] = useState<StaffWire[]>([]);
  const [services, setServices] = useState<ServiceWire[]>([]);
  const [hours, setHours] = useState<RuleWire[]>([]);
  const [customers, setCustomers] = useState<Map<number, string>>(new Map());
  const asked = useRef<Set<number>>(new Set());
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
    getAvailability(null).then((v) => { if (!cancelled) setHours(v.rules); }).catch(() => undefined);
    searchCustomers("", 100)
      .then((rows) => {
        if (cancelled) return;
        setCustomers((m) => {
          const next = new Map(m);
          for (const c of rows) { next.set(c.id, c.name); asked.current.add(c.id); }
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // the catalogue, staff and names are read once per mount; the range only reloads appointments
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromIso !== null]);

  // A name not in the recent hundred: its own read, once.
  useEffect(() => {
    if (appointments.status !== "ready") return;
    const missing = [...new Set(appointments.value.map((a) => a.customerId).filter((id): id is number => id !== null))].filter(
      (id) => !asked.current.has(id),
    );
    for (const id of missing.slice(0, 40)) {
      asked.current.add(id);
      customerName(id)
        .then((c) => setCustomers((m) => new Map(m).set(c.id, c.name)))
        .catch(() => undefined);
    }
  }, [appointments]);

  const names: Names = useMemo(
    () => ({
      customers,
      services: new Map(services.map((s) => [s.id, s.name])),
      staff: new Map(staff.map((s) => [s.id, s])),
    }),
    [customers, services, staff],
  );

  const rememberCustomer = useCallback((id: number, name: string) => {
    asked.current.add(id);
    setCustomers((m) => new Map(m).set(id, name));
  }, []);

  return { appointments, staff, services, hours, names, reload: loadAppointments, reloadStaff: loadStaff, rememberCustomer };
}
