/**
 * Unit test — display-only phone formatter. Run: npx tsx lib/format/phone-display.test.ts
 */
import assert from "node:assert/strict";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";

function main() {
  // Canonical Israeli mobile → readable 3-3-4.
  assert.equal(formatPhoneForDisplay("972529998877"), "052-999-8877", "IL mobile formatted");
  assert.equal(formatPhoneForDisplay("972501234567"), "050-123-4567", "IL mobile 050 formatted");
  // Canonical Israeli landline → readable 2-3-4.
  assert.equal(formatPhoneForDisplay("97231234567"), "03-123-4567", "IL landline formatted");

  // Not safely recognizable → returned as stored, never guessed.
  assert.equal(formatPhoneForDisplay("15551234567"), "15551234567", "foreign number unchanged");
  assert.equal(formatPhoneForDisplay("972123"), "972123", "IL prefix but too short → unchanged");
  assert.equal(formatPhoneForDisplay("not-a-number"), "not-a-number", "non-numeric unchanged");
  assert.equal(formatPhoneForDisplay(""), "", "empty stays empty");
  assert.equal(formatPhoneForDisplay(null), "", "null → empty string");

  // Storage value is never mutated — formatter is pure display.
  const stored = "972529998877";
  formatPhoneForDisplay(stored);
  assert.equal(stored, "972529998877", "input value untouched");

  console.log("phone-display.test.ts: ok");
}

main();
