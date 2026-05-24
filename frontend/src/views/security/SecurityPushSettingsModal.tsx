import type { SecurityAnomalyTag, SecurityPushConfig, SecurityPushConfigInput } from "@/api/client";
import { useLineChannels, useLineGroups } from "@/api/hooks/useLinePush";
import {
  useDeleteSecurityPushConfig,
  useSaveSecurityPushConfig,
  useSecurityPushConfigs,
  useTestSecurityPushConfig,
} from "@/api/hooks/useSecurityPush";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toast";
import { cn } from "@/lib/cn";
import { useEffect, useMemo, useState } from "react";

/**
 * 安全監控推播設定 — opens from /security topbar. Lists existing
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

export interface SecurityPushSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SecurityPushSettingsModal({ open, onOpenChange }: SecurityPushSettingsModalProps) {
  const [state, setState] = useState<EditingState>({ mode: "list" });
  const configsQuery = useSecurityPushConfigs();
  const configs = configsQuery.data ?? [];

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setState({ mode: "list" });
      }}
      title="安全監控推播設定"
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
        <ConfigList
          configs={configs}
          loading={configsQuery.isLoading}
          onAdd={() => setState({ mode: "new" })}
          onEdit={(cfg) => setState({ mode: "edit", cfg })}
        />
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
  onAdd,
  onEdit,
}: {
  configs: SecurityPushConfig[];
  loading: boolean;
  onAdd: () => void;
  onEdit: (cfg: SecurityPushConfig) => void;
}) {
  const del = useDeleteSecurityPushConfig();
  const test = useTestSecurityPushConfig();

  const handleTest = async (id: string) => {
    try {
      const resp = await test.mutateAsync(id);
      if (resp.errors.length > 0) {
        toast(`已送出 ${resp.sent} 則,${resp.errors.length} 則失敗`, "error");
      } else {
        toast(`已送出測試推播到 ${resp.sent} 個群組`, "success");
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : "未知錯誤";
      // LINE 400 通常代表 bot 不在那個群組,或選錯了 channel
      // (此 group 屬於別的 OA,access_token 對不上)
      const friendly = /400|Failed to send/.test(raw)
        ? "推播失敗:bot 可能不在所選群組,或群組屬於不同的 LINE 官方帳號。請檢查 channel 與群組的搭配。"
        : `測試失敗:${raw}`;
      toast(friendly, "error");
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
                  {cfg.last_error && (
                    <div className="mt-1 text-[11px] text-red-700">上次錯誤:{cfg.last_error}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={test.isPending}
                    onClick={() => void handleTest(cfg.id)}
                  >
                    {test.isPending ? "測試中..." : "測試"}
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
  const [pollMinutes, setPollMinutes] = useState(initial?.poll_interval_minutes ?? 10);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  // Show all live groups regardless of which channel they're nominally
  // attached to. Legacy groups have `channel_id === null` (LINE 推播設定
  // page also lists them), and we don't want to silently hide a group
  // the user can see elsewhere. The channel-name suffix on each row
  // makes the binding visible so the user can pick the matching pair.
  const groupsForChannel = groups;

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
      poll_interval_minutes: pollMinutes,
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
            尚未在任何 LINE 群組中發現 bot。請先把 bot 加進 LINE 群組。
          </p>
        ) : (
          <div className="flex max-h-[160px] flex-col gap-1.5 overflow-y-auto rounded-md border border-border bg-white p-2">
            {groupsForChannel.map((g) => {
              const channelMismatch = !!g.channel_id && g.channel_id !== channelId;
              return (
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
                  {g.channel_name && (
                    <span
                      className={cn(
                        "text-[11px]",
                        channelMismatch ? "font-semibold text-red-600" : "text-gray-400",
                      )}
                    >
                      · {g.channel_name}
                      {channelMismatch && " (非當前 channel,可能推不出去)"}
                    </span>
                  )}
                </label>
              );
            })}
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

      <Field label="檢查頻率" hint="後端輪詢間隔(分鐘),建議 5–30">
        <input
          type="number"
          min={1}
          max={1440}
          value={pollMinutes}
          onChange={(e) =>
            setPollMinutes(Math.max(1, Math.min(1440, Number(e.target.value) || 10)))
          }
          className="w-24 rounded-md border border-border bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-orange"
        />
      </Field>

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
