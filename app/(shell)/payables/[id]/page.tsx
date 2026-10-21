"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import BackButton from "@/components/ui/back-button";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import {
  CADENCE_LABEL,
  METHOD_LABEL,
  SCHEDULE_LABEL,
  cancelInstallment,
  fetchBankAccounts,
  fetchCheques,
  fetchOutboundProviders,
  fetchPreparations,
  fetchCommitment,
  formatDate,
  formatMoney,
  recordPayment,
  reverseAllocation,
  voidPayment,
  type BankAccountApi,
  type ChequeApi,
  type PreparationApi,
  type CommitmentDetailApi,
  type InstallmentApi,
} from "@/lib/payables/payables-client";
import {
  ActionMenu,
  Button,
  ButtonLink,
  Card,
  DialogFrame,
  EmptyState,
  ErrorState,
  Money,
  Notice,
  SkeletonRows,
  StatusChip,
  SummaryStrip,
  Tag,
  formatShortDate,
  hebrewErrorMessage,
  israelDayKey,
  useConfirm,
  useToast,
  type MenuItem,
} from "@/components/finance-ui";
import { PAYABLES_THEME } from "../payables-theme";
import { ChequeCard, ChequeForm } from "../cheque-parts";
import { PreparationCard, PreparePaymentForm } from "../prepare-parts";
import { auditLabel } from "../payables-labels";
import styles from "../payables.module.css";
import ui from "../payables-ui.module.css";
import { EndCommitmentForm, RecurringAmountForm } from "./recurring-changes";

const METHODS = [
  "BANK_TRANSFER",
  "CASH",
  "CREDIT_CARD",
  "CHECK",
  "DIRECT_DEBIT",
  "STANDING_ORDER",
  "BIT",
  "PAYBOX",
  "OTHER",
] as const;

const STATUS_TEXT: Record<string, string> = {
  ACTIVE: "פעילה",
  CLOSED: "נסגרה",
  RELEASED: "הוסרה מהמעקב",
};

type Dialog = null | "pay" | "prepare" | "cheque" | "amount" | "end";

/** Installments that can still take money (the same rule the payment form always used). */
function openInstallments(detail: CommitmentDetailApi): InstallmentApi[] {
  return detail.installments.filter((i) => Number(i.remaining) > 0 && i.status === "SCHEDULED");
}

export default function CommitmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const commitmentId = Number(id);

  const [detail, setDetail] = useState<CommitmentDetailApi | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cheques, setCheques] = useState<ChequeApi[]>([]);
  const [accounts, setAccounts] = useState<BankAccountApi[]>([]);
  const [preparations, setPreparations] = useState<PreparationApi[]>([]);
  const [providersLive, setProvidersLive] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, showToast] = useToast();
  const [confirmNode, confirm] = useConfirm();
  // Like other detail screens (billing/[id]): on phones this page brings its
  // own sticky action bar, so the shell bottom bar + FAB step aside.
  useHideShellChrome(true);

  // Arriving with ?pay=<installmentId> (a Dubiz recommendation, or "רישום
  // תשלום" in the list inspector) opens the payment form for that installment.
  const [payTarget] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const pay = Number(new URLSearchParams(window.location.search).get("pay"));
    return Number.isInteger(pay) && pay > 0 ? pay : null;
  });

  // Every setState for the fetch lives inside the effect, so a response for a
  // commitment the owner has already navigated away from cannot land on the
  // new one. `reloadToken` is how an action asks for fresh data.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);
  // The ?pay= target opens the payment dialog once, on the first load only.
  const payOpenedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Cheques are secondary to the ledger: if they fail to load, the
    // commitment still renders and the cheque section simply stays empty.
    Promise.all([
      fetchCommitment(commitmentId),
      fetchCheques({ scope: "all", commitmentId }).catch(() => [] as ChequeApi[]),
      fetchBankAccounts()
        .then((r) => r.accounts)
        .catch(() => [] as BankAccountApi[]),
      fetchPreparations({ commitmentId, scope: "all" }).catch(() => [] as PreparationApi[]),
      fetchOutboundProviders()
        .then((r) => r.live)
        .catch(() => false),
    ])
      .then(([d, list, bank, preps, live]) => {
        if (cancelled) return;
        if (!payOpenedRef.current && payTarget && openInstallments(d).some((i) => i.id === payTarget)) {
          payOpenedRef.current = true;
          setDialog("pay");
        }
        setDetail(d);
        setCheques(list);
        setAccounts(bank);
        setPreparations(preps);
        setProvidersLive(live);
        setLoadError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(hebrewErrorMessage(e, "לא הצלחנו לטעון את ההתחייבות."));
      });
    return () => {
      cancelled = true;
    };
  }, [commitmentId, reloadToken, payTarget]);

  /** Runs one ledger action; success → toast + reload, failure → Hebrew error. */
  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setActionError(null);
    try {
      await action();
      showToast(success);
      reload();
      return true;
    } catch (e) {
      setActionError(hebrewErrorMessage(e, "הפעולה לא הצליחה. שום דבר לא השתנה, ואפשר לנסות שוב."));
      return false;
    }
  }

  const open = useMemo(() => (detail ? openInstallments(detail) : []), [detail]);

  if (loadError && !detail) {
    return (
      <div className={ui.page} style={PAYABLES_THEME} dir="rtl">
        <div><BackButton /></div>
        <ErrorState title="לא הצלחנו לטעון את ההתחייבות" body={loadError} onRetry={reload} />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className={ui.page} style={PAYABLES_THEME} dir="rtl" aria-busy="true">
        <div><BackButton /></div>
        <SkeletonRows count={3} label="טוען את ההתחייבות" />
      </div>
    );
  }

  const active = detail.status === "ACTIVE";
  const recurring = detail.scheduleKind === "RECURRING";
  const nextOpen = open[0] ?? null;
  const surplusPayments = detail.payments.filter((p) => p.status === "RECORDED" && Number(p.unallocated) > 0);
  const payeeDiffers = detail.payeeNameSnapshot && detail.payeeNameSnapshot !== detail.title;

  const menu: MenuItem[] = [
    ...(recurring && active
      ? [
          { label: "שינוי סכום מתאריך…", onSelect: () => setDialog("amount") },
          { label: "סיום ההתחייבות…", onSelect: () => setDialog("end"), danger: true },
          { kind: "separator" as const },
        ]
      : []),
    { kind: "link", label: "צ׳קים וחשבונות בנק", href: "/payables/cheques" },
    { kind: "link", label: "תנועות בנק", href: "/payables/bank" },
  ];

  const actions = (
    <>
      {open.length > 0 ? (
        <Button variant="primary" onClick={() => setDialog("pay")}>
          רישום תשלום
        </Button>
      ) : null}
      {active ? (
        <Button variant="secondary" onClick={() => setDialog("prepare")}>
          הכנת תשלום
        </Button>
      ) : null}
      {active ? (
        <Button variant="secondary" onClick={() => setDialog("cheque")}>
          רישום צ׳ק
        </Button>
      ) : null}
      <ActionMenu items={menu} size="md" label="פעולות נוספות להתחייבות" />
    </>
  );

  return (
    <div className={ui.page} style={PAYABLES_THEME} dir="rtl">
      <div><BackButton /></div>

      <header className={ui.detailHead}>
        <div className={ui.detailTitleRow}>
          <div style={{ minWidth: 0 }}>
            <h1 className={ui.detailTitle}>{detail.title}</h1>
            <div className={ui.detailChips}>
              <Tag>
                {SCHEDULE_LABEL[detail.scheduleKind]}
                {recurring && detail.recurrence !== "NONE" ? ` · ${CADENCE_LABEL[detail.recurrence]}` : ""}
              </Tag>
              {nextOpen ? <StatusChip status={{ domain: "payables", state: nextOpen.state }} /> : null}
              {!active ? <Tag>{STATUS_TEXT[detail.status] ?? detail.status}</Tag> : null}
              {detail.isLegacy ? <Tag>נמסרה דרך המזכירה</Tag> : null}
            </div>
            {payeeDiffers ? <p className={ui.subtitle} style={{ marginBlockStart: 6 }}>מוטב: {detail.payeeNameSnapshot}</p> : null}
          </div>
          <div className={`${ui.detailActions} ${ui.wideOnly}`}>{actions}</div>
        </div>

        <SummaryStrip
          ariaLabel="מצב ההתחייבות"
          figures={
            recurring
              ? [
                  { label: "לתשלום במועד הקרוב", value: nextOpen ? <Money amount={nextOpen.remaining} currency={detail.currency} /> : "—", tone: nextOpen && nextOpen.state === "OVERDUE" ? "danger" : "default" },
                  { label: "המועד הקרוב", value: nextOpen ? formatShortDate(nextOpen.dueAt) : "—" },
                  { label: "שולם עד כה", value: <Money amount={detail.paid} currency={detail.currency} /> },
                ]
              : [
                  { label: "סכום כולל", value: detail.total === null ? "—" : <Money amount={detail.total} currency={detail.currency} /> },
                  { label: "שולם", value: <Money amount={detail.paid} currency={detail.currency} /> },
                  { label: "נותר", value: detail.remaining === null ? "—" : <Money amount={detail.remaining} currency={detail.currency} />, tone: nextOpen && nextOpen.state === "OVERDUE" ? "danger" : "default" },
                ]
          }
          footnote={recurring ? "התחייבות מתחדשת: אין לה סכום כולל ואין יתרה סופית. מוצג המועד הקרוב." : undefined}
        />
      </header>

      {detail.endAt ? <Notice tone="neutral">ההתחייבות בתוקף עד {formatDate(detail.endAt)} (כולל).</Notice> : null}

      {/* The legacy assertion, stated as an assertion. It must not read as a
          payment: nothing was ever observed, and no amount was recorded. */}
      {detail.legacy && (
        <Notice tone="warning">
          סומן כטופל
          {detail.legacy.metAt ? ` בתאריך ${formatDate(detail.legacy.metAt)}` : ""}
          {detail.legacy.assertedBy ? ` על ידי ${detail.legacy.assertedBy}` : ""}. זו הצהרה שהועברה מהמזכירה, ולא תשלום שנרשם — לא נשמר
          סכום, אמצעי תשלום או אסמכתא, והיא אינה נספרת כתשלום.
        </Notice>
      )}

      {actionError ? <Notice tone="danger" role="alert">{actionError}</Notice> : null}

      {surplusPayments.length > 0 && (
        <Notice tone="info">
          {surplusPayments.map((p) => (
            <div key={p.id}>
              בתשלום מ־{formatDate(p.paidAt)} נותרו <strong>{formatMoney(p.unallocated, detail.currency)}</strong> שלא שויכו לאף מועד.
              אפשר לשייך אותם בתשלום חדש, או להשאיר אותם כפי שהם.
            </div>
          ))}
        </Notice>
      )}

      <div className={ui.detailWork}>
        <div className={ui.detailMain}>
          <Card title="לוח התשלומים" meta={recurring ? "המועד הבא נוצר אחרי שהמועד הנוכחי שולם במלואו" : undefined}>
            <div className={ui.listBox}>
              {detail.installments.map((inst) => (
                <InstallmentRow
                  key={inst.id}
                  inst={inst}
                  currency={detail.currency}
                  canPay={Number(inst.remaining) > 0 && inst.status === "SCHEDULED"}
                  onPay={() => setDialog("pay")}
                  onReverse={async (allocationId) => {
                    const ok = await confirm({
                      title: "לבטל את השיוך?",
                      body: "התשלום עצמו נשאר רשום. הסכום חוזר ליתרה שלא שויכה, והמועד יחזור להיות פתוח.",
                      confirmLabel: "ביטול השיוך",
                      cancelLabel: "השארה",
                    });
                    if (ok) await run(() => reverseAllocation(allocationId, "תוקן על ידי בעל העסק"), "השיוך בוטל. הכסף חזר ליתרה שלא שויכה של התשלום.");
                  }}
                  onCancel={async (installmentId) => {
                    const lastOfSeries = recurring && detail.installments[detail.installments.length - 1]?.id === installmentId;
                    const ok = await confirm({
                      title: "לבטל את המועד הזה?",
                      body: lastOfSeries
                        ? "זה המועד האחרון של התחייבות מתחדשת. אחרי ביטולו לא ייווצרו מועדים חדשים, והעלות החודשית תפסיק להיספר. כדי לסיים התחייבות בתאריך מסוים, עדיף ״סיום ההתחייבות״."
                        : "המועד יבוטל ולא ייספר כחוב. הפעולה מתועדת.",
                      confirmLabel: "ביטול המועד",
                      cancelLabel: "השארה",
                    });
                    if (ok) await run(() => cancelInstallment(installmentId, "בוטל על ידי בעל העסק"), "המועד בוטל.");
                  }}
                />
              ))}
            </div>
          </Card>

          <Card title="תשלומים שנרשמו">
            {detail.payments.length === 0 ? (
              <EmptyState title="עוד לא נרשם תשלום" body={open.length > 0 ? "כשהכסף יוצא, רושמים כאן את התשלום והוא משויך למועד." : undefined} />
            ) : (
              <div className={ui.listBox}>
                {detail.payments.map((p) => (
                  <div key={p.id} className={ui.inst}>
                    <div className={ui.instHead}>
                      <span className={ui.instTitle}>
                        <Money amount={p.amount} currency={detail.currency} /> · {METHOD_LABEL[p.method] ?? p.method}
                        {p.status === "VOID" ? <Tag>רישום בוטל</Tag> : <StatusChip tone="success" label="נרשם" />}
                      </span>
                      {p.status === "RECORDED" ? (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            const ok = await confirm({
                              title: "לבטל את רישום התשלום?",
                              body: "הרישום נשמר בתיעוד, אבל הסכום יפסיק להיספר וכל השיוכים שלו יבוטלו.",
                              confirmLabel: "ביטול הרישום",
                              cancelLabel: "השארה",
                            });
                            if (ok) await run(() => voidPayment(p.id, "בוטל על ידי בעל העסק"), "רישום התשלום בוטל. הרישום נשמר וכל השיוכים שלו הפסיקו להיספר.");
                          }}
                        >
                          ביטול רישום
                        </Button>
                      ) : null}
                    </div>
                    <div className={ui.instFigures}>
                      <span>{formatDate(p.paidAt)}</span>
                      <span>שויך <b><Money amount={p.allocated} currency={detail.currency} /></b></span>
                      <span>לא שויך <b><Money amount={p.unallocated} currency={detail.currency} /></b></span>
                      {p.externalReference ? <span>אסמכתא {p.externalReference}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {preparations.length > 0 ? (
            <Card title="תשלומים מוכנים">
              {!providersLive ? <Notice tone="neutral">אין ספק לתשלומים יוצאים. הכנה ואישור נשמרים כאן ואינם מעבירים כסף.</Notice> : null}
              <div className={styles.timeline}>
                {preparations.map((p) => (
                  <PreparationCard
                    key={p.id}
                    prep={p}
                    providersLive={providersLive}
                    onChanged={(message) => {
                      showToast(message);
                      reload();
                    }}
                  />
                ))}
              </div>
            </Card>
          ) : null}

          <Card title="צ׳קים">
            {cheques.length === 0 ? (
              <EmptyState title="לא נרשמו צ׳קים להתחייבות הזו" />
            ) : (
              <div className={styles.timeline}>
                {cheques.map((c) => (
                  <ChequeCard
                    key={c.id}
                    cheque={c}
                    accounts={accounts}
                    showCommitment={false}
                    onChanged={(message) => {
                      showToast(message);
                      reload();
                    }}
                  />
                ))}
              </div>
            )}
          </Card>
        </div>

        <aside className={ui.detailSide} aria-label="פרטים ותיעוד">
          <Card title="פרטים">
            <dl className={ui.facts}>
              <div><dt>מוטב</dt><dd>{detail.payeeNameSnapshot || "—"}</dd></div>
              <div><dt>אופן התשלום</dt><dd>{SCHEDULE_LABEL[detail.scheduleKind]}</dd></div>
              {recurring ? <div><dt>תדירות</dt><dd>{CADENCE_LABEL[detail.recurrence]}</dd></div> : null}
              <div><dt>מצב</dt><dd>{STATUS_TEXT[detail.status] ?? detail.status}</dd></div>
              {detail.endAt ? <div><dt>בתוקף עד</dt><dd>{formatDate(detail.endAt)}</dd></div> : null}
              <div><dt>מקור</dt><dd>{detail.isLegacy ? "נמסרה דרך המזכירה" : "נרשמה בהתחייבויות"}</dd></div>
              {detail.note ? <div><dt>הערה</dt><dd>{detail.note}</dd></div> : null}
            </dl>
          </Card>
          <Card title="במזכירה">
            <p className={ui.inspectNote} style={{ fontSize: 13 }}>
              מועד שלא שולם מופיע ב״דורש טיפול״ במזכירה שבוע לפני התאריך, ונשאר שם עד שהוא מטופל. מסמך החיוב נשאר ב<Link href="/billing">חשבוניות</Link>.
            </p>
            <div>
              <ButtonLink href="/secretary" variant="quiet" size="sm">למזכירה</ButtonLink>
            </div>
          </Card>
          {detail.audit.length > 0 ? (
            <Card title="תיעוד">
              <ul className={ui.log}>
                {detail.audit.map((a) => (
                  <li key={a.id}>
                    <span>{auditLabel(a)}</span>
                    <time dateTime={a.occurredAt}>{formatShortDate(a.occurredAt)}</time>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>

      <div className={ui.stickyBar}>
        {open.length > 0 ? (
          <Button variant="primary" block onClick={() => setDialog("pay")}>
            רישום תשלום
          </Button>
        ) : null}
        {active ? (
          <Button variant="secondary" onClick={() => setDialog("prepare")}>
            הכנה
          </Button>
        ) : null}
        <ActionMenu
          items={[...(active ? [{ label: "רישום צ׳ק", onSelect: () => setDialog("cheque") }] : []), ...menu]}
          size="md"
          label="פעולות נוספות להתחייבות"
        />
      </div>

      <DialogFrame open={dialog === "pay"} onClose={() => setDialog(null)} title="רישום תשלום">
        <PaymentForm
          detail={detail}
          preselect={payTarget}
          onDone={(message) => {
            setDialog(null);
            showToast(message);
            reload();
          }}
          onCancel={() => setDialog(null)}
        />
      </DialogFrame>

      <DialogFrame open={dialog === "prepare"} onClose={() => setDialog(null)} title="הכנת תשלום" variant="wide">
        {!providersLive ? <Notice tone="neutral">אין ספק לתשלומים יוצאים. ההכנה והאישור נשמרים כאן ואינם מעבירים כסף.</Notice> : null}
        <PreparePaymentForm
          detail={detail}
          accounts={accounts}
          onPayeeLinked={() => {
            showToast("המוטב נרשם וקושר להתחייבות.");
            reload();
          }}
          onPrepared={() => {
            setDialog(null);
            showToast("התשלום הוכן. עדיין לא שולם דבר — בדקו ואשרו.");
            reload();
          }}
        />
      </DialogFrame>

      <DialogFrame open={dialog === "cheque"} onClose={() => setDialog(null)} title="רישום צ׳ק">
        <ChequeForm
          accounts={accounts}
          commitmentId={detail.id}
          installments={detail.installments}
          onCreated={(c) => {
            setDialog(null);
            showToast(`צ׳ק #${c.chequeNumber} נרשם. הוא ייספר כתשלום כשיסומן שנפרע.`);
            reload();
          }}
        />
      </DialogFrame>

      <DialogFrame open={dialog === "amount"} onClose={() => setDialog(null)} title="שינוי סכום מתאריך">
        <RecurringAmountForm commitmentId={detail.id} run={run} onDone={() => setDialog(null)} onCancel={() => setDialog(null)} />
      </DialogFrame>

      <DialogFrame open={dialog === "end"} onClose={() => setDialog(null)} title="סיום ההתחייבות">
        <EndCommitmentForm commitmentId={detail.id} run={run} onDone={() => setDialog(null)} onCancel={() => setDialog(null)} />
      </DialogFrame>

      {confirmNode}
      {toast}
    </div>
  );
}

function InstallmentRow({
  inst,
  currency,
  canPay,
  onPay,
  onReverse,
  onCancel,
}: {
  inst: InstallmentApi;
  currency: string;
  canPay: boolean;
  onPay: () => void;
  onReverse: (allocationId: number) => void;
  onCancel: (installmentId: number) => void;
}) {
  const hasActive = inst.allocations.some((a) => a.active);
  const cancellable = inst.status === "SCHEDULED" && !hasActive && Number(inst.paid) === 0;
  const menu: MenuItem[] = cancellable ? [{ label: "ביטול המועד…", onSelect: () => onCancel(inst.id), danger: true }] : [];

  return (
    <div className={ui.inst}>
      <div className={ui.instHead}>
        <span className={ui.instTitle}>
          מועד {inst.sequence} · {formatShortDate(inst.dueAt)}
          <StatusChip status={{ domain: "payables", state: inst.state }} />
        </span>
        <span style={{ display: "inline-flex", gap: 6 }}>
          {canPay ? (
            <Button size="sm" variant="secondary" onClick={onPay}>
              רישום תשלום
            </Button>
          ) : null}
          {menu.length > 0 ? <ActionMenu items={menu} label={`פעולות למועד ${inst.sequence}`} /> : null}
        </span>
      </div>

      <div className={ui.instFigures}>
        <span>לתשלום <b><Money amount={inst.scheduled} currency={currency} /></b></span>
        <span>שולם <b><Money amount={inst.paid} currency={currency} /></b></span>
        <span>נותר <b><Money amount={inst.remaining} currency={currency} /></b></span>
      </div>

      {inst.state === "SETTLED_LEGACY" && (
        <span className={ui.inspectNote}>סומן כטופל לפני שהפנקס קיים — לא נרשם תשלום, ואינו נספר כשולם.</span>
      )}

      {inst.allocations.map((a) => (
        <div key={a.id} className={`${ui.allocation} ${a.active ? "" : ui.allocationReversed}`}>
          <span>
            {formatMoney(a.amount, currency)} · {METHOD_LABEL[a.paymentMethod] ?? a.paymentMethod} · {formatDate(a.paymentPaidAt)}
            {a.reversedAt ? ` · השיוך בוטל${a.reversalReason ? ` (${a.reversalReason})` : ""}` : ""}
            {!a.reversedAt && a.paymentStatus === "VOID" ? " · רישום התשלום בוטל" : ""}
          </span>
          {a.active && (
            <Button size="sm" variant="quiet" onClick={() => onReverse(a.id)}>
              ביטול השיוך
            </Button>
          )}
        </div>
      ))}

      {inst.status === "SCHEDULED" && hasActive && Number(inst.remaining) > 0 ? (
        <span className={ui.inspectNote}>כדי לבטל מועד שכבר שויך אליו כסף, צריך לבטל קודם את השיוך.</span>
      ) : null}
    </div>
  );
}

/* ───────────────────────────── record a payment ──────────────────────────── */

function PaymentForm({
  detail,
  preselect,
  onDone,
  onCancel,
}: {
  detail: CommitmentDetailApi;
  preselect: number | null;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const open = useMemo(() => openInstallments(detail), [detail]);

  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState(israelDayKey(new Date()));
  const [method, setMethod] = useState<string>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  // Arriving from a Dubiz recommendation (`?pay=<installmentId>`): that open
  // installment is preselected. Only the selection; the amount and date are
  // what the owner actually paid.
  const [selected, setSelected] = useState<number[]>(() => (preselect && open.some((i) => i.id === preselect) ? [preselect] : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh key per mounted form. A double submit — the classic impatient
  // second tap — is then a retry of the SAME logical payment rather than a
  // second economic event.
  const [idempotencyKey] = useState(
    () => `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  if (open.length === 0) {
    return <EmptyState title="אין מועדים פתוחים לשיוך בהתחייבות הזו" />;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await recordPayment({
        commitmentId: detail.id,
        amount,
        paidAt: new Date(paidAt).toISOString(),
        method,
        externalReference: reference.trim() || null,
        installmentIds: selected.length > 0 ? selected : null,
        idempotencyKey,
      });

      if (result.replayed) {
        onDone("זהו אותו תשלום שנרשם קודם — לא נוצר תשלום נוסף.");
        return;
      }
      const surplus = Number(result.unallocated ?? "0");
      onDone(
        surplus > 0
          ? `התשלום נרשם. ${formatMoney(String(surplus), detail.currency)} לא שויכו ונשארו פתוחים.`
          : "התשלום נרשם ושויך במלואו.",
      );
    } catch (e) {
      setError(hebrewErrorMessage(e, "לא הצלחנו לרשום את התשלום. שום דבר לא נרשם, ואפשר לנסות שוב."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-amount">
            סכום ששולם
          </label>
          <input
            id="pm-amount"
            className={styles.input}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1200.00"
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-date">
            תאריך התשלום
          </label>
          <input
            id="pm-date"
            className={styles.input}
            type="date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            required
          />
        </div>
      </div>

      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-method">
            אמצעי תשלום
          </label>
          <select
            id="pm-method"
            className={styles.select}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m] ?? m}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-ref">
            אסמכתא (רשות)
          </label>
          <input
            id="pm-ref"
            className={styles.input}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <legend className={styles.label}>
          לאיזה מועד לשייך (אם לא נבחר — לפי סדר המועדים)
        </legend>
        {open.map((inst) => (
          <label key={inst.id} className={styles.checkboxRow}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={selected.includes(inst.id)}
              onChange={(e) =>
                setSelected((prev) =>
                  e.target.checked
                    ? [...prev, inst.id]
                    : prev.filter((x) => x !== inst.id),
                )
              }
            />
            <span>
              מועד {inst.sequence} · {formatShortDate(inst.dueAt)} · נותר {formatMoney(inst.remaining, detail.currency)}
            </span>
          </label>
        ))}
      </fieldset>

      <Notice tone="neutral">
        סכום גבוה מהנדרש לא יחולק למועדים אחרים מעצמו — העודף יישאר פתוח ויוצג כאן. רישום תשלום לא מעביר כסף.
      </Notice>

      {error && <Notice tone="danger" role="alert">{error}</Notice>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button type="submit" variant="primary" busy={busy} busyLabel="רושם…">
          רישום התשלום
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
