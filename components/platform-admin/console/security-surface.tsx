"use client";

/**
 * Admin security (A1): the second factors that protect the admin area.
 *
 *   - authenticator app (TOTP): enroll with a QR code, confirm with a code,
 *     receive the ten single-use recovery codes ONCE; replace it later (needs a
 *     fresh verification — a recovery code or passkey works if the phone is gone);
 *   - passkeys: Face ID / fingerprint / device PIN as a faster, phishing-
 *     resistant step-up; add (needs a fresh verification) and remove;
 *   - end the current verification on this device.
 *
 * Seeds, codes and recovery codes live in component state only for as long as
 * they are on screen. Nothing here is logged or stored in the browser.
 */
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";
import type { PlatformAdminSessionResponse } from "@/lib/services/platform-admin/types";
import {
  PlatformAdminFetchError,
  beginAdminMfaReplacement,
  confirmAdminMfaEnrollment,
  confirmAdminMfaReplacement,
  fetchAdminPasskeys,
  fetchPlatformAdminSession,
  registerAdminPasskey,
  revokeAdminPasskey,
  startAdminMfaEnrollment,
  type AdminPasskeyItem,
} from "@/lib/platform-admin/fetch-platform-admin";
import { clearAdminElevation } from "@/lib/platform-admin/admin-elevation";
import { formatRelativeTime } from "../platform-usage-labels";
import { ConsoleIcon } from "./console-icons";
import { ErrorBlock, LoadingBlock } from "./console-states";
import { useAdminLoad } from "./use-admin-load";
import styles from "./admin-console.module.css";

/** The secret, for typing it in by hand when the QR cannot be scanned. */
function secretFromUri(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("secret");
  } catch {
    return null;
  }
}

function guessDeviceLabel(): string {
  if (typeof navigator === "undefined") return "מפתח גישה";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "מפתח גישה";
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof PlatformAdminFetchError) {
    if (error.status === 429) return "יותר מדי ניסיונות. המתן מעט ונסה שוב.";
    if (error.code === "invalid_code") return "הקוד שגוי או פג תוקפו. נסה עם הקוד הנוכחי באפליקציה.";
    if (error.code === "ADMIN_MFA_REQUIRED") return "נדרש אימות נוסף כדי להמשיך.";
    if (error.code === "MFA_NOT_CONFIGURED") return "אימות דו-שלבי לא מוגדר בסביבה הזו.";
    if (error.code === "ALREADY_ENROLLED") return "כבר מוגדרת אפליקציית אימות לחשבון.";
    if (error.code === "superseded" || error.code === "bad_replacement") {
      return "תהליך ההחלפה פג או הוחלף. התחל שוב.";
    }
    if (error.code === "TOO_MANY_PASSKEYS") return "הגעת למספר המרבי של מפתחות גישה.";
    if (error.code === "duplicate") return "מפתח הגישה הזה כבר רשום.";
  }
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "הפעולה בוטלה או שהזמן עבר. נסה שוב.";
  }
  return fallback;
}

/* ------------------------------ authenticator ----------------------------- */

type EnrollStep =
  | { kind: "idle" }
  /** `replacementToken` is set when this scan REPLACES an active authenticator. */
  | { kind: "scan"; uri: string; replacementToken?: string }
  | { kind: "codes"; codes: string[] };

function AuthenticatorCard({
  session,
  onChanged,
}: {
  session: PlatformAdminSessionResponse;
  onChanged: () => void;
}) {
  const [step, setStep] = useState<EnrollStep>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [copied, setCopied] = useState(false);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      const { otpauthUri } = await startAdminMfaEnrollment();
      setStep({ kind: "scan", uri: otpauthUri });
    } catch (e) {
      setError(errorText(e, "לא הצלחנו להתחיל את ההגדרה."));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    const submitted = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(submitted)) {
      setError("הזן את 6 הספרות שמוצגות באפליקציה.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { recoveryCodes } =
        step.kind === "scan" && step.replacementToken
          ? await confirmAdminMfaReplacement(step.replacementToken, submitted)
          : await confirmAdminMfaEnrollment(submitted);
      setCode("");
      setStep({ kind: "codes", codes: recoveryCodes });
    } catch (e) {
      setError(errorText(e, "האימות נכשל."));
    } finally {
      setBusy(false);
    }
  }

  async function beginReplace() {
    setBusy(true);
    setError(null);
    try {
      const { otpauthUri, replacementToken } = await beginAdminMfaReplacement();
      setConfirmReplace(false);
      setStep({ kind: "scan", uri: otpauthUri, replacementToken });
    } catch (e) {
      setError(errorText(e, "לא הצלחנו להתחיל את ההחלפה."));
    } finally {
      setBusy(false);
    }
  }

  async function copyCodes(codes: string[]) {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const enrolled = session.mfa.enrolled;

  return (
    <section className={styles.card} aria-labelledby="totp-title">
      <div className={styles.cardHead}>
        <h2 id="totp-title">אפליקציית אימות</h2>
        {enrolled ? (
          <span className={`${styles.pill} ${styles.pillOk}`}>פעילה</span>
        ) : (
          <span className={`${styles.pill} ${styles.pillWarn}`}>לא הוגדרה</span>
        )}
      </div>

      {step.kind === "scan" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <p className={styles.note}>
            סרוק את הקוד באפליקציית אימות, למשל Google Authenticator או 1Password. אחר כך הזן את הקוד בן 6 הספרות שהיא מציגה.
            {step.replacementToken ? " האפליקציה הקודמת ממשיכה לעבוד עד שתאשר כאן קוד מהחדשה." : ""}
          </p>
          <div className={styles.qr}>
            <QRCodeSVG value={step.uri} size={176} level="M" />
          </div>
          {secretFromUri(step.uri) ? (
            <div>
              <p className={styles.note}>אין אפשרות לסרוק? הזן את המפתח ידנית:</p>
              <div className={styles.secret}>{secretFromUri(step.uri)}</div>
            </div>
          ) : null}
          <label className={styles.field} htmlFor="admin-totp-confirm">
            קוד מהאפליקציה
            <input
              id="admin-totp-confirm"
              className={styles.codeInput}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void confirm();
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              disabled={busy}
            />
          </label>
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void confirm()} disabled={busy}>
              {busy ? "מאמת…" : step.replacementToken ? "אשר והחלף" : "אשר והפעל"}
            </button>
            <button type="button" className={styles.btn} onClick={() => setStep({ kind: "idle" })} disabled={busy}>
              ביטול
            </button>
          </div>
        </div>
      ) : step.kind === "codes" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <p className={styles.note}>
            אפליקציית האימות פעילה. אלה קודי השחזור שלך. כל קוד עובד פעם אחת, והם מוצגים <b>רק עכשיו</b>. שמור אותם במקום בטוח, למשל במנהל הסיסמאות.
          </p>
          <div className={styles.codes} aria-label="קודי שחזור">
            {step.codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.btn} onClick={() => void copyCodes(step.codes)}>
              {copied ? "הועתק" : "העתק את הקודים"}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => {
                setStep({ kind: "idle" });
                setCopied(false);
                onChanged();
              }}
            >
              שמרתי אותם
            </button>
          </div>
        </div>
      ) : enrolled ? (
        <div style={{ display: "grid", gap: 10 }}>
          <p className={styles.note}>
            נותרו {session.mfa.recoveryCodesRemaining} קודי שחזור.
            {session.mfa.recoveryCodesRemaining <= 3
              ? " כדאי להחליף את האפליקציה כדי לקבל קודים חדשים."
              : ""}
          </p>
          {confirmReplace ? (
            <div className={`${styles.card} ${styles.cardAttention}`} style={{ boxShadow: "none" }}>
              <p className={styles.note} style={{ marginBottom: 10 }}>
                תתבקש לאמת את עצמך, ואז לסרוק קוד חדש. האפליקציה הנוכחית וקודי השחזור הקיימים יפסיקו לעבוד רק אחרי שתאשר קוד מהאפליקציה החדשה. הפעולה נרשמת ביומן.
              </p>
              <div className={styles.actions}>
                <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void beginReplace()} disabled={busy}>
                  {busy ? "מתחיל…" : "המשך להחלפה"}
                </button>
                <button type="button" className={styles.btn} onClick={() => setConfirmReplace(false)} disabled={busy}>
                  ביטול
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button type="button" className={styles.btn} onClick={() => setConfirmReplace(true)}>
                החלפת אפליקציה או טלפון
              </button>
            </div>
          )}
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <p className={styles.note}>
            {session.mfa.required
              ? "אימות דו-שלבי נדרש בסביבה הזו. הגדר אפליקציית אימות כדי לגשת לנתוני הניהול."
              : "אימות דו-שלבי לא נאכף בסביבה הזו, אבל מומלץ להגדיר אותו."}
          </p>
          <div>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void begin()} disabled={busy}>
              {busy ? "מתחיל…" : "הגדרת אפליקציית אימות"}
            </button>
          </div>
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/* --------------------------------- passkeys -------------------------------- */

function PasskeysCard({ session }: { session: PlatformAdminSessionResponse }) {
  // Local edits (add / remove) layered over the loaded list.
  const [items, setItems] = useState<AdminPasskeyItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [removing, setRemoving] = useState<number | null>(null);
  const factorReady = session.mfa.enrolled || session.mfa.passkeys.count > 0;
  const load = useAdminLoad("passkeys", fetchAdminPasskeys, session.mfa.passkeys.available && factorReady);
  const loadError = load.error;
  const shown = items ?? load.data?.passkeys ?? null;

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const created = await registerAdminPasskey(label.trim() || guessDeviceLabel());
      setItems([...(shown ?? []), created]);
      setLabel("");
    } catch (e) {
      setError(errorText(e, "לא הצלחנו להוסיף את מפתח הגישה."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true);
    setError(null);
    try {
      await revokeAdminPasskey(id);
      setItems((shown ?? []).filter((p) => p.id !== id));
      setRemoving(null);
    } catch (e) {
      setError(errorText(e, "ההסרה נכשלה."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} aria-labelledby="passkeys-title">
      <div className={styles.cardHead}>
        <h2 id="passkeys-title">מפתחות גישה (Face ID / טביעת אצבע)</h2>
        {session.mfa.passkeys.available ? null : (
          <span className={`${styles.pill} ${styles.pillNeutral}`}>כבוי בסביבה הזו</span>
        )}
      </div>

      {!session.mfa.passkeys.available ? (
        <p className={styles.note}>
          מפתחות גישה עוד לא הופעלו בסביבה הזו. בינתיים האימות הנוסף נעשה עם אפליקציית האימות.
        </p>
      ) : !factorReady ? (
        <p className={styles.note}>הגדר קודם אפליקציית אימות. אחר כך תוכל להוסיף מפתח גישה.</p>
      ) : loadError ? (
        <ErrorBlock error={loadError} onRetry={load.reload} />
      ) : shown === null ? (
        <LoadingBlock height={80} />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {shown.length === 0 ? (
            <p className={styles.note}>
              אין עדיין מפתח גישה. עם מפתח גישה מאמתים בטלפון ב־Face ID או בטביעת אצבע, בלי להקליד קוד.
            </p>
          ) : (
            <div className={styles.list}>
              {shown.map((p) => (
                <div key={p.id} className={styles.row}>
                  <ConsoleIcon name="key" />
                  <span>
                    <span className={styles.rowTitle}>{p.label}</span>
                    <span className={styles.rowSub}>
                      נוסף {formatRelativeTime(p.createdAt)}
                      {p.lastUsedAt ? ` · שימוש אחרון ${formatRelativeTime(p.lastUsedAt)}` : " · עוד לא נעשה בו שימוש"}
                      {p.backedUp ? " · מסונכרן בענן" : ""}
                    </span>
                  </span>
                  {removing === p.id ? (
                    <span className={styles.actions}>
                      <button type="button" className={`${styles.btn} ${styles.btnDanger} ${styles.btnSmall}`} onClick={() => void remove(p.id)} disabled={busy}>
                        הסר
                      </button>
                      <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setRemoving(null)} disabled={busy}>
                        ביטול
                      </button>
                    </span>
                  ) : (
                    <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setRemoving(p.id)}>
                      הסרה
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
            <label className={styles.field} htmlFor="admin-passkey-label" style={{ flex: "1 1 220px" }}>
              שם למכשיר (לא חובה)
              <input
                id="admin-passkey-label"
                value={label}
                onChange={(e) => setLabel(e.target.value.slice(0, 60))}
                placeholder={guessDeviceLabel()}
                maxLength={60}
              />
            </label>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void add()} disabled={busy}>
              <ConsoleIcon name="face" size={16} />
              {busy ? "ממתין למכשיר…" : "הוספת מפתח גישה"}
            </button>
          </div>
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/* ---------------------------------- page ----------------------------------- */

export function SecuritySurface({ initial }: { initial: PlatformAdminSessionResponse }) {
  const [session, setSession] = useState<PlatformAdminSessionResponse>(initial);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [ended, setEnded] = useState(false);

  const refresh = useCallback(() => {
    fetchPlatformAdminSession().then(
      (s) => {
        setSession(s);
        setLoadError(null);
      },
      (e) => setLoadError(e)
    );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>אבטחה</h1>
          <p>אמצעי האימות שמגינים על אזור הניהול</p>
        </div>
      </div>

      {loadError ? <ErrorBlock error={loadError} onRetry={refresh} /> : null}

      <section className={styles.card} aria-labelledby="status-title">
        <div className={styles.cardHead}>
          <h2 id="status-title">מצב האימות במכשיר הזה</h2>
          {session.mfa.required ? (
            <span className={`${styles.pill} ${styles.pillInfo}`}>אימות נוסף נאכף</span>
          ) : (
            <span className={`${styles.pill} ${styles.pillWarn}`}>אימות נוסף לא נאכף</span>
          )}
        </div>
        <p className={styles.note}>
          אחרי אימות, הגישה לנתונים פתוחה במכשיר הזה ל־15 דקות ונשמרת רק בזיכרון של הלשונית. רענון הדף או סגירתו מבקשים אימות מחדש.
        </p>
        <div className={styles.actions} style={{ marginTop: 10 }}>
          <button
            type="button"
            className={styles.btn}
            onClick={() => {
              clearAdminElevation();
              setEnded(true);
            }}
          >
            סיום האימות עכשיו
          </button>
          <Link href="/settings/security" className={styles.btn}>
            מכשירים וחיבורים פעילים
          </Link>
        </div>
        {ended ? (
          <p className={styles.note} role="status" style={{ marginTop: 8 }}>
            האימות הסתיים במכשיר הזה. הפעולה המוגנת הבאה תבקש אימות.
          </p>
        ) : null}
      </section>

      <AuthenticatorCard session={session} onChanged={refresh} />
      <PasskeysCard session={session} />
    </>
  );
}
