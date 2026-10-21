"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import DocumentsInboxScreen from "@/components/documents/inbox/DocumentsInboxScreen";
import InboxSkeleton from "@/components/documents/inbox/InboxSkeleton";
import DocumentsHeader from "@/components/documents/DocumentsHeader";
import { TOKEN } from "@/lib/design/documents-theme";
import { pageMain } from "../ui";
import { useI18n } from "@/components/i18n/I18nProvider";

export default function DocumentsInboxPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    void Promise.resolve().then(() => {
      setMounted(true);
      const t = window.localStorage.getItem("token");
      setToken(t);
      if (!t) {
        router.replace("/login");
      }
    });
  }, [router]);

  if (!mounted) {
    return (
      <div style={{ minHeight: "100vh", background: TOKEN.surface.page }}>
        <DocumentsHeader title={t("documents.inbox.headerTitle")} />
        <main style={pageMain}>
          <InboxSkeleton />
        </main>
      </div>
    );
  }

  if (!token) {
    return null;
  }

  return <DocumentsInboxScreen authToken={token} />;
}
