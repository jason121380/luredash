import { useAccounts } from "@/api/hooks/useAccounts";
import { useBillingUsage } from "@/api/hooks/useSubscription";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { GraceBanner } from "@/components/GraceBanner";
import { Loading } from "@/components/Loading";
import { toast } from "@/components/Toast";
import { UpgradeModal, type UpgradeModalState } from "@/components/UpgradeModal";
import { Topbar } from "@/layout/Topbar";
import { accountStatusColor, accountStatusLabel } from "@/lib/accountStatus";
import { cn } from "@/lib/cn";
import { queryClient } from "@/lib/queryClient";
import { useAccountsStore } from "@/stores/accountsStore";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  countChecked,
  groupAccountsByBusiness,
  reorderByDrop,
  sortAccountsByOrder,
} from "./settingsData";

/**
 * Settings view — 260px BM panel on the left, accounts panel on
 * the right with multi-select checkboxes + drag-to-reorder.
 *
 * Drag-sort uses native HTML5 drag events (same as the legacy code).
 * Reordering writes to accountsStore.order; checkboxes write to
 * accountsStore.selectedIds on save. Ephemeral "pending" state is
 * kept in component state (`pendingChecked`) and only committed to
 * the store when the user clicks 儲存.
 *
 * Ported from the original design lines 2296–2415.
 */
export function SettingsView() {
  const navigate = useNavigate();
  const accountsQuery = useAccounts();
  const allAccounts = accountsQuery.data ?? [];
  const savedSelectedIds = useAccountsStore((s) => s.selectedIds);
  const setSelectedIds = useAccountsStore((s) => s.setSelectedIds);
  const order = useAccountsStore((s) => s.order);
  const setOrder = useAccountsStore((s) => s.setOrder);

  const groups = useMemo(() => groupAccountsByBusiness(allAccounts), [allAccounts]);
  const [activeBmKey, setActiveBmKey] = useState<string | null>(null);
  const [pendingChecked, setPendingChecked] = useState<Set<string>>(
    () => new Set(savedSelectedIds),
  );
  const [search, setSearch] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Auto-select the first BM group when the list loads and nothing
  // is selected yet — same pattern as Dashboard's auto-select.
  // Without this, a first-time user redirected from
  // EmptyAccountsPrompt sees the empty "點選企業管理平台" state
  // and has to manually click a BM group before they can check any
  // accounts.
  useEffect(() => {
    if (activeBmKey !== null) return;
    if (groups.length === 0) return;
    const first = groups[0];
    if (first) setActiveBmKey(first.key);
  }, [activeBmKey, groups]);

  const activeGroup = groups.find((g) => g.key === activeBmKey) ?? null;

  const visibleInGroup = useMemo(() => {
    if (!activeGroup) return [];
    const q = search.trim().toLowerCase();
    const filtered = activeGroup.accounts.filter(
      (a) => !q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q),
    );
    return sortAccountsByOrder(filtered, order);
  }, [activeGroup, order, search]);

  const toggleCheck = (id: string) => {
    setPendingChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllInGroup = (checked: boolean) => {
    if (!activeGroup) return;
    setPendingChecked((prev) => {
      const next = new Set(prev);
      for (const a of activeGroup.accounts) {
        if (checked) next.add(a.id);
        else next.delete(a.id);
      }
      return next;
    });
  };

  const usageQuery = useBillingUsage();
  const adCap = usageQuery.data?.limits.ad_accounts ?? -1;
  const isUnlimited = adCap < 0 || adCap >= 999_000;
  const [upgradeState, setUpgradeState] = useState<UpgradeModalState | null>(null);

  const save = () => {
    if (!isUnlimited && pendingChecked.size > adCap) {
      setUpgradeState({
        resource: "ad_accounts",
        tier: usageQuery.data?.tier ?? "free",
        limit: adCap,
      });
      return;
    }
    setSelectedIds([...pendingChecked]);
    // Drop cached overview/insights data so the destination view
    // remounts into its LoadingState instead of flashing stale numbers
    // keyed by the previous account set.
    queryClient.removeQueries({ queryKey: ["overview"] });
    queryClient.removeQueries({ queryKey: ["overview-lite"] });
    toast("儲存成功");
    navigate("/dashboard");
  };

  // ── Drag handlers ─────────────────────────────────────────
  const onDragStart = (id: string) => setDraggingId(id);
  const onDragEnd = () => setDraggingId(null);
  const onDrop = (targetId: string) => {
    if (!draggingId) return;
    const currentIds = visibleInGroup.map((a) => a.id);
    const movingIdx = currentIds.indexOf(draggingId);
    const targetIdx = currentIds.indexOf(targetId);
    if (movingIdx < 0 || targetIdx < 0) return;
    const reordered = reorderByDrop(
      // Seed the base order with the currently displayed ids so drops
      // within an unordered group get a deterministic start.
      order.length === 0 ? currentIds : order,
      draggingId,
      targetId,
    );
    setOrder(reordered);
    setDraggingId(null);
  };

  const pendingCount = pendingChecked.size;
  const totalCount = allAccounts.length;

  return (
    <>
      <Topbar title="廣告帳號設定">
        <div className="flex items-center gap-2 md:gap-3">
          <span
            className={cn(
              "hidden text-xs md:inline",
              !isUnlimited && pendingCount > adCap ? "font-semibold text-orange" : "text-gray-500",
            )}
          >
            {isUnlimited
              ? `已選 ${pendingCount} / ${totalCount} 個帳戶`
              : `已選 ${pendingCount} / 上限 ${adCap}`}
          </span>
          <Button variant="primary" size="sm" onClick={save}>
            儲存
          </Button>
        </div>
      </Topbar>
      <UpgradeModal state={upgradeState} onClose={() => setUpgradeState(null)} />

      <GraceBanner usage={usageQuery.data} resource="ad_accounts" className="mx-3 mt-3 md:mx-5 md:mt-4" />

      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* Left: BM panel — full-width horizontal scroll on mobile,
            260px sidebar on desktop */}
        <aside className="flex shrink-0 flex-col border-b border-border bg-white md:w-[260px] md:border-b-0 md:border-r">
          <div className="hidden border-b border-border px-4 py-3.5 text-[13px] font-bold text-ink md:block">
            企業管理平台
          </div>
          <div className="flex flex-row gap-2 overflow-x-auto px-3 py-2 md:flex-1 md:flex-col md:gap-0 md:overflow-y-auto md:px-0 md:py-0">
            {accountsQuery.isLoading ? (
              <Loading>載入中</Loading>
            ) : groups.length === 0 ? (
              <div className="px-4 py-4 text-[13px] text-gray-300">無廣告帳戶</div>
            ) : (
              groups.map((g) => {
                const active = g.key === activeBmKey;
                const checked = countChecked(g, pendingChecked);
                return (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => setActiveBmKey(g.key)}
                    // Desktop: no left-edge orange indicator, no bottom
                    // divider — active state is a pure background fill.
                    // Mobile keeps the rounded-chip outline for
                    // horizontal scrolling clarity.
                    className={cn(
                      "flex shrink-0 cursor-pointer items-center justify-between gap-2 rounded-xl border-[1.5px] border-border px-3 py-2 text-left active:scale-[0.98] md:w-full md:rounded-none md:border-0 md:px-4 md:py-3",
                      active ? "border-orange bg-orange-bg" : "hover:bg-orange-bg",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-ink">{g.name}</div>
                      <div className="mt-0.5 text-[11px] text-gray-500">
                        {g.accounts.length} 個帳號
                      </div>
                    </div>
                    {checked > 0 && (
                      <span className="shrink-0 rounded-full bg-orange px-1.5 py-[1px] text-[11px] font-semibold text-white">
                        {checked}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Right: accounts panel */}
        <div className="flex min-h-0 flex-1 flex-col bg-bg">
          <div className="flex flex-col gap-2 border-b border-border bg-white px-3 py-2.5 md:px-4 md:py-3">
            <div className="flex items-center gap-2">
              <div className="flex-1 truncate text-sm font-bold text-ink">
                {activeGroup?.name ?? "選擇企業管理平台"}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => selectAllInGroup(true)}
                className="px-2.5 text-[11px]"
              >
                全選
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => selectAllInGroup(false)}
                className="px-2.5 text-[11px]"
              >
                全消
              </Button>
            </div>
            <input
              placeholder="搜尋廣告帳號..."
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              className="h-10 w-full rounded-lg border border-border px-3 text-[13px] outline-none focus:border-orange md:h-[30px] md:px-2.5 md:text-xs"
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {!activeGroup ? (
              <EmptyState>點選企業管理平台</EmptyState>
            ) : visibleInGroup.length === 0 ? (
              <EmptyState>無符合條件的廣告帳號</EmptyState>
            ) : (
              visibleInGroup.map((acc) => {
                const isChecked = pendingChecked.has(acc.id);
                const color = accountStatusColor(acc.account_status);
                const isDragging = draggingId === acc.id;
                return (
                  <div
                    key={acc.id}
                    data-acct-id={acc.id}
                    draggable
                    onDragStart={() => onDragStart(acc.id)}
                    onDragEnd={onDragEnd}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      onDrop(acc.id);
                    }}
                    className={cn(
                      "flex min-h-[56px] cursor-pointer items-center gap-3 border-b border-border bg-white px-4 py-2.5 active:bg-orange-bg hover:bg-orange-bg",
                      isDragging && "opacity-40",
                    )}
                    onClick={() => toggleCheck(acc.id)}
                  >
                    <span
                      className="hidden shrink-0 cursor-grab px-1 text-sm text-gray-300 md:inline"
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      ⠿
                    </span>
                    <input
                      type="checkbox"
                      className="custom-cb"
                      checked={isChecked}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleCheck(acc.id)}
                      aria-label={`toggle ${acc.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium md:text-[13px]">
                        {acc.name}
                      </div>
                      <div className="text-[11px] text-gray-300">{acc.id}</div>
                    </div>
                    <span
                      className="shrink-0 rounded-full px-2 py-[2px] text-[11px] font-semibold"
                      style={{
                        background: `var(--${color}-bg)`,
                        color: `var(--${color})`,
                      }}
                    >
                      {accountStatusLabel(acc.account_status)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </>
  );
}
