/**
 * denial.mjs — classify WHY a statement was refused (M-16 F-2).
 *
 * A battery that counts "any exception" as an RLS denial proves nothing: a unique
 * violation (P2002 / 23505), a foreign-key violation (P2003 / 23503), a missing table
 * (42P01), a ReferenceError or a dropped connection all "deny" too. These helpers
 * accept ONLY the SQLSTATE the control under test produces:
 *
 *   RLS        42501 "new row violates row-level security policy"
 *   PRIVILEGE  42501 "permission denied for ..."
 *
 * Everything else is reported by its real code so the check fails for the right reason.
 */

/** @returns {{kind: "RLS"|"PRIVILEGE"|"OTHER", code: string, message: string}} */
export function denialKind(e) {
  const msg = String(e?.message ?? e ?? "");
  const meta = e?.meta ?? {};
  const code = String(meta.code ?? e?.code ?? (msg.match(/\b(\d{2}[0-9A-Z]{3})\b/) || [])[1] ?? "");
  const is42501 = code === "42501" || /\b42501\b/.test(msg) || /Code: `42501`/.test(msg);
  if (/row-level security/i.test(msg) || /row level security/i.test(msg) || (is42501 && /row-level|policy/i.test(msg)))
    return { kind: "RLS", code: "42501", message: msg.slice(0, 200) };
  if (/permission denied/i.test(msg) || is42501) return { kind: "PRIVILEGE", code: "42501", message: msg.slice(0, 200) };
  return { kind: "OTHER", code: code || e?.name || "unknown", message: msg.slice(0, 200) };
}

/**
 * Run `fn`; succeed only if it throws AND the error is one of `kinds`.
 * @returns {Promise<{denied: boolean, kind: string, detail: string}>}
 */
export async function expectDenied(fn, kinds = ["RLS", "PRIVILEGE"]) {
  try {
    await fn();
    return { denied: false, kind: "NONE", detail: "statement SUCCEEDED — nothing denied it" };
  } catch (e) {
    const k = denialKind(e);
    // "CODE:22P02" accepts one exact SQLSTATE (e.g. a malformed tenant GUC must fail the cast).
    const codeOk = kinds.some((x) => x.startsWith("CODE:") && (x.slice(5) === k.code || String(e?.message ?? "").includes(x.slice(5))));
    return { denied: kinds.includes(k.kind) || codeOk, kind: k.kind, detail: `${k.kind} ${k.code}: ${k.message}` };
  }
}
