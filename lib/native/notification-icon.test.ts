/**
 * Unit test — the Android notification icon is the official Dubiz mark (owner 2026-11-15), drawn the way Android needs.
 * Run: npx tsx lib/native/notification-icon.test.ts
 *
 * Android draws a status-bar / shade icon from its ALPHA channel only: every non-transparent pixel becomes the tint.
 * An icon with an opaque background therefore shows as a plain white square. This checks the generated files
 * (scripts/native/generate-app-icons.mjs, from public/dubiz-mark.png):
 *   - the manifest names @drawable/ic_stat_dubiz and the brand teal (colorPrimary) as the shade colour;
 *   - one PNG per density at 24dp (24 / 36 / 48 / 72 / 96 px), and no leftover placeholder (bell vector);
 *   - every pixel white, the corners and the outer padding fully transparent, and the mark covering a real part of
 *     the square but far from all of it (so it can never read as a square);
 *   - the silhouette is the mark's own shape: at 96 px it matches the mark's alpha resized the same way.
 * Source and pixel checks only — how it looks on a real phone still needs the consolidated build on a device.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const root = process.cwd();
const RES = "android/app/src/main/res";
const DENSITIES: [string, number][] = [["mdpi", 24], ["hdpi", 36], ["xhdpi", 48], ["xxhdpi", 72], ["xxxhdpi", 96]];

let pass = 0;
const check = (name: string, fn: () => void) => { fn(); pass++; console.log(`  ok  ${name}`); };

async function main() {
const manifest = readFileSync(join(root, "android/app/src/main/AndroidManifest.xml"), "utf8");
check("manifest: FCM default icon is @drawable/ic_stat_dubiz", () =>
  assert.match(manifest, /com\.google\.firebase\.messaging\.default_notification_icon"\s*android:resource="@drawable\/ic_stat_dubiz"/));
check("manifest: FCM default colour is the brand teal (@color/colorPrimary)", () =>
  assert.match(manifest, /com\.google\.firebase\.messaging\.default_notification_color"\s*android:resource="@color\/colorPrimary"/));
check("colorPrimary is the DS teal #246966", () =>
  assert.match(readFileSync(join(root, RES, "values/colors.xml"), "utf8"), /<color name="colorPrimary">#246966<\/color>/));
check("the bell placeholder is gone (no drawable/ic_stat_dubiz.xml)", () =>
  assert.equal(existsSync(join(root, RES, "drawable/ic_stat_dubiz.xml")), false));

for (const [d, size] of DENSITIES) {
  const file = join(root, RES, `drawable-${d}`, "ic_stat_dubiz.png");
  check(`${d}: ic_stat_dubiz.png exists`, () => assert.ok(existsSync(file), file));
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  check(`${d}: ${size}×${size} px`, () => assert.deepEqual([info.width, info.height], [size, size]));
  let opaque = 0, nonWhite = 0, edge = 0;
  const pad = Math.floor(size / 24); // the 1dp optical padding
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const a = data[i + 3];
    if (a === 0) continue;
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) nonWhite++;
    if (a >= 128) opaque++;
    if (x < pad || y < pad || x >= size - pad || y >= size - pad) edge++;
  }
  check(`${d}: every visible pixel is white (Android tints it)`, () => assert.equal(nonWhite, 0));
  check(`${d}: the 1dp padding is fully transparent (no square frame)`, () => assert.equal(edge, 0));
  const share = opaque / (size * size);
  check(`${d}: the mark covers a real part of the square but not most of it (${(share * 100).toFixed(0)}%)`, () =>
    assert.ok(share > 0.15 && share < 0.6, String(share)));
}

// The silhouette is the official mark itself, not a redrawn shape.
{
  const size = 96, inner = 88;
  const ref = await sharp(join(root, "public/dubiz-mark.png"))
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data } = await sharp(join(root, RES, "drawable-xxxhdpi/ic_stat_dubiz.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const off = (size - inner) / 2;
  let diff = 0;
  for (let y = 0; y < inner; y++) for (let x = 0; x < inner; x++) {
    diff = Math.max(diff, Math.abs(ref.data[(y * inner + x) * 4 + 3] - data[((y + off) * size + (x + off)) * 4 + 3]));
  }
  check(`xxxhdpi: the alpha matches public/dubiz-mark.png (max diff ${diff})`, () => assert.ok(diff <= 2, String(diff)));
}

console.log(`\n${pass} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
