import { normalizeEmail } from "@/lib/auth/signup-identity";

import type {
  SenderAuthorizationInput,
  SenderAuthorizationResult,
} from "./sender-authorization-contract";

/**
 * Decide what the provider's evidence allows us to conclude about the sender.
 *
 * Pure. No database, no network, no clock, no randomness, no logging, no
 * environment. The same input always produces the same result, which is what
 * makes the adversarial suite beside it worth anything.
 *
 * # Order matters, and this is the order
 *
 *   1. the configured identity must be usable at all
 *   2. the configuration's own answer — revoked or unverified senders are
 *      refused before any evidence is weighed, because evidence cannot
 *      un-revoke somebody
 *   3. STRONG: the authenticated envelope IS the configured sender
 *   4. contradiction: the authenticated envelope is somebody ELSE
 *   5. MEDIUM: the narrow provider-DKIM rule
 *   6. everything else cannot tell
 *
 * Steps 3 and 4 are adjacent on purpose. They read the same field and reach
 * opposite conclusions, and putting them together is what stops a later edit
 * from adding a path between them.
 */
export function evaluateSenderAuthorization(
  input: SenderAuthorizationInput
): SenderAuthorizationResult {
  const configured = normalizeIdentity(input.configuredSender.normalizedEmail);
  const envelope = normalizeIdentity(input.envelopeMailFrom);
  const headerFrom = normalizeIdentity(input.headerFrom);

  // Computed once and reported whatever the outcome: a caller may want to record
  // that the visible From disagreed with the authenticated envelope even on a
  // result that authorises. It is an observation, never an input.
  const headerFromMatchedEnvelope =
    headerFrom === null || envelope === null ? null : headerFrom === envelope;

  const verdict = (
    decision: SenderAuthorizationResult["decision"],
    assurance: SenderAuthorizationResult["assurance"],
    reason: SenderAuthorizationResult["reason"]
  ): SenderAuthorizationResult => ({ decision, assurance, reason, headerFromMatchedEnvelope });

  // 1. A configured identity that cannot be parsed can never be matched by
  //    anything, so no evidence could authorise it.
  if (configured === null) {
    return verdict("INDETERMINATE", "NONE", "INVALID_CONFIGURED_IDENTITY");
  }

  // 2. The configuration decides before the evidence does. A revoked sender is
  //    refused even holding a perfect SPF pass: revocation is the business
  //    saying no, and authentication answers a different question.
  if (input.configuredSender.status === "REVOKED") {
    return verdict("UNAUTHORIZED", "NONE", "SENDER_REVOKED");
  }
  if (input.configuredSender.status === "PENDING_VERIFICATION") {
    return verdict("UNAUTHORIZED", "NONE", "SENDER_PENDING_VERIFICATION");
  }

  const spfPassed = input.spfVerdict === "PASS";

  // 3. STRONG. SPF authenticates the envelope MAIL FROM and nothing else, so
  //    this is the one identity an SPF pass can be bound to. The header From is
  //    not consulted: it is the sender's claim, and requiring it to agree would
  //    make a forged From able to WEAKEN a genuinely authenticated message.
  if (spfPassed && envelope !== null && envelope === configured) {
    return verdict("AUTHORIZED", "STRONG", "AUTHORIZED_ENVELOPE_SPF");
  }

  // 4. The same evidence pointing somewhere else. This is not "we cannot tell":
  //    the provider authenticated a specific different sender, which positively
  //    contradicts the claim, and it outranks every weaker path below.
  if (spfPassed && envelope !== null && envelope !== configured) {
    return verdict("UNAUTHORIZED", "NONE", "AUTHENTICATED_DIFFERENT_ENVELOPE_SENDER");
  }

  // An SPF pass we cannot attach to any identity proves nothing about anyone.
  if (spfPassed && envelope === null) {
    return verdict("INDETERMINATE", "NONE", "INVALID_ENVELOPE_IDENTITY");
  }

  const dkimPassed = input.dkimVerdict === "PASS";

  // 5. The narrow DKIM path.
  //
  //    SES reports DKIM as GRAY when the message is unsigned OR when the From
  //    domain and the signing domain disagree, so a PASS already carries SES's
  //    own alignment finding. That is the whole basis for this rule: we do not
  //    reconstruct `d=` and could not verify it if we did.
  //
  //    It is bound to the exact configured MAILBOX, not to the domain. We
  //    authorise an identity a business named, not everyone who happens to hold
  //    an address at the same company.
  if (dkimPassed) {
    if (headerFrom === null) {
      return verdict("INDETERMINATE", "NONE", "INVALID_HEADER_FROM_IDENTITY");
    }
    if (headerFrom === configured) {
      switch (input.headerFromDomainClassification) {
        case "PRIVATE_CONTROLLED":
          return verdict("AUTHORIZED", "MEDIUM", "AUTHORIZED_SES_DKIM_PRIVATE_DOMAIN");
        case "SHARED_CONSUMER":
          // The provider signed it, which proves the provider handled it. On a
          // shared mailbox domain that says nothing about which of its millions
          // of users this was.
          return verdict("INDETERMINATE", "NONE", "SHARED_DOMAIN_DKIM_ONLY");
        default:
          return verdict("INDETERMINATE", "NONE", "UNKNOWN_DOMAIN_CLASSIFICATION");
      }
    }
    // A passing signature for some other mailbox authorises nothing here.
    return verdict("INDETERMINATE", "NONE", "INSUFFICIENT_AUTHENTICATION");
  }

  // 6. Nothing authenticated the configured sender.
  //
  //    Named separately when the ONLY thing matching is the header the sender
  //    wrote, because that is the case most likely to look convincing to a human
  //    and is exactly the one that must not authorise.
  if (headerFrom !== null && headerFrom === configured) {
    return verdict("INDETERMINATE", "NONE", "HEADER_FROM_ONLY");
  }

  return verdict("INDETERMINATE", "NONE", "INSUFFICIENT_AUTHENTICATION");
}

/**
 * Canonicalise, or reject as unusable.
 *
 * Normalisation is the repository's existing rule, reused rather than restated
 * so that "the same address" means the same thing here as it does in the column
 * this is compared against. It folds case and trims, and does nothing else: no
 * dot-stripping, no plus-tag collapsing, no provider aliasing. `a+b@x.test` and
 * `a@x.test` are different identities, because treating them as one would let
 * anybody who can invent a tag inherit somebody else's authorisation.
 *
 * The validity test is deliberately minimal — one `@`, something either side, no
 * whitespace or control characters. This is not an RFC5322 parser and must not
 * become one; addresses arrive already parsed. It exists to ensure a value that
 * could never be a mailbox is never compared as one.
 */
function normalizeIdentity(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = normalizeEmail(raw);
  if (value.length === 0 || value.length > 320) return null;
  // Control characters, including the newline that would make this a header
  // injection rather than an address.
  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(value)) return null;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) return null;
  return value;
}
