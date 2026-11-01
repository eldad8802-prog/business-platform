"use client";

/**
 * TEMPORARY — website-form live proof (business 9). Not in the console menu; opened by its address.
 * Asks the server for a pilot pass for one website connection, then opens the pilot form page.
 * See lib/intake/acquisition/web-form-pilot.ts. Remove with the pilot.
 */
import { useState } from "react";
import { AdminConsole } from "@/components/platform-admin/console/admin-console";
import { PlatformAdminFetchError, postWebFormPilotPass } from "@/lib/platform-admin/fetch-platform-admin";

function PilotPassForm() {
  const [publicId, setPublicId] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function issue() {
    setBusy(true);
    setError(null);
    setUrl(null);
    try {
      setUrl((await postWebFormPilotPass(publicId.trim())).url);
    } catch (e) {
      setError(
        e instanceof PlatformAdminFetchError && e.status === 404
          ? "לא נמצא חיבור 'טופס באתר' פעיל של עסק 9 עם המזהה הזה."
          : "לא הצלחנו להנפיק כניסה. אפשר לנסות שוב."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
      <p style={{ margin: 0, lineHeight: 1.5 }}>
        ניסוי טופס אתר לעסק 9 בלבד. יש להדביק את מזהה החיבור (החלק האחרון בכתובת שליחת הטופס). הכניסה תקפה 15 דקות.
      </p>
      <input
        value={publicId}
        onChange={(e) => setPublicId(e.target.value)}
        placeholder="מזהה החיבור"
        dir="ltr"
        style={{ padding: 10, borderRadius: 8, border: "1px solid #ccc" }}
      />
      <button type="button" onClick={issue} disabled={busy || publicId.trim().length === 0} style={{ padding: 10, borderRadius: 8 }}>
        {busy ? "מנפיק…" : "הנפקת כניסה לעמוד הניסוי"}
      </button>
      {error && <p style={{ margin: 0, color: "#b42318" }}>{error}</p>}
      {url && (
        <div style={{ display: "grid", gap: 8 }}>
          <a href={url} target="_blank" rel="noopener">פתיחת עמוד הניסוי</a>
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            לבדיקת שליחה חוזרת: לפתוח שוב את אותו קישור ולשלוח את אותם פרטים (אותו submission_id).
          </p>
          <code dir="ltr" style={{ wordBreak: "break-all" }}>{url}</code>
        </div>
      )}
    </div>
  );
}

export default function WebFormPilotAdminPage() {
  return <AdminConsole title="ניסוי טופס אתר">{() => <PilotPassForm />}</AdminConsole>;
}
