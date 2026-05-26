import type {
  SecurityAnomalyTag,
  SecurityPushConfig,
  SecurityPushConfigInput,
  SecurityPushTestCard,
} from "@/api/client";
import { useLineChannels, useLineGroups } from "@/api/hooks/useLinePush";
import {
  useDeleteSecurityPushConfig,
  useSaveSecurityPushConfig,
  useSecurityPushConfigs,
  useTestSecurityPushConfig,
} from "@/api/hooks/useSecurityPush";
import { useSetSharedSetting, useSharedSettings } from "@/api/hooks/useSettings";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toast";
import { cn } from "@/lib/cn";
import { useAccountsStore } from "@/stores/accountsStore";
import { useEffect, useMemo, useState } from "react";

/**
 * 安全防護推播設定 — opens from /security topbar. Lists existing
 * alert subscriptions and lets the user create / edit / delete them.
 *
 * Each config is "when a new campaign is created and matches any of
 * the selected anomaly tags, push a LINE message to these groups".
 * The backend scheduler polls every `poll_interval_minutes` and fires
 * pushes for campaigns created since the previous poll.
 */

const ANOMALY_OPTIONS: Array<{ value: SecurityAnomalyTag; label: string; hint: string }> = [
  { value: "deep_night", label: "深夜創建", hint: "00:00–05:59 建立" },
  { value: "weekend", label: "週末創建", hint: "週六、週日建立" },
  { value: "high_budget", label: "日預算 > $2000", hint: "含廣告組合加總" },
  { value: "abnormal_language", label: "異常語言", hint: "活動名稱含非中/英字元" },
];

type EditingState = { mode: "list" } | { mode: "new" } | { mode: "edit"; cfg: SecurityPushConfig };

// Relative-time helpers used to surface the scheduler's progress
// ("上次檢查 5 分鐘前 · 下次 55 分鐘後") in the config list. Source
// of truth is the `last_run_at` / `next_run_at` columns the
// scheduler tick writes after each `_security_push_run_one()`.
function formatRelativeTime(iso: string | null): string {
  if (!iso) return "尚未檢查";
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 0) return "剛剛";
  if (diffSec < 60) return `${diffSec} 秒前`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分鐘前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小時前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}

function formatRelativeFuture(iso: string | null): string {
  if (!iso) return "排程中";
  const diffSec = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (diffSec < 0) return "即將觸發";
  if (diffSec < 60) return `${diffSec} 秒後`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分鐘後`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小時後`;
  return `${Math.floor(diffSec / 86400)} 天後`;
}

export interface SecurityPushSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Snapshot of the currently-visible 待查看 cards. When provided,
   * the「測試」button posts these directly to backend so it doesn't
   * need to re-scan FB. */
  pendingCards?: SecurityPushTestCard[];
}

export function SecurityPushSettingsModal({
  open,
  onOpenChange,
  pendingCards,
}: SecurityPushSettingsModalProps) {
  const [state, setState] = useState<EditingState>({ mode: "list" });
  const configsQuery = useSecurityPushConfigs();
  const configs = configsQuery.data ?? [];

  // Master switch — flipped via the「每小時檢查並推播」checkbox,
  // stored team-wide in shared_settings.security_push_master_enabled.
  // Defaults to **false** (off) when missing — feature is opt-in so
  // a fresh deploy doesn't quietly start hitting FB rate-limit.
  const sharedQuery = useSharedSettings();
  const setShared = useSetSharedSetting();
  const masterEnabledRaw = sharedQuery.data?.security_push_master_enabled;
  const masterEnabled = masterEnabledRaw === true;
  const enabledConfigsCount = configs.filter((cfg) => cfg.enabled).length;

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setState({ mode: "list" });
      }}
      title="安全防護推播設定"
      subtitle={
        state.mode === "list"
          ? "新建立廣告活動命中異常時自動發 LINE 訊息"
          : state.mode === "new"
            ? "新增推播設定"
            : "編輯推播設定"
      }
      width={560}
    >
      {state.mode === "list" ? (
        <div className="flex flex-col gap-3">
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg/40 p-3 text-[13px]">
            <input
              type="checkbox"
              className="custom-cb mt-0.5"
              checked={masterEnabled}
              onChange={(e) => {
                const next = e.target.checked;
                setShared.mutate(
                  { key: "security_push_master_enabled", value: next },
                  {
                    onSuccess: () =>
                      toast(
                        next ? "已啟用每小時自動檢查" : "已停用自動檢查",
                        "success",
                      ),
                    onError: (err) =>
                      toast(
                        `儲存失敗:${err instanceof Error ? err.message : "未知錯誤"}`,
                        "error",
                      ),
                  },
                );
              }}
            />
            <div className="flex-1">
              <div className="font-semibold text-ink">每小時檢查並推播</div>
              <div className="mt-0.5 text-[11px] text-gray-500">
                關掉後系統會暫停所有設定的自動掃描;手動點「測試」仍可運作。
              </div>
            </div>
          </label>
          {masterEnabled && enabledConfigsCount === 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800">
              已開啟總開關,但目前沒有啟用中的推播設定,所以排程不會自動掃描。
              請新增推播或把既有設定改為啟用。
            </div>
          )}
          <ConfigList
            configs={configs}
            loading={configsQuery.isLoading}
            pendingCards={pendingCards}
            onAdd={() => setState({ mode: "new" })}
            onEdit={(cfg) => setState({ mode: "edit", cfg })}
          />
        </div>
      ) : (
        <ConfigForm
          initial={state.mode === "edit" ? state.cfg : null}
          onCancel={() => setState({ mode: "list" })}
          onSaved={() => setState({ mode: "list" })}
        />
      )}
    </Modal>
  );
}

function ConfigList({
  configs,
  loading,
  pendingCards,
  onAdd,
  onEdit,
}: {
  configs: SecurityPushConfig[];
  loading: boolean;
  pendingCards?: SecurityPushTestCard[];
  onAdd: () => void;
  onEdit: (cfg: SecurityPushConfig) => void;
}) {
  const del = useDeleteSecurityPushConfig();
  const test = useTestSecurityPushConfig();
  const [testingId, setTestingId] = useState<string | null>(null);

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const resp = await test.mutateAsync({ id, cards: pendingCards });
      if (resp.errors.length > 0) {
        toast(
          `已送出 ${resp.sent} 則,${resp.errors.length} 則失敗:${resp.errors[0] ?? ""}`,
          "error",
          6000,
        );
      } else if (resp.synthetic) {
        toast(`已送出範例測試訊息到 ${resp.sent} 個群組`, "success");
      } else if (resp.source === "scan_record") {
        toast(`已用最近掃描紀錄送出測試推播到 ${resp.sent} 個群組`, "success");
      } else {
        toast(`已送出測試推播到 ${resp.sent} 個群組`, "success");
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : "未知錯誤";
      toast(`測試失敗:${raw}`, "error", 8000);
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Button variant="primary" onClick={onAdd} className="self-start">
        + 新增推播
      </Button>
      {loading ? (
        <p className="text-[12px] text-gray-500">載入中...</p>
      ) : configs.length === 0 ? (
        <p className="text-[12px] text-gray-500">
          尚未設定推播。按「新增推播」設定第一個告警訂閱。
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {configs.map((cfg) => (
            <li key={cfg.id} className="rounded-lg border border-border bg-white p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink">{cfg.name}</span>
                    {!cfg.enabled && (
                      <span className="rounded-full bg-gray-100 px-1.5 py-[1px] text-[10px] text-gray-500">
                        已停用
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-gray-500">
                    {cfg.group_ids.length} 個 LINE 群組 · 每 {cfg.poll_interval_minutes} 分鐘檢查 ·
                    異常:
                    {cfg.anomaly_filters
                      .map((t) => ANOMALY_OPTIONS.find((o) => o.value === t)?.label ?? t)
                      .join("、")}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500">
                    <span>
                      上次檢查:
                      <b className={cfg.last_run_at ? "text-ink" : "text-gray-400"}>
                        {formatRelativeTime(cfg.last_run_at)}
                      </b>
                    </span>
                    <span className="text-gray-300">·</span>
                    <span>
                      下次:
                      <b className={cfg.enabled ? "text-ink" : "text-gray-400"}>
                        {cfg.enabled ? formatRelativeFuture(cfg.next_run_at) : "已停用"}
                      </b>
                    </span>
                    {cfg.fail_count > 0 && (
                      <span className="rounded-full bg-amber-100 px-1.5 py-[1px] text-[10px] font-semibold text-amber-700">
                        失敗 {cfg.fail_count}/5 次
                      </span>
                    )}
                  </div>
                  {cfg.last_error && (
                    <div className="mt-1 text-[11px] text-red-700">上次錯誤:{cfg.last_error}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={testingId === cfg.id}
                    onClick={() => void handleTest(cfg.id)}
                  >
                    {testingId === cfg.id ? "測試中..." : "測試"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onEdit(cfg)}>
                    編輯
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`確定刪除「${cfg.name}」?`)) del.mutate(cfg.id);
                    }}
                  >
                    刪除
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConfigForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: SecurityPushConfig | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const channelsQuery = useLineChannels();
  const groupsQuery = useLineGroups();
  const save = useSaveSecurityPushConfig();
  const selectedAccountIds = useAccountsStore((s) => s.selectedIds);

  const channels = channelsQuery.data ?? [];
  const groups = useMemo(
    () => (groupsQuery.data ?? []).filter((g) => g.left_at === null),
    [groupsQuery.data],
  );

  const [name, setName] = useState(initial?.name ?? "");
  const [channelId, setChannelId] = useState(initial?.channel_id ?? channels[0]?.id ?? "");
  // `channels` arrives async from useLineChannels; first render gets
  // an empty array → useState seeds channelId="". Once the query
  // resolves, the <select> visually shows the first option but the
  // browser doesn't fire onChange for the implicit selection, so
  // channelId stays "" and "請選擇 LINE channel" fires on save.
  // Sync the state when the list lands.
  useEffect(() => {
    if (!channelId && channels.length > 0) {
      const first = channels[0];
      if (first) setChannelId(first.id);
    }
  }, [channels, channelId]);
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set(initial?.group_ids ?? []));
  const [filters, setFilters] = useState<Set<SecurityAnomalyTag>>(
    new Set(initial?.anomaly_filters ?? ["deep_night", "weekend", "high_budget"]),
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  // Only show groups belonging to the selected channel. LINE's push
  // API uses the channel's access_token, and a bot can only push to
  // groups it has joined under that channel — listing groups from
  // other channels just creates 400-failure traps.
  const groupsForChannel = useMemo(
    () => groups.filter((g) => g.channel_id === channelId),
    [groups, channelId],
  );

  const toggleGroup = (gid: string) => {
    const next = new Set(groupIds);
    if (next.has(gid)) next.delete(gid);
    else next.add(gid);
    setGroupIds(next);
  };

  const toggleFilter = (tag: SecurityAnomalyTag) => {
    const next = new Set(filters);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    setFilters(next);
  };

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError("請輸入名稱");
      return;
    }
    if (!channelId) {
      setError("請選擇 LINE channel");
      return;
    }
    if (groupIds.size === 0) {
      setError("請至少選擇一個 LINE group");
      return;
    }
    if (filters.size === 0) {
      setError("請至少勾選一項異常條件");
      return;
    }
    const payload: SecurityPushConfigInput = {
      ...(initial ? { id: initial.id } : {}),
      name: name.trim(),
      channel_id: channelId,
      group_ids: [...groupIds],
      account_ids: [],
      anomaly_filters: [...filters],
      enabled,
    };
    try {
      await save.mutateAsync(payload);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "儲存失敗");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Field label="名稱" hint="顯示用,例如「深夜異常告警」">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-border bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-orange"
        />
      </Field>

      <Field label="LINE Channel(OA)" hint="從哪個官方帳號發出">
        <select
          value={channelId}
          onChange={(e) => {
            setChannelId(e.target.value);
            setGroupIds(new Set()); // reset group selection when channel changes
          }}
          className="w-full rounded-md border border-border bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-orange"
        >
          {channels.length === 0 && <option value="">尚未連結任何 channel</option>}
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || c.id}
            </option>
          ))}
        </select>
      </Field>

      <Field label="LINE 群組" hint="發給哪些群組(可複選)">
        {groupsForChannel.length === 0 ? (
          <p className="text-[12px] text-gray-500">
            此 channel 下還沒有任何群組。請先把 bot 加入 LINE 群組,或切到其他 channel 試試。
          </p>
        ) : (
          <div className="flex max-h-[160px] flex-col gap-1.5 overflow-y-auto rounded-md border border-border bg-white p-2">
            {groupsForChannel.map((g) => (
              <label
                key={g.group_id}
                className="flex cursor-pointer items-center gap-2 text-[13px]"
              >
                <input
                  type="checkbox"
                  className="custom-cb"
                  checked={groupIds.has(g.group_id)}
                  onChange={() => toggleGroup(g.group_id)}
                />
                <span>{g.group_name || g.group_id}</span>
              </label>
            ))}
          </div>
        )}
      </Field>

      <Field label="異常條件" hint="命中任一項就推播">
        <div className="flex flex-col gap-1.5">
          {ANOMALY_OPTIONS.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-baseline gap-2 text-[13px]">
              <input
                type="checkbox"
                className="custom-cb"
                checked={filters.has(o.value)}
                onChange={() => toggleFilter(o.value)}
              />
              <span>{o.label}</span>
              <span className="text-[11px] text-gray-500">— {o.hint}</span>
            </label>
          ))}
        </div>
      </Field>

      <div className="rounded-md border border-border bg-bg/40 px-3 py-2 text-[11px] leading-relaxed text-gray-500">
        <div>
          掃描範圍:你在「廣告帳號設定」中啟用的{" "}
          <span className="font-semibold text-ink">{selectedAccountIds.length}</span> 個帳戶
          {selectedAccountIds.length === 0 && "(請先去啟用帳戶,否則無活動可掃)"}
        </div>
        <div className="mt-1">
          自動掃描頻率每 60 分鐘一次(系統固定值)。上方「每小時檢查並推播」可暫停整個排程。
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          className="custom-cb"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>啟用此推播</span>
      </label>

      {error && <p className="text-[12px] text-red-700">{error}</p>}

      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={save.isPending}>
          {save.isPending ? "儲存中..." : "儲存"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-semibold text-ink">{label}</span>
        {hint && <span className={cn("text-[11px] text-gray-500")}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}
