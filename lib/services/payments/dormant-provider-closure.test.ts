/**
 * Run: npx tsx lib/services/payments/dormant-provider-closure.test.ts
 *
 * CASA Wave E — PayPal and Tranzila were live, unauthenticated webhook
 * consumers whose only verification was a static token compared with `===`,
 * while production held zero rows for either provider in every provider-keyed
 * table. Rather than invent HMAC verification for providers nobody uses, the
 * capability was disabled.
 *
 * What this matrix pins is not "the code has a flag" but the properties that
 * make the closure real:
 *
 *   - a callback to a dormant provider reaches NO processing, so nothing can be
 *     persisted, mutated or verified;
 *   - the connect path is closed SERVER-side, so removing the option from the
 *     settings UI is not the control — a direct API call is refused too;
 *   - CardCom and the provider framework are untouched;
 *   - the disabled providers remain interpretable, so a historical record would
 *     still render.
 *
 * Deterministic and OFFLINE: in-memory store, stub provider, no DB, no network,
 * no crypto key.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  connectPaymentProvider,
  connectProviderFromDescriptor,
  listPaymentConnections,
  type PaymentConnectionDeps,
} from "./payment-connection.service";
import { handleProviderWebhook } from "./payment-webhook-handler";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import {
  DISABLED_PAYMENT_PROVIDERS,
  PaymentProviderDisabledError,
  isPaymentProviderEnabled,
} from "./providers/provider-availability";
import {
  getProviderDescriptor,
  listAllProviderDescriptors,
  listProviderDescriptors,
} from "./providers/provider-registry";
import type { ProcessWebhookDeps } from "./payment-webhook.service";
import type { EncryptedCredentialMaterial } from "./payment-crypto.service";

const fakeEncrypt = (plaintext: string): EncryptedCredentialMaterial => ({
  credentialEncrypted: `ENC(${plaintext})`,
  credentialIv: "IV",
  credentialTag: "TAG",
  encryptionKeyId: "k1",
});

const DORMANT = ["PAYPAL", "TRANZILA"] as const;

let pass = 0;
const ok = (label: string, condition: boolean) => {
  assert.ok(condition, label);
  pass += 1;
};

async function main() {
  // ── 1. the disabled set is exactly PayPal + Tranzila ─────────────────────
  {
    assert.deepEqual(
      [...DISABLED_PAYMENT_PROVIDERS].sort(),
      ["PAYPAL", "TRANZILA"],
      "only the two dormant providers are disabled"
    );
    ok("CardCom remains enabled", isPaymentProviderEnabled("CARDCOM"));
    pass += 1;
  }

  // ── 2. a dormant callback reaches no processing at all ───────────────────
  // The strongest available assertion: the store is handed to the handler, and
  // a provider that would throw if invoked. If either the persistence layer or
  // provider verification were reached, this fails.
  for (const provider of DORMANT) {
    const store = createInMemoryPaymentStore();
    let providerInvoked = false;
    const deps = {
      store,
      resolveProvider: () => {
        providerInvoked = true;
        throw new Error("provider verification must not be invoked");
      },
    } as unknown as ProcessWebhookDeps;

    const result = await handleProviderWebhook(
      {
        provider,
        rawBody: JSON.stringify({ hostile: true, amount: 999_999 }),
        headers: { "x-forged": "1" },
      },
      deps
    );

    ok(`${provider}: refused with 404`, result.status === 404);
    ok(
      `${provider}: response does not claim success`,
      result.body.ok === false
    );
    ok(
      `${provider}: response names the reason`,
      "error" in result.body && result.body.error === "provider_not_supported"
    );
    ok(`${provider}: provider verification NOT invoked`, providerInvoked === false);
    ok(`${provider}: no PaymentWebhookEvent persisted`, store.webhookEvents.length === 0);
    ok(`${provider}: no PaymentTransaction created`, store.transactions.length === 0);
    ok(`${provider}: no audit event recorded`, store.auditEvents.length === 0);
    ok(`${provider}: no PaymentRequest touched`, store.requests.length === 0);
  }

  // ── 3. the connect path is closed SERVER-side, not just in the UI ────────
  // This is the direct-API-bypass proof: the call below is exactly what
  // POST /api/payments/connections/tranzila performs after authorization.
  for (const provider of DORMANT) {
    const store = createInMemoryPaymentStore();
    const deps: PaymentConnectionDeps = { store, encryptCredential: fakeEncrypt };
    await assert.rejects(
      () =>
        connectProviderFromDescriptor(
          {
            businessId: 1,
            provider,
            fields: {
              merchantId: "m-1",
              secret: "s-1",
              terminalNumber: "t-1",
              apiName: "a",
              apiPassword: "p",
            },
          },
          deps
        ),
      (err: unknown) => err instanceof PaymentProviderDisabledError,
      `${provider}: connect must be refused`
    );
    const after = await listPaymentConnections(1, deps);
    ok(`${provider}: no connection row created`, after.length === 0);
    ok(`${provider}: no audit event recorded`, store.auditEvents.length === 0);
    pass += 1;
  }

  // ── 4. the catalogue no longer advertises them ───────────────────────────
  {
    const offered = listProviderDescriptors().map((d) => d.key).sort();
    assert.deepEqual(offered, ["CARDCOM"], "catalogue offers CardCom only");
    ok(
      "no dormant provider is advertised",
      offered.every((k) => isPaymentProviderEnabled(k))
    );
    pass += 1;
  }

  // ── 5. historical compatibility — disabled ≠ deleted ─────────────────────
  {
    const all = listAllProviderDescriptors().map((d) => d.key).sort();
    assert.deepEqual(
      all,
      ["CARDCOM", "PAYPAL", "TRANZILA"],
      "every descriptor is still resolvable for historical records"
    );
    for (const provider of DORMANT) {
      ok(
        `${provider}: descriptor still resolvable`,
        getProviderDescriptor(provider) !== null
      );
    }
    const schema = fs
      .readFileSync("prisma/schema.prisma", "utf8")
      .replace(/\r\n/g, "\n");
    for (const provider of DORMANT) {
      ok(
        `${provider}: Prisma enum value retained`,
        new RegExp(`^\\s*${provider}\\s*$`, "m").test(schema)
      );
    }
  }

  // ── 6. CardCom is unaffected ─────────────────────────────────────────────
  {
    const store = createInMemoryPaymentStore();
    const deps: PaymentConnectionDeps = { store, encryptCredential: fakeEncrypt };
    const conn = await connectProviderFromDescriptor(
      {
        businessId: 1,
        provider: "CARDCOM",
        fields: { terminalNumber: "1000", apiName: "api", apiPassword: "pw" },
      },
      deps
    );
    ok("CardCom still connects", conn.provider === "CARDCOM");
    ok("CardCom connection is active", conn.isActive === true);
    ok("CardCom secret is never returned", !JSON.stringify(conn).includes("pw"));

    // And a CardCom webhook still reaches processing (the stub provider stands
    // in for the real adapter; what matters is that the gate did not fire).
    const wStore = createInMemoryPaymentStore();
    const stub = createStubProvider();
    let reached = false;
    const wDeps = {
      store: wStore,
      resolveProvider: () => {
        reached = true;
        return stub;
      },
    } as unknown as ProcessWebhookDeps;
    const res = await handleProviderWebhook(
      { provider: "CARDCOM", rawBody: "{}", headers: {} },
      wDeps
    );
    ok("CardCom webhook is not refused by the gate", res.status === 200);
    ok("CardCom webhook reaches processing", reached === true);
  }

  // ── 7. the lower-level connect helper still serves history/tests ─────────
  // Deliberately NOT gated: connectProviderFromDescriptor is the single path
  // every API route uses, so the gate lives there. Guard 8 proves no route can
  // reach around it.
  {
    const store = createInMemoryPaymentStore();
    const deps: PaymentConnectionDeps = { store, encryptCredential: fakeEncrypt };
    const conn = await connectPaymentProvider(
      { businessId: 1, provider: "CARDCOM", merchantId: "m", credential: "c" },
      deps
    );
    ok("framework-level connect still works for CardCom", conn.provider === "CARDCOM");
  }

  // ── 8. STRUCTURAL GUARD — no connect route may bypass the gate ───────────
  {
    const routes = [
      "app/api/payments/connections/route.ts",
      "app/api/payments/connections/cardcom/route.ts",
      "app/api/payments/connections/tranzila/route.ts",
    ];
    for (const route of routes) {
      if (!fs.existsSync(route)) continue;
      const src = fs.readFileSync(route, "utf8");
      ok(
        `${route}: goes through the gated descriptor path`,
        src.includes("connectProviderFromDescriptor")
      );
      ok(
        `${route}: does not call the ungated helper directly`,
        !/\bconnectPaymentProvider\b/.test(src)
      );
    }
  }

  // ── 9. STRUCTURAL GUARD — the UI cannot re-enable on its own ─────────────
  // A future edit that puts Tranzila back in the settings picker without
  // re-enabling the capability fails here rather than shipping a provider whose
  // callback is switched off.
  {
    const ui = fs.readFileSync(
      "components/settings/PaymentConnectionCard.tsx",
      "utf8"
    );
    const m = ui.match(
      /const SELECTABLE_PROVIDERS: readonly ProviderKey\[\] = \[([^\]]*)\]/
    );
    assert.ok(m, "SELECTABLE_PROVIDERS must exist in the settings card");
    const selectable = [...m[1].matchAll(/"([A-Z]+)"/g)].map((x) => x[1]).sort();
    const enabled = listProviderDescriptors().map((d) => d.key).sort();
    assert.deepEqual(
      selectable,
      enabled,
      "the settings picker must offer exactly the server-enabled providers"
    );
    for (const provider of DORMANT) {
      ok(
        `${provider}: not selectable in the settings UI`,
        !selectable.includes(provider)
      );
    }
    ok(
      "the picker no longer hardcodes a dormant <option>",
      !/<option value="(TRANZILA|PAYPAL)"/.test(ui)
    );
    ok("the default selection is not a dormant provider", !/useState<ProviderKey>\("(TRANZILA|PAYPAL)"\)/.test(ui));
  }

  console.log(
    `CASA Wave E — dormant provider closure (PayPal + Tranzila): OK — ${pass}/${pass}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
