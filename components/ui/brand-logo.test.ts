/**
 * Unit test — the official Dubiz logo, never the "d" stand-in.
 * Run: npx tsx components/ui/brand-logo.test.ts
 *
 * Source checks: every screen that used to draw a "d" tile (+ a typed "dubiz") renders the official asset
 * through DubizLogo / DubizMark, and every transactional email opens with the logo image row.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMAIL_LOGO_HEIGHT, EMAIL_LOGO_PATH, EMAIL_LOGO_WIDTH, emailLogoRow } from "@/lib/email/transactional/templates/brand";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const pngSize = (p: string) => { const b = readFileSync(join(root, p)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

/** A JSX text node that is nothing but the letter d / D — the old placeholder glyph. */
const LONE_D = /(^|>)\s*[dD]\s*(<|$)/m;

const SCREENS: [string, "DubizLogo" | "DubizMark"][] = [
  ["app/register/register-form.tsx", "DubizLogo"],
  ["app/register/google/google-signup-form.tsx", "DubizLogo"],
  ["app/link/google/google-link-form.tsx", "DubizLogo"],
  ["app/link/google/confirm/google-link-confirm.tsx", "DubizLogo"],
  ["app/(shell)/setup/page.tsx", "DubizLogo"],
  ["components/navigation/side-nav.tsx", "DubizLogo"],
  ["components/navigation/side-nav.tsx", "DubizMark"],
  ["components/platform-admin/console/admin-console.tsx", "DubizMark"],
];

function main() {
  for (const [file, component] of SCREENS) {
    const src = read(file);
    assert.match(src, new RegExp(`<${component}\\b`), `${file} renders ${component}`);
    assert.match(src, /from "@\/components\/ui\/dubiz-logo"/, `${file} imports the official logo component`);
    assert.doesNotMatch(src, LONE_D, `${file} has no lone "d" glyph`);
    assert.doesNotMatch(src, /logoMark|logoWord|dz-sidebar__mark|dz-sidebar__word/, `${file} has no stand-in mark classes`);
  }

  // The components point at the official assets, at their true ratios.
  const logo = read("components/ui/dubiz-logo.tsx");
  assert.match(logo, /src="\/dubiz-logo\.png"/);
  assert.match(logo, /src="\/dubiz-mark\.png"/);
  assert.deepEqual(pngSize("public/dubiz-logo.png"), [827, 266]);
  assert.deepEqual(pngSize("public/dubiz-mark.png"), [303, 261]);

  // Email: a 2× asset of the lockup, shown at half size, absolute URL, alt text, reading-start alignment.
  assert.deepEqual(pngSize(`public${EMAIL_LOGO_PATH}`), [EMAIL_LOGO_WIDTH * 2, EMAIL_LOGO_HEIGHT * 2]);
  assert.ok(Math.abs(EMAIL_LOGO_WIDTH / EMAIL_LOGO_HEIGHT - 827 / 266) < 0.01, "email logo keeps the lockup ratio");
  const rtl = emailLogoRow("https://app.example.test", "right");
  assert.match(rtl, /<img src="https:\/\/app\.example\.test\/email\/dubiz-logo-v1\.png" width="168" height="54" alt="Dubiz"/);
  assert.match(rtl, /<td align="right"/);
  assert.match(emailLogoRow("https://app.example.test", "left"), /<td align="left"/);
  assert.equal(emailLogoRow(`https://x.test/"><script>`, "right").includes("<script>"), false, "base URL is attribute-escaped");
  for (const tpl of ["lib/email/transactional/templates/welcome.ts", "lib/email/transactional/templates/account-links.ts"]) {
    const src = read(tpl);
    assert.match(src, /emailLogoRow\(/, `${tpl} opens with the logo row`);
    assert.doesNotMatch(src, />Dubiz<\/td>/, `${tpl} no longer uses the text header`);
  }

  console.log("brand-logo: all checks passed");
}

main();
