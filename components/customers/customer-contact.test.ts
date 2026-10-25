/**
 * Unit test — customer contact links. Run: npx tsx components/customers/customer-contact.test.ts
 */
import assert from "node:assert/strict";
import { mailHref, telHref, whatsAppChatHref } from "@/components/customers/customer-contact";

function main() {
  // tel: canonical Israeli → +972; local and foreign keep their own digits.
  assert.equal(telHref("972501234567"), "tel:+972501234567", "canonical IL gets +");
  assert.equal(telHref("050-123-4567"), "tel:0501234567", "local form dialed as typed");
  assert.equal(telHref("+1 (555) 123-4567"), "tel:+15551234567", "foreign with + kept");
  assert.equal(telHref(null), null, "no phone");
  assert.equal(telHref("   "), null, "blank phone");
  assert.equal(telHref("12"), null, "too short to dial");

  // WhatsApp: opens the chat only — never a pre-written message.
  assert.equal(whatsAppChatHref("972501234567"), "https://wa.me/972501234567", "canonical IL");
  assert.equal(whatsAppChatHref("050-123-4567"), "https://wa.me/972501234567", "local IL normalized");
  assert.equal(whatsAppChatHref("15551234567"), null, "no country code, no leading zero → not guessed");
  assert.equal(whatsAppChatHref(null), null, "no phone");
  assert.ok(!String(whatsAppChatHref("972501234567")).includes("text="), "no message attached");

  // mailto
  assert.equal(mailHref("daniel@example.com"), "mailto:daniel@example.com", "plain address");
  assert.equal(mailHref(" daniel@example.com "), "mailto:daniel@example.com", "trimmed");
  assert.equal(mailHref("not-an-email"), null, "not an address");
  assert.equal(mailHref("a b@example.com"), null, "spaces rejected");
  assert.equal(mailHref(null), null, "no email");

  console.log("customer-contact: all assertions passed");
}

main();
