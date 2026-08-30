/**
 * Dubiz app-icon generator (native release asset task).
 *
 * Replaces the stock Capacitor launcher assets with the Dubiz mark. Run after
 * changing public/dubiz-mark.png, then `npx cap sync`:
 *
 *   node scripts/native/generate-app-icons.mjs
 *
 * Android adaptive icons: the foreground must keep the mark inside the 66%
 * safe zone of the 108dp canvas (the launcher masks and can parallax the
 * outer ring), so the mark is composited at 55% of the canvas, centred, on
 * transparency. The background is a flat DS colour resource, and a monochrome
 * layer is emitted for Android 13+ themed icons.
 *
 * iOS: a single flattened 1024 AppIcon (no alpha, per App Store rules) —
 * generating the asset does not require Xcode; wiring it does not either,
 * since Contents.json is committed.
 */
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MARK = "public/dubiz-mark.png";
const CREAM = { r: 0xfe, g: 0xf8, b: 0xf2, alpha: 1 };
const TEAL = "#246966";

// Android adaptive layers are 108dp; foreground art lives in the inner 66%.
const ANDROID = [
  ["mipmap-mdpi", 108],
  ["mipmap-hdpi", 162],
  ["mipmap-xhdpi", 216],
  ["mipmap-xxhdpi", 324],
  ["mipmap-xxxhdpi", 432],
];
// Legacy square/round launcher icons (pre-26 and some launchers).
const LEGACY = [
  ["mipmap-mdpi", 48],
  ["mipmap-hdpi", 72],
  ["mipmap-xhdpi", 96],
  ["mipmap-xxhdpi", 144],
  ["mipmap-xxxhdpi", 192],
];

async function markAt(size, ratio) {
  const inner = Math.round(size * ratio);
  return sharp(MARK)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
}

/** Transparent canvas with the mark centred at `ratio` of the canvas. */
async function foreground(size, ratio) {
  const art = await markAt(size, ratio);
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: art, gravity: "centre" }])
    .png()
    .toBuffer();
}

/** Flattened icon on the DS cream ground (legacy + iOS). */
async function flattened(size, ratio) {
  const art = await markAt(size, ratio);
  return sharp({ create: { width: size, height: size, channels: 4, background: CREAM } })
    .composite([{ input: art, gravity: "centre" }])
    .flatten({ background: CREAM })
    .png()
    .toBuffer();
}

/** Single-colour silhouette for the Android 13+ themed layer. */
async function monochrome(size, ratio) {
  const art = await markAt(size, ratio);
  const { data, info } = await sharp(art).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; // alpha carries the shape
  }
  const solid = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: solid, gravity: "centre" }])
    .png()
    .toBuffer();
}

async function main() {
  const res = "android/app/src/main/res";

  for (const [dir, size] of ANDROID) {
    await mkdir(path.join(res, dir), { recursive: true });
    await writeFile(path.join(res, dir, "ic_launcher_foreground.png"), await foreground(size, 0.55));
    await writeFile(path.join(res, dir, "ic_launcher_monochrome.png"), await monochrome(size, 0.55));
  }
  for (const [dir, size] of LEGACY) {
    await writeFile(path.join(res, dir, "ic_launcher.png"), await flattened(size, 0.62));
    await writeFile(path.join(res, dir, "ic_launcher_round.png"), await flattened(size, 0.62));
  }

  // iOS: flat 1024, no alpha.
  const iosDir = "ios/App/App/Assets.xcassets/AppIcon.appiconset";
  await mkdir(iosDir, { recursive: true });
  await writeFile(path.join(iosDir, "AppIcon-512@2x.png"), await flattened(1024, 0.62));

  console.log(`icons generated (mark=${MARK}, ground=#FEF8F2, monochrome=${TEAL} via themed layer)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
