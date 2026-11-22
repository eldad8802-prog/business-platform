/**
 * A quote created from a Service Desk case (pilot review 2026-11-21): the case screen opens billing with
 * `?create=QUOTE&customerId=…&customerName=…&returnTo=/service-desk/cases/<id>`. Billing only uses the customer to
 * pre-fill its own create dialog (the owner can still change it) and offers a link back to the case. Nothing about the
 * document, its numbering, its status or its rules changes.
 *
 * Only an exact service-case path is accepted as the way back — never another path, a query, a host or a scheme.
 */
const CASE_PATH = /^\/service-desk\/cases\/[1-9]\d{0,9}$/;

export function serviceCaseReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return CASE_PATH.test(v) ? v : null;
}
