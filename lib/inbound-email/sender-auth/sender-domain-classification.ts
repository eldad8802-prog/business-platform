import type { SenderDomainClassification } from "./sender-authorization-contract";

/**
 * Is this domain a shared consumer mailbox provider, a domain the supplier
 * controls, or something nobody has established?
 *
 * # Why this cannot currently answer PRIVATE_CONTROLLED
 *
 * The DKIM rule authorises a sender because the domain is controlled by the
 * business that sent the mail. Nothing in the repository establishes that today.
 * `InboundEmailAuthorizedSender` carries no classification, and the verification
 * challenge proves only that somebody can read the mailbox — which the holder of
 * a free consumer address can do just as easily. Establishing real control would
 * need a persisted classification, a DNS proof, or provider ownership
 * verification, and none of those exist.
 *
 * So this function returns SHARED_CONSUMER or UNKNOWN, and never
 * PRIVATE_CONTROLLED. The DKIM MEDIUM path is therefore fully implemented and
 * fully tested, and cannot fire in production until a later increment supplies
 * that evidence. That is the honest state: the alternative is to decide that
 * "not on my list" means "privately controlled", which would hand MEDIUM
 * authorisation to every provider nobody happened to think of.
 *
 * # The asymmetry, stated plainly
 *
 * Presence on the list is evidence. ABSENCE IS NOT. A list of consumer providers
 * is never complete, so the default for anything unlisted is UNKNOWN, and
 * UNKNOWN does not authorise.
 */

/**
 * Domains that are certainly shared consumer mailboxes.
 *
 * Deliberately short. This is not a catalogue and is not trying to be: its only
 * job is to make the most common cases classify as SHARED_CONSUMER rather than
 * UNKNOWN, which changes the REASON a message is held but not the outcome. Both
 * refuse to authorise. Adding to it can only ever move a domain from "cannot
 * tell" to "certainly shared", so the list can grow without widening anything.
 *
 * Fixed data, versioned with the file, identical on every machine and every run.
 */
const SHARED_CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "zoho.com",
  "walla.co.il",
  "walla.com",
]);

/**
 * Classify the domain part of an already-normalised address.
 *
 * Exact equality against the set, never a suffix test. `endsWith` would classify
 * `gmail.com.attacker.test` and `evil-gmail.com` as consumer domains, and a
 * comparison that can be fooled by a chosen name is not a security control.
 */
export function classifySenderDomain(normalizedEmail: string): SenderDomainClassification {
  const at = normalizedEmail.lastIndexOf("@");
  if (at < 0 || at === normalizedEmail.length - 1) return "UNKNOWN";
  const domain = normalizedEmail.slice(at + 1);
  if (domain.length === 0) return "UNKNOWN";
  if (SHARED_CONSUMER_DOMAINS.has(domain)) return "SHARED_CONSUMER";
  // Not "private". Merely not known to be shared.
  return "UNKNOWN";
}

/**
 * Can this deployment establish private control of a domain at all?
 *
 * Exported so the contract is a value a test can assert on rather than a claim
 * in a comment. While it is false, no input assembled by `classifySenderDomain`
 * can reach the MEDIUM path, and the verifier proves exactly that.
 */
export const PRIVATE_CONTROL_ESTABLISHABLE = false;
