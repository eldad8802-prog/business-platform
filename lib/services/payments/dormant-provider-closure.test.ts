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
  // ── 1. the disabled set is exactly the dormant + unproven providers ──────
  //
  // PayPal and Tranzila are DORMANT: live, unauthenticated webhook consumers
  // with no verification path, disabled in CASA Wave E.
  //
  // SUMIT is disabled for a different reason, and keeping the two reasons
  // distinct matters. Its adapter is complete and its authoritative lookup is
  // real and proven against the sandbox, so it satisfies the capability
  // invariant; it is disabled because no production connection exists and
  // because Bit, which runs only through the Upay aggregator, could not be
  // exercised in any sandbox.
  //
  // CardCom staying the only ENABLED provider is the assertion that actually
  // protects production, and it is unchanged.
  {
    assert.deepEqual(
      [...DISABLED_PAYMENT_PROVIDERS].sort(),
      ["PAYPAL", "SUMIT", "TRANZILA"],
      "only the dormant and unproven providers are disabled"
    );
    ok("CardCom remains enabled", isPaymentProviderEnabled("CARDCOM"));
    ok("SUMIT ships disabled", !isPaymentProviderEnabled("SUMIT"));
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
      ["CARDCOM", "PAYPAL", "SUMIT", "TRANZILA"],
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

  // ── 9. STRUCTURAL GUARD — the UI cannot decide who is connectable ────────
  //
  // THIS CHECK USED TO COMPARE TWO LISTS, and that was the wrong invariant.
  // It read a hard-coded `SELECTABLE_PROVIDERS` array out of the settings card
  // and asserted it equalled the server's enabled set — which kept the two in
  // step but blessed the existence of a second list. The consequence was a real
  // defect: a provider could be enabled, publish a complete descriptor, appear
  // in the catalogue, and still be impossible to connect, because the card had
  // never heard of it and nothing failed.
  //
  // So the invariant is now architectural rather than numerical: the connection
  // UI DERIVES its options from the canonical catalogue and names no provider
  // at all. A list that does not exist cannot drift, and re-introducing one is
  // caught by the provider-name check below — you cannot hard-code an allowlist
  // without naming a provider.
  {
    const ui = fs.readFileSync(
      "components/settings/PaymentConnectionCard.tsx",
      "utf8"
    );

    ok(
      "the settings card reads the canonical provider catalogue",
      ui.includes("/api/payments/providers")
    );
    ok(
      "and submits through the generic descriptor-validated connect route",
      /fetch\(\s*"\/api\/payments\/connections"/.test(ui)
    );
    ok(
      "with no per-provider connect endpoint left in the UI",
      !/\/api\/payments\/connections\/[a-z]/.test(ui)
    );
    ok(
      "its options are rendered from catalogue state, not from a constant",
      /catalogue\.map\(/.test(ui)
    );
    ok(
      "a catalogue it cannot read leaves nothing selectable",
      /setCatalogue\(\[\]\)/.test(ui) && ui.includes("catalogueFailed")
    );

    // The whole class, in one assertion. Every provider key the system knows —
    // enabled, dormant or otherwise — must be absent from this file. There is
    // no way to re-introduce an allowlist, a label map or a provider-specific
    // branch without tripping it.
    const everyProviderKey = listAllProviderDescriptors().map((d) => d.key);
    const named = everyProviderKey.filter((key) =>
      new RegExp(`\\b${key}\\b`).test(ui)
    );
    assert.deepEqual(
      named,
      [],
      `the connection UI must not name any payment provider; found: ${named.join(", ")}`
    );
    for (const provider of DORMANT) {
      ok(
        `${provider}: cannot be named by the settings UI`,
        !named.includes(provider)
      );
    }

    // And the catalogue the card reads is still the enabled set, so "derives
    // from the server" remains a real restriction rather than a nicer-sounding
    // one. Dormant providers are absent from it by construction.
    const advertised = listProviderDescriptors().map((d) => d.key);
    for (const provider of DORMANT) {
      ok(
        `${provider}: not advertised by the catalogue the UI renders`,
        !advertised.includes(provider)
      );
    }
  }

  console.log(
    `CASA Wave E — dormant provider closure (PayPal + Tranzila): OK — ${pass}/${pass}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
