/**
 * What Dubiz is allowed to conclude about who sent an inbound message.
 *
 * # The question this answers, and the one it does not
 *
 * It answers: given the authentication evidence the PROVIDER produced, and the
 * sender this business configured, may that message be treated as coming from
 * that sender. It does not answer whether the message is wanted, whether the
 * attachments are safe, or what to do next. Those are separate boundaries.
 *
 * # Two kinds of input, and the whole design rests on telling them apart
 *
 * TRUSTED, because SES produced it out of band and the sender cannot write it:
 * the envelope MAIL FROM that SES reports, and SES's own SPF, DKIM and DMARC
 * verdicts.
 *
 * CLAIMED, because it travelled inside the message the sender composed: the
 * RFC5322 `From` address. It is provenance. On its own it authorises nothing,
 * ever, and a rule that lets it is the spoofing bug this file exists to prevent.
 *
 * # What is deliberately NOT an input
 *
 * `Authentication-Results`, `Received-SPF`, `Return-Path`, `Received` and the
 * `d=` of a DKIM-Signature are all absent. SES does insert its own
 * `Authentication-Results`, and it does carry the SPF envelope identity and the
 * DKIM signing domain — but it lands in the same header block a sender can write
 * to, so using it safely needs a trusted-boundary rule (whose `authserv-id`,
 * which instance) that has not been designed or measured against a real
 * delivery. Until it has, this evaluator does not look at it.
 */

/**
 * The persisted vocabulary, unchanged.
 *
 * These are the same four values `InboundEmailAuthorizationOutcome` already
 * defines, so a caller can store the result without translating it and without a
 * second vocabulary drifting away from the first.
 *
 * `NOT_EVALUATED` is the database's default for a row nothing has judged yet.
 * This evaluator never returns it: having been called, it has evaluated, and
 * saying otherwise would make "nobody looked" indistinguishable from "we looked
 * and could not tell".
 */
export type SenderAuthorizationDecision = "AUTHORIZED" | "UNAUTHORIZED" | "INDETERMINATE";

/**
 * How strong the evidence was. A pure concept: no column, no migration.
 *
 * STRONG comes only from the authenticated envelope. MEDIUM comes only from the
 * narrow provider-DKIM rule. NONE means nothing authenticated the configured
 * sender, whether the answer was "no" or "cannot tell".
 */
export type SenderAuthorizationAssurance = "STRONG" | "MEDIUM" | "NONE";

/** Why the evaluator concluded what it did. Stable, machine-readable, address-free. */
export type SenderAuthorizationReason =
  // Authorised.
  | "AUTHORIZED_ENVELOPE_SPF"
  | "AUTHORIZED_SES_DKIM_PRIVATE_DOMAIN"
  // Refused because the configuration forbids it, whatever the evidence says.
  | "SENDER_PENDING_VERIFICATION"
  | "SENDER_REVOKED"
  // Refused because the evidence positively names somebody else.
  | "AUTHENTICATED_DIFFERENT_ENVELOPE_SENDER"
  // Cannot tell.
  | "HEADER_FROM_ONLY"
  | "SHARED_DOMAIN_DKIM_ONLY"
  | "UNKNOWN_DOMAIN_CLASSIFICATION"
  | "INSUFFICIENT_AUTHENTICATION"
  | "INVALID_ENVELOPE_IDENTITY"
  | "INVALID_HEADER_FROM_IDENTITY"
  | "INVALID_CONFIGURED_IDENTITY";

/** SES verdict statuses, exactly the five the schema already stores. */
export type SesAuthVerdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED" | "UNKNOWN";

/** The configured sender, as the tenant recorded it. */
export type ConfiguredSender = {
  /** Already canonicalised by the same rule the database column uses. */
  normalizedEmail: string;
  status: "PENDING_VERIFICATION" | "VERIFIED" | "REVOKED";
};

/**
 * How a domain is treated for the DKIM rule.
 *
 * The asymmetry is the point. A static list can say with confidence that a
 * domain IS a shared consumer mailbox provider. Nothing about being absent from
 * that list makes a domain privately controlled — it may simply be a provider
 * nobody has listed yet. So absence yields UNKNOWN, and UNKNOWN never
 * authorises.
 */
export type SenderDomainClassification = "PRIVATE_CONTROLLED" | "SHARED_CONSUMER" | "UNKNOWN";

/**
 * Everything the evaluator is allowed to see.
 *
 * Note what each field is worth. `envelopeMailFrom` is SES's report of the SMTP
 * MAIL FROM, which is what SPF authenticates and is therefore the only identity
 * an SPF pass can bind to. `headerFrom` is the sender's claim.
 */
export type SenderAuthorizationInput = {
  configuredSender: ConfiguredSender;
  /** SES `mail.source`. Trusted as a report of the envelope, not as identity. */
  envelopeMailFrom: string | null;
  /** The RFC5322 From address, as parsed from the message. Sender-controlled. */
  headerFrom: string | null;
  spfVerdict: SesAuthVerdict;
  dkimVerdict: SesAuthVerdict;
  /** Evidence only. It never decides this question by itself, in either direction. */
  dmarcVerdict: SesAuthVerdict;
  /**
   * The classification of the header-From domain, established OUTSIDE this
   * function. The evaluator performs no DNS, no network and no lookup of any
   * kind, so whoever calls it must have settled this already.
   */
  headerFromDomainClassification: SenderDomainClassification;
};

/**
 * The verdict.
 *
 * `headerFromMatchedEnvelope` is a boolean rather than the addresses, so a
 * caller can record that the claim disagreed with the authenticated envelope
 * without any address travelling into a log. It is an observation and never an
 * input to the decision: a STRONG result is not weakened because the `From`
 * disagreed, since the envelope is what was authenticated.
 */
export type SenderAuthorizationResult = {
  decision: SenderAuthorizationDecision;
  assurance: SenderAuthorizationAssurance;
  reason: SenderAuthorizationReason;
  headerFromMatchedEnvelope: boolean | null;
};
