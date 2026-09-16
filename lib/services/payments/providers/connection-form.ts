/**
 * The descriptor→form contract, as domain logic rather than UI code.
 *
 * WHY THIS IS NOT INSIDE THE COMPONENT
 *
 * A provider descriptor already declares everything a connection form needs:
 * which field carries the merchant identifier, which fields carry credentials,
 * which of those are secret, and which are required. What was missing was a
 * single place that turns that declaration into a request body — so the
 * settings card grew its own hard-coded provider universe instead, and a
 * provider could be enabled server-side while remaining unreachable through
 * onboarding. Keeping the translation here means the rule is testable without
 * a browser, and the component has nothing left to hard-code.
 *
 * Everything below is pure. No React, no fetch, no provider names.
 */

import type { ProviderDescriptor } from "./provider-descriptor.types";

/**
 * The catalogue entry as it arrives over the wire.
 *
 * Structurally the descriptor, but declared separately because this one has
 * crossed a network boundary: it is what a server SENT, not what the registry
 * holds, and nothing here may assume the two are the same object.
 */
export type ProviderCatalogEntryWire = ProviderDescriptor;

/** Every field a form must render for a provider, in display order. */
export interface ConnectionFormField {
  key: string;
  label: string;
  type: "text" | "secret";
  required: boolean;
  /** True for the merchant/terminal identifier, which is never a secret. */
  isMerchantId: boolean;
}

/**
 * The fields to render for one provider: its merchant identifier first, then
 * its credentials in declared order.
 *
 * A provider with no credential fields yields exactly one field, which is
 * correct — some providers are an activation flag plus an identifier and
 * nothing else.
 */
export function connectionFormFields(
  descriptor: ProviderCatalogEntryWire
): ConnectionFormField[] {
  return [
    {
      key: descriptor.merchantIdField.key,
      label: descriptor.merchantIdField.label,
      type: "text",
      required: true,
      isMerchantId: true,
    },
    ...descriptor.credentialFields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      isMerchantId: false,
    })),
  ];
}

/** A blank value for every field the provider declares. */
export function emptyValuesFor(
  descriptor: ProviderCatalogEntryWire
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of connectionFormFields(descriptor)) values[field.key] = "";
  return values;
}

/**
 * Which required fields are still empty.
 *
 * A trimmed emptiness test for text, an exact one for secrets: a credential
 * whose leading or trailing whitespace is significant must not be silently
 * altered, which is the same distinction the server's own validation makes.
 */
export function missingRequiredFields(
  descriptor: ProviderCatalogEntryWire,
  values: Record<string, string>
): ConnectionFormField[] {
  return connectionFormFields(descriptor).filter((field) => {
    if (!field.required) return false;
    const raw = values[field.key] ?? "";
    const value = field.type === "secret" ? raw : raw.trim();
    return value.length === 0;
  });
}

/**
 * Build the body for POST /api/payments/connections.
 *
 * Flat, keyed exactly as the descriptor declares, because that is the shape
 * `connectProviderFromDescriptor` reads. The provider key is the only field
 * this function adds, and it comes from the descriptor the server sent — never
 * from anything a form remembered about a provider it thought it knew.
 */
export function buildConnectionRequestBody(
  descriptor: ProviderCatalogEntryWire,
  values: Record<string, string>
): Record<string, string> {
  const body: Record<string, string> = { provider: descriptor.key };
  for (const field of connectionFormFields(descriptor)) {
    const raw = values[field.key] ?? "";
    const value = field.type === "secret" ? raw : raw.trim();
    // An empty optional field is omitted rather than sent blank, so a provider
    // cannot end up holding an empty-string credential it would treat as set.
    if (value.length > 0) body[field.key] = value;
  }
  return body;
}

/** True when the entry is shaped like something this form can render. */
export function isRenderableCatalogEntry(
  value: unknown
): value is ProviderCatalogEntryWire {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const merchant = entry.merchantIdField as Record<string, unknown> | undefined;
  return (
    typeof entry.key === "string" &&
    entry.key.length > 0 &&
    typeof entry.label === "string" &&
    !!merchant &&
    typeof merchant.key === "string" &&
    typeof merchant.label === "string" &&
    Array.isArray(entry.credentialFields)
  );
}

/**
 * The providers a form may offer.
 *
 * Whatever the catalogue returned, filtered only for structural sanity. There
 * is deliberately no allowlist here: which providers are offered is a SERVER
 * decision, and a client that re-decided it could offer one whose webhook is
 * switched off.
 */
export function selectableProviders(
  catalogue: unknown
): ProviderCatalogEntryWire[] {
  if (!Array.isArray(catalogue)) return [];
  return catalogue.filter(isRenderableCatalogEntry);
}
