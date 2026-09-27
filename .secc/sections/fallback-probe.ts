/** Child process for phase3.ts state 0: the REAL modules against a database the
 * sec(C) migration has not reached (function absent). Prints one JSON line. */
async function main() {
  const wa = await import("@/lib/services/integrations/whatsapp/connection.service");
  const pos = await import("@/lib/services/inventory/pos-api-key.service");
  const out = {
    pnA: await wa.resolveBusinessIdByPhoneNumberId("pnA"),
    pnC: await wa.resolveBusinessIdByPhoneNumberId("pnC"),
    hashA: (await pos.lookupPosApiKey("hashA"))?.businessId ?? null,
  };
  console.log(`PROBE ${JSON.stringify(out)}`);
  process.exit(0);
}
main().catch((e) => { console.log(`PROBE-ERROR ${String(e?.message ?? e).slice(0, 200)}`); process.exit(2); });
