/**
 * Unit test — Android notifications carry the Dubiz mark on the app's teal.
 *   - the notification small icon is ic_stat_dubiz: the SAME mark (public/dubiz-mark.png) as a white silhouette that
 *     fills the 24dp icon, in every density — not the launcher's monochrome layer (mark at 55% inside a 108dp safe
 *     zone, which read as a small anonymous symbol at 24dp);
 *   - the notification colour is the app's own colorPrimary (no new brand colour), from the manifest default and
 *     from every FCM message (lib/notifications/push/fcm-client.ts ANDROID_NOTIFICATION_COLOR).
 * Run: npx tsx lib/native/android-notification-branding.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import sharp from "sharp";

import { ANDROID_NOTIFICATION_COLOR } from "@/lib/notifications/push/fcm-client";

const RES = "android/app/src/main/res";

async function main() {
  const manifest = readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
  assert.match(manifest, /default_notification_icon"\s+android:resource="@drawable\/ic_stat_dubiz"/, "manifest: small icon = ic_stat_dubiz");
  assert.match(manifest, /default_notification_color"\s+android:resource="@color\/colorPrimary"/, "manifest: colour = colorPrimary");
  assert.match(manifest, /default_notification_channel_id"\s+android:value="dubiz_default"/, "manifest: default channel unchanged");
  console.log("[PASS] manifest: ic_stat_dubiz on colorPrimary, default channel dubiz_default");

  const colors = readFileSync(`${RES}/values/colors.xml`, "utf8");
  assert.ok(colors.includes(`<color name="colorPrimary">${ANDROID_NOTIFICATION_COLOR}</color>`), "server colour = the app's colorPrimary");
  console.log(`[PASS] the FCM colour ${ANDROID_NOTIFICATION_COLOR} is the app's colorPrimary`);

  for (const [dir, size] of [["drawable-mdpi", 24], ["drawable-hdpi", 36], ["drawable-xhdpi", 48], ["drawable-xxhdpi", 72], ["drawable-xxxhdpi", 96]] as const) {
    const file = `${RES}/${dir}/ic_stat_dubiz.png`;
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, size, `${file}: ${size}px wide`);
    assert.equal(info.height, size, `${file}: ${size}px high`);
    let minX = size, minY = size, maxX = -1, maxY = -1, transparent = 0, coloured = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const a = data[i + 3];
        if (a === 0) { transparent++; continue; }
        if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) coloured++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    assert.equal(coloured, 0, `${file}: a white silhouette (Android tints it; colour would be ignored)`);
    assert.ok(transparent > size * size * 0.3, `${file}: transparent ground`);
    const extent = Math.max(maxX - minX + 1, maxY - minY + 1) / size;
    assert.ok(extent >= 0.85, `${file}: the mark fills the icon (extent ${extent.toFixed(2)} ≥ 0.85; the launcher layer is 0.55)`);
  }
  console.log("[PASS] ic_stat_dubiz: 5 densities, white silhouette on transparency, the mark fills the icon");

  // The same mark: the silhouette matches the mark's own alpha (resized the same way), not another drawing.
  const ref = await sharp("public/dubiz-mark.png").resize(88, 88, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer();
  const icon = await sharp(`${RES}/drawable-xxxhdpi/ic_stat_dubiz.png`).extract({ left: 4, top: 4, width: 88, height: 88 }).ensureAlpha().raw().toBuffer();
  let diff = 0;
  for (let i = 3; i < ref.length; i += 4) diff += Math.abs(ref[i] - icon[i]);
  const meanAlphaDiff = diff / (ref.length / 4);
  assert.ok(meanAlphaDiff < 8, `ic_stat_dubiz is the Dubiz mark (mean alpha difference ${meanAlphaDiff.toFixed(2)})`);
  console.log(`[PASS] ic_stat_dubiz is the Dubiz mark itself (mean alpha difference ${meanAlphaDiff.toFixed(2)})`);
  console.log("\nandroid-notification-branding: ALL PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
