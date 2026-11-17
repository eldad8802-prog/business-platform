# Real-device test plan: signup legal identity and corrections (#1142, #1152, #1154)

**Status:** not run. So far only a desktop browser engine (Chromium 72/72, WebKit 24/24) has been tested; that is **not** a device test. This plan needs physical phones. Emulator or simulator results must be reported separately and never counted as device results.

## Devices (minimum)

| # | Device | OS | Surfaces |
|---|---|---|---|
| A1 | Android phone, mid-range, Samsung or similar | Android 14 | Chrome browser; the Dubiz Android app (Capacitor) once the consolidated build exists |
| A2 | Android phone, older or small screen (≤ 6.1") | Android 12 or 13 | Chrome browser |
| I1 | iPhone, current | iOS 18 | Safari; added to the home screen |
| I2 | iPhone SE or other small screen | iOS 17 | Safari |

Plus one desktop browser for the admin side (#1154 is admin-only, desktop).

**Where:** a Preview deployment with the relevant flags on in Preview only. Setting those Preview environment variables and a test approver needs **your approval**. Never Production: there, the correction flag stays OFF and no approver is configured.

**Data:** synthetic businesses and test tax ids that pass the check digit only (for example 000000018). No real customer data.

## Recording per case

Device + OS + browser/app version, date, tester, PASS/FAIL, and a screenshot or screen recording for every FAIL. Mark each result **PHYSICAL** or **EMULATOR**.

## S: Signup (#1142)

| ID | Case | Expected |
|---|---|---|
| S1 | Three-step `/register` in Hebrew, right to left | Steps advance; back keeps entered values; the progress indicator is right to left |
| S2 | Kind selector: עוסק פטור / עוסק מורשה / חברה בע״מ | The label changes ת.ז./ע.מ. ↔ ח״פ |
| S3 | Keyboards | Phone field opens the numeric (tel) keyboard; email opens the email keyboard; tax id opens digits |
| S4 | Invalid tax id (bad check digit) | Inline Hebrew error on that field; the number isn't repeated in toasts |
| S5 | Legal name 121 characters / phone 8 digits | Refused at the field, with the limit stated |
| S6 | Successful signup | Account opens; the business page shows kind / legal name / tax id read-only with the locked note |
| S7 | Google signup (`/register/google`) | Same identity step; account created; fields locked |
| S8 | Password manager (Google Password Manager / iCloud Keychain) | Offers to save on the account step only; never fills business fields with personal data |
| S9 | Rotate the phone mid-signup; background the app and return | No data lost; no double submit |
| S10 | Slow network (throttled) and network loss on submit | One account at most; a clear retry message; no partial account |
| S11 | Smallest screen (A2, I2) at 200% system font size | No horizontal scroll; buttons reachable; text not clipped |
| S12 | Android app (Capacitor), once built | Same as S1–S7 inside the app; the keyboard doesn't cover the submit button |

## L: Locked identity after signup (#1142)

| ID | Case | Expected |
|---|---|---|
| L1 | Billing identity form for a new business | Kind / legal name / tax id read-only; address, phone and email editable and saved |
| L2 | Existing (pre-signup-change) business | Everything editable exactly as before; no locked note |
| L3 | Issue an invoice and a receipt after signup | The documents show the signup identity; previously issued documents unchanged |

## C: Correction, owner side (#1152)

The flag is ON in Preview only.

| ID | Case | Expected |
|---|---|---|
| C1 | Open the correction request page | Current values shown; "נבדק מבנה המספר בלבד" wording; never "verified" |
| C2 | Typo correction (same entity) | Re-verification asks for the password, or a recent Google sign-in; the request is created as ממתין לבדיקה |
| C3 | Individual → company | Refused with an explanation (different legal entity) |
| C4 | Upload from the camera (A1, I1) | iPhone camera photos are HEIC by default: confirm Safari hands over JPEG, or that a clear Hebrew error appears; never a silent failure |
| C5 | Upload a PDF from Files / Drive / iCloud | Accepted up to 10 MB; an 11 MB file is refused with the limit stated |
| C6 | 6th attachment | Refused (5 maximum) |
| C7 | Download your own attachment | Downloads as a file (no inline render); works on iOS Safari and Android Chrome |
| C8 | Cancel the request | Status בוטל; no further uploads |
| C9 | After an admin requests more information | "התבקש מידע נוסף" with the public note; upload works |
| C10 | After a decision | אושר ובוצע or נדחה with the public note only; never the internal note or the approver's name |

## A: Admin side (#1154), desktop plus one phone for read-only display

| ID | Case | Expected |
|---|---|---|
| A1 | Admin **without** the approver permission | Pages and API refuse (403 LEGAL_IDENTITY_APPROVER_REQUIRED); nothing sensitive shown |
| A2 | Approver: list, then detail | Masked tax ids in the list; full detail; side-by-side current/requested; attachments open as downloads |
| A3 | Decide without a fresh MFA step-up | Asked to re-verify before deciding |
| A4 | Approve without the confirmation checkbox / without both notes | Refused |
| A5 | Approve | Owner sees אושר ובוצע; the profile updated; issued documents unchanged |
| A6 | Request more information | Owner sees the note; status stays pending |
| A7 | Two admins deciding at the same time | One succeeds; the other gets "already decided" |

## Exit criteria

- Every S, L and C case PASS on at least one physical Android (A1) and one physical iPhone (I1).
- S11 PASS on a small-screen physical device.
- No FAIL left without an owner decision.

**Results go in a table on the PR, each marked PHYSICAL or EMULATOR.**
