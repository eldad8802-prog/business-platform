import type { AppointmentStatus } from "@prisma/client";

import type { MessageKey } from "@/lib/i18n/translate";

/**
 * The customer card's label for every appointment status. Typed by the enum, so a status the database can hold
 * cannot be missing here: an earlier map keyed CANCELLED (the enum spells CANCELED) and had no NO_SHOW, and both
 * statuses showed their raw key on the card.
 */
export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, MessageKey> = {
  PROPOSED: "customers.customer.appointmentStatus.proposed",
  CONFIRMED: "customers.customer.appointmentStatus.confirmed",
  COMPLETED: "customers.customer.appointmentStatus.completed",
  NO_SHOW: "customers.customer.appointmentStatus.noShow",
  CANCELED: "customers.customer.appointmentStatus.cancelled",
};
