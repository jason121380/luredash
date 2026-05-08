import type { LinePushConfig, LinePushDateRange } from "@/api/client";
import { useAccounts } from "@/api/hooks/useAccounts";
import {
  useDeleteLinePushConfig,
  useLineGroupPushConfigs,
  useLineGroups,
  useTestLinePush,
} from "@/api/hooks/useLinePush";
import { useBillingUsage } from "@/api/hooks/useSubscription";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { confirm } from "@/components/ConfirmDialog";
import { GraceBanner } from "@/components/GraceBanner";
import { toast } from "@/components/Toast";
import { UpgradeModal, type UpgradeModalState } from "@/components/UpgradeModal";
import { cn } from "@/lib/cn";
import { useMemo, useState } from "react";
import { GroupPushConfigModal } from "./GroupPushConfigModal";

type EditTarget = {
  groupId: string;
  groupDisplayName: string;
  editing: LinePushConfig | null;
} | null;

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

const DATE_RANGE_LABELS: Record<LinePushDateRange, string> = {
  yesterday: "昨日",
  last_7d: "過去 7 天",
  last_14d: "過去 14 天",
  last_30d: "過去 30 天",
  this_month: "本月",
  month_to_yesterday: "本月1日-昨日",
  custom: "自訂區間",
};

function formatDateRangeLabel(cfg: LinePushConfig): string {
  if (cfg.date_range === "custom" && cfg.date_from && cfg.date_to) {
    // ISO YYYY-MM-DD → M/D - M/D for compact display
    const f = (s: string) => {
      const [, m, d] = s.split("-");
      return `${Number.parseInt(m ?? "0", 10)}/${Number.parseInt(d ?? "0", 10)}`;
    };
    return `${f(cfg.date_from)}-${f(cfg.date_to)}`;
  }
  return DATE_RANGE_LABELS[cfg.date_range] ?? cfg.date_range;
}

function formatPushRule(cfg: LinePushConfig): string {
  const time = `${String(cfg.hour).padStart(2, "0")}:${String(cfg.minute).padStart(2, "0")}`;
  if (cfg.frequency === "daily") return `每日 ${time}`;
  if (cfg.frequency === "weekly" || cfg.frequency === "biweekly") {
    const prefix = cfg.frequency === "biweekly" ? "雙週" : "";
    const days = (cfg.weekdays ?? []).map((d) => `週${WEEKDAY_LABELS[d] ?? "?"}`).join("、");
    const fallback = cfg.frequency === "biweekly" ? "" : "每週";
    return `${prefix}${days || fallback} ${time}`;
  }
  return `每月 ${cfg.month_day ?? 1} 日 ${time}`;
}

interface LineGroup {
  group_id: string;
  group_name: string;
  label: string;
  channel_id: string | null;
  channel_name: string;
  channel_owner_fb_user_id: string | null;
  is_owner: boolean;
  is_shared: boolean;
  joined_at: string | null;
  left_at: string | null;
}

/**
 * Shared list UI for LINE groups the bot has joined. Standalone page
 * is `LinePushSettingsView`; that view's Topbar refresh button calls
 * `/api/line-groups/refresh-all` to bulk-update group names from
 * LINE and drop any whose membership ended.
 *
 * Two-column table:
 *   群組(LINE 顯示名 + ID) | 已設定的推播
 *
 * Top-of-page search filters by group_name / group_id.
 */
export function LineGroupsContent() {
  const groupsQuery = useLineGroups();
  const groups = groupsQuery.data ?? [];
  const { user } = useFbAuth();
  const currentUserId = user?.id ?? "";
  // Set of account IDs the current FB user has Marketing API access to.
  // `useAccounts()` calls /me/adaccounts which FB itself filters by the
  // user's permissions, so this is the authoritative "what they can see".
  // We use it to hide push configs that target accounts outside the
  // current user's reach — matches the principle of "看不到的帳戶,
  // 不該看到它的推播". Backend-side gating is still needed for hard
  // security but this kills the visibility leak.
  const accountsQuery = useAccounts();
  const accessibleAccountIds = useMemo(
    () => new Set((accountsQuery.data ?? []).map((a) => a.id)),
    [accountsQuery.data],
  );
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<"channel" | "group" | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const usageQuery = useBillingUsage();
  const groupCap = usageQuery.data?.limits.line_groups ?? -1;
  const groupsUsed = usageQuery.data?.usage.line_groups ?? 0;
  const isUnlimited = groupCap < 0 || groupCap >= 999_000;
  // Tier limit only applies when the user owns at least one channel.
  // Shared OAs count against the OWNER's tier (not the caller's), so
  // a grantee viewing only shared groups should never see「已達上限」
  // — that limit is irrelevant for them.
  const ownedGroupsCount = (groups as LineGroup[]).filter((g) => g.is_owner).length;
  const sharedGroupsCount = (groups as LineGroup[]).filter((g) => g.is_shared).length;
  const showLimitBadge = !isUnlimited && ownedGroupsCount > 0;
  const atLimit = showLimitBadge && groupsUsed >= groupCap;
  const [upgradeState, setUpgradeState] = useState<UpgradeModalState | null>(null);

  const tryAddPush = (target: NonNullable<EditTarget>) => {
    // Only enforce caller's tier on rows under their OWN channels.
    // For shared OAs the limit lives on the owner's tier — backend
    // will 403 if owner is over THEIR cap, with a friendly message.
    const targetGroup = (groups as LineGroup[]).find((g) => g.group_id === target.groupId);
    const isCallerOwnedTarget = targetGroup?.is_owner ?? false;
    if (isCallerOwnedTarget && atLimit) {
      setUpgradeState({
        resource: "line_groups",
        tier: usageQuery.data?.tier ?? "free",
        limit: groupCap,
      });
      return;
    }
    setEditTarget(target);
  };

  const onSort = (key: "channel" | "group") => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? groups.filter(
          (g) =>
            (g.group_name ?? "").toLowerCase().includes(q) ||
            g.group_id.toLowerCase().includes(q),
        )
      : groups;
    if (sortKey === null) return base;
    const sorted = [...base];
    sorted.sort((a, b) => {
      const av =
        sortKey === "channel" ? (a.channel_name ?? "") : (a.group_name?.trim() || a.group_id);
      const bv =
        sortKey === "channel" ? (b.channel_name ?? "") : (b.group_name?.trim() || b.group_id);
      const cmp = av.localeCompare(bv, "zh-TW");
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [groups, query, sortKey, sortDir]);

  if (groupsQuery.isLoading) {
    return (
      <div className="rounded-xl border border-border bg-bg px-3 py-4 text-center text-[13px] text-gray-500">
        載入中...
      </div>
    );
  }

  if (groupsQuery.isSuccess && groups.length === 0) {
    return (
      <div className="rounded-xl bg-orange-bg px-3 py-3 text-[13px] text-ink">
        尚未偵測到任何 LINE 群組。請把 LINE 官方帳號加入您要推播的群組,bot 會在收到 join
        事件時自動把群組登錄進來。
      </div>
    );
  }

  return (
    <>
      <UpgradeModal state={upgradeState} onClose={() => setUpgradeState(null)} />
      <GraceBanner usage={usageQuery.data} resource="line_groups" />
      {showLimitBadge && (
        <div
          className={cn(
            "mb-3 flex items-center justify-between rounded-lg border px-3 py-2 text-[12px]",
            atLimit
              ? "border-orange bg-orange-bg text-orange"
              : "border-border bg-white text-gray-500",
          )}
        >
          <span>
            我的推播設定{" "}
            <span className="font-semibold tabular-nums text-ink">{groupsUsed}</span> /{" "}
            <span className="tabular-nums">{groupCap}</span>
            {sharedGroupsCount > 0 && (
              <span className="ml-3 text-gray-300">
                · 共享 {sharedGroupsCount} 個群組(計入擁有者方案,不影響你的額度)
              </span>
            )}
          </span>
          {atLimit && <span className="font-semibold">已達上限</span>}
        </div>
      )}
      <div className="mb-3 flex items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="搜尋群組名稱或 ID"
          className="h-9 w-full rounded-lg border border-border bg-white px-3 text-[13px] outline-none focus:border-orange"
        />
        <span className="shrink-0 text-[11px] text-gray-300">
          {filtered.length} / {groups.length}
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border bg-white">
        <table className="w-full min-w-[640px] border-collapse text-[13px]">
          <thead className="border-b border-border bg-bg text-left">
            <tr>
              <th className="w-12 px-3 py-2 font-semibold text-gray-500">No.</th>
              <SortableTh
                label="推播官方帳號"
                active={sortKey === "channel"}
                dir={sortDir}
                onClick={() => onSort("channel")}
              />
              <SortableTh
                label="群組"
                active={sortKey === "group"}
                dir={sortDir}
                onClick={() => onSort("group")}
              />
              <th className="px-3 py-2 font-semibold text-gray-500">已設定的推播</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-center text-[12px] text-gray-300" colSpan={4}>
                  無符合搜尋條件的群組
                </td>
              </tr>
            ) : (
              filtered.map((g, idx) => {
                const displayName = g.group_name?.trim() || g.group_id;
                return (
                  <GroupRow
                    key={g.group_id}
                    no={idx + 1}
                    group={g}
                    accessibleAccountIds={accessibleAccountIds}
                    canAddPush={!!g.channel_owner_fb_user_id && g.channel_owner_fb_user_id === currentUserId}
                    onAddPush={() =>
                      tryAddPush({
                        groupId: g.group_id,
                        groupDisplayName: displayName,
                        editing: null,
                      })
                    }
                    onEditPush={(cfg) =>
                      setEditTarget({
                        groupId: g.group_id,
                        groupDisplayName: displayName,
                        editing: cfg,
                      })
                    }
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {editTarget && (
        <GroupPushConfigModal
          open={!!editTarget}
          onOpenChange={(o) => {
            if (!o) setEditTarget(null);
          }}
          groupId={editTarget.groupId}
          groupDisplayName={editTarget.groupDisplayName}
          editing={editTarget.editing}
        />
      )}
    </>
  );
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th className="px-3 py-2 font-semibold text-gray-500">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex items-center gap-1 hover:text-orange",
          active && "text-orange",
        )}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <span>{label}</span>
        <span className="text-[9px] leading-none">
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

function GroupRow({
  no,
  group,
  accessibleAccountIds,
  canAddPush,
  onAddPush,
  onEditPush,
}: {
  no: number;
  group: LineGroup;
  accessibleAccountIds: Set<string>;
  canAddPush: boolean;
  onAddPush: () => void;
  onEditPush: (cfg: LinePushConfig) => void;
}) {
  const displayName = group.group_name?.trim() || "（尚未取得群組名稱）";
  const hasName = !!group.group_name?.trim();

  return (
    <tr className="border-b border-border last:border-b-0 align-top">
      <td className="px-3 py-2.5 text-center text-[11px] tabular-nums text-gray-300">{no}</td>
      <td className="px-3 py-2.5">
        {group.channel_name ? (
          <span className="inline-block rounded-full bg-orange-bg px-2 py-[1px] text-[11px] font-semibold text-orange">
            {group.channel_name}
          </span>
        ) : (
          <span className="text-[11px] text-gray-300">—</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <span
          className={cn("block truncate font-bold", hasName ? "text-ink" : "text-gray-300")}
          title={displayName}
        >
          {displayName}
        </span>
        <div className="mt-0.5 truncate font-mono text-[10px] text-gray-300">{group.group_id}</div>
      </td>

      <td className="px-3 py-2.5">
        <GroupPushConfigsList
          groupId={group.group_id}
          accessibleAccountIds={accessibleAccountIds}
          onEdit={onEditPush}
          onAdd={canAddPush ? onAddPush : undefined}
        />
      </td>
    </tr>
  );
}

function GroupPushConfigsList({
  groupId,
  accessibleAccountIds,
  onEdit,
  onAdd,
}: {
  groupId: string;
  accessibleAccountIds: Set<string>;
  onEdit: (cfg: LinePushConfig) => void;
  /** Optional: omit when the bot has left the group (cannot create new). */
  onAdd?: () => void;
}) {
  const query = useLineGroupPushConfigs(groupId);
  const allConfigs = query.data ?? [];
  // Hide configs whose account_id isn't in the current FB user's
  // accessible set — they belong to a teammate's account scope.
  const configs = useMemo(
    () => allConfigs.filter((c) => accessibleAccountIds.has(c.account_id)),
    [allConfigs, accessibleAccountIds],
  );

  return (
    <div className="flex flex-col gap-1.5">
      {query.isLoading ? (
        <div className="text-[11px] text-gray-300">載入中...</div>
      ) : configs.length === 0 ? (
        <div className="text-[11px] text-gray-300">尚無推播設定</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {configs.map((cfg) => (
            <PushConfigRow key={cfg.id} cfg={cfg} onEdit={onEdit} />
          ))}
        </ul>
      )}
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          className="self-start rounded-md border border-dashed border-border px-2 py-0.5 text-[11px] text-gray-500 hover:border-orange hover:text-orange"
        >
          + 新增推播
        </button>
      )}
    </div>
  );
}

function PushConfigRow({
  cfg,
  onEdit,
}: {
  cfg: LinePushConfig & { campaign_nickname?: string };
  onEdit: (cfg: LinePushConfig) => void;
}) {
  // Display fallback: nickname (店家·設計師) → cached FB campaign name
  // → campaign_id. Cached name comes from `campaign_name` persisted on
  // the row at save-time, so the user sees「ICONI 南京 · Cherry 燙髮」
  // instead of「6949544757391」when no team-wide nickname is set.
  const name = cfg.campaign_nickname?.trim() || cfg.campaign_name?.trim() || cfg.campaign_id;
  const dateLabel = formatDateRangeLabel(cfg);
  const rule = formatPushRule(cfg);
  const deleteMutation = useDeleteLinePushConfig();
  const testMutation = useTestLinePush();
  const { user } = useFbAuth();
  // Read-only when the channel is owned by someone else (or has no
  // owner / is shared). Visibility was already gated by FB account
  // access; ownership controls write access.
  const editable = !!cfg.channel_owner_fb_user_id && cfg.channel_owner_fb_user_id === user?.id;

  const onUnbind = async () => {
    const ok = await confirm(`確定要解除「${name}」的推播綁定？`);
    if (!ok) return;
    try {
      await deleteMutation.mutateAsync(cfg.id);
      toast("已解除推播", "success");
    } catch (e) {
      toast(`解除失敗:${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    }
  };

  const onTest = async () => {
    try {
      await testMutation.mutateAsync(cfg.id);
      toast(`已發送測試推播到「${name}」`, "success");
    } catch (e) {
      toast(`測試失敗:${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    }
  };

  return (
    <li
      className={cn(
        "group/row flex items-start justify-between gap-2 rounded-md px-1 py-0.5 hover:bg-bg",
        !cfg.enabled && "opacity-60",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12px] font-semibold text-ink">{name}</span>
          {!cfg.enabled && (
            <span className="shrink-0 rounded-full bg-red-bg px-1.5 py-[1px] text-[10px] font-semibold text-red">
              已停用
            </span>
          )}
          {!editable && (
            <span
              className="shrink-0 rounded-full bg-bg px-1.5 py-[1px] text-[10px] font-semibold text-gray-300"
              title="此推播由其他用戶的官方帳號管理,你只有檢視權限"
            >
              唯讀
            </span>
          )}
        </div>
        <div className="text-[11px] text-gray-500">
          {rule} · {dateLabel}
        </div>
      </div>
      {editable && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onEdit(cfg)}
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-gray-500 hover:border-orange hover:text-orange"
          >
            編輯
          </button>
          <button
            type="button"
            onClick={onTest}
            disabled={testMutation.isPending}
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-orange hover:border-orange hover:bg-orange-bg disabled:opacity-50"
          >
            {testMutation.isPending ? "發送中" : "測試"}
          </button>
          <button
            type="button"
            onClick={onUnbind}
            disabled={deleteMutation.isPending}
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-red hover:border-red hover:bg-red-bg disabled:opacity-50"
          >
            {deleteMutation.isPending ? "解除中" : "解除綁定"}
          </button>
        </div>
      )}
    </li>
  );
}
