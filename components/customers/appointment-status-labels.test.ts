/**
 * Customer card — every appointment status shows a real label, in both languages. Run:
 *   npx tsx components/customers/appointment-status-labels.test.ts
 *
 * Regression for the audit finding (2026-10-25): the card's map keyed CANCELLED while the enum spells CANCELED, and
 * had no NO_SHOW, so a cancelled or no-show appointment showed its raw key.
 */
import { AppointmentStatus } from "@prisma/client";

import { getMessages } from "@/lib/i18n/messages";
import { translate } from "@/lib/i18n/translate";

import { APPOINTMENT_STATUS_LABEL } from "./appointment-status-labels";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

const statuses = Object.values(AppointmentStatus);
check("the enum has the five statuses the card can meet", statuses.length === 5, statuses.join(","));
for (const locale of ["he", "en"] as const) {
  const messages = getMessages(locale);
  for (const status of statuses) {
    const key = APPOINTMENT_STATUS_LABEL[status];
    const text = key ? translate(messages, key) : "";
    check(`${locale}: ${status} has a label`, Boolean(key) && text.length > 0 && text !== key && text !== status, `${key} → ${text}`);
  }
}
check("he: CANCELED reads בוטל", translate(getMessages("he"), APPOINTMENT_STATUS_LABEL.CANCELED) === "בוטל");
check("he: NO_SHOW reads לא הגיע/ה", translate(getMessages("he"), APPOINTMENT_STATUS_LABEL.NO_SHOW) === "לא הגיע/ה");
check("no key for the misspelt CANCELLED", !("CANCELLED" in APPOINTMENT_STATUS_LABEL));

console.log(`\n${total - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
