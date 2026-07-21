import type { EInvoiceDraft, InvoiceCategory } from "@/api/client";
import { friendlyApiError } from "@/api/client";
import { useAccounts } from "@/api/hooks/useAccounts";
import {
  useEInvoiceDrafts,
  useEInvoices,
  useIssueInvoice,
  useSaveEInvoiceDraft,
} from "@/api/hooks/useEInvoice";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import { useNicknames } from "@/api/hooks/useNicknames";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toast";
import { Topbar } from "@/layout/Topbar";
import { cn } from "@/lib/cn";
import type { DateConfig } from "@/lib/datePicker";
import { fM } from "@/lib/format";
import { spendOf } from "@/lib/insights";
import { useAccountsStore } from "@/stores/accountsStore";
import { useFinanceStore } from "@/stores/financeStore";
import { useUiStore } from "@/stores/uiStore";
import type { FbEntityStatus } from "@/types/fb";
import { FinanceAccountPanel } from "@/views/finance/FinanceAccountPanel";
import {
  buildAccountRows,
  formatNickname,
  markupFor,
  spendPlus,
} from "@/views/finance/financeData";
import * as Popover from "@radix-ui/react-popover";
import { useMemo, useState } from "react";

/**
 * 電子發票 (ezPay 藍新).
 *
 * 開立發票 = a 費用中心-style two-pane: pick an ad account on the left,
 * the right table lists that month's campaigns with 花費 / 月% / 花費+%
 * (reused verbatim from the finance numbers — % is read-only). Each row
 * has an 開立發票 button that opens the issue modal. 花費+% is the invoice
 * 含稅總額 (應稅 5%). 個人 = 雲端發票 (no buyer fields); 統編 = 統編 + 抬頭.
 */

type Tab = "issue" | "records";

export function EInvoiceView() {
  const [tab, setTab] = useState<Tab>("issue");
  const [month, setMonth] = useState<string>(currentMonth);

  return (
    <>
      <Topbar title="電子發票">
        {tab === "issue" && <MonthPicker value={month} onChange={setMonth} />}
      </Topbar>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Underline tab bar */}
        <div className="flex gap-5 border-border border-b bg-white px-4 md:px-5">
          <UnderlineTab active={tab === "issue"} onClick={() => setTab("issue")}>
            開立發票
          </UnderlineTab>
          <UnderlineTab active={tab === "records"} onClick={() => setTab("records")}>
            開立紀錄
          </UnderlineTab>
        </div>

        {tab === "issue" ? <IssueTab month={month} /> : <RecordsTab />}
      </div>
    </>
  );
}

function UnderlineTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative py-2.5 text-[14px] font-semibold transition",
        active ? "text-orange" : "text-gray-400 hover:text-ink",
      )}
    >
      {children}
      {active && <span className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-orange" />}
    </button>
  );
}

/** Month dropdown styled to match the app's DatePicker trigger (rounded
 *  pill + orange calendar icon), not a native <select>. */
function MonthPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const label = MONTH_OPTIONS.find((m) => m.value === value)?.label ?? value;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-10 select-none items-center gap-2 whitespace-nowrap rounded-xl border-[1.5px] px-3.5 font-sans text-[13px] font-medium leading-none text-ink transition-all duration-150 md:h-9",
            "cursor-pointer active:scale-95",
            open
              ? "border-orange bg-white ring-[3px] ring-orange/10"
              : "border-border bg-white hover:border-orange-border hover:bg-orange-bg",
          )}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-orange"
            role="img"
            aria-label="calendar"
          >
            <title>calendar</title>
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span>{label}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 max-h-[320px] overflow-y-auto rounded-xl border border-border bg-white p-1 shadow-lg"
        >
          {MONTH_OPTIONS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => {
                onChange(m.value);
                setOpen(false);
              }}
              className={cn(
                "block w-full rounded-lg px-3 py-1.5 text-left text-[13px] transition",
                m.value === value
                  ? "bg-orange-bg font-semibold text-orange"
                  : "text-ink hover:bg-bg",
              )}
            >
              {m.label}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ── Month helpers ─────────────────────────────────────────────────────

const currentMonth = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
})();

const MONTH_OPTIONS = (() => {
  const out: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    out.push({ value: `${y}-${String(m).padStart(2, "0")}`, label: `${y} 年 ${m} 月` });
  }
  return out;
})();

/** "YYYY-MM" → a custom DateConfig spanning that whole month. */
function monthToDate(ym: string): DateConfig {
  const [y, m] = ym.split("-").map((s) => Number.parseInt(s, 10));
  const yy = y as number;
  const mm = m as number;
  const from = `${yy}-${String(mm).padStart(2, "0")}-01`;
  const last = new Date(yy, mm, 0).getDate(); // day 0 of next month = last day
  const to = `${yy}-${String(mm).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { preset: "custom", from, to };
}

// ── 開立發票 tab ──────────────────────────────────────────────────────

/** Fixed markup used for the statutory invoice amount — 花費 + 5%,
 *  independent of the per-campaign 月% (which is the internal store bill). */
const INVOICE_MARKUP = 5;

interface IssueRow {
  campaignId: string;
  accountId: string;
  name: string;
  store: string;
  designer: string;
  status: FbEntityStatus;
  spend: number;
  markup: number;
  plus: number;
  /** 發票金額 = ceil(花費 × 1.05) — what the invoice is issued for. */
  invoiceAmt: number;
}

function IssueTab({ month }: { month: string }) {
  const accountsQuery = useAccounts();
  const allAccounts = accountsQuery.data ?? [];
  const visible = useAccountsStore((s) => s.visibleAccounts)(allAccounts);
  const date = useMemo(() => monthToDate(month), [month]);
  const settingsReady = useUiStore((s) => s.settingsReady);

  const overview = useMultiAccountOverview(visible, date, {
    includeArchived: true,
    source: "finance",
  });
  const rowMarkups = useFinanceStore((s) => s.rowMarkups);
  const defaultMarkup = useFinanceStore((s) => s.defaultMarkup);
  const nicknames = useNicknames();
  const draftsQuery = useEInvoiceDrafts();

  const [selectedAcct, setSelectedAcct] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [issuing, setIssuing] = useState<IssueRow | null>(null);

  const accountRows = useMemo(
    () =>
      buildAccountRows(visible, overview.insights, overview.campaigns, rowMarkups, defaultMarkup),
    [visible, overview.insights, overview.campaigns, rowMarkups, defaultMarkup],
  );

  const rows = useMemo<IssueRow[]>(() => {
    const q = search.trim().toLowerCase();
    const out: IssueRow[] = [];
    for (const c of overview.campaigns) {
      if (selectedAcct && c._accountId !== selectedAcct) continue;
      const spend = spendOf(c);
      if (spend <= 0) continue;
      const nick = nicknames.data?.[c.id];
      const store = (nick?.store ?? "").trim();
      const designer = (nick?.designer ?? "").trim();
      if (
        q &&
        !c.name.toLowerCase().includes(q) &&
        !store.toLowerCase().includes(q) &&
        !designer.toLowerCase().includes(q)
      ) {
        continue;
      }
      const markup = markupFor(c.id, rowMarkups, defaultMarkup);
      out.push({
        campaignId: c.id,
        accountId: c._accountId ?? "",
        name: c.name,
        store,
        designer,
        status: c.status,
        spend,
        markup,
        plus: spendPlus(spend, markup),
        invoiceAmt: spendPlus(spend, INVOICE_MARKUP),
      });
    }
    return out.sort((a, b) => b.plus - a.plus);
  }, [overview.campaigns, selectedAcct, rowMarkups, defaultMarkup, nicknames.data, search]);

  const money = (v: number) => `$${fM(v)}`;

  return (
    <div className="flex min-w-0 flex-1 items-stretch overflow-hidden">
      <div className="hidden md:flex">
        <FinanceAccountPanel
          rows={accountRows}
          selectedId={selectedAcct}
          onSelect={setSelectedAcct}
        />
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto px-3 pt-3 md:px-4 md:pt-4">
        <div className="mb-3 flex flex-col overflow-hidden rounded-2xl border border-border md:mb-4">
          <div className="flex shrink-0 items-center gap-2 border-border border-b bg-white px-3 py-2.5 md:px-5">
            <input
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder="搜尋活動 / 店家 / 設計師"
              className="h-9 min-w-0 flex-1 rounded-lg border-[1.5px] border-border px-3 text-[13px] outline-none focus:border-orange"
            />
          </div>

          <div className="w-full overflow-x-auto">
            {!settingsReady || overview.isLoading ? (
              <LoadingState title="載入費用中心資料中..." />
            ) : visible.length === 0 ? (
              <EmptyState>請先在設定中啟用廣告帳戶</EmptyState>
            ) : rows.length === 0 ? (
              <EmptyState>此月份沒有有花費的行銷活動</EmptyState>
            ) : (
              <table className="w-full min-w-[640px] text-[13px]">
                <thead>
                  <tr className="border-border border-b bg-bg text-left text-[11px] font-semibold text-gray-400">
                    <th className="px-3 py-2 md:px-5">No.</th>
                    <th className="px-2 py-2">狀態</th>
                    <th className="px-2 py-2">行銷活動名稱</th>
                    <th className="px-2 py-2 text-right">花費</th>
                    <th className="px-2 py-2 text-right">月%</th>
                    <th className="px-2 py-2 text-right">花費+%</th>
                    <th className="px-2 py-2 text-right">發票金額</th>
                    <th className="px-3 py-2 text-right md:px-5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.campaignId} className="border-border border-b last:border-0">
                      <td className="px-3 py-2 text-gray-400 md:px-5">{i + 1}</td>
                      <td className="px-2 py-2">
                        <Badge status={r.status} />
                      </td>
                      <td className="px-2 py-2">
                        {(() => {
                          // 跟費用中心一樣:主標顯示「店家 · 設計師」暱稱,
                          // 沒暱稱才 fallback 原始活動名;有暱稱時活動名放灰字副標。
                          const label = formatNickname({ store: r.store, designer: r.designer });
                          return (
                            <>
                              <div className="max-w-[280px] truncate font-semibold text-ink">
                                {label ?? r.name}
                              </div>
                              {label && (
                                <div className="max-w-[280px] truncate text-[11px] text-gray-400">
                                  {r.name}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-ink">
                        {money(r.spend)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-400">
                        {r.markup}%
                      </td>
                      <td className="px-2 py-2 text-right font-semibold text-orange tabular-nums">
                        {money(r.plus)}
                      </td>
                      <td className="px-2 py-2 text-right font-bold text-orange tabular-nums">
                        {money(r.invoiceAmt)}
                      </td>
                      <td className="px-3 py-2 text-right md:px-5">
                        <Button size="sm" variant="primary" onClick={() => setIssuing(r)}>
                          開立發票
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {issuing && (
        <IssueModal
          key={issuing.campaignId}
          row={issuing}
          month={month}
          draft={draftsQuery.data?.data?.[issuing.campaignId]}
          onClose={() => setIssuing(null)}
        />
      )}
    </div>
  );
}

// ── 開立發票 modal ────────────────────────────────────────────────────

function IssueModal({
  row,
  month,
  draft,
  onClose,
}: {
  row: IssueRow;
  month: string;
  draft?: EInvoiceDraft;
  onClose: () => void;
}) {
  const issue = useIssueInvoice();
  const saveDraft = useSaveEInvoiceDraft();
  // Init from the campaign's saved draft (mounted with key=campaignId so
  // this runs fresh per campaign).
  const [itemName, setItemName] = useState(draft?.item_name ?? "廣告行銷");
  const [category, setCategory] = useState<InvoiceCategory>(draft?.category ?? "B2C");
  const [buyerName, setBuyerName] = useState(draft?.buyer_name ?? "");
  const [taxId, setTaxId] = useState(draft?.tax_id ?? "");
  const [email, setEmail] = useState(draft?.email ?? "");
  const [issued, setIssued] = useState<{ number: string | null; mock: boolean } | null>(null);

  const money = (v: number) => `$${fM(v)}`;

  // Persist the entered fields per campaign on close, so this 行銷活動
  // remembers its 統編 / 抬頭 / 品項 next time.
  const closeAndSave = () => {
    const changed =
      category !== (draft?.category ?? "B2C") ||
      itemName !== (draft?.item_name ?? "廣告行銷") ||
      buyerName !== (draft?.buyer_name ?? "") ||
      taxId !== (draft?.tax_id ?? "") ||
      email !== (draft?.email ?? "");
    if (changed) {
      saveDraft.mutate({
        campaignId: row.campaignId,
        body: {
          category,
          item_name: itemName,
          buyer_name: buyerName,
          tax_id: taxId,
          email,
        },
      });
    }
    onClose();
  };

  const onIssue = async () => {
    if (category === "B2B") {
      if (!/^\d{8}$/.test(taxId.trim())) {
        toast("統編需 8 碼數字", "error");
        return;
      }
      if (!buyerName.trim()) {
        toast("請填寫公司抬頭", "error");
        return;
      }
    }
    try {
      const res = await issue.mutateAsync({
        category,
        // 發票金額 = 花費 + 5% (fixed), NOT the 月% store bill.
        total_amt: row.invoiceAmt,
        item_name: itemName.trim() || "廣告行銷",
        buyer_name: buyerName.trim(),
        tax_id: category === "B2B" ? taxId.trim() : "",
        email: email.trim(),
        store: row.store,
        account_id: row.accountId,
        campaign_id: row.campaignId,
        period: month,
        spend: Math.round(row.spend),
        // Store the 月% so 開立紀錄 can show the 花費+月% store amount
        // alongside the 發票金額.
        markup_percent: row.markup,
      });
      setIssued({ number: res.invoice_number, mock: res.mock });
      toast(res.mock ? "已開立(測試模式)" : "已開立電子發票", "success", 4000);
    } catch (e) {
      toast(`開立失敗:${friendlyApiError(e)}`, "error", 5000);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) closeAndSave();
      }}
      title="開立發票"
      subtitle={row.store || row.name}
      width={520}
    >
      <div className="mb-3 rounded-xl border border-border bg-bg px-3.5 py-2.5 text-[12px] text-gray-500">
        花費 <span className="font-semibold text-ink">{money(row.spend)}</span> · 發票金額{" "}
        <span className="font-bold text-orange">{money(row.invoiceAmt)}</span>(花費+5%,含稅)
      </div>

      {issued ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-green/40 bg-green-bg/40 px-4 py-3 text-[13px]">
            <span className="font-bold text-green">已開立</span> · 發票號碼{" "}
            <span className="font-mono font-bold">{issued.number ?? "—"}</span>
            {issued.mock && <span className="ml-2 text-[11px] text-gray-400">(測試模式)</span>}
          </div>
          <div className="flex justify-end">
            <Button variant="primary" size="sm" onClick={closeAndSave}>
              完成
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-3 flex gap-1 self-start rounded-lg border border-border bg-bg p-1">
            {(["B2C", "B2B"] as InvoiceCategory[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={cn(
                  "rounded-md px-3 py-1 text-[12px] font-semibold transition",
                  category === c ? "bg-white text-orange shadow-sm" : "text-gray-500",
                )}
              >
                {c === "B2C" ? "個人(雲端發票)" : "公司(統編)"}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            <Field label="發票項目">
              <input
                value={itemName}
                onChange={(e) => setItemName(e.currentTarget.value)}
                placeholder="廣告行銷"
                className={inputCls}
              />
            </Field>
            {category === "B2B" ? (
              <>
                <Field label="公司抬頭" required>
                  <input
                    value={buyerName}
                    onChange={(e) => setBuyerName(e.currentTarget.value)}
                    placeholder="例: 上越股份有限公司"
                    className={inputCls}
                  />
                </Field>
                <Field label="統一編號" required>
                  <input
                    value={taxId}
                    onChange={(e) => setTaxId(e.currentTarget.value)}
                    placeholder="8 碼數字"
                    inputMode="numeric"
                    maxLength={8}
                    className={inputCls}
                  />
                </Field>
                <Field label="發票寄送信箱">
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.currentTarget.value)}
                    type="email"
                    placeholder="example@mail.com"
                    className={inputCls}
                  />
                </Field>
              </>
            ) : (
              <div className="flex items-center text-[12px] text-gray-400">
                個人發票開立為雲端發票,無需填寫買方資料。
              </div>
            )}
          </div>

          <div className="mt-4 flex justify-end">
            <Button variant="primary" size="sm" onClick={onIssue} disabled={issue.isPending}>
              {issue.isPending ? "開立中..." : "開立發票"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ── 開立紀錄 tab ──────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  issued: { label: "已開立", cls: "bg-green-bg text-green" },
  void: { label: "已作廢", cls: "bg-bg text-gray-400" },
  allowance: { label: "已折讓", cls: "bg-orange-bg text-orange" },
};

function RecordsTab() {
  const q = useEInvoices();
  const rows = q.data?.data ?? [];
  const money = (v: number) => `$${fM(v)}`;
  const fmtTime = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div className="min-w-0 flex-1 overflow-y-auto px-3 pt-3 md:px-5 md:pt-4">
      <div className="mx-auto flex w-full max-w-[960px] flex-col overflow-hidden rounded-2xl border border-border">
        <div className="border-border border-b bg-white px-4 py-3 text-[13px] font-bold text-ink md:px-5">
          開立紀錄{q.data ? `（${q.data.total}）` : ""}
        </div>
        <div className="w-full overflow-x-auto bg-white">
          {q.isLoading ? (
            <LoadingState title="載入開立紀錄中..." />
          ) : q.isError ? (
            <EmptyState>載入失敗:{friendlyApiError(q.error)}(此功能僅限管理員)</EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState>尚無開立紀錄。到「開立發票」開一張後會顯示於此。</EmptyState>
          ) : (
            <table className="w-full min-w-[640px] text-[13px]">
              <thead>
                <tr className="border-border border-b bg-bg text-left text-[11px] font-semibold text-gray-400">
                  <th className="px-3 py-2 md:px-5">開立時間</th>
                  <th className="px-2 py-2">發票號碼</th>
                  <th className="px-2 py-2">買方 / 店家</th>
                  <th className="px-2 py-2">類型</th>
                  <th className="px-2 py-2 text-right">花費</th>
                  <th className="px-2 py-2 text-right">發票金額</th>
                  <th className="px-3 py-2 md:px-5">狀態</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = STATUS_LABEL[r.status] ?? {
                    label: r.status,
                    cls: "bg-bg text-gray-400",
                  };
                  return (
                    <tr key={r.id} className="border-border border-b last:border-0">
                      <td className="px-3 py-2 text-gray-500 md:px-5">{fmtTime(r.created_at)}</td>
                      <td className="px-2 py-2 font-mono text-[12px]">{r.invoice_number ?? "—"}</td>
                      <td className="px-2 py-2">
                        <div className="max-w-[240px] truncate text-ink">
                          {r.buyer_name || r.store || "—"}
                        </div>
                        {r.buyer_tax_id && (
                          <div className="text-[11px] text-gray-400">統編 {r.buyer_tax_id}</div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-gray-500">{r.category}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-ink">
                        {r.spend != null ? money(r.spend) : "—"}
                      </td>
                      <td className="px-2 py-2 text-right font-bold tabular-nums text-orange">
                        {money(r.total_amt)}
                      </td>
                      <td className="px-3 py-2 md:px-5">
                        <span
                          className={cn(
                            "rounded-full px-2 py-[2px] text-[11px] font-semibold",
                            st.cls,
                          )}
                        >
                          {st.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "h-10 w-full min-w-0 rounded-lg border-[1.5px] border-border bg-white px-3 text-[13px] outline-none focus:border-orange disabled:bg-bg disabled:text-gray-300 md:h-9";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the form control is passed in as `children`
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold text-gray-500">
        {label}
        {required && <span className="text-orange"> *</span>}
      </span>
      {children}
    </label>
  );
}
