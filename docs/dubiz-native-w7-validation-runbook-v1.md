# Dubiz W7 — Native Validation Runbook (Android first) v1

**Status: PREPARED — Native is NOT closed. No runtime proof exists yet.**
Per the owner's instruction, Native stays **OPEN** until a real device/emulator run produces evidence.

Context: the Native Foundation (Spec v1 §13, PR #276 merged `cac5d61`) is implemented at code/config level — plugins, edge-to-edge insets contract, predictive back, OAuth-out-of-WebView, branded splash, permissions. None of it has been executed on an Android runtime, because this machine has **no JDK, no Android SDK, no emulator** (verified: `java`, `gradle`, `%LOCALAPPDATA%\Android` all absent).

## Two paths — pick either (A is unattended)

### Path A — CI emulator (recommended, no local setup)
Workflow: `.github/workflows/native-android-validation.yml` (manual dispatch).

1. GitHub → Actions → **native-android-validation** → Run workflow.
2. Inputs: `server_url` (default `https://promaxgroup.co.il`), `api_level` **36** (the Play target; 35/34 available for comparison).
3. It provisions JDK 21 + Android SDK, runs `npx cap sync android` with `CAP_SERVER_URL`, assembles the debug APK, boots a Pixel-6 API-36 emulator with KVM, and runs `scripts/native/android-validate.sh`.
4. Download the artifact **`android-runtime-evidence-api36`**: `report.txt`, `shots/01..05*.png`, `logcat.txt`, `window.log`.

Runtime ~20–30 min (emulator boot dominates).

### Path B — your own device/phone (fastest for visual truth)
Prereqs: Android Studio (JDK+SDK+platform-tools), USB debugging on.
```bash
npm ci
CAP_SERVER_URL=https://promaxgroup.co.il npx cap sync android
cd android && ./gradlew assembleDebug && cd ..
adb devices                      # confirm the device is listed
bash scripts/native/android-validate.sh
```
Evidence lands in `.native-evidence/` exactly as in CI.

## What the battery proves automatically
| # | Check | Contract |
|---|---|---|
| 1 | APK installs | build integrity |
| 2 | Cold launch completes, activity resumed | no crash-on-start (Apple 2.1 / Play G8 analogue) |
| 3 | Portrait + landscape render captured | no orientation trap; ≥600dp ignores locks on API 36 |
| 4 | Edge-to-edge screenshot + window dump | forced edge-to-edge at targetSdk 36 |
| 5 | Back press keeps the app alive in-app | predictive back reaches `@capacitor/app` (onBackPressed is no longer delivered) |
| 6 | No FATAL EXCEPTION / ANR in logcat | Play vitals readiness |

## What still needs HUMAN eyes (the actual closure gate)
The screenshots are the proof; the script cannot judge them:
1. **Safe areas** — no header text under the status bar, no control under the gesture pill, at both orientations. This is the single highest-risk item (`env(safe-area-inset-top)` was used exactly once app-wide before this wave).
2. **Keyboard** — open a form (login), confirm the field stays visible and focus is not cleared on resize (the documented Android M139 WebView failure loop).
3. **RTL** — Hebrew layout direction correct in the native chrome, not just the web content.
4. **Splash** — DS cream, no white flash between splash and remote content.
5. **OAuth** — Gmail connect must open in Custom Tabs and return to the app (requires a signed-in operator; not automated here).
6. **Download/share** — accountant ZIP download behavior in the WebView.

## Closure criteria (Spec v1 §31 — Play UI/native readiness)
Native may be marked **CLOSED** only when: the battery is green **and** items 1–6 above are visually confirmed on API 36 **and** the evidence artifact is attached to the closure report. Until then the status line is: *Native Foundation implemented, runtime unproven.*

## iOS (Spec v1 §14) — blocked on hardware
iOS validation needs macOS + Xcode 26 (mandatory SDK since 28.04.2026); it cannot run on this machine or on a standard GitHub Linux runner. Options: a Mac, or a macOS runner (`macos-14`+) added later in the same pattern. Not started — tracked, not claimed.
