"use client";

/**
 * The calendar's reads. The appointments of the range on screen (reloaded when it changes and after every write),
 * and what gives them names: the staff, the catalog's services and the business's weekly hours (the shaded closed
 * time). The customers' names come with the appointments themselves (one read for the whole range).
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
import type { AppointmentWire, Names, StaffWire } from "./calendar-model";

export type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; code: string; httpStatus: number };

export function useCalendarData(range: { from: Date; to: Date } | null) {
  const [appointments, setAppointments] = useState<Load<AppointmentWire[]>>({ status: "loading" });
  const [staff, setStaff] = useState<StaffWire[]>([]);
  const [services, setServices] = useState<ServiceWire[]>([]);
  const [hours, setHours] = useState<RuleWire[]>([]);
  const [customers, setCustomers] = useState<Map<number, string>>(new Map());
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
    return () => {
      cancelled = true;
    };
    // the catalogue, staff and names are read once per mount; the range only reloads appointments
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromIso !== null]);

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

  return { appointments, staff, services, hours, names, reload: loadAppointments, reloadStaff: loadStaff, rememberCustomer };
}
