/**
 * Unit test — the device password manager can save and fill Dubiz sign-ins, on the site and in the
 * Android app, without the app claiming any link handling.
 * Run: npx tsx lib/native/credential-sharing.test.ts
 *
 * Source checks only. They keep the markup and the asset-links pair from drifting; they do NOT prove a
 * save prompt appears — that was checked in real Chrome (chrome://password-manager-internals) and still
 * needs a real phone for the Android WebView.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const PACKAGE = "il.co.promaxgroup.dubiz";
const SITE_STATEMENT = "https://promaxgroup.co.il/.well-known/assetlinks.json";
const ASSETLINKS = "public/.well-known/assetlinks.json";
/**
 * Play App Signing — app signing key certificate (the key Play Console marks in use; upload key excluded).
 * Owner-verified 2026-11-10. The previous key's classical/PQC fingerprints (0% install base) are left out
 * on purpose: adding one is an owner decision backed by device evidence, not a drive-by edit.
 */
const APPROVED_FINGERPRINTS = ["B5:42:26:A9:6F:46:A4:53:33:B1:6E:E9:48:9D:92:D9:52:C5:90:83:1F:93:A1:18:16:4E:C6:82:1E:34:98:0B"];

/** The opening tag of the <input> with this id, attributes only. */
function inputTag(source: string, id: string): string {
  const at = source.indexOf(`id="${id}"`);
  assert.ok(at > 0, `input #${id} exists`);
  const start = source.lastIndexOf("<input", at);
  const end = source.indexOf("/>", at);
  return source.slice(start, end);
}

function main() {
  // Sign-in: the email is the account identifier, so it is "username" to the password manager.
  const login = read("app/login/login-form.tsx");
  assert.match(inputTag(login, "login-email"), /name="email"/);
  assert.match(inputTag(login, "login-email"), /autoComplete="username"/);
  assert.match(inputTag(login, "login-password"), /name="password"/);
  assert.match(inputTag(login, "login-password"), /autoComplete="current-password"/);

  // Sign-up: without "username" on the email, Chrome saved the full-name field as the account.
  const register = read("app/register/register-form.tsx");
  assert.match(inputTag(register, "reg-email"), /name="email"/);
  assert.match(inputTag(register, "reg-email"), /autoComplete="username"/);
  assert.match(inputTag(register, "reg-name"), /autoComplete="name"/);
  assert.match(inputTag(register, "reg-password"), /name="password"/);
  assert.match(inputTag(register, "reg-password"), /autoComplete="new-password"/);
  // The honeypot must never be autofilled, or a real person trips it.
  assert.match(inputTag(register, "dz-confirm-field"), /autoComplete="off"/);

  // Reset: both fields are a new password. No identifier field: the reset check does not return the
  // address and the page must not derive one from the link.
  const reset = read("app/reset-password/page.tsx");
  assert.match(inputTag(reset, "reset-password"), /autoComplete="new-password"/);
  assert.match(inputTag(reset, "reset-confirm"), /autoComplete="new-password"/);
  assert.doesNotMatch(reset, /autoComplete="username"/, "no guessed identifier on the reset page");

  const forgot = read("app/forgot-password/forgot-form.tsx");
  assert.match(inputTag(forgot, "forgot-email"), /autoComplete="username"/);

  // App side of the pair: one include, pointing at the production site statement.
  const strings = read("android/app/src/main/res/values/strings.xml");
  const statement = /<string name="asset_statements" translatable="false">(.*)<\/string>/.exec(strings);
  assert.ok(statement, "asset_statements string exists");
  assert.deepEqual(JSON.parse(statement[1].replaceAll('\\"', '"')), [{ include: SITE_STATEMENT }]);

  const manifest = read("android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android:name="asset_statements"\s+android:resource="@string\/asset_statements"/);
  // Credential sharing only: no verified App Links, no change to how links open.
  assert.doesNotMatch(manifest, /autoVerify/);
  assert.doesNotMatch(manifest, /android\.intent\.action\.VIEW/);

  // Site side of the pair. Absent until the Play App Signing fingerprint is supplied — never a stand-in.
  if (existsSync(join(root, ASSETLINKS))) {
    const links = JSON.parse(read(ASSETLINKS)) as Array<{ relation: string[]; target: Record<string, unknown> }>;
    assert.equal(links.length, 1, "one statement");
    assert.deepEqual(links[0].relation, ["delegate_permission/common.get_login_creds"], "credential sharing only");
    assert.equal(links[0].target.namespace, "android_app");
    assert.equal(links[0].target.package_name, PACKAGE);
    const prints = links[0].target.sha256_cert_fingerprints as string[];
    assert.deepEqual(prints, APPROVED_FINGERPRINTS, "exactly the owner-approved app signing key(s)");
    for (const p of prints) assert.match(p, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, "SHA-256, upper-case, colon-separated");
    console.log("assetlinks.json: present and valid");
  } else {
    console.log("assetlinks.json: not yet present (awaits the Play App Signing SHA-256)");
  }

  console.log("credential-sharing: all checks passed");
}

main();
