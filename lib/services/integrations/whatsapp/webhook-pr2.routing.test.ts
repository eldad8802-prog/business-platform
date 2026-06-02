/**
 * PR2 routing tests. Run:
 *   npx tsx lib/services/integrations/whatsapp/webhook-pr2.routing.test.ts
 *
 * NOTE for Bot-MVP-1:
 *   `routeInboundWhatsAppMessage` is now ASYNC (DB-backed routing). For
 *   parity with the pre-existing env-map tests, this test enables
 *   `WHATSAPP_ALLOW_ENV_FALLBACK=1` so env-only fixtures keep working.
 *   Text messages with a non-empty body now route to CONVERSATION_INTAKE
 *   (was: STOP with `unsupported_message_type`) — the assertions below
 *   reflect that.
 */
import assert from "node:assert/strict";
import { resetAllowlistCacheForTests } from "./allowlist.service";
import { resetBusinessResolveCacheForTests } from "./business-resolve.service";
import { resolveBusinessFromPhoneNumberId } from "./business-resolve.service";
import { checkSenderAllowlisted } from "./allowlist.service";
import { routeInboundWhatsAppMessage } from "./routing-gate.service";
import type { WhatsAppWebhookMessageSummary } from "./types";

function applyTestEnv(): void {
  process.env.WHATSAPP_ALLOW_ENV_FALLBACK = "1";
  process.env.WHATSAPP_PHONE_NUMBER_BUSINESS_MAP = JSON.stringify({
    "123456789": 1,
  });
  process.env.WHATSAPP_ALLOWLIST_BY_BUSINESS = JSON.stringify({
    "1": ["972501234567", "+972-50-987-6543"],
  });
  resetBusinessResolveCacheForTests();
  resetAllowlistCacheForTests();
}

function baseMessage(
  overrides: Partial<WhatsAppWebhookMessageSummary> = {}
): WhatsAppWebhookMessageSummary {
  return {
    phoneNumberId: "123456789",
    from: "972501234567",
    wamid: "wamid.test.message",
    type: "image",
    mediaId: "media-abc",
    textBody: null,
    ...overrides,
  };
}

async function main() {
  applyTestEnv();

  // Business resolve
  const resolved = await resolveBusinessFromPhoneNumberId("123456789");
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.businessId, 1);

  const unknownBusiness = await resolveBusinessFromPhoneNumberId("000");
  assert.equal(unknownBusiness.ok, false);
  if (!unknownBusiness.ok) {
    assert.equal(unknownBusiness.reason, "unknown_phone_number_id");
  }

  const missingPn = await resolveBusinessFromPhoneNumberId(null);
  assert.equal(missingPn.ok, false);
  if (!missingPn.ok) assert.equal(missingPn.reason, "missing_phone_number_id");

  // Allowlist
  const allowed = checkSenderAllowlisted({
    businessId: 1,
    sender: "972501234567",
  });
  assert.equal(allowed.ok, true);

  const notAllowed = checkSenderAllowlisted({
    businessId: 1,
    sender: "972111111111",
  });
  assert.equal(notAllowed.ok, false);
  if (!notAllowed.ok) assert.equal(notAllowed.reason, "sender_not_allowlisted");

  // Routing: authorized + image
  const intake = await routeInboundWhatsAppMessage(baseMessage());
  assert.equal(intake.kind, "DOCUMENTS_INTAKE");
  if (intake.kind === "DOCUMENTS_INTAKE") {
    assert.equal(intake.businessId, 1);
    assert.equal(intake.mediaType, "image");
    assert.equal(intake.mediaId, "media-abc");
    assert.equal(intake.sender, "972501234567");
    assert.equal(intake.senderTrust, "allowlist");
  }

  // document type
  const doc = await routeInboundWhatsAppMessage(
    baseMessage({ type: "document", mediaId: "media-doc" })
  );
  assert.equal(doc.kind, "DOCUMENTS_INTAKE");
  if (doc.kind === "DOCUMENTS_INTAKE") assert.equal(doc.mediaType, "document");

  // sender NOT allowlisted + media + identified business → conversation-origin
  // DOCUMENTS_INTAKE (media inside a normal customer conversation still
  // enters the document pipeline, tagged senderTrust: "conversation").
  const convoMedia = await routeInboundWhatsAppMessage(
    baseMessage({ from: "972000000000" })
  );
  assert.equal(convoMedia.kind, "DOCUMENTS_INTAKE");
  if (convoMedia.kind === "DOCUMENTS_INTAKE") {
    assert.equal(convoMedia.businessId, 1);
    assert.equal(convoMedia.mediaType, "image");
    assert.equal(convoMedia.mediaId, "media-abc");
    assert.equal(convoMedia.sender, "972000000000");
    assert.equal(convoMedia.senderTrust, "conversation");
  }

  // media WITHOUT mediaId → STOP, regardless of allowlist membership.
  const stopNoMedia = await routeInboundWhatsAppMessage(
    baseMessage({ from: "972000000000", mediaId: null })
  );
  assert.equal(stopNoMedia.kind, "STOP");
  if (stopNoMedia.kind === "STOP") {
    assert.equal(stopNoMedia.reason, "missing_media_id");
  }

  // text WITH body — new Bot-MVP-1 behavior: routes to CONVERSATION_INTAKE.
  const text = await routeInboundWhatsAppMessage(
    baseMessage({ type: "text", mediaId: null, textBody: "hello there" })
  );
  assert.equal(text.kind, "CONVERSATION_INTAKE");
  if (text.kind === "CONVERSATION_INTAKE") {
    assert.equal(text.businessId, 1);
    assert.equal(text.text, "hello there");
    assert.equal(text.senderPhone, "972501234567");
  }

  // text WITHOUT body — STOP with the new dedicated reason.
  const stopText = await routeInboundWhatsAppMessage(
    baseMessage({ type: "text", mediaId: null, textBody: null })
  );
  assert.equal(stopText.kind, "STOP");
  if (stopText.kind === "STOP") {
    assert.equal(stopText.reason, "missing_text_body");
  }

  // unknown business (phone_number_id)
  const stopBiz = await routeInboundWhatsAppMessage(
    baseMessage({ phoneNumberId: "unknown-pn" })
  );
  assert.equal(stopBiz.kind, "STOP");
  if (stopBiz.kind === "STOP") {
    assert.equal(stopBiz.reason, "unknown_phone_number_id");
  }

  // missing business mapping env — with env fallback enabled but env map removed.
  delete process.env.WHATSAPP_PHONE_NUMBER_BUSINESS_MAP;
  resetBusinessResolveCacheForTests();
  const stopNoMap = await routeInboundWhatsAppMessage(baseMessage());
  assert.equal(stopNoMap.kind, "STOP");
  if (stopNoMap.kind === "STOP") {
    assert.equal(stopNoMap.reason, "mapping_not_configured");
  }

  console.log("whatsapp webhook PR2 routing tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
