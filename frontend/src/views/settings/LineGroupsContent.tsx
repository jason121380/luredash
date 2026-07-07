import type { LineGroupFolder, LinePushConfig, LinePushDateRange } from "@/api/client";
import { useAccounts } from "@/api/hooks/useAccounts";
import {
  useCreateLineFolder,
  useDeleteLineFolder,
  useDeleteLinePushConfig,
  useLineGroupFolders,
  useLineGroupPushConfigs,
  useLineGroups,
  useSetLineGroupFolder,
  useTestLinePush,
  useUpdateLineFolder,
} from "@/api/hooks/useLinePush";
import { useBillingUsage } from "@/api/hooks/useSubscription";
import { confirm } from "@/components/ConfirmDialog";
import { GraceBanner } from "@/components/GraceBanner";
import { toast } from "@/components/Toast";
import { UpgradeModal, type UpgradeModalState } from "@/components/UpgradeModal";
import { cn } from "@/lib/cn";
import { useEffect, useMemo, useState } from "react";
import { GroupPushConfigModal } from "./GroupPushConfigModal";

type EditTarget = {
  groupId: string;
  groupDisplayName: string;
  editing: LinePushConfig | null;
} | null;

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
/** Sentinel folder selections (real folder ids are UUIDs). */
const FOLDER_ALL = "__all__";
const FOLDER_NONE = "__none__";
/** OA-tab key for groups whose channel_id is NULL (legacy / unclaimed). */
const OA_NONE = "__none_oa__";

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
  folder_id: string | null;
  channel_name: string;
  channel_owner_fb_user_id: string | null;
  is_owner: boolean;
  is_shared: boolean;
  my_role: "owner" | "admin" | "viewer" | "";
  joined_at: string | null;
  left_at: string | null;
}

interface OaTab {
  key: string; // channel_id or OA_NONE
  channelId: string | null;
  name: string;
  role: LineGroup["my_role"];
  count: number;
}

const oaKeyOf = (channelId: string | null): string => channelId ?? OA_NONE;

/**
 * LINE 群組管理 — OA-tabbed view. Each LINE 官方帳號 (channel) is its
 * own tab; within a tab, a left-hand folder list categorises that OA's
 * groups (全部 / 未分類 / user folders). The search box is scoped to the
 * currently-selected OA (and narrows within the selected folder).
 *
 * Standalone page is `LinePushSettingsView`; its Topbar refresh button
 * calls `/api/line-groups/refresh-all` to bulk-update group names.
 */
export function LineGroupsContent() {
  const groupsQuery = useLineGroups();
  const groups = (groupsQuery.data ?? []) as LineGroup[];
  const foldersQuery = useLineGroupFolders();
  const allFolders = foldersQuery.data ?? [];
  // Set of account IDs the current FB user has Marketing API access to.
  const accountsQuery = useAccounts();
  const accessibleAccountIds = useMemo(
    () => new Set((accountsQuery.data ?? []).map((a) => a.id)),
    [accountsQuery.data],
  );
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [query, setQuery] = useState("");
  const [selectedOaKey, setSelectedOaKey] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string>(FOLDER_ALL);
  const usageQuery = useBillingUsage();
  const groupCap = usageQuery.data?.limits.line_groups ?? -1;
  const groupsUsed = usageQuery.data?.usage.line_groups ?? 0;
  const isUnlimited = groupCap < 0 || groupCap >= 999_000;
  const ownedGroupsCount = groups.filter((g) => g.is_owner).length;
  const sharedGroupsCount = groups.filter((g) => g.is_shared).length;
  const showLimitBadge = !isUnlimited && ownedGroupsCount > 0;
  const atLimit = showLimitBadge && groupsUsed >= groupCap;
  const [upgradeState, setUpgradeState] = useState<UpgradeModalState | null>(null);

  // ── OA tabs (one per distinct channel among visible groups) ──
  const oaTabs = useMemo<OaTab[]>(() => {
    const map = new Map<string, OaTab>();
    for (const g of groups) {
      const key = oaKeyOf(g.channel_id);
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(key, {
          key,
          channelId: g.channel_id,
          name: g.channel_name?.trim() || (g.channel_id ? "未命名官方帳號" : "未指定官方帳號"),
          role: g.my_role,
          count: 1,
        });
      }
    }
    // Real channels first (by name), the null-channel bucket last.
    return [...map.values()].sort((a, b) => {
      if ((a.channelId === null) !== (b.channelId === null)) {
        return a.channelId === null ? 1 : -1;
      }
      return a.name.localeCompare(b.name, "zh-TW");
    });
  }, [groups]);

  // Resolve the active OA: keep the user's pick if it still exists,
  // else fall back to the first tab.
  const activeOa = useMemo<OaTab | null>(() => {
    if (oaTabs.length === 0) return null;
    return oaTabs.find((t) => t.key === selectedOaKey) ?? oaTabs[0] ?? null;
  }, [oaTabs, selectedOaKey]);

  // Reset folder selection whenever the active OA changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on OA switch only
  useEffect(() => {
    setSelectedFolder(FOLDER_ALL);
  }, [activeOa?.key]);

  const canManageFolders =
    !!activeOa?.channelId && (activeOa.role === "owner" || activeOa.role === "admin");

  const oaFolders = useMemo(
    () => allFolders.filter((f) => f.channel_id === activeOa?.channelId),
    [allFolders, activeOa?.channelId],
  );

  // Groups in the active OA, with per-folder counts for the sidebar.
  const oaGroups = useMemo(
    () => groups.filter((g) => oaKeyOf(g.channel_id) === activeOa?.key),
    [groups, activeOa?.key],
  );
  const uncategorisedCount = useMemo(() => oaGroups.filter((g) => !g.folder_id).length, [oaGroups]);

  // Folder filter → then search filter (search is scoped to the OA,
  // narrowing within whatever folder is selected).
  const visibleGroups = useMemo(() => {
    let base = oaGroups;
    if (selectedFolder === FOLDER_NONE) base = base.filter((g) => !g.folder_id);
    else if (selectedFolder !== FOLDER_ALL)
      base = base.filter((g) => g.folder_id === selectedFolder);
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (g) => (g.group_name ?? "").toLowerCase().includes(q) || g.group_id.toLowerCase().includes(q),
    );
  }, [oaGroups, selectedFolder, query]);

  const tryAddPush = (target: NonNullable<EditTarget>) => {
    const targetGroup = groups.find((g) => g.group_id === target.groupId);
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
            我的推播設定 <span className="font-semibold tabular-nums text-ink">{groupsUsed}</span> /{" "}
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

      {/* OA tabs */}
      <div
        className="mb-3 flex gap-1.5 overflow-x-auto pb-0.5"
        role="tablist"
        aria-label="LINE 官方帳號"
      >
        {oaTabs.map((tab) => {
          const active = tab.key === activeOa?.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSelectedOaKey(tab.key)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-1.5 text-[13px] transition-colors",
                active
                  ? "border-orange bg-white font-semibold text-orange"
                  : "border-transparent text-gray-500 hover:text-orange",
              )}
            >
              <span>{tab.name}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] tabular-nums",
                  active ? "bg-orange-bg text-orange" : "bg-bg text-gray-400",
                )}
              >
                {tab.count}
              </span>
              {tab.role === "viewer" && (
                <span className="rounded-full bg-gray-100 px-1 text-[9px] font-semibold text-gray-500">
                  唯讀
                </span>
              )}
              {tab.role === "admin" && (
                <span className="rounded-full bg-emerald-50 px-1 text-[9px] font-semibold text-emerald-600">
                  共享
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[190px_minmax(0,1fr)]">
        <FolderSidebar
          channelId={activeOa?.channelId ?? null}
          folders={oaFolders}
          selected={selectedFolder}
          onSelect={setSelectedFolder}
          allCount={oaGroups.length}
          uncategorisedCount={uncategorisedCount}
          canManage={canManageFolders}
        />

        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder={`在「${activeOa?.name ?? ""}」搜尋群組名稱或 ID`}
              className="h-9 w-full rounded-lg border border-border bg-white px-3 text-[13px] outline-none focus:border-orange"
            />
            <span className="shrink-0 text-[11px] text-gray-300">
              {visibleGroups.length} / {oaGroups.length}
            </span>
          </div>
          <div className="overflow-x-auto rounded-xl border border-border bg-white">
            <table className="w-full min-w-[560px] border-collapse text-[13px]">
              <thead className="border-b border-border bg-bg text-left">
                <tr>
                  <th className="w-12 px-3 py-2 font-semibold text-gray-500">No.</th>
                  <th className="px-3 py-2 font-semibold text-gray-500">群組</th>
                  <th className="w-32 px-3 py-2 font-semibold text-gray-500">資料夾</th>
                  <th className="px-3 py-2 font-semibold text-gray-500">已設定的推播</th>
                </tr>
              </thead>
              <tbody>
                {visibleGroups.length === 0 ? (
                  <tr>
                    <td className="px-3 py-4 text-center text-[12px] text-gray-300" colSpan={4}>
                      {query.trim() ? "無符合搜尋條件的群組" : "此分類尚無群組"}
                    </td>
                  </tr>
                ) : (
                  visibleGroups.map((g, idx) => {
                    const displayName = g.group_name?.trim() || g.group_id;
                    return (
                      <GroupRow
                        key={g.group_id}
                        no={idx + 1}
                        group={g}
                        folders={oaFolders}
                        canManageFolders={canManageFolders}
                        accessibleAccountIds={accessibleAccountIds}
                        canEdit={g.my_role === "owner" || g.my_role === "admin"}
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
        </div>
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

// ── Left folder list (per-OA categorisation) ──────────────────

function FolderSidebar({
  channelId,
  folders,
  selected,
  onSelect,
  allCount,
  uncategorisedCount,
  canManage,
}: {
  channelId: string | null;
  folders: LineGroupFolder[];
  selected: string;
  onSelect: (folder: string) => void;
  allCount: number;
  uncategorisedCount: number;
  canManage: boolean;
}) {
  const createMutation = useCreateLineFolder();
  const updateMutation = useUpdateLineFolder();
  const deleteMutation = useDeleteLineFolder();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");

  const onCreate = async () => {
    const name = newName.trim();
    if (!name || !channelId) return;
    try {
      await createMutation.mutateAsync({ channelId, name });
      setNewName("");
      setAdding(false);
      toast("已新增資料夾", "success");
    } catch (e) {
      toast(`新增失敗:${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    }
  };

  const onRename = async (id: string) => {
    const name = renameName.trim();
    if (!name) return;
    try {
      await updateMutation.mutateAsync({ folderId: id, body: { name } });
      setRenamingId(null);
      toast("已更名", "success");
    } catch (e) {
      toast(`更名失敗:${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    }
  };

  const onDelete = async (f: LineGroupFolder) => {
    const ok = await confirm(
      `確定要刪除資料夾「${f.name}」？裡面的 ${f.group_count} 個群組會移回「未分類」,不會被刪除。`,
    );
    if (!ok) return;
    try {
      await deleteMutation.mutateAsync(f.id);
      if (selected === f.id) onSelect(FOLDER_ALL);
      toast("已刪除資料夾", "success");
    } catch (e) {
      toast(`刪除失敗:${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    }
  };

  const chip = (key: string, label: string, count: number) => {
    const active = selected === key;
    return (
      <button
        key={key}
        type="button"
        onClick={() => onSelect(key)}
        className={cn(
          "flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] transition-colors md:w-full",
          active
            ? "bg-orange-bg font-semibold text-orange"
            : "text-gray-500 hover:bg-bg hover:text-ink",
        )}
      >
        <span className="truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-[10px] text-gray-300">{count}</span>
      </button>
    );
  };

  return (
    <aside className="md:sticky md:top-0 md:self-start">
      <div className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-white p-1.5 md:flex-col md:gap-0.5">
        {chip(FOLDER_ALL, "全部", allCount)}
        {chip(FOLDER_NONE, "未分類", uncategorisedCount)}
        {folders.length > 0 && <div className="my-1 hidden border-t border-border md:block" />}
        {folders.map((f) => {
          const active = selected === f.id;
          if (renamingId === f.id) {
            return (
              <div key={f.id} className="flex shrink-0 items-center gap-1 px-1 py-0.5 md:w-full">
                <input
                  ref={(el) => el?.focus()}
                  value={renameName}
                  onChange={(e) => setRenameName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void onRename(f.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="h-7 w-full min-w-[90px] rounded border border-orange px-1.5 text-[12px] outline-none"
                />
                <button
                  type="button"
                  onClick={() => void onRename(f.id)}
                  className="shrink-0 rounded px-1 text-[11px] text-orange hover:underline"
                >
                  存
                </button>
              </div>
            );
          }
          return (
            <div
              key={f.id}
              className={cn(
                "group/folder flex shrink-0 items-center gap-1 rounded-lg md:w-full",
                active && "bg-orange-bg",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(f.id)}
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-between gap-2 whitespace-nowrap px-2.5 py-1.5 text-[12px]",
                  active ? "font-semibold text-orange" : "text-gray-500 hover:text-ink",
                )}
              >
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 tabular-nums text-[10px] text-gray-300">
                  {f.group_count}
                </span>
              </button>
              {canManage && (
                <div
                  className={cn(
                    "flex shrink-0 items-center gap-0.5 pr-1",
                    "opacity-0 group-hover/folder:opacity-100",
                    active && "opacity-100",
                  )}
                >
                  <button
                    type="button"
                    title="更名"
                    onClick={() => {
                      setRenamingId(f.id);
                      setRenameName(f.name);
                    }}
                    className="rounded px-1 text-[11px] text-gray-400 hover:text-orange"
                  >
                    改名
                  </button>
                  <button
                    type="button"
                    title="刪除"
                    onClick={() => void onDelete(f)}
                    className="rounded px-1 text-[11px] text-gray-400 hover:text-red"
                  >
                    刪
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {canManage &&
          (adding ? (
            <div className="flex shrink-0 items-center gap-1 px-1 py-0.5 md:w-full">
              <input
                ref={(el) => el?.focus()}
                value={newName}
                onChange={(e) => setNewName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onCreate();
                  if (e.key === "Escape") {
                    setAdding(false);
                    setNewName("");
                  }
                }}
                placeholder="資料夾名稱"
                className="h-7 w-full min-w-[90px] rounded border border-orange px-1.5 text-[12px] outline-none"
              />
              <button
                type="button"
                onClick={() => void onCreate()}
                disabled={createMutation.isPending}
                className="shrink-0 rounded px-1 text-[11px] text-orange hover:underline disabled:opacity-50"
              >
                新增
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="shrink-0 whitespace-nowrap rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[12px] text-gray-500 hover:border-orange hover:text-orange md:w-full md:text-left"
            >
              + 新增資料夾
            </button>
          ))}
      </div>
    </aside>
  );
}

/** Per-row control to move a group into / out of a folder. */
function GroupFolderSelect({
  group,
  folders,
  canManage,
}: {
  group: LineGroup;
  folders: LineGroupFolder[];
  canManage: boolean;
}) {
  const setFolder = useSetLineGroupFolder();
  const current = folders.find((f) => f.id === group.folder_id);

  if (!canManage) {
    return <span className="text-[12px] text-gray-500">{current?.name ?? "未分類"}</span>;
  }

  return (
    <select
      value={group.folder_id ?? ""}
      disabled={setFolder.isPending}
      onChange={(e) => {
        const v = e.currentTarget.value;
        void setFolder
          .mutateAsync({ groupId: group.group_id, folderId: v || null })
          .then(() => toast("已移動群組", "success"))
          .catch((err) =>
            toast(`移動失敗:${err instanceof Error ? err.message : String(err)}`, "error", 4500),
          );
      }}
      className="h-7 w-full max-w-[120px] rounded border border-border bg-white px-1.5 text-[12px] text-ink outline-none focus:border-orange disabled:opacity-50"
    >
      <option value="">未分類</option>
      {folders.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  );
}

function GroupRow({
  no,
  group,
  folders,
  canManageFolders,
  accessibleAccountIds,
  canEdit,
  onAddPush,
  onEditPush,
}: {
  no: number;
  group: LineGroup;
  folders: LineGroupFolder[];
  canManageFolders: boolean;
  accessibleAccountIds: Set<string>;
  /** Caller can mutate configs (add / edit / delete / test). */
  canEdit: boolean;
  onAddPush: () => void;
  onEditPush: (cfg: LinePushConfig) => void;
}) {
  const displayName = group.group_name?.trim() || "（尚未取得群組名稱）";
  const hasName = !!group.group_name?.trim();

  return (
    <tr className="border-b border-border last:border-b-0 align-top">
      <td className="px-3 py-2.5 text-center text-[11px] tabular-nums text-gray-300">{no}</td>
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
        <GroupFolderSelect group={group} folders={folders} canManage={canManageFolders} />
      </td>
      <td className="px-3 py-2.5">
        <GroupPushConfigsList
          groupId={group.group_id}
          accessibleAccountIds={accessibleAccountIds}
          canEdit={canEdit}
          onEdit={onEditPush}
          onAdd={canEdit ? onAddPush : undefined}
        />
      </td>
    </tr>
  );
}

function GroupPushConfigsList({
  groupId,
  accessibleAccountIds,
  canEdit,
  onEdit,
  onAdd,
}: {
  groupId: string;
  accessibleAccountIds: Set<string>;
  canEdit: boolean;
  onEdit: (cfg: LinePushConfig) => void;
  /** Optional: omit when the bot has left the group (cannot create new). */
  onAdd?: () => void;
}) {
  const query = useLineGroupPushConfigs(groupId);
  const allConfigs = query.data ?? [];
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
            <PushConfigRow key={cfg.id} cfg={cfg} canEdit={canEdit} onEdit={onEdit} />
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
  canEdit,
  onEdit,
}: {
  cfg: LinePushConfig & { campaign_nickname?: string };
  canEdit: boolean;
  onEdit: (cfg: LinePushConfig) => void;
}) {
  const name = cfg.campaign_nickname?.trim() || cfg.campaign_name?.trim() || cfg.campaign_id;
  const dateLabel = formatDateRangeLabel(cfg);
  const rule = formatPushRule(cfg);
  const deleteMutation = useDeleteLinePushConfig();
  const testMutation = useTestLinePush();
  const editable = canEdit;

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
