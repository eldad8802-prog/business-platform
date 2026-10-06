"use client";

import { useCallback, useEffect, useState } from "react";
import { Action, Field, stamp } from "./LeadSourcesPanel";

/**
 * Settings → Connections → "חנויות ושיחות" (M7-B / M7-C).
 *
 * The owner connects their online store (WooCommerce, Wix) and their phone system (CloudTalk, Voicenter):
 * orders and calls appear in Dubiz next to the customer — an order is never a lead, a call is not automatically
 * a lead, nothing moves stock, payments or documents. Everything goes through /api/integrations/*; no key,
 * secret or token is ever shown back (Voicenter's address is shown ONCE, right after it is created; CloudTalk's
 * secret and API key are typed in and only "saved" is ever shown).
 *
 * A source that is not switched on for the business is shown as "coming soon", and Wix is connectable only when
 * the Dubiz Wix app is configured — never a button that cannot work.
 */

type SourceKey = "commerce.woocommerce" | "commerce.wix" | "telephony.cloudtalk" | "telephony.voicenter";
type Connection = {
  id: number;
  sourceKey: string;
  status: "ACTIVE" | "PAUSED" | "ERROR" | "REVOKED";
  label: string | null;
  keyHint: string | null;
  lastEventAt: string | null;
  lastErrorCode: string | null;
  endpointUrl: string | null;
  activity: { lastTestAt: string | null; lastDeliveryAt: string | null; deliveries30d: number } | null;
  /** CloudTalk: which of its two values the owner has saved (flags only). */
  setup: { signingSecret: boolean; apiKey: boolean } | null;
};
type Overview = {
  sources: Record<string, boolean>;
  wix?: { available: boolean; installUrl: string | null };
  connections: Connection[];
};

const SOURCES: { key: SourceKey; title: string; description: string; noun: string }[] = [
  { key: "commerce.woocommerce", title: "חנות WooCommerce", description: "הזמנות מהחנות שלך בוורדפרס מופיעות ב-Dubiz ליד הלקוח.", noun: "הזמנה" },
  { key: "commerce.wix", title: "חנות Wix", description: "הזמנות מחנות ה-Wix שלך מופיעות ב-Dubiz ליד הלקוח.", noun: "הזמנה" },
  { key: "telephony.cloudtalk", title: "CloudTalk", description: "שיחות נכנסות, יוצאות ושלא נענו — כדי שאף לקוח לא יישאר בלי חזרה.", noun: "שיחה" },
  { key: "telephony.voicenter", title: "Voicenter", description: "שיחות נכנסות, יוצאות ושלא נענו — כדי שאף לקוח לא יישאר בלי חזרה.", noun: "שיחה" },
];

const STATUS: Record<Connection["status"], { label: string; tone: string }> = {
  ACTIVE: { label: "פעיל", tone: "bg-[var(--dz-success-bg-soft)] text-[var(--dz-success)]" },
  PAUSED: { label: "מושהה", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
  ERROR: { label: "דורש טיפול", tone: "bg-[var(--dz-danger-bg-soft)] text-[var(--dz-danger)]" },
  REVOKED: { label: "מנותק", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
};

/** What the owner can do about a provider-side problem (lastErrorCode → plain words). */
const HEALTH: Record<string, string> = {
  WOO_KEYS_REVOKED: "החנות ביטלה את ההרשאה של Dubiz — חבר/י את החנות מחדש.",
  WOO_STORE_UNREACHABLE: "לא ניתן להגיע לחנות כרגע. ננסה שוב אוטומטית.",
  WOO_STORE_ERROR: "החנות החזירה שגיאה. ננסה שוב אוטומטית.",
  WOO_WEBHOOK_SETUP_FAILED: "לא הצלחנו להגדיר את העדכונים בחנות. ננסה שוב אוטומטית.",
  WOO_RECONCILE_FAILED: "בדיקת ההזמנות נכשלה. ננסה שוב אוטומטית.",
  WIX_APP_UNINSTALLED: "האפליקציה של Dubiz הוסרה מהאתר ב-Wix — התקן/י אותה מחדש.",
  WIX_RECONCILE_FAILED: "בדיקת ההזמנות נכשלה. ננסה שוב אוטומטית.",
};

const ERRORS: Record<string, string> = {
  source_not_enabled: "החיבור הזה עדיין לא פתוח בחשבון שלך.",
  unavailable: "החיבור עדיין לא זמין.",
  invalid_store_url: "כתובת החנות לא תקינה — למשל: https://www.my-shop.co.il",
  signing_secret_invalid: 'ה-Signing secret לא תקין — הוא מתחיל ב-"whsec_".',
  api_key_invalid: "מפתח ה-API לא תקין — צריך גם את ה-ID וגם את ה-Secret.",
  nothing_to_set: "לא הוזן דבר לשמירה.",
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  let t: string | null = null;
  try {
    t = localStorage.getItem("token");
  } catch {
    t = null;
  }
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(ERRORS[json.error ?? ""] ?? "משהו השתבש — נסה/י שוב.");
  return json;
}

function when(c: Connection, noun: string): string {
  const last = c.activity?.lastDeliveryAt ?? c.lastEventAt;
  if (!last) return `עוד לא התקבלה ${noun}`;
  const n = c.activity?.deliveries30d ?? 0;
  return `עדכון אחרון: ${stamp(last)}${n > 0 ? ` · ${n} ב-30 הימים האחרונים` : ""}`;
}

export function StoresAndCallsPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [storeUrl, setStoreUrl] = useState("");
  const [voicenterUrl, setVoicenterUrl] = useState<{ connectionId: number; url: string } | null>(null);

  const load = useCallback(() => api<Overview>("/api/integrations/acquisition").then(setData, (e: unknown) => setError(e instanceof Error ? e.message : "לא ניתן לטעון.")), []);
  useEffect(() => {
    let live = true;
    api<Overview>("/api/integrations/acquisition").then(
      (d) => live && setData(d),
      (e: unknown) => live && setError(e instanceof Error ? e.message : "לא ניתן לטעון.")
    );
    return () => {
      live = false;
    };
  }, []);

  async function run(tag: string, fn: () => Promise<void>) {
    setBusy(tag);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "משהו השתבש — נסה/י שוב.");
    } finally {
      setBusy(null);
    }
  }

  const connectWoo = () =>
    run("create:woo", async () => {
      if (!storeUrl.trim()) throw new Error(ERRORS.invalid_store_url);
      const r = await api<{ authorizeUrl: string }>("/api/integrations/commerce/woocommerce", { storeUrl: storeUrl.trim() });
      window.location.assign(r.authorizeUrl);
    });

  const createLine = (sourceKey: "telephony.cloudtalk" | "telephony.voicenter") =>
    run(`create:${sourceKey}`, async () => {
      const r = await api<{ connection: Connection; key?: string }>("/api/integrations/acquisition", { sourceKey });
      if (sourceKey === "telephony.voicenter" && r.connection.endpointUrl) setVoicenterUrl({ connectionId: r.connection.id, url: r.connection.endpointUrl });
    });

  const act = (c: Connection, action: "pause" | "resume" | "revoke" | "rotate") =>
    run(`${action}:${c.id}`, async () => {
      if (action === "revoke" && !window.confirm("לנתק את החיבור? עדכונים חדשים ממנו לא ייכנסו יותר.")) return;
      if (action === "rotate" && !window.confirm("ליצור כתובת חדשה? הכתובת הקודמת תפסיק לעבוד מיד ויהיה צריך לעדכן אותה ב-Voicenter.")) return;
      const r = await api<{ connection: Connection; key?: string }>(`/api/integrations/acquisition/${c.id}`, { action });
      if (r.key && r.connection.endpointUrl) setVoicenterUrl({ connectionId: c.id, url: r.connection.endpointUrl.replace("<key>", r.key) });
    });

  if (!data) {
    return (
      <section className="rounded-[24px] dz-mist p-4 shadow-sm" dir="rtl">
        <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">חנויות ושיחות</h2>
        <p className="mt-1 text-xs text-[var(--dz-text-muted)]">{error ?? "טוען…"}</p>
      </section>
    );
  }

  return (
    <section className="rounded-[24px] dz-mist p-4 shadow-sm md:col-span-2" dir="rtl">
      <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">חנויות ושיחות</h2>
      <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
        הזמנות מהחנות ושיחות מהטלפוניה מופיעות ליד הלקוח. Dubiz רק מציג — הוא לא משנה מלאי, תשלומים או מסמכים, והזמנה או שיחה לא הופכות לליד מעצמן.
      </p>
      {error ? <p className="mt-3 rounded-2xl bg-[var(--dz-danger-bg-soft)] px-3 py-2 text-xs font-bold text-[var(--dz-danger)]">{error}</p> : null}

      <div className="mt-3 space-y-3">
        {SOURCES.map((s) => {
          const enabled = !!data.sources[s.key];
          const available = enabled && (s.key !== "commerce.wix" || !!data.wix?.available);
          const live = data.connections.filter((c) => c.sourceKey === s.key && c.status !== "REVOKED");
          return (
            <div key={s.key} className="rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-bold text-[var(--dz-text-primary)]">{s.title}</h3>
                {!available ? (
                  <span className="rounded-full bg-[var(--dz-surface-muted)] px-3 py-1 text-xs font-bold text-[var(--dz-text-muted)]">בקרוב</span>
                ) : !live.length ? (
                  <span className="rounded-full bg-[var(--dz-surface-muted)] px-3 py-1 text-xs font-bold text-[var(--dz-text-muted)]">לא מחובר</span>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">{s.description}</p>

              {live.map((c) => (
                <div key={c.id} className="mt-3 rounded-2xl bg-[var(--dz-surface-muted)] px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold text-[var(--dz-text-primary)]">{c.label ?? s.title}</div>
                      <div className="text-[11px] text-[var(--dz-text-muted)]">{when(c, s.noun)}</div>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${STATUS[c.status].tone}`}>{STATUS[c.status].label}</span>
                  </div>
                  {c.status === "ERROR" && c.lastErrorCode ? (
                    <p className="mt-1 text-[11px] font-bold text-[var(--dz-danger)]">{HEALTH[c.lastErrorCode] ?? "יש בעיה בחיבור. ננסה שוב אוטומטית."}</p>
                  ) : null}
                  {c.sourceKey === "telephony.cloudtalk" ? <CloudTalkSetup c={c} onSaved={load} /> : null}
                  {c.sourceKey === "telephony.voicenter" && c.endpointUrl ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-bold text-[var(--dz-text-muted)]">איך מחברים ב-Voicenter</summary>
                      <p className="mt-1 text-[11px] leading-5 text-[var(--dz-text-muted)]">
                        את הכתובת המלאה (עם הקוד הסודי) מוסרים ל-Voicenter כ&quot;כתובת CDR&quot;. היא מוצגת רק פעם אחת — שכחת אותה? צור/י כתובת חדשה.
                      </p>
                    </details>
                  ) : null}
                  {voicenterUrl?.connectionId === c.id ? (
                    <div className="mt-3 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-3">
                      <p className="text-xs font-bold text-[var(--dz-text-primary)]">העתק/י עכשיו — הכתובת לא תוצג שוב.</p>
                      <p className="mt-1 text-[11px] leading-5 text-[var(--dz-text-muted)]">שלח/י אותה לתמיכה של Voicenter (או הדבק/י ב-Backoffice) ככתובת לקבלת נתוני שיחות (CDR).</p>
                      <Field label="כתובת לקבלת שיחות" value={voicenterUrl.url} />
                      <div className="mt-3">
                        <Action onClick={() => setVoicenterUrl(null)} primary>שמרתי, סיום</Action>
                      </div>
                    </div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {c.sourceKey === "telephony.voicenter" ? <Action onClick={() => act(c, "rotate")} busy={busy === `rotate:${c.id}`}>כתובת חדשה</Action> : null}
                    {c.status === "PAUSED" ? (
                      <Action onClick={() => act(c, "resume")} busy={busy === `resume:${c.id}`}>הפעלה</Action>
                    ) : (
                      <Action onClick={() => act(c, "pause")} busy={busy === `pause:${c.id}`}>השהיה</Action>
                    )}
                    <Action onClick={() => act(c, "revoke")} busy={busy === `revoke:${c.id}`} danger>ניתוק</Action>
                  </div>
                </div>
              ))}

              {available && s.key === "commerce.woocommerce" ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    dir="ltr"
                    value={storeUrl}
                    onChange={(e) => setStoreUrl(e.target.value)}
                    placeholder="כתובת החנות, למשל https://www.my-shop.co.il"
                    aria-label="כתובת החנות"
                    className="min-w-0 flex-1 rounded-full border border-[var(--dz-border)] bg-[var(--dz-surface)] px-3 py-1 text-xs"
                  />
                  <Action onClick={connectWoo} busy={busy === "create:woo"} primary>{live.length ? "חיבור מחדש" : "חיבור החנות"}</Action>
                </div>
              ) : null}
              {available && s.key === "commerce.wix" && data.wix?.installUrl ? (
                <div className="mt-3">
                  <p className="mb-2 text-[11px] leading-5 text-[var(--dz-text-muted)]">מתקינים את האפליקציה של Dubiz באתר ה-Wix, ופותחים אותה מלוח הבקרה של Wix כדי לאשר את החיבור.</p>
                  <a href={data.wix.installUrl} target="_blank" rel="noreferrer" className="inline-block rounded-full bg-[var(--dz-text-primary)] px-4 py-1 text-xs font-bold text-[var(--dz-surface)]">
                    התקנת האפליקציה ב-Wix
                  </a>
                </div>
              ) : null}
              {available && (s.key === "telephony.cloudtalk" || s.key === "telephony.voicenter") && !live.length ? (
                <div className="mt-3">
                  <Action onClick={() => createLine(s.key as "telephony.cloudtalk" | "telephony.voicenter")} busy={busy === `create:${s.key}`} primary>
                    חיבור {s.title}
                  </Action>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** CloudTalk: the endpoint address to paste into CloudTalk, then its signing secret and API key back into Dubiz. */
function CloudTalkSetup({ c, onSaved }: { c: Connection; onSaved: () => Promise<void> }) {
  const [secret, setSecret] = useState("");
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!c.setup?.signingSecret && !!c.setup?.apiKey;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { action: "set_credentials" };
      if (secret.trim()) body.signingSecret = secret.trim();
      if (keyId.trim() || keySecret.trim()) {
        body.apiKeyId = keyId.trim();
        body.apiKeySecret = keySecret.trim();
      }
      await api(`/api/integrations/acquisition/${c.id}`, body);
      setSecret("");
      setKeyId("");
      setKeySecret("");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "משהו השתבש — נסה/י שוב.");
    } finally {
      setBusy(false);
    }
  }

  const input = "min-w-0 w-full rounded-full border border-[var(--dz-border)] bg-[var(--dz-surface)] px-3 py-1 text-xs";
  return (
    <details className="mt-2" open={!ready}>
      <summary className="cursor-pointer text-[11px] font-bold text-[var(--dz-text-muted)]">{ready ? "הגדרות החיבור — הושלמו ✓" : "השלמת החיבור (2 שלבים)"}</summary>
      <ol className="mt-2 list-decimal space-y-1 pr-4 text-[11px] leading-5 text-[var(--dz-text-muted)]">
        <li>ב-CloudTalk: Account ← Settings ← Webhooks ← הוספת Webhook עם הכתובת למטה ובחירת האירוע call.ended. אחרי השמירה העתק/י את ה-Signing secret.</li>
        <li>ב-CloudTalk: Account ← Settings ← API keys ← יצירת מפתח. הדבק/י כאן את ה-ID וה-Secret — כך Dubiz יודע אם שיחה נענתה.</li>
      </ol>
      {c.endpointUrl ? <Field label="כתובת ה-Webhook" value={c.endpointUrl} /> : null}
      <div className="mt-2 space-y-2">
        <div className="text-[11px] font-bold text-[var(--dz-text-muted)]">Signing secret {c.setup?.signingSecret ? "· נשמר ✓" : ""}</div>
        <input dir="ltr" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="whsec_…" aria-label="Signing secret" className={input} />
        <div className="text-[11px] font-bold text-[var(--dz-text-muted)]">מפתח API {c.setup?.apiKey ? "· נשמר ✓" : ""}</div>
        <input dir="ltr" autoComplete="off" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="API key ID" aria-label="API key ID" className={input} />
        <input dir="ltr" type="password" autoComplete="off" value={keySecret} onChange={(e) => setKeySecret(e.target.value)} placeholder="API key secret" aria-label="API key secret" className={input} />
        {error ? <p className="text-[11px] font-bold text-[var(--dz-danger)]">{error}</p> : null}
        <Action onClick={save} busy={busy} primary>שמירה</Action>
      </div>
      <p className="mt-2 text-[11px] text-[var(--dz-text-muted)]">הפרטים נשמרים מוצפנים ולא מוצגים שוב.</p>
    </details>
  );
}
