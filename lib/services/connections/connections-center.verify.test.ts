/**
 * Connections center (S1-B · M1) — checked without a database (`npm run verify:connections-center`).
 *
 *   1. Mapping per source: state, attention kind (action only where a working fix exists),
 *      availability (the gate each mechanism already uses), error copy incl. the unknown-code fallback.
 *   2. Hidden: Rivhit while pos_rivhit is off; disabled payment providers; sources not enabled.
 *   3. Isolation: one read throwing marks only its own cards unavailable; the response still resolves,
 *      and only the error NAME is logged.
 *   4. Secrecy: the service selects no credential / token / provider-message column.
 *   5. Copy: every key the model can emit exists in Hebrew and English; the stores panel's health
 *      copy is unchanged after moving to the shared map.
 *   6. Route: 401 without a session. Page: the four management components and the OAuth landing stay.
 */
import fs from "node:fs";
import path from "node:path";

import { en } from "@/lib/i18n/messages/en";
import { he } from "@/lib/i18n/messages/he";
import { listProviderDescriptors } from "@/lib/services/payments/providers/provider-registry";

import { CLOUDTALK_CREDENTIAL_CODES } from "@/lib/intake/calls/cloudtalk";

import { CONNECTION_HEALTH, connectionHealthKey } from "./connection-health-copy";
import {
  ACQUISITION_SOURCES,
  CATEGORY_TITLE,
  UNAVAILABLE_CARDS,
  assembleConnectionsCenter,
  mapAcquisitionCards,
  mapAuthorityCards,
  mapGmailCards,
  mapInboundEmailCards,
  mapPaymentCards,
  mapWhatsAppCards,
  type AcquisitionConnectionRow,
  type AcquisitionInput,
  type ConnectionCard,
} from "./connections-center.model";
import { loadConnectionsCenter, type ConnectionsCenterReaders } from "./connections-center.service";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  OK    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function lookup(dict: unknown, key: string): string | undefined {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}
const heText = (key: string) => lookup(he, key) ?? `<missing ${key}>`;

/** Every MessageKey a card carries. */
function cardKeys(c: ConnectionCard): string[] {
  return [
    c.nameKey,
    ...(c.lastActivity ? [c.lastActivity.labelKey] : []),
    ...(c.errorKey ? [c.errorKey] : []),
    ...c.provides,
    ...(c.manage ? [c.manage.labelKey] : []),
    ...(c.attention ? [c.attention.textKey, ...(c.attention.action ? [c.attention.action.labelKey] : [])] : []),
  ];
}
const emitted = new Set<string>();
function track(cards: ConnectionCard[]): ConnectionCard[] {
  for (const c of cards) for (const k of cardKeys(c)) emitted.add(k);
  return cards;
}

const T = new Date("2026-10-20T08:30:00.000Z");
const row = (id: number, sourceKey: string, status: string, extra: Partial<AcquisitionConnectionRow> = {}): AcquisitionConnectionRow => ({
  id,
  sourceKey,
  status,
  label: null,
  lastEventAt: T,
  lastErrorCode: null,
  ...extra,
});
const acq = (over: Partial<AcquisitionInput>): AcquisitionInput => ({
  enabled: {},
  connections: [],
  metaAvailable: false,
  wixAvailable: false,
  ...over,
});

async function main() {
  console.log("\n  acquisition — availability");
  {
    const cards = track(
      mapAcquisitionCards(
        acq({
          enabled: {},
          connections: [row(1, "web.form", "ACTIVE"), row(2, "commerce.woocommerce", "ACTIVE"), row(3, "pos.rivhit", "ACTIVE")],
        })
      )
    );
    ok("a source the business is not enabled for adds no card, even with an ACTIVE connection", cards.length === 0, JSON.stringify(cards));
  }
  {
    const cards = track(mapAcquisitionCards(acq({ enabled: { "pos.rivhit": false }, connections: [row(3, "pos.rivhit", "ACTIVE")] })));
    ok("Rivhit is hidden while pos_rivhit is off (connection or not)", cards.length === 0);
  }
  {
    const cards = track(mapAcquisitionCards(acq({ enabled: { "pos.rivhit": true }, connections: [] })));
    ok("Rivhit allowed but not connected → no card (no connect UI in M1)", cards.length === 0);
  }
  {
    const [c] = track(mapAcquisitionCards(acq({ enabled: { "pos.rivhit": true }, connections: [row(3, "pos.rivhit", "ACTIVE", { label: "רווחית ראשי" })] })));
    ok(
      "Rivhit allowed + connected → read-only invoices card (no manage link)",
      c?.category === "invoices" && c.state === "connected" && c.manage === null && c.accountLabel === "רווחית ראשי",
      JSON.stringify(c)
    );
  }
  {
    const [c] = track(
      mapAcquisitionCards(acq({ enabled: { "pos.rivhit": true }, connections: [row(3, "pos.rivhit", "ERROR", { lastErrorCode: "RIVHIT_TOKEN_REJECTED" })] }))
    );
    ok(
      "Rivhit RIVHIT_TOKEN_REJECTED → attention, info only (reconnecting is M2), its own copy",
      c?.state === "attention" && c.attention?.kind === "info" && c.errorKey === "account.settings.connections.center.health.rivhitTokenRejected",
      JSON.stringify(c)
    );
  }
  {
    const cards = track(mapAcquisitionCards(acq({ enabled: { "web.form": true, "google.lead_form": true } })));
    ok(
      "an enabled source with no connection → one 'disconnected' card with the panel anchor",
      cards.length === 2 && cards.every((c) => c.state === "disconnected" && c.manage?.href === "#connections-leads" && c.attention === null),
      JSON.stringify(cards)
    );
  }
  {
    const cards = track(mapAcquisitionCards(acq({ enabled: { "meta.lead_ads": true, "commerce.wix": true }, metaAvailable: false, wixAvailable: false })));
    ok("Meta / Wix enabled but their Dubiz app not configured, no connection → no card (nothing to connect)", cards.length === 0, JSON.stringify(cards));
  }
  {
    const cards = track(mapAcquisitionCards(acq({ enabled: { "meta.lead_ads": true, "commerce.wix": true }, metaAvailable: true, wixAvailable: true })));
    ok("Meta / Wix connectable → 'disconnected' cards", cards.length === 2 && cards.every((c) => c.state === "disconnected"));
  }
  {
    const cards = track(
      mapAcquisitionCards(acq({ enabled: { "web.form": true }, connections: [row(1, "web.form", "ACTIVE"), row(2, "web.form", "REVOKED"), row(4, "web.form", "ACTIVE", { lastEventAt: null })] }))
    );
    ok("one card per live connection; REVOKED is not shown", cards.length === 2 && cards.map((c) => c.id).join() === "web.form:1,web.form:4");
    ok(
      "ACTIVE → connected; lastActivity = lastEventAt, labelled 'עדכון אחרון התקבל'",
      cards[0]!.state === "connected" && cards[0]!.lastActivity?.at === T.toISOString() && heText(cards[0]!.lastActivity!.labelKey) === "עדכון אחרון התקבל"
    );
    ok("no event yet → no lastActivity (never a made-up time)", cards[1]!.lastActivity === null);
  }

  console.log("\n  acquisition — state and attention");
  {
    const [c] = track(mapAcquisitionCards(acq({ enabled: { "web.form": true }, connections: [row(1, "web.form", "PAUSED")] })));
    ok("PAUSED → paused + info (the owner's choice; no button)", c?.state === "paused" && c.attention?.kind === "info" && !c.attention.action);
  }
  {
    const [c] = track(
      mapAcquisitionCards(acq({ enabled: { "commerce.woocommerce": true }, connections: [row(5, "commerce.woocommerce", "ERROR", { lastErrorCode: "WOO_KEYS_REVOKED" })] }))
    );
    ok(
      "WOO_KEYS_REVOKED → action to the stores panel (its reconnect works)",
      c?.state === "attention" && c.attention?.kind === "action" && c.attention.action?.href === "#connections-stores" && c.errorKey === CONNECTION_HEALTH.WOO_KEYS_REVOKED,
      JSON.stringify(c)
    );
  }
  {
    const [c] = track(
      mapAcquisitionCards(acq({ enabled: { "commerce.woocommerce": true }, connections: [row(5, "commerce.woocommerce", "ERROR", { lastErrorCode: "WOO_STORE_UNREACHABLE" })] }))
    );
    ok("WOO_STORE_UNREACHABLE → info (Dubiz retries itself), its copy", c?.attention?.kind === "info" && c.errorKey === CONNECTION_HEALTH.WOO_STORE_UNREACHABLE);
  }
  {
    const fixable = track(mapAcquisitionCards(acq({ enabled: { "commerce.wix": true }, wixAvailable: true, connections: [row(6, "commerce.wix", "ERROR", { lastErrorCode: "WIX_APP_UNINSTALLED" })] })))[0];
    const notFixable = track(mapAcquisitionCards(acq({ enabled: { "commerce.wix": true }, wixAvailable: false, connections: [row(6, "commerce.wix", "ERROR", { lastErrorCode: "WIX_APP_UNINSTALLED" })] })))[0];
    ok("WIX_APP_UNINSTALLED with the Wix app configured → action (the install link works)", fixable?.attention?.kind === "action");
    ok("WIX_APP_UNINSTALLED without the Wix app configured → info (no working install link)", notFixable?.attention?.kind === "info" && notFixable.state === "attention");
  }
  {
    const [c] = track(
      mapAcquisitionCards(acq({ enabled: { "meta.lead_ads": true }, metaAvailable: true, connections: [row(7, "meta.lead_ads", "ERROR", { lastErrorCode: "META_TOKEN_INVALID" })] }))
    );
    ok("META_TOKEN_INVALID → info (Meta reconnect is not open yet), its copy", c?.attention?.kind === "info" && c.errorKey === CONNECTION_HEALTH.META_TOKEN_INVALID);
  }
  {
    const [unknown] = track(mapAcquisitionCards(acq({ enabled: { "telephony.cloudtalk": true }, connections: [row(8, "telephony.cloudtalk", "ERROR", { lastErrorCode: "SOMETHING_NEW" })] })));
    const [none] = track(mapAcquisitionCards(acq({ enabled: { "telephony.cloudtalk": true }, connections: [row(8, "telephony.cloudtalk", "ERROR")] })));
    ok(
      "an unknown code → the generic Hebrew copy, info, never the raw code",
      unknown?.errorKey === "account.settings.connections.center.health.generic" && unknown.attention?.kind === "info" && !JSON.stringify(unknown).includes("SOMETHING_NEW")
    );
    ok("ERROR with no code → the generic copy", none?.errorKey === "account.settings.connections.center.health.generic");
  }
  {
    // Leads L1 · G-06 — CloudTalk's API key problem sits on a connection that stays ACTIVE (calls keep arriving).
    const ct = (extra: Partial<AcquisitionConnectionRow> = {}, id = 8) => row(id, "telephony.cloudtalk", "ACTIVE", extra);
    const on = { "telephony.cloudtalk": true };
    const [healthy] = track(mapAcquisitionCards(acq({ enabled: on, connections: [ct()] })));
    ok("G-06: a healthy ACTIVE CloudTalk line → connected", healthy?.state === "connected" && healthy.attention === null && healthy.errorKey === null);
    for (const code of CLOUDTALK_CREDENTIAL_CODES) {
      const [c] = track(mapAcquisitionCards(acq({ enabled: on, connections: [ct({ lastErrorCode: code })] })));
      ok(
        `G-06: ACTIVE + ${code} → attention with its own copy and a fix in the stores panel (never "connected")`,
        c?.state === "attention" && c.errorKey === CONNECTION_HEALTH[code] && c.attention?.kind === "action"
          && c.attention.action?.href === "#connections-stores" && c.attention.textKey === CONNECTION_HEALTH[code]
      );
      ok(`G-06: …${code}: no raw code, key or secret in the card`, !/CLOUDTALK_|apiKey|secret|whsec/i.test(JSON.stringify(c)));
    }
    const [fixed] = track(mapAcquisitionCards(acq({ enabled: on, connections: [ct({ lastErrorCode: null })] })));
    ok("G-06: the code cleared (a key saved / CloudTalk answers) → connected again", fixed?.state === "connected" && fixed.attention === null);
    const [unknown] = track(mapAcquisitionCards(acq({ enabled: on, connections: [ct({ lastErrorCode: "SOMETHING_NEW" })] })));
    ok("G-06: ACTIVE with a code outside the shared map → still connected (the panel shows nothing for it either)", unknown?.state === "connected");
    const two = track(mapAcquisitionCards(acq({ enabled: on, connections: [ct({ lastErrorCode: "CLOUDTALK_API_KEY_MISSING" }, 8), ct({}, 9)] })));
    ok("G-06: per connection — only the line with the key problem asks for attention",
      two.length === 2 && two.find((c) => c.id === "telephony.cloudtalk:8")?.state === "attention" && two.find((c) => c.id === "telephony.cloudtalk:9")?.state === "connected");
    ok("G-06: platform flag off → no CloudTalk card in the center (the stores panel shows it as platform-disabled)",
      mapAcquisitionCards(acq({ enabled: { "telephony.cloudtalk": false }, connections: [ct({ lastErrorCode: "CLOUDTALK_API_KEY_MISSING" })] })).length === 0);
    const panel = fs.readFileSync(path.join(process.cwd(), "components/settings/StoresAndCallsPanel.tsx"), "utf8");
    ok("G-06: the center and the stores panel use the same rule (ACTIVE + a code from the shared map)",
      panel.includes(`c.status === "ACTIVE" && has(CONNECTION_HEALTH, c.lastErrorCode)`)
        && CLOUDTALK_CREDENTIAL_CODES.every((code) => !!CONNECTION_HEALTH[code] && heText(CONNECTION_HEALTH[code]!).length > 20));
  }
  ok("every acquisition source sits in its business category", ACQUISITION_SOURCES["web.form"].category === "leads" && ACQUISITION_SOURCES["telephony.voicenter"].category === "stores_calls" && ACQUISITION_SOURCES["pos.rivhit"].category === "invoices");

  console.log("\n  payments");
  const catalogue = listProviderDescriptors().map((d) => d.key);
  ok("the payment catalogue offers CARDCOM only (PayPal, Tranzila, SUMIT, PayPlus are not live)", catalogue.join() === "CARDCOM", catalogue.join());
  {
    const cards = track(
      mapPaymentCards({
        enabledProviders: catalogue,
        connections: [
          { id: 1, provider: "PAYPAL", isActive: true, updatedAt: T },
          { id: 2, provider: "SUMIT", isActive: true, updatedAt: T },
          { id: 3, provider: "CARDCOM", isActive: true, updatedAt: T },
        ],
      })
    );
    ok("a stored row of a disabled provider is hidden", cards.length === 1 && cards[0]!.provider === "CARDCOM");
    ok(
      "CARDCOM active → connected; provides 'תשלומים שנגבו בדוביז' (not sales)",
      cards[0]!.state === "connected" && cards[0]!.provides.map(heText).join() === "תשלומים שנגבו בדוביז" && cards[0]!.manage?.href === "#connections-payments"
    );
    ok("its time is labelled as a settings change, not activity", heText(cards[0]!.lastActivity!.labelKey) === "פרטי החיבור עודכנו");
  }
  {
    const inactive = track(mapPaymentCards({ enabledProviders: catalogue, connections: [{ id: 3, provider: "CARDCOM", isActive: false, updatedAt: T }] }));
    const none = track(mapPaymentCards({ enabledProviders: catalogue, connections: [] }));
    ok("CARDCOM inactive → disconnected, no time", inactive[0]?.state === "disconnected" && inactive[0].lastActivity === null);
    ok("no payment connection → one 'disconnected' CardCom card", none.length === 1 && none[0]!.state === "disconnected");
    ok("payments never raise attention", [...inactive, ...none].every((c) => c.attention === null));
  }

  console.log("\n  tax authority");
  ok("NOT_CONFIGURED → no card (the card below says it)", mapAuthorityCards({ status: "NOT_CONFIGURED", connectedAt: null }).length === 0);
  ok("DISCONNECTED → no card (its connect button is not open yet)", mapAuthorityCards({ status: "DISCONNECTED", connectedAt: null }).length === 0);
  {
    const [c] = track(mapAuthorityCards({ status: "CONNECTED", connectedAt: T.toISOString() }));
    ok("CONNECTED → connected, time = OAuth authorization", c?.state === "connected" && heText(c.lastActivity!.labelKey) === "אושר ברשות המסים");
  }
  for (const s of ["EXPIRED", "REVOKED", "ERROR"] as const) {
    const [c] = track(mapAuthorityCards({ status: s, connectedAt: T.toISOString() }));
    ok(`${s} → attention, info only (reconnect is not open yet)`, c?.state === "attention" && c.attention?.kind === "info" && !c.attention.action && !!c.errorKey);
  }

  console.log("\n  WhatsApp");
  {
    const [none] = track(mapWhatsAppCards(null));
    ok("no row → disconnected, manage /settings/whatsapp", none?.state === "disconnected" && none.manage?.href === "/settings/whatsapp");
    const [conn] = track(mapWhatsAppCards({ status: "CONNECTED", displayPhoneNumber: "+972 50-000-0000", lastVerifiedAt: T }));
    ok("CONNECTED → connected, number shown, 'אומת לאחרונה'", conn?.state === "connected" && conn.accountLabel === "+972 50-000-0000" && heText(conn.lastActivity!.labelKey) === "אומת לאחרונה");
    for (const s of ["REVOKED_BY_META", "ERROR"]) {
      const [c] = track(mapWhatsAppCards({ status: s, displayPhoneNumber: "+972", lastVerifiedAt: null }));
      ok(`${s} → attention, info (reconnect is "בקרוב" on /settings/whatsapp)`, c?.state === "attention" && c.attention?.kind === "info");
    }
    for (const s of ["REVOKED", "DISCONNECTED"]) {
      const [c] = track(mapWhatsAppCards({ status: s, displayPhoneNumber: "+972", lastVerifiedAt: T }));
      ok(`${s} → disconnected, no number, no attention`, c?.state === "disconnected" && c.accountLabel === null && c.attention === null);
    }
  }

  console.log("\n  Gmail");
  {
    ok("no account → one disconnected card", track(mapGmailCards([]))[0]?.state === "disconnected");
    ok("only revoked accounts → one disconnected card", (() => { const c = track(mapGmailCards([{ id: 1, emailAddress: "a@x.test", status: "revoked", lastSyncedAt: T }])); return c.length === 1 && c[0]!.state === "disconnected" && c[0]!.accountLabel === null; })());
    const two = track(
      mapGmailCards([
        { id: 2, emailAddress: "b@x.test", status: "connected", lastSyncedAt: T },
        { id: 3, emailAddress: "c@x.test", status: "error", lastSyncedAt: null },
      ])
    );
    ok("one card per connected / errored account", two.length === 2 && two[0]!.state === "connected" && heText(two[0]!.lastActivity!.labelKey) === "סונכרן לאחרונה");
    ok(
      "error → action to /documents/email (its reconnect works), generic copy (never lastError)",
      two[1]!.state === "attention" && two[1]!.attention?.kind === "action" && two[1]!.attention.action?.href === "/documents/email" && two[1]!.errorKey === "account.settings.connections.center.gmail.error"
    );
  }

  console.log("\n  inbound email");
  ok("switch off → no card (its page is notFound())", mapInboundEmailCards({ enabled: false, addresses: [{ status: "ACTIVE", lastReceivedAt: T }] }).length === 0);
  ok("switch on, no address → disconnected", track(mapInboundEmailCards({ enabled: true, addresses: [] }))[0]?.state === "disconnected");
  {
    const [c] = track(mapInboundEmailCards({ enabled: true, addresses: [{ status: "ACTIVE", lastReceivedAt: T }] }));
    ok("ACTIVE address → connected, 'מייל אחרון התקבל', manage /settings/inbound-email", c?.state === "connected" && heText(c.lastActivity!.labelKey) === "מייל אחרון התקבל" && c.manage?.href === "/settings/inbound-email");
  }
  ok("only a RETIRING address → disconnected", track(mapInboundEmailCards({ enabled: true, addresses: [{ status: "RETIRING", lastReceivedAt: T }] }))[0]?.state === "disconnected");

  console.log("\n  assembly + isolation");
  {
    const empty = assembleConnectionsCenter([], []);
    ok("nothing → no categories, zero counts", empty.categories.length === 0 && empty.counts.connected === 0 && empty.counts.needsAction === 0);
  }
  const happy: ConnectionsCenterReaders = {
    acquisition: async () => acq({ enabled: { "web.form": true, "commerce.woocommerce": true }, connections: [row(1, "web.form", "ACTIVE"), row(5, "commerce.woocommerce", "ERROR", { lastErrorCode: "WOO_KEYS_REVOKED" })] }),
    payments: async () => ({ enabledProviders: ["CARDCOM"], connections: [{ id: 3, provider: "CARDCOM", isActive: true, updatedAt: T }] }),
    authority: async () => ({ status: "CONNECTED", connectedAt: T.toISOString() }),
    whatsapp: async () => ({ status: "CONNECTED", displayPhoneNumber: "+972", lastVerifiedAt: T }),
    gmail: async () => [{ id: 2, emailAddress: "b@x.test", status: "error", lastSyncedAt: T }],
    inboundEmail: async () => ({ enabled: false, addresses: [] }),
  };
  const caller = { businessId: 9, userId: 1 };
  {
    const center = await loadConnectionsCenter(caller, happy);
    for (const g of center.categories) for (const c of g.cards) track([c]);
    ok(
      "categories in business order, empty ones (pos) left out",
      center.categories.map((g) => g.category).join() === "invoices,payments,messaging,leads,stores_calls,authority",
      center.categories.map((g) => g.category).join()
    );
    ok("counts: connected 4 (web form, CardCom, WhatsApp, authority) · needs action 2 (Woo, Gmail)", center.counts.connected === 4 && center.counts.needsAction === 2, JSON.stringify(center.counts));
    ok("no source unavailable", center.unavailableSources.length === 0);
  }
  const secret = "token=sk_live_SHOULD_NEVER_APPEAR";
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const center = await loadConnectionsCenter(caller, {
      ...happy,
      authority: async () => {
        const e = new Error(secret);
        e.name = "AuthorityProbeError";
        throw e;
      },
    });
    const authority = center.categories.find((g) => g.category === "authority");
    ok(
      "authority throwing → only its card is 'unavailable' with 'לא הצלחנו לבדוק כרגע'",
      authority?.cards.length === 1 && authority.cards[0]!.state === "unavailable" && heText(authority.cards[0]!.errorKey!) === "לא הצלחנו לבדוק כרגע"
    );
    ok("…every other category is intact", center.categories.find((g) => g.category === "payments")?.cards[0]?.state === "connected" && center.counts.connected === 3);
    ok("…unavailableSources names it", center.unavailableSources.join() === "authority");
    ok("…the log carries the error name only", errors.length === 1 && errors[0]!.includes("AuthorityProbeError") && !errors.join().includes("sk_live"));
    ok("…the response carries no error text", !JSON.stringify(center).includes("sk_live"));

    const acqDown = await loadConnectionsCenter(caller, { ...happy, acquisition: async () => { throw new TypeError("x"); } });
    ok(
      "acquisition throwing → leads and stores & calls each show one unavailable card; payments etc. intact",
      acqDown.categories.find((g) => g.category === "leads")?.cards.every((c) => c.state === "unavailable") === true &&
        acqDown.categories.find((g) => g.category === "stores_calls")?.cards.every((c) => c.state === "unavailable") === true &&
        acqDown.categories.find((g) => g.category === "invoices")?.cards.some((c) => c.provider === "gmail" && c.state === "attention") === true
    );

    const boom = async () => { throw new Error("down"); };
    const allDown = await loadConnectionsCenter(caller, { acquisition: boom, payments: boom, authority: boom, whatsapp: boom, gmail: boom, inboundEmail: boom });
    ok("every read throwing → the response still resolves, all six unavailable, zero counts", allDown.unavailableSources.length === 6 && allDown.counts.connected === 0);
  } finally {
    console.error = origError;
  }
  ok("every source has an unavailable placeholder", Object.values(UNAVAILABLE_CARDS).every((cards) => cards.length > 0));

  console.log("\n  secrecy — the reads select no secret");
  {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/services/connections/connections-center.service.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of [
      "credentialEncrypted",
      "credentialIv",
      "credentialTag",
      "merchantId",
      "credentialsEncrypted",
      "keyHash",
      "lastErrorMessage",
      "lastError:",
      "accessToken",
      "refreshToken",
      "localPartEncrypted",
      "readConnectionSecrets",
      "rivhitStatus",
      "decrypt",
      "getAccessTokenForBusiness",
      "listPaymentConnections",
    ]) {
      ok(`connections-center.service.ts never names ${banned}`, !code.includes(banned));
    }
    ok("…and never writes (no create / update / delete / upsert)", !/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/.test(code));
  }

  console.log("\n  copy");
  {
    for (const k of Object.values(CATEGORY_TITLE)) emitted.add(k);
    for (const s of ["connected", "attention", "paused", "disconnected", "unavailable"]) emitted.add(`account.settings.connections.center.state.${s}`);
    const missingHe = [...emitted].filter((k) => lookup(he, k) === undefined);
    const missingEn = [...emitted].filter((k) => lookup(en, k) === undefined);
    ok(`every emitted key (${emitted.size}) exists in Hebrew`, missingHe.length === 0, missingHe.join());
    ok("…and in English", missingEn.length === 0, missingEn.join());
    ok(
      "category titles are the agreed Hebrew",
      Object.values(CATEGORY_TITLE).map(heText).join("|") === "חשבוניות ומסמכים|קופות|סליקה וגבייה|תקשורת|לידים|חנויות ושיחות|רשויות"
    );
    // The panel's map before the move (StoresAndCallsPanel @ 5dcc498c) — rendered text must not change.
    const before: Record<string, string> = {
      WOO_KEYS_REVOKED: "account.settings.connections.stores.health.wooKeysRevoked",
      WOO_STORE_UNREACHABLE: "account.settings.connections.stores.health.wooUnreachable",
      WOO_STORE_ERROR: "account.settings.connections.stores.health.wooError",
      WOO_WEBHOOK_SETUP_FAILED: "account.settings.connections.stores.health.wooWebhookSetupFailed",
      WOO_RECONCILE_FAILED: "account.settings.connections.stores.health.reconcileFailed",
      WIX_APP_UNINSTALLED: "account.settings.connections.stores.health.wixUninstalled",
      WIX_RECONCILE_FAILED: "account.settings.connections.stores.health.reconcileFailed",
    };
    const panelFallback = "account.settings.connections.stores.health.generic" as const;
    ok(
      "the stores panel resolves every one of its codes to the same key as before",
      Object.entries(before).every(([code, key]) => connectionHealthKey(code, panelFallback) === key)
    );
    ok("…and an unknown code to its old fallback", connectionHealthKey("NOPE", panelFallback) === panelFallback);
    ok("the center's own fallback is generic Hebrew", heText(connectionHealthKey("NOPE")) === "יש בעיה בחיבור.");
    const panel = fs.readFileSync(path.join(process.cwd(), "components/settings/StoresAndCallsPanel.tsx"), "utf8");
    ok("the panel uses the shared map with its old fallback", panel.includes(`connectionHealthKey(c.lastErrorCode, "account.settings.connections.stores.health.generic")`) && !panel.includes("const HEALTH"));
  }

  console.log("\n  route + page");
  {
    const { GET } = await import("@/app/api/settings/connections-center/route");
    const none = await GET(new Request("http://t/api/settings/connections-center"));
    ok("GET without a session → 401", none.status === 401, String(none.status));
    const forged = await GET(new Request("http://t/api/settings/connections-center", { headers: { authorization: "Bearer not-a-token" } }));
    ok("GET with a forged token → 401", forged.status === 401, String(forged.status));
    const body = (await none.json()) as Record<string, unknown>;
    ok("the 401 body carries no detail", JSON.stringify(body) === JSON.stringify({ error: "Unauthorized" }));

    const pageSrc = fs.readFileSync(path.join(process.cwd(), "app/settings/connections/page.tsx"), "utf8");
    for (const c of ["<PaymentConnectionCard />", "<AuthorityConnectionCard />", "<LeadSourcesPanel />", "<StoresAndCallsPanel />", "account.settings.connections.page.footnote"]) {
      ok(`the page still renders ${c}`, pageSrc.includes(c));
    }
    ok("the page no longer mounts IntegrationStatusCards (WhatsApp / Gmail are status rows)", !pageSrc.includes("IntegrationStatusCards"));
    ok("IntegrationStatusCards itself is kept (no deletions in M1)", fs.existsSync(path.join(process.cwd(), "components/settings/IntegrationStatusCards.tsx")));
    const woo = fs.readFileSync(path.join(process.cwd(), "lib/intake/commerce/woocommerce-connect.ts"), "utf8");
    const tax = fs.readFileSync(path.join(process.cwd(), "app/api/taxes/oauth/callback/route.ts"), "utf8");
    ok("WooCommerce still returns to /settings/connections?store=woocommerce", woo.includes("/settings/connections?store=woocommerce"));
    ok("the tax authority callback still returns to /settings/connections", tax.includes(`const RESULT_PATH = "/settings/connections";`));
  }

  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    process.exitCode = 1;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
