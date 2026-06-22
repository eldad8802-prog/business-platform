"use client";
import { TOKEN } from "@/lib/design/tokens";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  fetchDocumentsHubSummary,
  fetchDocumentsInbox,
  type DocumentsHubSnapshot,
} from "@/lib/documents/fetch-inbox";h
import type { InboxListItem, InboxPagination } from "@/lib/documents/inbox-types";
import { CATEGORIES, CATEGORY_MAP } from "@/lib/constants/categories";

type Station = "records" | "search" | "accountant";
type DirectionFilter = "all" | "income" | "expense";
type ExportStep = 1 | 2 | 3;
type ExportType = "month" | "quarter" | "year";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      snapshot: DocumentsHubSnapshot;
      items: InboxListItem[];
      pagination: InboxPagination | null;
    };

type SearchResult = {
  id: number;
  documentId: number;
  vendorName: string;
  category: string;
  amount: number;
  date: string;
  direction: string;
  document?: {
    status?: string | null;
    source?: string | null;
    createdAt?: string | null;
  } | null;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: "ILS",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toLocaleString("he-IL", { maximumFractionDigits: 2 })} ש"ח`;
  }
}

function formatDate(raw: string | null | undefined): string {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function sourceLabel(source: string): string {
  if (source === "email") return "Gmail";
  if (source === "whatsapp") return "WhatsApp";
  return "העלאה";
}

function statusLabel(status: string): { text: string; bg: string; color: string } {
  if (status === "approved") {
    return { text: "אומת", bg: "#e9f9ef", color: "#16945a" };
  }
  return { text: "ממתין לאימות", bg: "#fff1e7", color: "#f0782b" };
}

function directionLabel(direction: string | null | undefined): string {
  if (direction === "income") return "הכנסה";
  if (direction === "expense") return "הוצאה";
  return "לא סווג";
}

function categoryLabel(category: string | null | undefined): string {
  if (!category) return "ללא קטגוריה";
  return CATEGORY_MAP[category] ?? category;
}

function confidenceLabel(item: InboxListItem): string {
  const levels = Object.values(item.confidenceDots);
  if (levels.includes("low")) return "דורש בדיקה";
  if (levels.includes("medium")) return "ביטחון בינוני";
  return "ביטחון גבוה";
}

function monthLabel(raw: string): string {
  if (!raw) return "ללא חודש";
  const [year, month] = raw.split("-");
  if (!year || !month) return raw;
  const d = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("he-IL", { month: "long", year: "numeric" });
}

function currentMonthValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function DocumentIllustration() {
  return (
    <div style={illustrationWrap} aria-hidden>
      <div style={trayStyle} />
      <div style={{ ...paperStyle, transform: "rotate(-13deg)", right: 24, top: 30 }} />
      <div style={{ ...paperStyle, transform: "rotate(-5deg)", right: 42, top: 20 }}>
        <span style={paperLineWide} />
        <span style={paperLine} />
        <span style={paperLineShort} />
      </div>
      <span style={{ ...sparkleStyle, right: 14, top: 54 }} />
      <span style={{ ...sparkleStyle, left: 26, top: 42 }} />
      <span style={{ ...sparkleTinyStyle, left: 8, top: 76 }} />
      <span style={checkBadgeStyle}>
        <CheckIcon size={30} />
      </span>
    </div>
  );
}

function HeaderIcon({ children }: { children: ReactNode }) {
  return <span style={topIconButton}>{children}</span>;
}

function IntakeAction({
  title,
  subtitle,
  icon,
  tone,
  onClick,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  tone: "whatsapp" | "gmail" | "camera" | "upload";
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} style={intakeCardStyle}>
      <span style={{ ...intakeIconCircle, ...intakeTones[tone] }}>{icon}</span>
      <span style={intakeTitleStyle}>{title}</span>
      <span style={intakeSubtitleStyle}>{subtitle}</span>
    </button>
  );
}

function StationTab({
  active,
  title,
  icon,
  onClick,
}: {
  active: boolean;
  title: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        ...stationTabStyle,
        color: active ? "#075bff" : "#0d1b3d",
      }}
    >
      <span style={stationIconStyle}>{icon}</span>
      <span>{title}</span>
      {active ? <span style={activeStationLine} /> : null}
    </button>
  );
}

function RecentDocumentRow({ item }: { item: InboxListItem }) {
  const router = useRouter();
  const vendor =
    item.financial?.vendorName ?? item.extracted?.vendorName ?? "מסמך ללא ספק";
  const amount = item.financial?.amount ?? item.extracted?.amount ?? null;
  const subtitle =
    item.financial?.category ?? item.extracted?.category ?? sourceLabel(item.source);
  const date = formatDate(item.financial?.date ?? item.extracted?.date ?? item.createdAt);
  const status = statusLabel(item.status);
  const isPending = item.status !== "approved";

  return (
    <button
      type="button"
      onClick={() => router.push(`/documents/review/${item.documentId}`)}
      className="documents-recent-row"
      style={recentRowStyle}
    >
      <PdfIcon />
      <span style={statusStackStyle}>
        <span style={statusPillStyle(status.bg, status.color)}>{status.text}</span>
        {isPending ? (
          <span style={confidencePillStyle}>{confidenceLabel(item)}</span>
        ) : null}
      </span>
      <span className="documents-recent-vendor" style={recentVendorBlock}>
        <span style={recentVendorStyle}>{vendor}</span>
        <span style={recentSubtitleStyle}>{subtitle}</span>
      </span>
      <span className="documents-recent-amount" style={recentAmountStyle}>
        {formatMoney(amount)}
      </span>
      <span className="documents-recent-date" style={recentDateStyle}>{date}</span>
      <span className="documents-recent-source" style={sourceIconStyle(item.source)}>
        {sourceGlyph(item.source)}
      </span>
      <span className="documents-recent-menu" style={kebabStyle}>⋮</span>
    </button>
  );
}

function sourceGlyph(source: string): ReactNode {
  if (source === "email") return <GmailIcon />;
  if (source === "whatsapp") return <WhatsAppIcon />;
  return <CameraIcon size={22} />;
}

function SearchResultRow({ result }: { result: SearchResult }) {
  const router = useRouter();
  const status = statusLabel(result.document?.status ?? "approved");
  const source = result.document?.source ?? "upload";

  return (
    <button
      type="button"
      onClick={() => router.push(`/documents/review/${result.documentId}`)}
      className="documents-search-result-row"
      style={searchResultRowStyle}
    >
      <PdfIcon />
      <span style={statusPillStyle(status.bg, status.color)}>{status.text}</span>
      <span style={recentVendorBlock}>
        <span style={recentVendorStyle}>{result.vendorName || "רשומה ללא ספק"}</span>
        <span style={recentSubtitleStyle}>
          {categoryLabel(result.category)} · {directionLabel(result.direction)}
        </span>
      </span>
      <span style={recentAmountStyle}>{formatMoney(result.amount)}</span>
      <span style={recentDateStyle}>{formatDate(result.date)}</span>
      <span style={sourceIconStyle(source)}>{sourceGlyph(source)}</span>
    </button>
  );
}

export default function DocumentsHome() {
  const router = useRouter();
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [activeStation, setActiveStation] = useState<Station>("records");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchVendor, setSearchVendor] = useState("");
  const [searchCategory, setSearchCategory] = useState("");
  const [searchMonth, setSearchMonth] = useState("");
  const [searchDirection, setSearchDirection] = useState<DirectionFilter>("all");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchLoaded, setSearchLoaded] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [exportStep, setExportStep] = useState<ExportStep>(1);
  const [exportType, setExportType] = useState<ExportType>("month");
  const [exportMonth, setExportMonth] = useState(currentMonthValue());
  const [exportYear, setExportYear] = useState(String(new Date().getFullYear()));
  const [exportQuarter, setExportQuarter] = useState("1");
  const [exportAllCategories, setExportAllCategories] = useState(true);
  const [exportCategories, setExportCategories] = useState<string[]>([]);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState("");

  async function load() {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;

    if (!token) {
      router.replace("/login");
      return;
    }

    setState({ status: "loading" });
    try {
      const [snapshot, inbox] = await Promise.all([
        fetchDocumentsHubSummary(token),
        fetchDocumentsInbox(token, { limit: 6 }),
      ]);
      setState({
        status: "ready",
        snapshot,
        items: inbox.items,
        pagination: inbox.pagination,
      });
    } catch (e) {
      const message = errorMessage(e, "שגיאה בטעינת המסמכים");
      if (message === "Unauthorized") {
        window.localStorage.removeItem("token");
        window.localStorage.removeItem("user");
        router.replace("/login");
        return;
      }
      setState({ status: "error", message });
    }
  }

  useEffect(() => {
    void Promise.resolve().then(() => load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function uploadDocument(file: File | null | undefined) {
    if (!file) return;

    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) {
      router.replace("/login");
      return;
    }

    setUploading(true);
    setUploadError("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/documents/upload", {
        method: "POST",
        body: formData,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();
      if (!res.ok || !data?.documentId) {
        throw new Error(data?.error || "Upload failed");
      }

      router.push(`/documents/review/${data.documentId}`);
    } catch (e: unknown) {
      setUploadError(errorMessage(e, "אירעה שגיאה בהעלאת המסמך"));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  }

  async function loadMoreRecords() {
    if (state.status !== "ready" || !state.pagination?.nextCursor) return;

    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) {
      router.replace("/login");
      return;
    }

    setLoadingMore(true);
    try {
      const inbox = await fetchDocumentsInbox(token, {
        cursor: state.pagination.nextCursor,
        limit: state.pagination.limit,
      });
      setState({
        status: "ready",
        snapshot: state.snapshot,
        items: [...state.items, ...inbox.items],
        pagination: inbox.pagination,
      });
    } catch (e) {
      setUploadError(errorMessage(e, "לא הצלחנו לטעון רשומות נוספות"));
    } finally {
      setLoadingMore(false);
    }
  }

  async function runSearch() {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) {
      router.replace("/login");
      return;
    }

    const url = new URL("/api/search", window.location.origin);
    if (searchQuery.trim()) url.searchParams.set("q", searchQuery.trim());
    if (searchVendor.trim()) url.searchParams.set("vendor", searchVendor.trim());
    if (searchCategory) url.searchParams.set("category", searchCategory);
    if (searchMonth) url.searchParams.set("month", searchMonth);
    if (searchDirection !== "all") url.searchParams.set("direction", searchDirection);
    url.searchParams.set("limit", "20");

    setSearchLoading(true);
    setSearchError("");
    try {
      const res = await fetch(url.pathname + url.search, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { results?: SearchResult[]; error?: string };
      if (!res.ok) throw new Error(data.error || "Search failed");
      setSearchResults(Array.isArray(data.results) ? data.results : []);
      setSearchLoaded(true);
    } catch (e) {
      setSearchError(errorMessage(e, "שגיאה בחיפוש"));
      setSearchLoaded(true);
    } finally {
      setSearchLoading(false);
    }
  }

  function clearSearch() {
    setSearchQuery("");
    setSearchVendor("");
    setSearchCategory("");
    setSearchMonth("");
    setSearchDirection("all");
    setSearchResults([]);
    setSearchLoaded(false);
    setSearchError("");
  }

  function toggleExportCategory(category: string) {
    setExportAllCategories(false);
    setExportCategories((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category]
    );
  }

  async function downloadAccountantZip() {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) {
      router.replace("/login");
      return;
    }

    setExportLoading(true);
    setExportError("");

    try {
      const res = await fetch("/api/reports/export-zip", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: exportType,
          month: exportMonth,
          year: exportYear,
          quarter: exportQuarter,
          categories: exportAllCategories ? [] : exportCategories,
        }),
      });

      if (res.status === 401) {
        window.localStorage.removeItem("token");
        window.localStorage.removeItem("user");
        router.replace("/login");
        return;
      }

      if (!res.ok) throw new Error("שגיאה ביצירת חבילה");

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "accountant-pack.zip";
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(errorMessage(e, "שגיאה ביצירת חבילת רו״ח"));
    } finally {
      setExportLoading(false);
    }
  }

  const snapshot = state.status === "ready" ? state.snapshot : null;
  const items = state.status === "ready" ? state.items : [];
  const pagination = state.status === "ready" ? state.pagination : null;
  const pending = snapshot?.nextPending ?? null;
  const pendingCount =
    snapshot?.financialPulse.inboxDocumentCounts.pendingReview ?? 0;
  const approvedCount =
    snapshot?.financialPulse.inboxDocumentCounts.approvedDocuments ?? 0;
  const totalDocs = pendingCount + approvedCount;
  const progress = totalDocs > 0 ? Math.round((approvedCount / totalDocs) * 100) : 0;
  const pendingItems = items.filter((item) => item.status !== "approved");
  const approvedItems = items.filter((item) => item.status === "approved");
  const groupedItems = items.reduce<Record<string, InboxListItem[]>>((acc, item) => {
    const key = item.groupMonth || "ללא חודש";
    acc[key] = acc[key] ? [...acc[key], item] : [item];
    return acc;
  }, {});
  const hasSearchFilters =
    Boolean(searchQuery.trim()) ||
    Boolean(searchVendor.trim()) ||
    Boolean(searchCategory) ||
    Boolean(searchMonth) ||
    searchDirection !== "all";
  const selectedExportCategories = exportAllCategories
    ? "כל הקטגוריות"
    : exportCategories.length > 0
      ? exportCategories.map(categoryLabel).join(", ")
      : "לא נבחרו קטגוריות";

  const primaryHref = pending
    ? `/documents/review/${pending.documentId}`
    : "/documents/inbox";

  return (
    <div dir="rtl" style={pageShellStyle}>
      <style>{documentsHomeCss}</style>
      <main className="documents-home" style={pageContentStyle}>
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*,application/pdf"
          style={{ display: "none" }}
          onChange={(e) => void uploadDocument(e.target.files?.[0])}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => void uploadDocument(e.target.files?.[0])}
        />

        <header className="documents-top-header" style={topHeaderStyle}>
          <HeaderIcon>
            <MenuIcon />
          </HeaderIcon>
          <label className="documents-top-search" style={topSearchStyle}>
            <SearchIcon size={24} />
            <input
              type="search"
              placeholder="חיפוש מסמך, ספק, תאריך..."
              style={topSearchInputStyle}
              onFocus={() => setActiveStation("search")}
              onKeyDown={(e) => {
                if (e.key === "Enter") router.push("/documents/search");
              }}
            />
          </label>
          <div className="documents-brand" style={brandStyle}>Dubiz</div>
          <HeaderIcon>
            <BellIcon />
          </HeaderIcon>
        </header>

        <section className="documents-title-section" style={titleSectionStyle}>
          <DocumentIcon size={58} />
          <h1 className="documents-title" style={titleStyle}>מסמכים</h1>
          <p className="documents-subtitle" style={subtitleStyle}>
            המרכז של כל הניירת של העסק במקום אחד.
          </p>
        </section>

        {state.status === "error" ? (
          <section style={{ ...softCardStyle, borderColor: "#fecaca", background: "#fff7f7" }}>
            <div style={{ color: "#991b1b", fontWeight: 900 }}>
              לא הצלחנו לטעון את מרכז המסמכים.
            </div>
            <p style={errorTextStyle}>{state.message}</p>
            <button type="button" onClick={() => void load()} style={secondaryButtonStyle}>
              נסה שוב
            </button>
          </section>
        ) : null}

        {uploadError ? (
          <section style={{ ...softCardStyle, borderColor: "#fecaca", background: "#fff7f7" }}>
            <div style={{ color: "#991b1b", fontWeight: 850 }}>{uploadError}</div>
          </section>
        ) : null}

        <section className="documents-status-card" style={statusCardStyle}>
          <div className="documents-status-content" style={statusContentStyle}>
            <div style={pendingTextStyle}>
              יש לך{" "}
              <span style={{ color: "#075bff" }}>
                {state.status === "loading" ? "..." : pendingCount.toLocaleString("he-IL")}
              </span>{" "}
              מסמכים ממתינים לאימות
            </div>
            <div style={progressTrackStyle}>
              <span style={{ ...progressFillStyle, width: `${progress}%` }} />
            </div>
            <div style={progressLabelStyle}>{progress}% הושלם</div>
            <button
              type="button"
              disabled={state.status === "loading" || uploading}
              onClick={() => router.push(primaryHref)}
              className="documents-primary-cta"
              style={primaryButtonStyle(state.status === "loading" || uploading)}
            >
              <DocumentCheckIcon />
              <span>{uploading ? "מעלה מסמך..." : "אמת את המסמך הבא"}</span>
            </button>
            <button
              type="button"
              onClick={() => router.push("/documents/inbox")}
              style={queueLinkStyle}
            >
              <ChevronLeftIcon />
              <span>צפה בתור האימות</span>
            </button>
          </div>
          <div className="documents-illustration-slot">
            <DocumentIllustration />
          </div>
        </section>

        <section>
          <h2 style={sectionTitleStyle}>מה תרצה לעשות?</h2>
          <div className="documents-intake-grid" style={intakeGridStyle}>
            <IntakeAction
              title="העלאה מהמחשב"
              subtitle="גרור קבצים או בחר מהמחשב"
              icon={<UploadCloudIcon />}
              tone="upload"
              onClick={() => {
                setUploadError("");
                uploadInputRef.current?.click();
              }}
            />
            <IntakeAction
              title="צילום מסמך"
              subtitle="צלם עם המצלמה והמערכת תזהה"
              icon={<CameraIcon size={31} />}
              tone="camera"
              onClick={() => {
                setUploadError("");
                cameraInputRef.current?.click();
              }}
            />
            <IntakeAction
              title="קליטה ממייל"
              subtitle="יבא קבלות וחשבוניות ישירות מהמייל"
              icon={<GmailIcon />}
              tone="gmail"
              onClick={() => router.push("/documents/email")}
            />
            <IntakeAction
              title="קליטה מ-WhatsApp"
              subtitle="יבא מסמכים מצ'אטים בלחיצה אחת"
              icon={<WhatsAppIcon />}
              tone="whatsapp"
              onClick={() => router.push("/settings/whatsapp")}
            />
          </div>
        </section>

        <section className="documents-stations" style={stationsStyle}>
          <StationTab
            active={activeStation === "records"}
            title="רשומות"
            icon={<FolderIcon />}
            onClick={() => setActiveStation("records")}
          />
          <StationTab
            active={activeStation === "search"}
            title="חיפוש"
            icon={<SearchIcon size={30} />}
            onClick={() => setActiveStation("search")}
          />
          <StationTab
            active={activeStation === "accountant"}
            title='רו"ח'
            icon={<UserIcon />}
            onClick={() => setActiveStation("accountant")}
          />
        </section>

        <section className="documents-content-panel" style={contentPanelStyle}>
          {activeStation === "records" ? (
            <>
              <div style={panelHeaderStyle}>
                <span>רשומות</span>
                <span style={panelHeaderMetaStyle}>מה נכנס ומה מצבו?</span>
              </div>
              {state.status === "loading" ? (
                <div style={loadingRowsStyle}>טוען רשומות...</div>
              ) : items.length > 0 ? (
                <div style={recordsStackStyle}>
                  <div className="documents-records-queue" style={recordsQueueStyle}>
                    <div>
                      <div style={recordsQueueTitleStyle}>
                        {pendingCount > 0
                          ? `${pendingCount.toLocaleString("he-IL")} ממתינים לאימות`
                          : "אין מסמכים שממתינים לאימות"}
                      </div>
                      <div style={recordsQueueTextStyle}>
                        {pendingCount > 0
                          ? "המשך מהמסמך הבא כדי לנקות את תור האימות."
                          : "התור נקי. הרשומות המאושרות זמינות כאן ובחיפוש."}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!pending}
                      onClick={() => router.push(primaryHref)}
                      style={compactPrimaryButtonStyle(!pending)}
                    >
                      אמת את הבא
                    </button>
                  </div>

                  {pendingItems.length > 0 ? (
                    <div style={contentSubsectionStyle}>
                      <div style={contentSubsectionTitleStyle}>ממתינים</div>
                      {pendingItems.map((item) => (
                        <RecentDocumentRow key={item.documentId} item={item} />
                      ))}
                    </div>
                  ) : null}

                  {approvedItems.length > 0 ? (
                    <div style={contentSubsectionStyle}>
                      <div style={contentSubsectionTitleStyle}>מאושרים לאחרונה</div>
                      {approvedItems.slice(0, 4).map((item) => (
                        <RecentDocumentRow key={item.documentId} item={item} />
                      ))}
                    </div>
                  ) : null}

                  <div style={contentSubsectionStyle}>
                    <div style={contentSubsectionTitleStyle}>קיבוץ לפי חודש</div>
                    <div style={monthGroupListStyle}>
                      {Object.entries(groupedItems).map(([month, monthItems]) => (
                        <div key={month} style={monthGroupRowStyle}>
                          <span>{monthLabel(month)}</span>
                          <span style={monthGroupCountStyle}>
                            {monthItems.length.toLocaleString("he-IL")} מסמכים
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {pagination?.hasMore ? (
                    <button
                      type="button"
                      onClick={() => void loadMoreRecords()}
                      disabled={loadingMore}
                      style={outlineActionButtonStyle}
                    >
                      {loadingMore ? "טוען..." : "טען עוד רשומות"}
                    </button>
                  ) : null}
                </div>
              ) : (
                <div style={emptyStateStyle}>
                  אין עדיין מסמכים. אחרי קליטה מ-WhatsApp, Gmail, צילום או העלאה,
                  יופיע כאן יומן העבודה.
                </div>
              )}
              <button
                type="button"
                onClick={() => router.push("/documents/inbox")}
                style={allDocsLinkStyle}
              >
                <ChevronLeftIcon />
                <span>צפייה בכל המסמכים</span>
              </button>
            </>
          ) : null}

          {activeStation === "search" ? (
            <div style={recordsStackStyle}>
              <div style={panelHeaderStyle}>
                <span>חיפוש</span>
                <span style={panelHeaderMetaStyle}>איפה הרשומה שאני מחפש?</span>
              </div>
              <div className="documents-station-form" style={searchFormStyle}>
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runSearch();
                  }}
                  placeholder="חיפוש חופשי..."
                  style={fieldStyle}
                />
                <input
                  value={searchVendor}
                  onChange={(e) => setSearchVendor(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runSearch();
                  }}
                  placeholder="ספק"
                  style={fieldStyle}
                />
                <input
                  type="month"
                  value={searchMonth}
                  onChange={(e) => setSearchMonth(e.target.value)}
                  style={fieldStyle}
                  aria-label="תקופה"
                />
                <select
                  value={searchCategory}
                  onChange={(e) => setSearchCategory(e.target.value)}
                  style={fieldStyle}
                  aria-label="קטגוריה"
                >
                  <option value="">כל הקטגוריות</option>
                  {CATEGORIES.map((category) => (
                    <option key={category.value} value={category.value}>
                      {category.label}
                    </option>
                  ))}
                </select>
                <select
                  value={searchDirection}
                  onChange={(e) => setSearchDirection(e.target.value as DirectionFilter)}
                  style={fieldStyle}
                  aria-label="הכנסה או הוצאה"
                >
                  <option value="all">הכנסה והוצאה</option>
                  <option value="income">הכנסה</option>
                  <option value="expense">הוצאה</option>
                </select>
              </div>
              <div style={actionRowStyle}>
                <button
                  type="button"
                  onClick={() => void runSearch()}
                  disabled={searchLoading}
                  style={compactPrimaryButtonStyle(searchLoading)}
                >
                  {searchLoading ? "מחפש..." : "חפש"}
                </button>
                <button
                  type="button"
                  onClick={clearSearch}
                  disabled={!hasSearchFilters && !searchLoaded}
                  style={textActionButtonStyle}
                >
                  נקה סינונים
                </button>
              </div>

              <div style={searchScopeNoteStyle}>
                החיפוש מציג רשומות פיננסיות שאושרו. אם מסמך חדש לא מופיע כאן,
                ייתכן שהוא עדיין ממתין לאימות ברשומות.
              </div>

              {searchError ? <div style={inlineErrorStyle}>{searchError}</div> : null}

              {searchLoaded ? (
                <div style={contentSubsectionStyle}>
                  <div style={contentSubsectionTitleStyle}>
                    {searchResults.length > 0
                      ? `${searchResults.length.toLocaleString("he-IL")} תוצאות`
                      : "אין תוצאות"}
                  </div>
                  {searchResults.length > 0 ? (
                    searchResults.map((result) => (
                      <SearchResultRow key={result.id} result={result} />
                    ))
                  ) : (
                    <div style={emptyStateStyle}>
                      לא נמצאו רשומות מאושרות שתואמות לחיפוש. נסה להרחיב סינון,
                      או בדוק ברשומות אם המסמך עדיין ממתין לאימות.
                    </div>
                  )}
                </div>
              ) : (
                <div style={contentSubsectionStyle}>
                  <div style={contentSubsectionTitleStyle}>רשומות מאושרות אחרונות</div>
                  {approvedItems.length > 0 ? (
                    approvedItems.slice(0, 3).map((item) => (
                      <RecentDocumentRow key={item.documentId} item={item} />
                    ))
                  ) : (
                    <div style={emptyStateStyle}>
                      אין עדיין רשומות מאושרות לחיפוש. אחרי אימות המסמכים הן יופיעו כאן.
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : null}

          {activeStation === "accountant" ? (
            <div style={recordsStackStyle}>
              <div style={panelHeaderStyle}>
                <span>רו״ח</span>
                <span style={panelHeaderMetaStyle}>
                  האם החומר מוכן למסירה לרואה החשבון?
                </span>
              </div>

              <div style={stepRowStyle}>
                {[1, 2, 3].map((step) => (
                  <button
                    key={step}
                    type="button"
                    onClick={() => setExportStep(step as ExportStep)}
                    style={stepButtonStyle(exportStep === step)}
                  >
                    {step === 1 ? "תקופה" : step === 2 ? "מוכנות" : "ייצוא"}
                  </button>
                ))}
              </div>

              {exportStep === 1 ? (
                <div style={contentSubsectionStyle}>
                  <div style={contentSubsectionTitleStyle}>בחירת תקופה</div>
                  <div className="documents-station-form" style={searchFormStyle}>
                    <select
                      value={exportType}
                      onChange={(e) => setExportType(e.target.value as ExportType)}
                      style={fieldStyle}
                      aria-label="סוג תקופה"
                    >
                      <option value="month">חודש</option>
                      <option value="quarter">רבעון</option>
                      <option value="year">שנה קודמת</option>
                    </select>
                    {exportType === "month" ? (
                      <input
                        type="month"
                        value={exportMonth}
                        onChange={(e) => setExportMonth(e.target.value)}
                        style={fieldStyle}
                        aria-label="חודש לייצוא"
                      />
                    ) : null}
                    {exportType !== "month" ? (
                      <input
                        value={exportYear}
                        onChange={(e) => setExportYear(e.target.value)}
                        placeholder="שנה"
                        style={fieldStyle}
                      />
                    ) : null}
                    {exportType === "quarter" ? (
                      <select
                        value={exportQuarter}
                        onChange={(e) => setExportQuarter(e.target.value)}
                        style={fieldStyle}
                        aria-label="רבעון"
                      >
                        <option value="1">רבעון 1</option>
                        <option value="2">רבעון 2</option>
                        <option value="3">רבעון 3</option>
                        <option value="4">רבעון 4</option>
                      </select>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setExportStep(2)}
                    style={compactPrimaryButtonStyle(false)}
                  >
                    המשך למוכנות
                  </button>
                </div>
              ) : null}

              {exportStep === 2 ? (
                <div style={contentSubsectionStyle}>
                  <div style={contentSubsectionTitleStyle}>מוכנות לתקופה</div>
                  <div style={readinessCardStyle(pendingCount === 0 && approvedCount > 0)}>
                    <div style={readinessTitleStyle}>
                      {approvedCount === 0
                        ? "אין עדיין חומר מאושר לייצוא"
                        : pendingCount > 0
                          ? "יש חסמים לפני מסירה נקייה"
                          : "החומר המאושר מוכן לייצוא"}
                    </div>
                    <div style={recordsQueueTextStyle}>
                      {approvedCount === 0
                        ? "חבילת רו״ח נוצרת מתוך רשומות שאושרו. צריך לאמת מסמכים לפני ייצוא."
                        : pendingCount > 0
                          ? "מסמכים שממתינים לאימות עלולים להשאיר את החבילה לא שלמה."
                          : "אפשר להמשיך לייצוא ZIP מתוך הרשומות המאושרות."}
                    </div>
                  </div>

                  <div style={blockerListStyle}>
                    <div className="documents-blocker-row" style={blockerRowStyle}>
                      <span>מה חסר</span>
                      <span>
                        {pendingCount > 0
                          ? `${pendingCount.toLocaleString("he-IL")} מסמכים לא מאומתים`
                          : "אין חסם אימות פעיל"}
                      </span>
                    </div>
                    <div className="documents-blocker-row" style={blockerRowStyle}>
                      <span>למה זה חשוב</span>
                      <span>רו״ח צריך חבילה שמבוססת על אמת מאושרת וקבצי מקור.</span>
                    </div>
                    <div className="documents-blocker-row" style={blockerRowStyle}>
                      <span>הצעד הבא</span>
                      <span>
                        {pendingCount > 0
                          ? "לעבור לרשומות ולאמת את המסמכים הממתינים."
                          : "להגדיר קטגוריות ולהוריד ZIP."}
                      </span>
                    </div>
                  </div>

                  <div style={contentSubsectionTitleStyle}>קטגוריות לייצוא</div>
                  <div style={chipGridStyle}>
                    <button
                      type="button"
                      onClick={() => {
                        setExportAllCategories(true);
                        setExportCategories([]);
                      }}
                      style={chipButtonStyle(exportAllCategories)}
                    >
                      כל הקטגוריות
                    </button>
                    {CATEGORIES.map((category) => (
                      <button
                        key={category.value}
                        type="button"
                        onClick={() => toggleExportCategory(category.value)}
                        style={chipButtonStyle(
                          !exportAllCategories && exportCategories.includes(category.value)
                        )}
                      >
                        {category.label}
                      </button>
                    ))}
                  </div>

                  <div style={actionRowStyle}>
                    <button
                      type="button"
                      onClick={() => setExportStep(3)}
                      style={compactPrimaryButtonStyle(false)}
                    >
                      המשך לייצוא
                    </button>
                    {pendingCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => setActiveStation("records")}
                        style={textActionButtonStyle}
                      >
                        עבור לרשומות
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {exportStep === 3 ? (
                <div style={contentSubsectionStyle}>
                  <div style={contentSubsectionTitleStyle}>ייצוא חבילה</div>
                  <div style={exportSummaryStyle}>
                    <div>התוצר: accountant-pack.zip</div>
                    <div>כולל: XLSX, CSV, manifest וקבצי מקור קיימים.</div>
                    <div>קטגוריות: {selectedExportCategories}</div>
                    <div>היסטוריית ייצוא: לא קיימת כרגע כנתון מתמשך.</div>
                  </div>
                  {exportError ? <div style={inlineErrorStyle}>{exportError}</div> : null}
                  <div style={actionRowStyle}>
                    <button
                      type="button"
                      onClick={() => void downloadAccountantZip()}
                      disabled={exportLoading}
                      style={compactPrimaryButtonStyle(exportLoading)}
                    >
                      {exportLoading ? "מכין ZIP..." : "הורד ZIP"}
                    </button>
                    <button
                      type="button"
                      onClick={() => router.push("/documents/accountant-pack")}
                      style={textActionButtonStyle}
                    >
                      פתח מסך רו״ח הקיים
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

const pageShellStyle = {
  minHeight: "100vh",
  background: "#ffffff",
  color: "#0d1b3d",
};

const pageContentStyle = {
  width: "100%",
  maxWidth: 980,
  margin: "0 auto",
  padding: "0 18px 118px",
  boxSizing: "border-box" as const,
};

const topHeaderStyle = {
  height: 106,
  marginInline: -18,
  padding: "24px 34px 18px",
  display: "grid",
  gridTemplateColumns: "48px minmax(0, 1fr) auto 48px",
  gap: 22,
  alignItems: "center",
  borderBottom: "1px solid #edf1f8",
  boxSizing: "border-box" as const,
};

const topIconButton = {
  width: 42,
  height: 42,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#0d1b3d",
};

const topSearchStyle = {
  height: 54,
  minWidth: 0,
  maxWidth: 510,
  justifySelf: "stretch",
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "0 22px",
  border: "1px solid #dfe7f4",
  borderRadius: 14,
  background: "#ffffff",
  boxShadow: "0 8px 24px rgba(13, 27, 61, 0.06)",
  color: "#677695",
  boxSizing: "border-box" as const,
};

const topSearchInputStyle = {
  border: "none",
  outline: "none",
  background: "transparent",
  width: "100%",
  minWidth: 0,
  color: "#0d1b3d",
  fontSize: 18,
  fontWeight: 500,
  textAlign: "right" as const,
};

const brandStyle = {
  color: "#0d1b3d",
  fontSize: 42,
  lineHeight: 1,
  fontWeight: 950,
  letterSpacing: "-0.02em",
};

const titleSectionStyle = {
  padding: "42px 6px 34px",
  textAlign: "right" as const,
};

const titleStyle = {
  margin: "8px 0 0",
  fontSize: 54,
  lineHeight: 1.05,
  fontWeight: 950,
  letterSpacing: "0",
  color: "#0d1b3d",
};

const subtitleStyle = {
  margin: "18px 0 0",
  color: "#6b7899",
  fontSize: 21,
  lineHeight: 1.6,
  fontWeight: 600,
};

const softCardStyle = {
  background: "#ffffff",
  border: "1px solid #dfe7f4",
  borderRadius: 28,
  padding: 18,
  boxShadow: "0 18px 44px rgba(13, 27, 61, 0.07)",
};

const errorTextStyle = {
  margin: "8px 0 0",
  color: "#7f1d1d",
  fontSize: 14,
  lineHeight: 1.6,
};

const secondaryButtonStyle = {
  width: "100%",
  minHeight: 44,
  marginTop: 14,
  border: "1px solid #dfe7f4",
  borderRadius: 12,
  background: "#ffffff",
  color: "#075bff",
  fontSize: 15,
  fontWeight: 900,
  cursor: "pointer",
};

const statusCardStyle = {
  ...softCardStyle,
  minHeight: 340,
  padding: "40px 52px",
  display: "grid",
  gridTemplateColumns: "minmax(210px, 320px) minmax(0, 1fr)",
  gap: 58,
  alignItems: "center",
  borderRadius: 28,
};

const statusContentStyle = {
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  textAlign: "center" as const,
  gap: 18,
};

const pendingTextStyle = {
  fontSize: 22,
  lineHeight: 1.45,
  color: "#0d1b3d",
  fontWeight: 850,
};

const progressTrackStyle = {
  width: "100%",
  maxWidth: 414,
  height: 12,
  borderRadius: 999,
  background: "#dbe5f7",
  overflow: "hidden",
};

const progressFillStyle = {
  display: "block",
  height: "100%",
  borderRadius: 999,
  background: "linear-gradient(90deg, #075bff 0%, #1f6dff 100%)",
  transition: "width 180ms ease",
};

const progressLabelStyle = {
  color: "#075bff",
  fontSize: 19,
  fontWeight: 850,
};

const primaryButtonStyle = (disabled: boolean) => ({
  width: "100%",
  maxWidth: 452,
  minHeight: 78,
  border: "none",
  borderRadius: 17,
  background: TOKEN.brand.gradient,
  color: "#ffffff",
  fontSize: 25,
  fontWeight: 800,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 18,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.62 : 1,
  boxShadow: "0 16px 34px rgba(7, 91, 255, 0.28)",
});

const queueLinkStyle = {
  border: "none",
  background: "transparent",
  color: "#075bff",
  fontSize: 19,
  fontWeight: 850,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  cursor: "pointer",
};

const illustrationWrap = {
  position: "relative" as const,
  width: 260,
  height: 210,
  margin: "0 auto",
  background:
    "radial-gradient(circle at 45% 60%, rgba(7, 91, 255, 0.16), transparent 58%)",
};

const trayStyle = {
  position: "absolute" as const,
  right: 34,
  bottom: 18,
  width: 172,
  height: 62,
  borderRadius: "16px 16px 28px 28px",
  background: "linear-gradient(180deg, #9ebdff 0%, #74a0ff 100%)",
  boxShadow: "0 18px 26px rgba(49, 105, 220, 0.26)",
};

const paperStyle = {
  position: "absolute" as const,
  width: 104,
  height: 138,
  borderRadius: 14,
  background: "#ffffff",
  boxShadow: "0 15px 28px rgba(37, 70, 143, 0.12)",
};

const paperLineWide = {
  display: "block",
  width: 58,
  height: 7,
  borderRadius: 999,
  margin: "38px 22px 0",
  background: "#dfe7f7",
};

const paperLine = {
  display: "block",
  width: 72,
  height: 7,
  borderRadius: 999,
  margin: "18px 18px 0",
  background: "#dfe7f7",
};

const paperLineShort = {
  display: "block",
  width: 48,
  height: 7,
  borderRadius: 999,
  margin: "18px 22px 0",
  background: "#dfe7f7",
};

const sparkleStyle = {
  position: "absolute" as const,
  width: 12,
  height: 12,
  borderRadius: 999,
  background: "#9ebdff",
  boxShadow: "0 0 20px rgba(117, 157, 255, 0.85)",
};

const sparkleTinyStyle = {
  position: "absolute" as const,
  width: 6,
  height: 6,
  borderRadius: 999,
  background: "#9ebdff",
};

const checkBadgeStyle = {
  position: "absolute" as const,
  left: 30,
  top: 94,
  width: 66,
  height: 66,
  borderRadius: 999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#ff8a2a",
  color: "#ffffff",
  boxShadow: "0 10px 18px rgba(255, 138, 42, 0.28)",
};

const sectionTitleStyle = {
  margin: "42px 0 22px",
  textAlign: "center" as const,
  color: "#0d1b3d",
  fontSize: 22,
  fontWeight: 900,
};

const intakeGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 20,
};

const intakeCardStyle = {
  minHeight: 238,
  padding: "28px 22px 24px",
  border: "1px solid #e1e8f4",
  borderRadius: 18,
  background: "#ffffff",
  boxShadow: "0 14px 34px rgba(13, 27, 61, 0.06)",
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  textAlign: "center" as const,
  cursor: "pointer",
};

const intakeIconCircle = {
  width: 74,
  height: 74,
  borderRadius: 999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const intakeTones = {
  whatsapp: { background: "#e7f8ee", color: "#20bb62" },
  gmail: { background: "#ffffff", color: "#0d1b3d" },
  camera: { background: "#eee8ff", color: "#7351c9" },
  upload: { background: "#edf6ff", color: "#075bff" },
};

const intakeTitleStyle = {
  color: "#0d1b3d",
  fontSize: 20,
  fontWeight: 900,
  lineHeight: 1.25,
};

const intakeSubtitleStyle = {
  color: "#4f5f81",
  fontSize: 16,
  lineHeight: 1.45,
  fontWeight: 650,
};

const stationsStyle = {
  marginTop: 44,
  minHeight: 84,
  border: "1px solid #e1e8f4",
  borderRadius: 18,
  background: "#ffffff",
  boxShadow: "0 14px 34px rgba(13, 27, 61, 0.06)",
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
};

const stationTabStyle = {
  position: "relative" as const,
  border: "none",
  borderLeft: "1px solid #edf1f8",
  background: "transparent",
  minHeight: 84,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  fontSize: 19,
  fontWeight: 900,
  cursor: "pointer",
};

const stationIconStyle = {
  width: 34,
  height: 34,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const activeStationLine = {
  position: "absolute" as const,
  left: 18,
  right: 18,
  bottom: 0,
  height: 4,
  borderRadius: "8px 8px 0 0",
  background: "#075bff",
};

const contentPanelStyle = {
  marginTop: 28,
  border: "1px solid #e1e8f4",
  borderRadius: 18,
  background: "#ffffff",
  boxShadow: "0 14px 34px rgba(13, 27, 61, 0.06)",
  padding: "22px 28px 18px",
};

const panelHeaderStyle = {
  paddingBottom: 18,
  borderBottom: "1px solid #edf1f8",
  color: "#0d1b3d",
  fontSize: 21,
  fontWeight: 900,
  textAlign: "right" as const,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap" as const,
};

const panelHeaderMetaStyle = {
  color: "#6b7899",
  fontSize: 15,
  fontWeight: 750,
};

const recordsStackStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 20,
};

const recordsQueueStyle = {
  marginTop: 20,
  padding: "18px 20px",
  borderRadius: 16,
  background: "#f8fbff",
  border: "1px solid #e1e8f4",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
};

const recordsQueueTitleStyle = {
  color: "#0d1b3d",
  fontSize: 20,
  fontWeight: 900,
};

const recordsQueueTextStyle = {
  marginTop: 5,
  color: "#6b7899",
  fontSize: 15,
  lineHeight: 1.55,
  fontWeight: 650,
};

const contentSubsectionStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 10,
};

const contentSubsectionTitleStyle = {
  color: "#0d1b3d",
  fontSize: 17,
  fontWeight: 900,
};

const compactPrimaryButtonStyle = (disabled: boolean) => ({
  minHeight: 46,
  padding: "0 22px",
  border: "none",
  borderRadius: 12,
  background: TOKEN.brand.gradient,
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 900,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.55 : 1,
  whiteSpace: "nowrap" as const,
});

const outlineActionButtonStyle = {
  minHeight: 46,
  border: "1px solid #d8e2f2",
  borderRadius: 12,
  background: "#ffffff",
  color: "#075bff",
  fontSize: 15,
  fontWeight: 900,
  cursor: "pointer",
};

const textActionButtonStyle = {
  border: "none",
  background: "transparent",
  color: "#075bff",
  fontSize: 15,
  fontWeight: 900,
  cursor: "pointer",
};

const statusStackStyle = {
  justifySelf: "start",
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "flex-start",
  gap: 5,
};

const confidencePillStyle = {
  borderRadius: 999,
  padding: "4px 9px",
  background: "#f8fbff",
  color: "#6b7899",
  border: "1px solid #e1e8f4",
  fontSize: 12,
  fontWeight: 800,
  whiteSpace: "nowrap" as const,
};

const monthGroupListStyle = {
  border: "1px solid #edf1f8",
  borderRadius: 14,
  overflow: "hidden",
};

const monthGroupRowStyle = {
  minHeight: 52,
  padding: "0 16px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  borderBottom: "1px solid #edf1f8",
  color: "#0d1b3d",
  fontSize: 15,
  fontWeight: 850,
};

const monthGroupCountStyle = {
  color: "#6b7899",
  fontSize: 14,
  fontWeight: 750,
};

const searchFormStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
  gap: 10,
};

const fieldStyle = {
  width: "100%",
  minHeight: 46,
  border: "1px solid #d8e2f2",
  borderRadius: 12,
  background: "#ffffff",
  color: "#0d1b3d",
  padding: "0 13px",
  fontSize: 15,
  fontWeight: 750,
  boxSizing: "border-box" as const,
};

const actionRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  gap: 12,
  flexWrap: "wrap" as const,
};

const searchScopeNoteStyle = {
  borderRadius: 14,
  background: "#f8fbff",
  border: "1px solid #e1e8f4",
  color: "#4f5f81",
  padding: "12px 14px",
  fontSize: 14,
  lineHeight: 1.55,
  fontWeight: 700,
};

const inlineErrorStyle = {
  borderRadius: 14,
  background: "#fff7f7",
  border: "1px solid #fecaca",
  color: "#991b1b",
  padding: "12px 14px",
  fontSize: 14,
  lineHeight: 1.5,
  fontWeight: 800,
};

const searchResultRowStyle = {
  width: "100%",
  minHeight: 76,
  border: "none",
  borderBottom: "1px solid #edf1f8",
  background: "#ffffff",
  display: "grid",
  gridTemplateColumns: "40px 118px minmax(0, 1fr) 118px 84px 42px",
  gap: 14,
  alignItems: "center",
  color: "#0d1b3d",
  textAlign: "right" as const,
  cursor: "pointer",
  font: "inherit",
};

const stepRowStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 10,
};

const stepButtonStyle = (active: boolean) => ({
  minHeight: 46,
  border: `1px solid ${active ? "#075bff" : "#d8e2f2"}`,
  borderRadius: 12,
  background: active ? "#eff6ff" : "#ffffff",
  color: active ? "#075bff" : "#0d1b3d",
  fontSize: 15,
  fontWeight: 900,
  cursor: "pointer",
});

const readinessCardStyle = (ready: boolean) => ({
  padding: "16px 18px",
  borderRadius: 16,
  border: `1px solid ${ready ? "#bdebd1" : "#ffd7bd"}`,
  background: ready ? "#f1fbf6" : "#fff8f2",
});

const readinessTitleStyle = {
  color: "#0d1b3d",
  fontSize: 18,
  fontWeight: 950,
};

const blockerListStyle = {
  border: "1px solid #edf1f8",
  borderRadius: 14,
  overflow: "hidden",
};

const blockerRowStyle = {
  minHeight: 52,
  padding: "12px 15px",
  display: "grid",
  gridTemplateColumns: "130px minmax(0, 1fr)",
  gap: 12,
  borderBottom: "1px solid #edf1f8",
  color: "#0d1b3d",
  fontSize: 14,
  lineHeight: 1.5,
  fontWeight: 750,
};

const chipGridStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: 8,
};

const chipButtonStyle = (active: boolean) => ({
  minHeight: 38,
  border: `1px solid ${active ? "#075bff" : "#d8e2f2"}`,
  borderRadius: 999,
  background: active ? "#eff6ff" : "#ffffff",
  color: active ? "#075bff" : "#0d1b3d",
  padding: "0 14px",
  fontSize: 13,
  fontWeight: 850,
  cursor: "pointer",
});

const exportSummaryStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 8,
  borderRadius: 16,
  background: "#f8fbff",
  border: "1px solid #e1e8f4",
  padding: "16px 18px",
  color: "#0d1b3d",
  fontSize: 15,
  lineHeight: 1.55,
  fontWeight: 750,
};

const recentRowStyle = {
  width: "100%",
  minHeight: 76,
  border: "none",
  borderBottom: "1px solid #edf1f8",
  background: "#ffffff",
  display: "grid",
  gridTemplateColumns: "40px 132px minmax(0, 1fr) 128px 84px 42px 24px",
  gap: 14,
  alignItems: "center",
  color: "#0d1b3d",
  textAlign: "right" as const,
  cursor: "pointer",
  font: "inherit",
};

const statusPillStyle = (bg: string, color: string) => ({
  justifySelf: "start",
  borderRadius: 999,
  padding: "7px 13px",
  background: bg,
  color,
  fontSize: 14,
  fontWeight: 800,
  whiteSpace: "nowrap" as const,
});

const recentVendorBlock = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column" as const,
  gap: 4,
};

const recentVendorStyle = {
  color: "#0d1b3d",
  fontSize: 16,
  fontWeight: 700,
  whiteSpace: "nowrap" as const,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const recentSubtitleStyle = {
  color: "#6b7899",
  fontSize: 14,
  fontWeight: 600,
  whiteSpace: "nowrap" as const,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const recentAmountStyle = {
  color: "#0d1b3d",
  fontSize: 16,
  fontWeight: 900,
  textAlign: "left" as const,
};

const recentDateStyle = {
  color: "#667493",
  fontSize: 15,
  fontWeight: 650,
  textAlign: "center" as const,
};

const sourceIconStyle = (source: string) => ({
  width: 34,
  height: 34,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: source === "whatsapp" ? "#20bb62" : source === "email" ? "#e94335" : "#7351c9",
});

const kebabStyle = {
  color: "#0d1b3d",
  fontSize: 28,
  lineHeight: 1,
};

const allDocsLinkStyle = {
  margin: "18px auto 0",
  border: "none",
  background: "transparent",
  color: "#075bff",
  fontSize: 17,
  fontWeight: 850,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  cursor: "pointer",
};

const loadingRowsStyle = {
  padding: "28px 0",
  color: "#6b7899",
  fontSize: 16,
  fontWeight: 750,
  textAlign: "center" as const,
};

const emptyStateStyle = {
  padding: "32px 0",
  color: "#6b7899",
  fontSize: 16,
  fontWeight: 750,
  textAlign: "center" as const,
};

function BellIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.7 21a2 2 0 0 1-3.4 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="18.3" cy="3.8" r="3" fill="#075bff" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 6h16M4 12h16M4 18h16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SearchIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 21l-4.35-4.35M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DocumentIcon({ size = 52 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6M8 13h8M8 17h6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 6 9 17l-5-5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DocumentCheckIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="m15 18 2 2 4-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m15 18-6-6 6-6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4.9 18.7 6 15.1a7.6 7.6 0 1 1 2.8 2.7l-3.9.9z"
        fill="currentColor"
      />
      <path
        d="M9.2 8.2c.2-.4.4-.4.7-.4h.5c.2 0 .4.1.5.4l.7 1.6c.1.3.1.5-.1.7l-.4.5c-.1.1-.2.3-.1.5.4.8 1.2 1.7 2.3 2.2.2.1.4.1.5-.1l.6-.7c.2-.2.4-.2.7-.1l1.6.8c.3.1.4.3.4.6 0 .8-.7 1.6-1.5 1.7-1.2.1-2.9-.4-4.5-1.7-1.7-1.3-2.8-3.1-3-4.4-.2-.8.3-1.7 1.1-2.2z"
        fill="#fff"
      />
    </svg>
  );
}

function GmailIcon() {
  return (
    <svg width="42" height="42" viewBox="0 0 48 48" aria-hidden>
      <path fill="#e94335" d="M6 14v22h8V20l10 8 10-8v16h8V14l-18 14L6 14z" />
      <path fill="#fbbc04" d="M34 14v6l8-6v-4c0-2.2-2.5-3.5-4.2-2.2L34 10.7V14z" />
      <path fill="#34a853" d="M6 14v-4c0-2.2 2.5-3.5 4.2-2.2L14 10.7V20l-8-6z" />
      <path fill="#4285f4" d="M34 36h8V14l-8 6v16z" />
      <path fill="#c5221f" d="M6 36h8V20l-8-6v22z" />
    </svg>
  );
}

function CameraIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 7h3l1.6-2h6.8L17 7h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"
        fill="currentColor"
      />
      <circle cx="12" cy="13" r="3.4" fill="#fff" opacity=".88" />
    </svg>
  );
}

function UploadCloudIcon() {
  return (
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M17.5 18H8a5 5 0 0 1-.8-9.94 6 6 0 0 1 11.5 1.7A4.2 4.2 0 0 1 17.5 18z"
        fill="currentColor"
        opacity=".95"
      />
      <path
        d="M12 16V9m0 0-3 3m3-3 3 3"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-10z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PdfIcon() {
  return (
    <span
      aria-hidden
      style={{
        width: 30,
        height: 36,
        border: "1px solid #aeb8cc",
        borderRadius: 4,
        display: "inline-flex",
        alignItems: "flex-end",
        justifyContent: "center",
        paddingBottom: 3,
        color: "#e53935",
        fontSize: 10,
        fontWeight: 950,
        background: "#ffffff",
      }}
    >
      PDF
    </span>
  );
}

const documentsHomeCss = `
  .documents-home input::placeholder {
    color: #6f7d9d;
    opacity: 1;
  }

  @media (max-width: 860px) {
    .documents-top-header {
      height: 86px !important;
      margin-inline: -18px !important;
      padding: 18px 20px 14px !important;
      grid-template-columns: 42px minmax(120px, 1fr) auto 42px !important;
      gap: 14px !important;
    }

    .documents-brand {
      font-size: 32px !important;
    }

    .documents-top-search {
      height: 48px !important;
      padding: 0 16px !important;
      max-width: none !important;
    }

    .documents-title-section {
      padding: 34px 0 28px !important;
    }

    .documents-title {
      font-size: 46px !important;
    }

    .documents-subtitle {
      font-size: 18px !important;
    }

    .documents-status-card {
      grid-template-columns: 1fr !important;
      gap: 22px !important;
      padding: 30px 24px !important;
    }

    .documents-illustration-slot {
      order: 1;
    }

    .documents-status-content {
      order: 2;
    }

    .documents-primary-cta {
      min-height: 66px !important;
      font-size: 21px !important;
    }

    .documents-intake-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      gap: 16px !important;
    }

    .documents-stations {
      margin-top: 34px !important;
    }

    .documents-content-panel {
      padding: 20px 22px 16px !important;
    }

    .documents-station-form {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    }

    .documents-records-queue {
      align-items: stretch !important;
      flex-direction: column !important;
    }

    .documents-blocker-row {
      grid-template-columns: 110px minmax(0, 1fr) !important;
    }

    .documents-search-result-row {
      grid-template-columns: 34px minmax(0, 1fr) 86px 36px !important;
      gap: 10px !important;
      min-height: 78px !important;
    }

    .documents-search-result-row > span:nth-child(2) {
      grid-column: 2;
      grid-row: 2;
      justify-self: start;
    }

    .documents-search-result-row > span:nth-child(3) {
      grid-column: 2;
      grid-row: 1;
    }

    .documents-search-result-row > span:nth-child(4) {
      grid-column: 3;
      grid-row: 1;
      font-size: 15px !important;
    }

    .documents-search-result-row > span:nth-child(5) {
      display: none !important;
    }

    .documents-search-result-row > span:nth-child(6) {
      grid-column: 4;
      grid-row: 1 / span 2;
    }

    .documents-recent-row {
      grid-template-columns: 34px minmax(0, 1fr) 86px 36px 18px !important;
      gap: 10px !important;
      min-height: 78px !important;
    }

    .documents-recent-row > span:nth-child(2) {
      grid-column: 2;
      grid-row: 2;
      justify-self: start;
    }

    .documents-recent-vendor {
      grid-column: 2;
      grid-row: 1;
    }

    .documents-recent-amount {
      grid-column: 3;
      grid-row: 1;
      font-size: 15px !important;
    }

    .documents-recent-date {
      display: none !important;
    }

    .documents-recent-source {
      grid-column: 4;
      grid-row: 1 / span 2;
    }

    .documents-recent-menu {
      grid-column: 5;
      grid-row: 1 / span 2;
    }
  }

  @media (max-width: 560px) {
    .documents-home {
      padding-inline: 14px !important;
      padding-bottom: 148px !important;
    }

    .documents-top-header {
      grid-template-columns: 34px minmax(0, 1fr) auto 34px !important;
      gap: 10px !important;
      padding-inline: 16px !important;
    }

    .documents-brand {
      font-size: 27px !important;
    }

    .documents-top-search {
      height: 44px !important;
      border-radius: 13px !important;
      padding: 0 12px !important;
    }

    .documents-top-search input {
      font-size: 15px !important;
    }

    .documents-title {
      font-size: 39px !important;
    }

    .documents-subtitle {
      font-size: 16px !important;
      margin-top: 12px !important;
    }

    .documents-status-card {
      padding: 24px 18px !important;
      min-height: 0 !important;
    }

    .documents-primary-cta {
      min-height: 58px !important;
      font-size: 18px !important;
      gap: 12px !important;
    }

    .documents-intake-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      gap: 14px !important;
    }

    .documents-intake-grid button {
      min-height: 190px !important;
      padding: 22px 14px 20px !important;
    }

    .documents-stations {
      min-height: 74px !important;
    }

    .documents-stations button {
      min-height: 74px !important;
      font-size: 16px !important;
      gap: 8px !important;
    }

    .documents-content-panel {
      padding: 18px 16px 14px !important;
    }

    .documents-station-form {
      grid-template-columns: 1fr !important;
    }

    .documents-blocker-row {
      grid-template-columns: 1fr !important;
    }

    .documents-recent-row {
      grid-template-columns: 30px minmax(0, 1fr) 78px 28px 16px !important;
      gap: 8px !important;
      padding-block: 8px !important;
    }

    .documents-search-result-row {
      grid-template-columns: 30px minmax(0, 1fr) 78px 28px !important;
      gap: 8px !important;
      padding-block: 8px !important;
    }
  }
`;
