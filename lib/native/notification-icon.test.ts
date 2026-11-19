/**
 * Unit test — the Android (FCM) notification icon is the app's EXISTING monochrome Dubiz logo (owner 2026-11-16).
 * Run: npx tsx lib/native/notification-icon.test.ts
 *
 * Android draws a status-bar notification icon from its ALPHA channel only (every visible pixel becomes the tint), and
 * an adaptive-icon XML cannot be used as one. So the icon must be a plain bitmap per density, one colour on a fully
 * transparent ground — otherwise it shows as a white square. This checks:
 *   - the manifest's FCM default icon is @mipmap/ic_launcher_monochrome (the Android 13+ themed-icon layer generated
 *     from public/dubiz-mark.png by scripts/native/generate-app-icons.mjs — no new artwork);
 *   - it is a PNG at every density, never an adaptive-icon XML, and the bell placeholder is gone;
 *   - each file is one colour on transparency, with transparent corners and the logo covering part of the square.
 * Web Push (task reminders and browser notifications today) is a separate path and must stay exactly as it is: the
 * service worker keeps icon and badge "/icons/dubiz-192.png", and that file is there.
 * Source and pixel checks only — the look on a real phone needs the consolidated build on a device.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const root = process.cwd();
const RES = "android/app/src/main/res";
const DENSITIES: [string, number][] = [["mdpi", 108], ["hdpi", 162], ["xhdpi", 216], ["xxhdpi", 324], ["xxxhdpi", 432]];

let pass = 0;
const check = (name: string, fn: () => void) => { fn(); pass++; console.log(`  ok  ${name}`); };

async function main() {
  const manifest = readFileSync(join(root, "android/app/src/main/AndroidManifest.xml"), "utf8");
  check("manifest: the FCM default icon is the existing @mipmap/ic_launcher_monochrome", () =>
    assert.match(manifest, /com\.google\.firebase\.messaging\.default_notification_icon"\s*android:resource="@mipmap\/ic_launcher_monochrome"/));
  check("the bell placeholder is gone (no ic_stat_dubiz anywhere in res)", () => {
    for (const dir of readdirSync(join(root, RES))) {
      assert.equal(readdirSync(join(root, RES, dir)).some((f) => f.startsWith("ic_stat_dubiz")), false, dir);
    }
  });
  check("never an adaptive-icon XML (Android cannot draw one as a notification icon)", () => {
    for (const dir of readdirSync(join(root, RES))) assert.equal(existsSync(join(root, RES, dir, "ic_launcher_monochrome.xml")), false, dir);
  });

  for (const [d, size] of DENSITIES) {
    const file = join(root, RES, `mipmap-${d}`, "ic_launcher_monochrome.png");
    check(`${d}: ic_launcher_monochrome.png exists`, () => assert.ok(existsSync(file), file));
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    check(`${d}: ${size}×${size} px`, () => assert.deepEqual([info.width, info.height], [size, size]));
    const colours = new Set<string>();
    let visible = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      visible++;
      colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    const at = (x: number, y: number) => data[(y * size + x) * 4 + 3];
    check(`${d}: one colour on transparency (only the alpha draws the logo)`, () => assert.equal(colours.size, 1, [...colours].join(" ")));
    check(`${d}: transparent corners (never a square)`, () =>
      assert.deepEqual([at(0, 0), at(size - 1, 0), at(0, size - 1), at(size - 1, size - 1)], [0, 0, 0, 0]));
    const share = visible / (size * size);
    check(`${d}: the logo covers part of the square (${(share * 100).toFixed(1)}%)`, () => assert.ok(share > 0.05 && share < 0.5, String(share)));
  }

  const sw = readFileSync(join(root, "public/sw.js"), "utf8");
  check("Web Push unchanged: the service worker's icon and badge are /icons/dubiz-192.png", () => {
    assert.match(sw, /icon: "\/icons\/dubiz-192\.png",/);
    assert.match(sw, /badge: "\/icons\/dubiz-192\.png",/);
    assert.ok(existsSync(join(root, "public/icons/dubiz-192.png")));
  });

  console.log(`\n${pass} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
