/**
 * Run: npx tsx lib/services/payments/connection-form.test.ts
 *
 * The descriptor→connection-form contract.
 *
 * WHAT THIS EXISTS TO PREVENT
 *
 * A provider was enabled server-side, published a complete descriptor, appeared
 * in the catalogue — and could not be connected, because the settings card kept
 * its own hard-coded provider universe and had never heard of it. Nothing
 * failed. The product simply had no onboarding path for a provider it
 * advertised.
 *
 * So the assertions below are deliberately about providers the UI does NOT
 * mention by name. They take the real registry descriptors and prove that a
 * form built from them alone asks for the right fields, marks the right ones
 * secret, and produces the exact body the generic connect route reads.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildConnectionRequestBody,
  connectionFormFields,
  emptyValuesFor,
  isRenderableCatalogEntry,
  missingRequiredFields,
  selectableProviders,
} from "./providers/connection-form";
import {
  getProviderDescriptor,
  listProviderDescriptors,
} from "./providers/provider-registry";
import { DISABLED_PAYMENT_PROVIDERS } from "./providers/provider-availability";
import type { ProviderDescriptor } from "./providers/provider-descriptor.types";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

function descriptorFor(key: string): ProviderDescriptor {
  const d = getProviderDescriptor(key);
  assert.ok(d, `the registry must still hold a descriptor for ${key}`);
  return d;
}

function main() {
  // ── CardCom: the provider that already worked must keep working ─────────
  {
    const cardcom = descriptorFor("CARDCOM");
    const fields = connectionFormFields(cardcom);

    ok(
      "CardCom renders its terminal number first",
      fields[0]!.key === cardcom.merchantIdField.key && fields[0]!.isMerchantId
    );
    ok(
      "then every credential field it declares",
      fields.slice(1).map((f) => f.key).join(",") ===
        cardcom.credentialFields.map((f) => f.key).join(",")
    );
    ok(
      "its API password is rendered as a secret",
      fields.find((f) => f.key === "apiPassword")?.type === "secret"
    );
    ok(
      "its API name is not",
      fields.find((f) => f.key === "apiName")?.type === "text"
    );

    const body = buildConnectionRequestBody(cardcom, {
      terminalNumber: " 1234 ",
      apiName: " acme ",
      apiPassword: "  p a s s  ",
    });
    ok("the body names the provider", body.provider === "CARDCOM");
    ok("text fields are trimmed", body.terminalNumber === "1234" && body.apiName === "acme");
    ok(
      "a secret is sent EXACTLY as typed, whitespace included",
      body.apiPassword === "  p a s s  "
    );
    ok(
      "and the body carries nothing the descriptor did not declare",
      Object.keys(body).sort().join(",") ===
        ["apiName", "apiPassword", "provider", "terminalNumber"].join(",")
    );
  }

  // ── SUMIT: the provider the old UI could not express at all ─────────────
  {
    // Note what is NOT needed to make this work: no branch, no label map entry,
    // no endpoint. Only the descriptor.
    const sumit = descriptorFor("SUMIT");
    const fields = connectionFormFields(sumit);

    ok("SUMIT renders exactly two fields", fields.length === 2, String(fields.length));
    ok(
      "the first is its Company ID, as the merchant identifier",
      fields[0]!.key === "companyId" && fields[0]!.isMerchantId
    );
    ok("labelled as the descriptor says", fields[0]!.label === "Company ID");
    ok("and required", fields[0]!.required);
    ok("the second is its API key", fields[1]!.key === "apiKey");
    ok("rendered as a SECRET input", fields[1]!.type === "secret");
    ok("and required", fields[1]!.required);

    const values = emptyValuesFor(sumit);
    ok(
      "a fresh form starts blank on both",
      values.companyId === "" && values.apiKey === ""
    );
    ok(
      "and both are reported missing before anything is typed",
      missingRequiredFields(sumit, values).map((f) => f.key).join(",") ===
        "companyId,apiKey"
    );

    const body = buildConnectionRequestBody(sumit, {
      companyId: " 4242 ",
      apiKey: "k-secret",
    });
    assert.deepEqual(
      body,
      { provider: "SUMIT", companyId: "4242", apiKey: "k-secret" },
      "SUMIT's body must match what connectProviderFromDescriptor reads"
    );
    ok("SUMIT submits through the generic contract with no special case", true);
  }

  // ── required / optional semantics ───────────────────────────────────────
  {
    const optionalField: ProviderDescriptor = {
      ...descriptorFor("SUMIT"),
      credentialFields: [
        { key: "apiKey", label: "API Key", type: "secret", required: true },
        { key: "note", label: "Note", type: "text", required: false },
      ],
    };

    const missing = missingRequiredFields(optionalField, {
      companyId: "1",
      apiKey: "k",
      note: "",
    });
    ok("an empty OPTIONAL field is not missing", missing.length === 0);

    const body = buildConnectionRequestBody(optionalField, {
      companyId: "1",
      apiKey: "k",
      note: "",
    });
    ok(
      "and is omitted from the body rather than sent blank",
      !("note" in body),
      Object.keys(body).join(",")
    );

    const blankSecret = missingRequiredFields(optionalField, {
      companyId: "1",
      apiKey: "   ",
      note: "",
    });
    ok(
      "a whitespace-only value in a required SECRET is accepted as typed",
      blankSecret.length === 0
    );
    const blankText = missingRequiredFields(optionalField, {
      companyId: "   ",
      apiKey: "k",
      note: "",
    });
    ok(
      "but a whitespace-only merchant id is still missing",
      blankText.map((f) => f.key).join(",") === "companyId"
    );
  }

  // ── the catalogue is the only source of options ─────────────────────────
  {
    ok(
      "a provider absent from the catalogue is not selectable",
      selectableProviders([descriptorFor("CARDCOM")]).map((p) => p.key).join(",") ===
        "CARDCOM"
    );
    ok(
      "a catalogue that failed to load leaves nothing selectable",
      selectableProviders(null).length === 0 &&
        selectableProviders(undefined).length === 0
    );
    ok(
      "and so does a malformed one, rather than a partial render",
      selectableProviders([{ key: "X" }, null, "CARDCOM"]).length === 0
    );
    ok(
      "a complete descriptor is renderable",
      isRenderableCatalogEntry(descriptorFor("SUMIT"))
    );
    ok(
      "one missing its merchant field is not",
      !isRenderableCatalogEntry({
        key: "X",
        label: "X",
        credentialFields: [],
      })
    );

    // The server decides. Every disabled provider is absent from the catalogue
    // the UI renders, so hiding it is not the client's job.
    const advertised = listProviderDescriptors().map((d) => d.key);
    for (const disabled of DISABLED_PAYMENT_PROVIDERS) {
      ok(
        `${disabled}: a disabled provider is not advertised`,
        !advertised.includes(disabled)
      );
    }
  }

  // ── the UI names no provider ────────────────────────────────────────────
  {
    // The defect was not that the card had the wrong list; it was that the card
    // had a list at all. This is the assertion that keeps it gone.
    const ui = fs.readFileSync(
      "components/settings/PaymentConnectionCard.tsx",
      "utf8"
    );
    ok(
      "the connection card mentions no provider by name",
      !/\b(CARDCOM|SUMIT|TRANZILA|PAYPAL|CardCom|Tranzila|PayPal)\b/.test(ui)
    );
    ok(
      "it renders its fields from the descriptor contract",
      ui.includes("connectionFormFields")
    );
    ok(
      "and builds its request body from the same place",
      ui.includes("buildConnectionRequestBody")
    );
  }

  console.log(`\nconnection-form: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main();
