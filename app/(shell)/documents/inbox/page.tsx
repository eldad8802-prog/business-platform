"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import DocumentsInboxScreen from "@/components/documents/inbox/DocumentsInboxScreen";
import InboxSkeleton from "@/components/documents/inbox/InboxSkeleton";
import DocumentsHeader from "@/components/documents/DocumentsHeader";
import { TOKEN } from "@/lib/design/tokens";
import { pageMain } from "../ui";

export default function DocumentsInboxPage() {
  const router = useRouter();
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
      <div dir="rtl" style={{ minHeight: "100vh", background: TOKEN.surface.page }}>
        <DocumentsHeader title="תיבת מסמכים" />
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
