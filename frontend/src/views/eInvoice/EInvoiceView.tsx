import type { InvoiceBuyer, InvoiceBuyerInput, InvoiceCategory } from "@/api/client";
import { friendlyApiError } from "@/api/client";
import {
  useDeleteInvoiceBuyer,
  useInvoiceBuyers,
  useUpsertInvoiceBuyer,
} from "@/api/hooks/useEInvoice";
import { useNicknames } from "@/api/hooks/useNicknames";
import { Button } from "@/components/Button";
import { confirm } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { toast } from "@/components/Toast";
import { Topbar } from "@/layout/Topbar";
import { cn } from "@/lib/cn";
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
  const [tab, setTab] = useState<Tab>("buyers");

  return (
    <>
      <Topbar title="電子發票" />
      <div className="min-w-0 flex-1 overflow-y-auto bg-bg px-3 py-3 md:px-5 md:py-5">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
          {/* Tab bar */}
          <div className="flex gap-1 self-start rounded-xl border border-border bg-white p-1">
            <TabButton active={tab === "buyers"} onClick={() => setTab("buyers")}>
              買方資料
            </TabButton>
            <TabButton active={tab === "issue"} onClick={() => setTab("issue")}>
              開立發票
            </TabButton>
            <TabButton active={tab === "records"} onClick={() => setTab("records")}>
              發票紀錄
            </TabButton>
          </div>

          {tab === "buyers" && <BuyersTab />}
          {tab === "issue" && <ComingSoon title="開立發票" phase="階段 2-3" />}
          {tab === "records" && <ComingSoon title="發票紀錄" phase="階段 4-5" />}
        </div>
      </div>
    </>
  );
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
        「{title}」功能將於 {phase} 開放。請先於「買方資料」建立各店家的開票資料。
      </EmptyState>
    </section>
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
