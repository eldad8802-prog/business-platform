"use client";

import { useCallback, useEffect, useState } from "react";
import { loadFacebookSdk } from "@/components/whatsapp/facebook-sdk";

/**
 * Settings → Connections → "מקורות לידים" (M6).
 *
 * The owner connects where leads come from — a form on their website, Google Ads lead forms,
 * Facebook / Instagram Lead Ads — and every lead lands in the same Leads list. Everything here goes
 * through /api/integrations/acquisition/*; no business id, key hash or token is ever shown or kept
 * in the browser. A new key is shown ONCE, right after it is created.
 *
 * A source that is not switched on for the business is shown as "not available yet", and Meta is
 * connectable only when Dubiz's Meta app is approved and configured (meta.available) — never a
 * button that cannot work.
 */

type SourceKey = "web.form" | "google.lead_form" | "meta.lead_ads";
type Connection = {
  id: number;
  sourceKey: SourceKey;
  status: "ACTIVE" | "PAUSED" | "ERROR" | "REVOKED";
  label: string | null;
  keyHint: string | null;
  allowedOrigins: string[];
  lastEventAt: string | null;
  lastErrorCode: string | null;
  endpointUrl: string | null;
};
type MetaLogin = { appId: string; configId: string; graphVersion: string };
type Overview = {
  sources: Record<SourceKey, boolean>;
  meta?: { available: boolean; login: MetaLogin | null };
  connections: Connection[];
};
type Secret = { connectionId: number; url: string; key: string };
type MetaPick = { handle: string; pages: { id: string; name: string; canAdvertise: boolean }[] };

const SOURCES: { key: SourceKey; title: string; description: string }[] = [
  { key: "web.form", title: "טופס באתר", description: "פניות מטופס יצירת הקשר באתר שלך נכנסות ישר לרשימת הלידים." },
  { key: "google.lead_form", title: "Google Ads", description: "לידים מטפסי לידים במודעות Google נכנסים אוטומטית." },
  { key: "meta.lead_ads", title: "Facebook ו-Instagram", description: "לידים ממודעות לידים בפייסבוק ובאינסטגרם נכנסים אוטומטית." },
];

const STATUS: Record<Connection["status"], { label: string; tone: string }> = {
  ACTIVE: { label: "פעיל — מקבל פניות", tone: "bg-[var(--dz-success-bg-soft)] text-[var(--dz-success)]" },
  PAUSED: { label: "מושהה — פניות לא מתקבלות", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
  ERROR: { label: "דורש חיבור מחדש", tone: "bg-[var(--dz-danger-bg-soft)] text-[var(--dz-danger)]" },
  REVOKED: { label: "מנותק", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
};

const ERRORS: Record<string, string> = {
  source_not_enabled: "המקור הזה עדיין לא פתוח בחשבון שלך.",
  unavailable: "החיבור לפייסבוק עדיין לא זמין.",
  page_not_managed: "הדף שבחרת לא מנוהל על ידי החשבון שהתחברת איתו.",
  advertise_task_required: "כדי לקבל לידים צריך הרשאת פרסום בדף הזה.",
  page_connected_to_another_business: "הדף הזה כבר מחובר לעסק אחר.",
  handle_expired: "עבר יותר מדי זמן — התחבר/י שוב לפייסבוק.",
  token_invalid: "פייסבוק לא אישר את ההתחברות — נסה/י שוב.",
  permission_missing: "חסרה הרשאה בפייסבוק — התחבר/י שוב ואשר/י את כל ההרשאות.",
  provider_error: "פייסבוק לא זמין כרגע — נסה/י שוב בעוד כמה דקות.",
};

function token(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const t = token();
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

function when(iso: string | null): string {
  if (!iso) return "עוד לא הגיעו לידים";
  return `ליד אחרון: ${new Date(iso).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}`;
}

function originOf(input: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
    return u.origin;
  } catch {
    return null;
  }
}

function Copy({ text, label = "העתקה" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 rounded-full border border-[var(--dz-border)] px-3 py-1 text-xs font-bold text-[var(--dz-text-primary)]"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "הועתק ✓" : label}
    </button>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2">
      <div className="text-[11px] font-bold text-[var(--dz-text-muted)]">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <code dir="ltr" className="min-w-0 flex-1 truncate rounded-xl bg-[var(--dz-surface-muted)] px-3 py-2 text-xs">{value}</code>
        <Copy text={value} />
      </div>
    </div>
  );
}

/**
 * The ready-made contact form an owner pastes into their own site (Wix / WordPress "HTML embed").
 * It carries NO secret: it posts from the browser, so the endpoint accepts it only from the site
 * address the owner gave, behind the honeypot and the rate limits. The one-line script records the
 * page the visitor was on (campaign tags included) for attribution.
 */
function formSnippet(url: string): string {
  return [
    `<form action="${url}" method="post" accept-charset="UTF-8" dir="rtl" style="display:grid;gap:8px;max-width:420px">`,
    `  <input name="name" placeholder="שם" autocomplete="name">`,
    `  <input name="phone" type="tel" placeholder="טלפון" autocomplete="tel" required>`,
    `  <input name="email" type="email" placeholder="אימייל (לא חובה)" autocomplete="email">`,
    `  <textarea name="message" rows="4" placeholder="במה נוכל לעזור?"></textarea>`,
    `  <input name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-5000px">`,
    `  <input type="hidden" name="page_url">`,
    `  <button type="submit">שליחה</button>`,
    `</form>`,
    `<script>document.querySelectorAll('input[name="page_url"]').forEach(function(i){i.value=location.href});</script>`,
  ].join("\n");
}

function WebFormInstall({ url }: { url: string }) {
  return (
    <div className="mt-2">
      <ol className="list-decimal space-y-1 pr-4 text-xs leading-5 text-[var(--dz-text-muted)]">
        <li>מעתיקים את הטופס המוכן.</li>
        <li>מדביקים אותו בעמוד &quot;צור קשר&quot; באתר (בוויקס / וורדפרס: רכיב &quot;HTML&quot; או &quot;קוד מוטמע&quot;).</li>
        <li>מכאן כל פנייה מהטופס נכנסת ישר לרשימת הלידים, עם העמוד והקמפיין שממנו הגיעה.</li>
      </ol>
      <div className="mt-2 flex flex-wrap gap-2">
        <Copy text={formSnippet(url)} label="העתקת הטופס המוכן" />
      </div>
    </div>
  );
}

function SecretBox({ source, secret, onDone }: { source: SourceKey; secret: Secret; onDone: () => void }) {
  const developerNote =
    `Send each form submission as an HTTP POST (JSON or form-encoded) to:\n${secret.url}\n` +
    `Header: Authorization: Bearer ${secret.key}\n` +
    `Fields: name, phone, email, message (any other field is kept as an answer); ` +
    `optional submission_id (prevents duplicates), page_url, utm_source/utm_medium/utm_campaign, gclid, fbclid.`;
  if (source === "web.form") {
    return (
      <div className="mt-3 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-3">
        <p className="text-xs font-bold text-[var(--dz-text-primary)]">הטופס מוכן — נשאר רק להדביק אותו באתר.</p>
        <WebFormInstall url={secret.url} />
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-bold text-[var(--dz-text-muted)]">למי שבנה את האתר: שליחה מהשרת (קוד סודי)</summary>
          <p className="mt-2 text-[11px] leading-5 text-[var(--dz-text-muted)]">הקוד הסודי מוצג רק עכשיו. הוא לשימוש בשרת של האתר בלבד — לעולם לא בתוך עמוד שהמבקרים רואים.</p>
          <Field label="כתובת" value={secret.url} />
          <Field label="קוד סודי" value={secret.key} />
          <div className="mt-2"><Copy text={developerNote} label="העתקת הוראות למפתח" /></div>
        </details>
        <div className="mt-3">
          <button type="button" onClick={onDone} className="rounded-full bg-[var(--dz-text-primary)] px-4 py-1 text-xs font-bold text-[var(--dz-surface)]">
            סיום
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-3">
      <p className="text-xs font-bold text-[var(--dz-text-primary)]">העתק/י עכשיו — הקוד לא יוצג שוב.</p>
      <ol className="mt-2 list-decimal space-y-1 pr-4 text-xs leading-5 text-[var(--dz-text-muted)]">
        <li>ב-Google Ads פתח/י את טופס הלידים ← &quot;שילוב Webhook&quot;.</li>
        <li>הדבק/י את הכתובת בשדה &quot;Webhook URL&quot; ואת הקוד בשדה &quot;Key&quot;.</li>
        <li>לחץ/י &quot;שליחת נתוני בדיקה&quot; — הבדיקה לא תיצור ליד, אבל תסמן שהחיבור עובד.</li>
      </ol>
      <Field label="כתובת" value={secret.url} />
      <Field label="קוד סודי" value={secret.key} />
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onDone} className="rounded-full bg-[var(--dz-text-primary)] px-4 py-1 text-xs font-bold text-[var(--dz-surface)]">
          שמרתי, סיום
        </button>
      </div>
    </div>
  );
}

export function LeadSourcesPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [siteInput, setSiteInput] = useState("");
  const [metaPick, setMetaPick] = useState<MetaPick | null>(null);

  const load = useCallback(
    () =>
      api<Overview>("/api/integrations/acquisition").then(setData, (e: unknown) =>
        setError(e instanceof Error ? e.message : "לא ניתן לטעון את מקורות הלידים.")
      ),
    []
  );
  useEffect(() => {
    let live = true;
    api<Overview>("/api/integrations/acquisition").then(
      (d) => live && setData(d),
      (e: unknown) => live && setError(e instanceof Error ? e.message : "לא ניתן לטעון את מקורות הלידים.")
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

  const create = (sourceKey: "web.form" | "google.lead_form") =>
    run(`create:${sourceKey}`, async () => {
      const site = sourceKey === "web.form" ? originOf(siteInput) : null;
      if (sourceKey === "web.form" && !siteInput.trim()) throw new Error("כדי שהטופס באתר יעבוד, צריך את כתובת האתר שלך.");
      if (sourceKey === "web.form" && !site) throw new Error("כתובת האתר לא תקינה — למשל: www.my-site.co.il");
      const r = await api<{ connection: Connection; key: string }>("/api/integrations/acquisition", {
        sourceKey,
        ...(site ? { allowedOrigins: [site] } : {}),
      });
      setSecret({ connectionId: r.connection.id, url: r.connection.endpointUrl ?? "", key: r.key });
    });

  const saveSite = (c: Connection, input: string) =>
    run(`site:${c.id}`, async () => {
      const site = originOf(input);
      if (!input.trim() || !site) throw new Error("כתובת האתר לא תקינה — למשל: www.my-site.co.il");
      await api(`/api/integrations/acquisition/${c.id}`, { action: "set_origins", allowedOrigins: [site] });
    });

  const act = (c: Connection, action: "rotate" | "pause" | "resume" | "revoke") =>
    run(`${action}:${c.id}`, async () => {
      if (action === "revoke" && !window.confirm("לנתק את החיבור? לידים חדשים מהמקור הזה לא ייכנסו יותר.")) return;
      if (action === "rotate" && !window.confirm("ליצור קוד חדש? הקוד הקודם יפסיק לעבוד מיד ויהיה צריך לעדכן אותו.")) return;
      const r = await api<{ connection: Connection; key?: string }>(`/api/integrations/acquisition/${c.id}`, { action });
      if (r.key) setSecret({ connectionId: c.id, url: r.connection.endpointUrl ?? "", key: r.key });
    });

  const metaLogin = () =>
    run("meta:login", async () => {
      const login = data?.meta?.login;
      if (!login) throw new Error(ERRORS.unavailable);
      const fb = await loadFacebookSdk(login);
      const code = await new Promise<string>((resolve, reject) =>
        fb.login(
          (resp) => (resp.authResponse?.code ? resolve(resp.authResponse.code) : reject(new Error("ההתחברות לפייסבוק בוטלה."))),
          { config_id: login.configId, response_type: "code", override_default_response_type: true }
        )
      );
      const r = await api<MetaPick>("/api/integrations/acquisition/meta/pages", { code });
      if (!r.pages.length) throw new Error("לא נמצאו דפים בחשבון הזה.");
      setMetaPick(r);
    });

  const metaConnect = (pageId: string) =>
    run(`meta:connect:${pageId}`, async () => {
      if (!metaPick) return;
      await api("/api/integrations/acquisition/meta/connect", { handle: metaPick.handle, pageId });
      setMetaPick(null);
    });

  if (!data) {
    return (
      <section className="rounded-[24px] dz-mist p-4 shadow-sm" dir="rtl">
        <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">מקורות לידים</h2>
        <p className="mt-1 text-xs text-[var(--dz-text-muted)]">{error ?? "טוען…"}</p>
      </section>
    );
  }

  return (
    <section className="rounded-[24px] dz-mist p-4 shadow-sm md:col-span-2" dir="rtl">
      <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">מקורות לידים</h2>
      <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
        חבר/י את המקומות שמהם מגיעים לקוחות — כל ליד נכנס לרשימת הלידים, עם המקור והקמפיין שממנו הגיע.
      </p>
      {error ? (
        <p className="mt-3 rounded-2xl bg-[var(--dz-danger-bg-soft)] px-3 py-2 text-xs font-bold text-[var(--dz-danger)]">{error}</p>
      ) : null}

      <div className="mt-3 space-y-3">
        {SOURCES.map((s) => {
          const enabled = data.sources[s.key];
          const metaReady = s.key !== "meta.lead_ads" || !!data.meta?.available;
          const live = data.connections.filter((c) => c.sourceKey === s.key && c.status !== "REVOKED");
          const available = enabled && metaReady;
          return (
            <div key={s.key} className="rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-bold text-[var(--dz-text-primary)]">{s.title}</h3>
                {!available ? (
                  <span className="rounded-full bg-[var(--dz-surface-muted)] px-3 py-1 text-xs font-bold text-[var(--dz-text-muted)]">
                    {s.key === "meta.lead_ads" && enabled ? "ממתין לאישור של Meta" : "בקרוב"}
                  </span>
                ) : !live.length ? (
                  <span className="rounded-full bg-[var(--dz-surface-muted)] px-3 py-1 text-xs font-bold text-[var(--dz-text-muted)]">לא מחובר</span>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">{s.description}</p>
              {!available && s.key === "meta.lead_ads" ? (
                <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
                  החיבור לפייסבוק ואינסטגרם ייפתח ברגע ש-Meta תאשר את Dubiz לקבלת לידים. אין צורך לעשות דבר בינתיים.
                </p>
              ) : null}

              {live.map((c) => (
                <div key={c.id} className="mt-3 rounded-2xl bg-[var(--dz-surface-muted)] px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold text-[var(--dz-text-primary)]">
                        {c.label ?? s.title}
                        {c.allowedOrigins.length ? <span className="font-normal text-[var(--dz-text-muted)]"> · {c.allowedOrigins.map((o) => o.replace(/^https?:\/\//, "")).join(", ")}</span> : null}
                      </div>
                      <div className="text-[11px] text-[var(--dz-text-muted)]">{when(c.lastEventAt)}</div>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${STATUS[c.status].tone}`}>{STATUS[c.status].label}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {c.sourceKey === "meta.lead_ads" && c.status === "ERROR" && available ? (
                      <Action onClick={metaLogin} busy={busy === "meta:login"}>חיבור מחדש</Action>
                    ) : null}
                    {c.sourceKey !== "meta.lead_ads" ? (
                      <>
                        <Action onClick={() => act(c, "rotate")} busy={busy === `rotate:${c.id}`}>קוד חדש</Action>
                        {c.status === "PAUSED" ? (
                          <Action onClick={() => act(c, "resume")} busy={busy === `resume:${c.id}`}>הפעלה</Action>
                        ) : (
                          <Action onClick={() => act(c, "pause")} busy={busy === `pause:${c.id}`}>השהיה</Action>
                        )}
                      </>
                    ) : null}
                    <Action onClick={() => act(c, "revoke")} busy={busy === `revoke:${c.id}`} danger>ניתוק</Action>
                  </div>
                  {c.endpointUrl && c.status !== "PAUSED" && c.sourceKey === "web.form" ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-bold text-[var(--dz-text-muted)]">הטופס להדבקה באתר</summary>
                      <WebFormInstall url={c.endpointUrl} />
                      <SiteEditor current={c.allowedOrigins} busy={busy === `site:${c.id}`} onSave={(v) => saveSite(c, v)} />
                    </details>
                  ) : c.endpointUrl && c.status !== "PAUSED" ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-bold text-[var(--dz-text-muted)]">הכתובת לחיבור</summary>
                      <Field label="כתובת" value={c.endpointUrl} />
                      <p className="mt-1 text-[11px] text-[var(--dz-text-muted)]">הקוד הסודי מסתיים ב-{c.keyHint ?? "…"}. שכחת אותו? צור/י קוד חדש.</p>
                    </details>
                  ) : null}
                  {secret?.connectionId === c.id ? <SecretBox source={s.key} secret={secret} onDone={() => setSecret(null)} /> : null}
                </div>
              ))}

              {available && s.key === "web.form" ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    dir="ltr"
                    value={siteInput}
                    onChange={(e) => setSiteInput(e.target.value)}
                    placeholder="כתובת האתר שלך, למשל www.my-site.co.il"
                    aria-label="כתובת האתר שלך"
                    className="min-w-0 flex-1 rounded-full border border-[var(--dz-border)] bg-[var(--dz-surface)] px-3 py-1 text-xs"
                  />
                  <Action onClick={() => create("web.form")} busy={busy === "create:web.form"} primary>
                    {live.length ? "חיבור טופס נוסף" : "חיבור טופס"}
                  </Action>
                </div>
              ) : null}
              {available && s.key === "google.lead_form" ? (
                <div className="mt-3">
                  <Action onClick={() => create("google.lead_form")} busy={busy === "create:google.lead_form"} primary>
                    {live.length ? "חיבור טופס נוסף" : "חיבור Google Ads"}
                  </Action>
                </div>
              ) : null}
              {available && s.key === "meta.lead_ads" && !metaPick ? (
                <div className="mt-3">
                  <Action onClick={metaLogin} busy={busy === "meta:login"} primary>
                    {live.length ? "חיבור דף נוסף" : "התחברות עם Facebook"}
                  </Action>
                </div>
              ) : null}
              {s.key === "meta.lead_ads" && metaPick ? (
                <div className="mt-3 space-y-2">
                  <p className="text-xs font-bold text-[var(--dz-text-primary)]">איזה דף לחבר?</p>
                  {metaPick.pages.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 rounded-2xl bg-[var(--dz-surface-muted)] px-3 py-2">
                      <span className="truncate text-xs">{p.name}</span>
                      {p.canAdvertise ? (
                        <Action onClick={() => metaConnect(p.id)} busy={busy === `meta:connect:${p.id}`} primary>חיבור</Action>
                      ) : (
                        <span className="text-[11px] text-[var(--dz-text-muted)]">אין הרשאת פרסום בדף</span>
                      )}
                    </div>
                  ))}
                  <button type="button" onClick={() => setMetaPick(null)} className="text-[11px] font-bold text-[var(--dz-text-muted)]">ביטול</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SiteEditor({ current, busy, onSave }: { current: string[]; busy: boolean; onSave: (v: string) => void }) {
  // One line per site: the www / bare twin the server adds is not shown twice.
  const shown = current
    .map((o) => o.replace(/^https?:\/\//, ""))
    .filter((h) => !h.startsWith("www.") || !current.includes(`https://${h.slice(4)}`));
  const [value, setValue] = useState("");
  return (
    <div className="mt-3">
      <div className="text-[11px] font-bold text-[var(--dz-text-muted)]">כתובת האתר שממנו הטופס נשלח: {shown.join(", ") || "—"}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          dir="ltr"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="כתובת חדשה, למשל www.my-site.co.il"
          aria-label="כתובת אתר חדשה"
          className="min-w-0 flex-1 rounded-full border border-[var(--dz-border)] bg-[var(--dz-surface)] px-3 py-1 text-xs"
        />
        <Action onClick={() => onSave(value)} busy={busy}>שמירת כתובת</Action>
      </div>
    </div>
  );
}

function Action({
  children,
  onClick,
  busy,
  primary,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  const tone = primary
    ? "bg-[var(--dz-text-primary)] text-[var(--dz-surface)]"
    : danger
      ? "border border-[var(--dz-border)] text-[var(--dz-danger)]"
      : "border border-[var(--dz-border)] text-[var(--dz-text-primary)]";
  return (
    <button type="button" disabled={busy} onClick={onClick} className={`rounded-full px-4 py-1 text-xs font-bold disabled:opacity-60 ${tone}`}>
      {busy ? "רגע…" : children}
    </button>
  );
}
