"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * "ייבוא מסמכים במייל" — the owner-facing settings surface.
 *
 * # What this screen is careful not to say
 *
 * It never tells the owner that mail is already arriving. The receiving side
 * does not exist yet, so a screen that said "forward invoices here" would be
 * promising a service that silently drops everything. The address is presented
 * as something to keep, and the copy stays in the future tense until intake is
 * real.
 *
 * All lifecycle decisions are the server's. This component renders what it is
 * told and asks for actions by name; it never computes whether an address is
 * still usable, because a second opinion about that is a second rule.
 */

type AddressView = {
  id: number;
  address: string | null;
  preview: string;
  status: "ACTIVE" | "RETIRING" | "REVOKED";
  graceUntil: string | null;
  expired: boolean;
};

type SenderView = {
  id: number;
  email: string;
  status: "PENDING_VERIFICATION" | "VERIFIED" | "REVOKED";
};

type Settings = {
  current: AddressView | null;
  retiring: AddressView[];
  senders: SenderView[];
  addressUnreadable: boolean;
  suggestedSenderEmail: string | null;
};

const SENDER_STATUS_LABEL: Record<SenderView["status"], string> = {
  PENDING_VERIFICATION: "ממתין לאימות",
  VERIFIED: "מאומת",
  REVOKED: "מבוטל",
};

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("he-IL", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export function InboundEmailCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [senderEmail, setSenderEmail] = useState("");
  const [confirmRotate, setConfirmRotate] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/inbound-email/settings", { cache: "no-store" });
      if (!res.ok) {
        // 404 is what a disabled feature looks like from here.
        setSettings(null);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as Settings;
      setSettings(data);
      setSenderEmail((prev) => (prev.length > 0 ? prev : data.suggestedSenderEmail ?? ""));
    } catch {
      setError("לא הצלחנו לטעון את ההגדרות.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? "הפעולה נכשלה.");
        } else {
          await load();
        }
      } catch {
        setError("הפעולה נכשלה.");
      }
      setBusy(false);
    },
    [load]
  );

  if (loading) return null;
  // The feature is off, or unreachable. Say nothing rather than showing a
  // surface that cannot work.
  if (!settings) return null;

  const current = settings.current;

  return (
    <section dir="rtl" className="rounded-2xl border border-black/10 bg-white p-4 shadow-sm">
      <h2 className="mb-1 text-base font-semibold">ייבוא מסמכים במייל</h2>
      <p className="mb-4 text-sm text-black/60">
        ניתן להעביר לכתובת הזו חשבוניות ומסמכים שמגיעים אליך במייל.
      </p>

      {settings.addressUnreadable ? (
        <p className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">
          לא הצלחנו להציג את הכתובת הקיימת. אל תיצרי כתובת חדשה — פנייה לתמיכה תשחזר את ההגדרה.
        </p>
      ) : null}

      {current ? (
        <div className="mb-4">
          <div className="mb-1 text-sm font-medium">כתובת להעברת מסמכים</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-xl bg-black/5 px-3 py-2 text-sm">
              {current.address ?? current.preview}
            </code>
            <button
              type="button"
              disabled={!current.address}
              className="shrink-0 rounded-xl border border-black/10 px-3 py-2 text-sm"
              onClick={() => {
                if (!current.address) return;
                void navigator.clipboard?.writeText(current.address);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "הועתק" : "העתק"}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy || settings.addressUnreadable}
          className="mb-4 rounded-xl bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          onClick={() => void post("/api/inbound-email/address", { action: "initialize" })}
        >
          צרי כתובת
        </button>
      )}

      {settings.retiring.length > 0 ? (
        <div className="mb-4 space-y-2">
          <div className="text-sm font-medium">כתובות קודמות</div>
          {settings.retiring.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 rounded-xl bg-black/5 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm">{a.address ?? a.preview}</div>
                <div className="text-xs text-black/60">
                  {a.expired ? "כבר לא בתוקף" : `בתוקף עד ${formatDate(a.graceUntil)}`}
                </div>
              </div>
              <button
                type="button"
                disabled={busy}
                className="shrink-0 rounded-lg border border-black/10 px-2 py-1 text-xs"
                onClick={() =>
                  void post("/api/inbound-email/address", { action: "revoke", addressId: a.id })
                }
              >
                בטלי עכשיו
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {current ? (
        <div className="mb-6">
          {confirmRotate ? (
            <div className="rounded-xl border border-black/10 p-3">
              <p className="mb-2 text-sm">הכתובת הישנה תמשיך לפעול במשך 30 יום.</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-xl bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  onClick={async () => {
                    await post("/api/inbound-email/address", { action: "rotate" });
                    setConfirmRotate(false);
                  }}
                >
                  החליפי כתובת
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-black/10 px-3 py-1.5 text-sm"
                  onClick={() => setConfirmRotate(false)}
                >
                  ביטול
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setConfirmRotate(true)}
            >
              החלפת כתובת
            </button>
          )}
        </div>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-semibold">שולחים מורשים</h3>
        <div className="mb-3 flex gap-2">
          <input
            type="email"
            dir="ltr"
            value={senderEmail}
            onChange={(e) => setSenderEmail(e.target.value)}
            placeholder="name@example.com"
            className="flex-1 rounded-xl border border-black/10 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={busy || senderEmail.trim().length === 0}
            className="shrink-0 rounded-xl bg-black px-3 py-2 text-sm text-white disabled:opacity-50"
            onClick={() => void post("/api/inbound-email/senders", { action: "add", email: senderEmail })}
          >
            הוסף שולח
          </button>
        </div>

        {settings.senders.length === 0 ? (
          <p className="text-sm text-black/60">עדיין לא הוגדרו שולחים.</p>
        ) : (
          <ul className="space-y-2">
            {settings.senders.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 rounded-xl bg-black/5 px-3 py-2"
              >
                <div className="min-w-0">
                  <div dir="ltr" className="truncate text-start text-sm">
                    {s.email}
                  </div>
                  <div className="text-xs text-black/60">{SENDER_STATUS_LABEL[s.status]}</div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-black/10 px-2 py-1 text-xs"
                  onClick={() =>
                    void post("/api/inbound-email/senders", { action: "revoke", senderId: s.id })
                  }
                >
                  בטלי
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
    </section>
  );
}
