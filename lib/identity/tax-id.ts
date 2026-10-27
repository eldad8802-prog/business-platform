// Pure: no database, no tenant context. Shared by M5 identity binding and the document issuer reading.

/**
 * A tax id that is allowed to bind WITHOUT a person, or null.
 *
 * `taxId` is free text on every form that writes it — nothing validates it on the way in. An exact
 * string match is therefore only as authoritative as the strings are: two unrelated suppliers both
 * typed in as "000000000", "1" or "-" share a value and nothing else, and binding on it would be the
 * weak auto-merge this module exists to refuse, wearing a strong identifier's name.
 *
 * So only an identifier that is SHAPED like one the state issued may bind: Israeli ת.ז / ח.פ / ע.מ
 * numbers are nine digits (eight when a leading zero was dropped) carrying a check digit, with the
 * usual separators tolerated. A value failing that is not discarded as evidence of anything — it is
 * simply not authority, and the subject anchors on its own like any subject without an identifier.
 * The canonical nine-digit form is what gets written, so "51-412345-6" and "514123456" agree.
 */
export function authoritativeTaxId(value: string | null | undefined): string | null {
  const stripped = (value ?? "").trim().replace(/[\s\-.\/]/g, "");
  if (!/^\d{8,9}$/.test(stripped)) return null;
  const digits = stripped.padStart(9, "0");
  if (/^(\d)\1{8}$/.test(digits)) return null;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    const step = Number(digits[i]) * ((i % 2) + 1);
    sum += step > 9 ? step - 9 : step;
  }
  return sum % 10 === 0 ? digits : null;
}
