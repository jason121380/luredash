import type { InvoiceBuyer, InvoiceBuyerInput, InvoiceCategory } from "@/api/client";
import { friendlyApiError } from "@/api/client";
import { useAccounts } from "@/api/hooks/useAccounts";
import {
  useDeleteInvoiceBuyer,
  useInvoiceBuyers,
  useIssueInvoice,
  useUpsertInvoiceBuyer,
} from "@/api/hooks/useEInvoice";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import { useNicknames } from "@/api/hooks/useNicknames";
import { Button } from "@/components/Button";
import { confirm } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { toast } from "@/components/Toast";
import { Topbar } from "@/layout/Topbar";
import { cn } from "@/lib/cn";
import type { DateConfig } from "@/lib/datePicker";
import { fM } from "@/lib/format";
import { spendOf } from "@/lib/insights";
import { useAccountsStore } from "@/stores/accountsStore";
import { useFinanceStore } from "@/stores/financeStore";
import { markupFor, spendPlus } from "@/views/finance/financeData";
import { useMemo, useState } from "react";

/**
 * 電子發票 (ezPay 藍新).
 *
 * Phase 1 ships the 買方資料 tab — per-store buyer identity (統編 / 載具 /
 * 捐贈碼) that later phases' 開立發票 form prefills from. The 開立發票 and
 * 發票紀錄 tabs are placeholders until Phases 2-5 land. The whole page is
 * 頁面權限-gated and the buyer APIs are admin-gated server-side.
 */

type Tab = "buyers" | "issue" | "records";

const EMPTY_DRAFT: InvoiceBuyerInput = {
  category: "B2C",
  buyer_name: "",
  tax_id: "",
  email: "",
  carrier_type: "",
  carrier_num: "",
  love_code: "",
  print_flag: "N",
  address: "",
  notes: "",
};

const CARRIER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "無載具(索取紙本 / 雲端發票)" },
  { value: "0", label: "手機條碼載具" },
  { value: "1", label: "自然人憑證載具" },
  { value: "2", label: "ezPay 會員載具" },
];

export function EInvoiceView() {
  const [tab, setTab] = useState<Tab>("issue");
  // Month selection (right of the topbar) — drives which month's 費用中心
  // numbers the 開立發票 tab reads. Defaults to the current month.
  const [month, setMonth] = useState<string>(currentMonth);

  return (
    <>
      <Topbar title="電子發票">
        {tab === "issue" && (
          <select
            value={month}
            onChange={(e) => setMonth(e.currentTarget.value)}
            aria-label="選擇月份"
            className="h-10 rounded-lg border border-border bg-white px-2.5 text-[13px] outline-none focus:border-orange md:h-[30px]"
          >
            {MONTH_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </Topbar>
      <div className="min-w-0 flex-1 overflow-y-auto bg-bg px-3 py-3 md:px-5 md:py-5">
        <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
          {/* Tab bar */}
          <div className="flex gap-1 self-start rounded-xl border border-border bg-white p-1">
            <TabButton active={tab === "issue"} onClick={() => setTab("issue")}>
              開立發票
            </TabButton>
            <TabButton active={tab === "buyers"} onClick={() => setTab("buyers")}>
              買方資料
            </TabButton>
            <TabButton active={tab === "records"} onClick={() => setTab("records")}>
              發票紀錄
            </TabButton>
          </div>

          {tab === "issue" && <IssueTab month={month} />}
          {tab === "buyers" && <BuyersTab />}
          {tab === "records" && <ComingSoon title="發票紀錄" phase="階段 4-5" />}
        </div>
      </div>
    </>
  );
}

// ── Month helpers ─────────────────────────────────────────────────────

/** "YYYY-MM" for today. */
const currentMonth = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
})();

/** Last 12 months as {value:"YYYY-MM", label:"2026 年 7 月"} options. */
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
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const last = new Date(y as number, m as number, 0).getDate(); // day 0 of next month = last day
  const to = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { preset: "custom", from, to };
}

function TabButton({
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
        "rounded-lg px-3.5 py-1.5 text-[13px] font-semibold transition",
        active ? "bg-orange text-white" : "text-gray-500 hover:bg-bg hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function ComingSoon({ title, phase }: { title: string; phase: string }) {
  return (
    <section className="rounded-2xl border border-border bg-white">
      <EmptyState>
        「{title}」功能將於 {phase} 開放。
      </EmptyState>
    </section>
  );
}

// ── 開立發票 tab ──────────────────────────────────────────────────────

interface IssueRow {
  campaignId: string;
  accountId: string;
  name: string;
  store: string;
  designer: string;
  spend: number;
  markup: number;
  plus: number;
}

function IssueTab({ month }: { month: string }) {
  const accountsQuery = useAccounts();
  const allAccounts = accountsQuery.data ?? [];
  const visible = useAccountsStore((s) => s.visibleAccounts)(allAccounts);
  const date = useMemo(() => monthToDate(month), [month]);

  const overview = useMultiAccountOverview(visible, date, {
    includeArchived: true,
    source: "finance",
  });
  const rowMarkups = useFinanceStore((s) => s.rowMarkups);
  const defaultMarkup = useFinanceStore((s) => s.defaultMarkup);
  const nicknames = useNicknames();
  const buyersQuery = useInvoiceBuyers();
  const issue = useIssueInvoice();

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Issue form fields.
  const [itemName, setItemName] = useState("廣告行銷");
  const [category, setCategory] = useState<InvoiceCategory>("B2C");
  const [buyerName, setBuyerName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [email, setEmail] = useState("");
  const [issued, setIssued] = useState<{ number: string | null; mock: boolean } | null>(null);

  // Build rows straight from the 費用中心 numbers — same spend/markup/
  // spend+% the finance table shows (no separate fetch). Only campaigns
  // that actually spent this month can be invoiced.
  const rows = useMemo<IssueRow[]>(() => {
    const out: IssueRow[] = [];
    for (const c of overview.campaigns) {
      const spend = spendOf(c);
      if (spend <= 0) continue;
      const markup = markupFor(c.id, rowMarkups, defaultMarkup);
      const nick = nicknames.data?.[c.id];
      out.push({
        campaignId: c.id,
        accountId: c._accountId ?? "",
        name: c.name,
        store: (nick?.store ?? "").trim(),
        designer: (nick?.designer ?? "").trim(),
        spend,
        markup,
        plus: spendPlus(spend, markup),
      });
    }
    const q = search.trim().toLowerCase();
    const filtered = q
      ? out.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.store.toLowerCase().includes(q) ||
            r.designer.toLowerCase().includes(q),
        )
      : out;
    return filtered.sort((a, b) => b.plus - a.plus);
  }, [overview.campaigns, rowMarkups, defaultMarkup, nicknames.data, search]);

  const selected = rows.find((r) => r.campaignId === selectedId) ?? null;

  // When a campaign is picked, prefill buyer info from the store's saved
  // 買方資料 profile (if any) so B2B 統編/抬頭 don't get retyped monthly.
  const selectRow = (r: IssueRow) => {
    setSelectedId(r.campaignId);
    setIssued(null);
    const profile = buyersQuery.data?.find((b) => b.store === r.store);
    if (profile) {
      setCategory(profile.category);
      setBuyerName(profile.buyer_name);
      setTaxId(profile.tax_id);
      setEmail(profile.email);
    } else {
      setCategory("B2C");
      setBuyerName("");
      setTaxId("");
      setEmail("");
    }
  };

  const onIssue = async () => {
    if (!selected) return;
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
        total_amt: selected.plus,
        item_name: itemName.trim() || "廣告行銷",
        buyer_name: buyerName.trim(),
        tax_id: category === "B2B" ? taxId.trim() : "",
        email: email.trim(),
        store: selected.store,
        account_id: selected.accountId,
        campaign_id: selected.campaignId,
        period: month,
        spend: Math.round(selected.spend),
        markup_percent: selected.markup,
      });
      setIssued({ number: res.invoice_number, mock: res.mock });
      toast(res.mock ? "已開立(測試模式)" : "已開立電子發票", "success", 4000);
    } catch (e) {
      toast(`開立失敗:${friendlyApiError(e)}`, "error", 5000);
    }
  };

  const money = (v: number) => `$${fM(v)}`;

  return (
    <div className="flex flex-col gap-4">
      {/* Campaign picker — reuses 費用中心 花費 / % / 花費+% */}
      <section className="flex flex-col overflow-hidden rounded-2xl border border-border bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 md:px-5">
          <div className="text-[13px] font-bold text-ink">選擇行銷活動</div>
          <input
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="搜尋活動 / 店家 / 設計師"
            className="h-9 min-w-0 flex-1 rounded-lg border-[1.5px] border-border px-3 text-[13px] outline-none focus:border-orange"
          />
        </div>
        {overview.isLoading ? (
          <LoadingState title="載入費用中心資料中..." />
        ) : rows.length === 0 ? (
          <EmptyState>此月份沒有有花費的行銷活動</EmptyState>
        ) : (
          <div className="max-h-[340px] overflow-y-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-bg">
                <tr className="text-left text-[11px] font-semibold text-gray-400">
                  <th className="px-4 py-2 md:px-5">活動 / 店家</th>
                  <th className="px-2 py-2 text-right">花費</th>
                  <th className="px-2 py-2 text-right">%</th>
                  <th className="px-4 py-2 text-right md:px-5">花費+%</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.campaignId}
                    onClick={() => selectRow(r)}
                    className={cn(
                      "cursor-pointer border-border border-t transition hover:bg-orange-bg/40",
                      selectedId === r.campaignId && "bg-orange-bg/60",
                    )}
                  >
                    <td className="px-4 py-2 md:px-5">
                      <div className="truncate font-semibold text-ink">{r.store || r.name}</div>
                      <div className="truncate text-[11px] text-gray-400">
                        {r.store ? r.name : r.designer || "—"}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-gray-500">
                      {money(r.spend)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-gray-400">{r.markup}%</td>
                    <td className="px-4 py-2 text-right font-bold text-orange tabular-nums md:px-5">
                      {money(r.plus)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Issue form for the selected campaign */}
      {selected && (
        <section className="rounded-2xl border border-border bg-white p-4 md:p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-[13px] font-bold text-ink">
              開立:{selected.store || selected.name}
            </div>
            <div className="text-[12px] text-gray-500">
              花費 {money(selected.spend)} · {selected.markup}% ·{" "}
              <span className="font-bold text-orange">發票金額 {money(selected.plus)}</span>
              (含稅)
            </div>
          </div>

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
              <div className="flex items-end text-[12px] text-gray-400 md:col-span-1">
                個人發票開立為雲端發票,無需填寫買方資料。
              </div>
            )}
          </div>

          {issued ? (
            <div className="mt-3 rounded-xl border border-green/40 bg-green-bg/40 px-4 py-3 text-[13px]">
              <span className="font-bold text-green">已開立</span> · 發票號碼{" "}
              <span className="font-mono font-bold">{issued.number ?? "—"}</span>
              {issued.mock && <span className="ml-2 text-[11px] text-gray-400">(測試模式)</span>}
            </div>
          ) : (
            <div className="mt-3 flex justify-end">
              <Button variant="primary" size="sm" onClick={onIssue} disabled={issue.isPending}>
                {issue.isPending ? "開立中..." : "開立發票"}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ── 買方資料 tab ──────────────────────────────────────────────────────

function BuyersTab() {
  const buyersQuery = useInvoiceBuyers();
  const upsert = useUpsertInvoiceBuyer();
  const del = useDeleteInvoiceBuyer();
  const nicknames = useNicknames();

  // Distinct store labels from campaign nicknames — the datalist of
  // known stores so the operator picks a real 店家 name (matching 店家花費).
  const storeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const n of Object.values(nicknames.data ?? {})) {
      const s = n.store.trim();
      if (s) set.add(s);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }, [nicknames.data]);

  // `editing` = the store name currently loaded into the form (null =
  // a fresh add). `store` is the editable key field.
  const [editing, setEditing] = useState<string | null>(null);
  const [store, setStore] = useState("");
  const [draft, setDraft] = useState<InvoiceBuyerInput>(EMPTY_DRAFT);

  const resetForm = () => {
    setEditing(null);
    setStore("");
    setDraft(EMPTY_DRAFT);
  };

  const loadForEdit = (b: InvoiceBuyer) => {
    setEditing(b.store);
    setStore(b.store);
    setDraft({
      category: b.category,
      buyer_name: b.buyer_name,
      tax_id: b.tax_id,
      email: b.email,
      carrier_type: b.carrier_type,
      carrier_num: b.carrier_num,
      love_code: b.love_code,
      print_flag: b.print_flag,
      address: b.address,
      notes: b.notes,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const onSave = async () => {
    const storeKey = store.trim();
    if (!storeKey) {
      toast("請填寫店家名稱", "error");
      return;
    }
    if (!draft.buyer_name.trim()) {
      toast("請填寫買方抬頭 / 姓名", "error");
      return;
    }
    if (draft.category === "B2B" && !/^\d{8}$/.test(draft.tax_id.trim())) {
      toast("B2B 需填寫 8 碼統一編號", "error");
      return;
    }
    if (draft.category === "B2C" && draft.carrier_num.trim() && draft.love_code.trim()) {
      toast("載具號碼與捐贈碼只能擇一", "error");
      return;
    }
    try {
      await upsert.mutateAsync({ store: storeKey, body: draft });
      toast(editing ? "已更新買方資料" : "已新增買方資料", "success");
      resetForm();
    } catch (e) {
      toast(`儲存失敗:${friendlyApiError(e)}`, "error", 4500);
    }
  };

  const onDelete = async (b: InvoiceBuyer) => {
    const ok = await confirm(`確定要刪除「${b.store}」的買方資料？`);
    if (!ok) return;
    try {
      await del.mutateAsync(b.store);
      if (editing === b.store) resetForm();
      toast("已刪除", "success");
    } catch (e) {
      toast(`刪除失敗:${friendlyApiError(e)}`, "error", 4500);
    }
  };

  const buyers = buyersQuery.data ?? [];
  const isB2B = draft.category === "B2B";

  return (
    <div className="flex flex-col gap-4">
      {/* Add / edit form */}
      <section className="rounded-2xl border border-border bg-white p-4 md:p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[13px] font-bold text-ink">
            {editing ? `編輯買方:${editing}` : "新增買方"}
          </div>
          {editing && (
            <Button variant="ghost" size="sm" onClick={resetForm}>
              取消編輯
            </Button>
          )}
        </div>

        {/* Category toggle */}
        <div className="mb-3 flex gap-1 self-start rounded-lg border border-border bg-bg p-1">
          {(["B2C", "B2B"] as InvoiceCategory[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setDraft((d) => ({ ...d, category: c }))}
              className={cn(
                "rounded-md px-3 py-1 text-[12px] font-semibold transition",
                draft.category === c ? "bg-white text-orange shadow-sm" : "text-gray-500",
              )}
            >
              {c === "B2C" ? "B2C 個人" : "B2B 公司(統編)"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          <Field label="店家名稱" required>
            <input
              value={store}
              onChange={(e) => setStore(e.currentTarget.value)}
              placeholder="對應店家花費的店家"
              list="einv-store-options"
              disabled={!!editing}
              className={inputCls}
            />
            <datalist id="einv-store-options">
              {storeOptions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>

          <Field label={isB2B ? "公司抬頭" : "買方姓名"} required>
            <input
              value={draft.buyer_name}
              onChange={(e) => setDraft((d) => ({ ...d, buyer_name: e.currentTarget.value }))}
              placeholder={isB2B ? "例: 上越股份有限公司" : "例: 王小明"}
              className={inputCls}
            />
          </Field>

          {isB2B && (
            <Field label="統一編號" required>
              <input
                value={draft.tax_id}
                onChange={(e) => setDraft((d) => ({ ...d, tax_id: e.currentTarget.value }))}
                placeholder="8 碼數字"
                inputMode="numeric"
                maxLength={8}
                className={inputCls}
              />
            </Field>
          )}

          <Field label="發票寄送信箱">
            <input
              value={draft.email}
              onChange={(e) => setDraft((d) => ({ ...d, email: e.currentTarget.value }))}
              placeholder="example@mail.com"
              type="email"
              className={inputCls}
            />
          </Field>

          {!isB2B && (
            <>
              <Field label="載具類型">
                <select
                  value={draft.carrier_type}
                  onChange={(e) => setDraft((d) => ({ ...d, carrier_type: e.currentTarget.value }))}
                  className={inputCls}
                >
                  {CARRIER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="載具號碼">
                <input
                  value={draft.carrier_num}
                  onChange={(e) => setDraft((d) => ({ ...d, carrier_num: e.currentTarget.value }))}
                  placeholder="手機條碼 / 憑證號碼"
                  disabled={!!draft.love_code.trim()}
                  className={inputCls}
                />
              </Field>
              <Field label="捐贈碼(愛心碼)">
                <input
                  value={draft.love_code}
                  onChange={(e) => setDraft((d) => ({ ...d, love_code: e.currentTarget.value }))}
                  placeholder="與載具擇一;捐贈時填"
                  disabled={!!draft.carrier_num.trim()}
                  className={inputCls}
                />
              </Field>
            </>
          )}

          <Field label="地址">
            <input
              value={draft.address}
              onChange={(e) => setDraft((d) => ({ ...d, address: e.currentTarget.value }))}
              className={inputCls}
            />
          </Field>
          <Field label="備註">
            <input
              value={draft.notes}
              onChange={(e) => setDraft((d) => ({ ...d, notes: e.currentTarget.value }))}
              className={inputCls}
            />
          </Field>
        </div>

        {isB2B && (
          <div className="mt-2 text-[11px] text-gray-300">B2B 三聯式一律開立紙本電子發票。</div>
        )}

        <div className="mt-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={onSave} disabled={upsert.isPending}>
            {upsert.isPending ? "儲存中..." : editing ? "更新" : "新增"}
          </Button>
        </div>
      </section>

      {/* Existing buyers */}
      <section className="rounded-2xl border border-border bg-white">
        <div className="border-b border-border px-4 py-3 text-[13px] font-bold text-ink md:px-5">
          已建立的買方（{buyers.length}）
        </div>
        {buyersQuery.isLoading ? (
          <LoadingState title="載入買方資料中..." />
        ) : buyersQuery.isError ? (
          <EmptyState>載入失敗:{friendlyApiError(buyersQuery.error)}(此功能僅限管理員)</EmptyState>
        ) : buyers.length === 0 ? (
          <EmptyState>尚未建立任何買方資料</EmptyState>
        ) : (
          <div className="flex flex-col">
            {buyers.map((b) => (
              <BuyerRow
                key={b.store}
                buyer={b}
                onEdit={() => loadForEdit(b)}
                onDelete={() => onDelete(b)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function BuyerRow({
  buyer,
  onEdit,
  onDelete,
}: {
  buyer: InvoiceBuyer;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const detail =
    buyer.category === "B2B"
      ? `統編 ${buyer.tax_id || "—"}`
      : buyer.love_code
        ? `捐贈碼 ${buyer.love_code}`
        : buyer.carrier_num
          ? `載具 ${buyer.carrier_num}`
          : "紙本 / 雲端發票";
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 last:border-b-0 md:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-bold text-ink">{buyer.store}</span>
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-[1px] text-[10px] font-semibold",
              buyer.category === "B2B" ? "bg-orange-bg text-orange" : "bg-bg text-gray-500",
            )}
          >
            {buyer.category}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-gray-500">
          {buyer.buyer_name || "—"} · {detail}
          {buyer.email ? ` · ${buyer.email}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onEdit}
          className="rounded border border-border px-2 py-0.5 text-[11px] text-gray-500 hover:border-orange hover:text-orange"
        >
          編輯
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded border border-border px-2 py-0.5 text-[11px] text-red hover:border-red hover:bg-red-bg"
        >
          刪除
        </button>
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
