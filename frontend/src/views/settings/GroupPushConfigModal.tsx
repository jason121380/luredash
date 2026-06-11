import type {
  LinePushConfig,
  LinePushConfigInput,
  LinePushDateRange,
  LinePushFrequency,
} from "@/api/client";
import { useAccounts } from "@/api/hooks/useAccounts";
import { useAdsets } from "@/api/hooks/useAdsets";
import { useCampaigns } from "@/api/hooks/useCampaigns";
import {
  useDeleteLinePushConfig,
  useLineGroupPushConfigs,
  useSaveLinePushConfig,
} from "@/api/hooks/useLinePush";
import { useNicknames } from "@/api/hooks/useNicknames";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { ReportFieldsPicker } from "@/components/ReportFieldsPicker";
import { toast } from "@/components/Toast";
import { cn } from "@/lib/cn";
import { DEFAULT_REPORT_FIELDS } from "@/lib/reportFields";
import { formatNickname } from "@/views/finance/financeData";
import * as Popover from "@radix-ui/react-popover";
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Group-side push config editor — opened from the LINE 群組管理 table.
 * The group is fixed and the user picks an account → campaign, with
 * substring search on both since we may have 80+ accounts and
 * thousands of campaigns.
 */

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

const DATE_RANGE_OPTIONS: Array<{ value: LinePushDateRange; label: string }> = (() => {
  const today = new Date();
  let monthToYesterdayLabel: string;
  if (today.getDate() === 1) {
    monthToYesterdayLabel = `${today.getMonth() + 1}/1`;
  } else {
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    monthToYesterdayLabel = `${today.getMonth() + 1}/1-${yesterday.getMonth() + 1}/${yesterday.getDate()}`;
  }
  return [
    { value: "yesterday", label: "昨日" },
    { value: "last_7d", label: "過去 7 天" },
    { value: "last_14d", label: "過去 14 天" },
    { value: "last_30d", label: "過去 30 天" },
    { value: "this_month", label: "本月" },
    { value: "month_to_yesterday", label: `本月1日-昨日 (${monthToYesterdayLabel})` },
    { value: "custom", label: "自訂區間" },
  ];
})();

interface GroupPushConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  groupDisplayName: string;
  /** When provided, the modal opens in edit mode pre-filled from this row. */
  editing?: LinePushConfig | null;
}

const FREQS: LinePushFrequency[] = ["daily", "weekly", "biweekly", "monthly"];

/** State for ONE frequency tab. Each frequency maintains its own
 *  enabled flag + schedule; the modal saves all four at once. */
interface PerFreqState {
  /** Existing config id (when this tab was already saved); undefined
   *  → first time enabling this frequency. Drives upsert vs create on
   *  save, and delete-on-disable detection. */
  id?: string;
  enabled: boolean;
  weekdays: number[];
  monthDay: number;
  hour: number;
  minute: number;
  dateRange: LinePushDateRange;
  /** KPI field codes to include in the report. */
  reportFields: string[];
  /** Show「查看完整報告」footer button on the flex card. */
  includeReportButton: boolean;
  /** Render「優化建議」bullet list in the flex body. */
  includeRecommendations: boolean;
  /** ISO YYYY-MM-DD; only meaningful when dateRange === "custom". */
  customFrom: string;
  customTo: string;
}

interface EditorState {
  accountId: string;
  accountName: string;
  campaignId: string;
  /** Cached at the moment the user picks a campaign. Sent on save so
   *  the backend can persist it next to the row, sparing the group
   *  management UI from displaying the bare campaign_id when no
   *  team-wide nickname is set. */
  campaignName: string;
  /** When true, the report is scoped to specific adsets inside the
   *  selected campaign — backend emits a Flex carousel (one bubble
   *  per adset, title = adset name). When false, single bubble at
   *  campaign level (original behaviour). */
  byAdset: boolean;
  /** Adsets the user picked when `byAdset` is true. Empty when
   *  `byAdset` is false. Capped at 10 (LINE carousel limit 12,
   *  enforced server-side). */
  adsetIds: string[];
  /** When true, the report covers multiple campaigns — backend emits
   *  a Flex carousel (one bubble per campaign, title = campaign
   *  nickname/name). Mutually exclusive with `byAdset`. */
  byCampaigns: boolean;
  /** Campaigns picked when `byCampaigns` is true. Capped at 10. */
  campaignIds: string[];
  /** Which tab is currently visible — purely a UI selector, doesn't
   *  affect what gets saved. */
  activeFrequency: LinePushFrequency;
  byFreq: Record<LinePushFrequency, PerFreqState>;
}

const blankFreq = (): PerFreqState => ({
  enabled: false,
  weekdays: [5],
  monthDay: 1,
  hour: 9,
  minute: 0,
  dateRange: "month_to_yesterday",
  reportFields: ["spend_plus", "msgs", "msg_cost"],
  includeReportButton: false,
  includeRecommendations: false,
  customFrom: "",
  customTo: "",
});

const blankState = (): EditorState => ({
  accountId: "",
  accountName: "",
  campaignId: "",
  campaignName: "",
  byAdset: false,
  adsetIds: [],
  byCampaigns: false,
  campaignIds: [],
  activeFrequency: "weekly",
  byFreq: {
    daily: blankFreq(),
    // 新增推播時預設啟用每週,使用者只要選好帳號 / 行銷活動就能直接儲存。
    weekly: { ...blankFreq(), enabled: true },
    biweekly: blankFreq(),
    monthly: blankFreq(),
  },
});

/** Hydrate a PerFreqState from an existing server config row. */
function freqFromConfig(c: LinePushConfig): PerFreqState {
  return {
    id: c.id,
    enabled: c.enabled,
    weekdays: c.weekdays.length ? c.weekdays : [1, 2, 3, 4, 5],
    monthDay: c.month_day ?? 1,
    hour: c.hour,
    minute: c.minute,
    dateRange: c.date_range,
    // Backend stores [] for "use defaults"; surface that as the
    // explicit default list so the UI checkboxes start populated.
    reportFields: c.report_fields?.length ? c.report_fields : [...DEFAULT_REPORT_FIELDS],
    includeReportButton: !!c.include_report_button,
    includeRecommendations: !!c.include_recommendations,
    customFrom: c.date_from ?? "",
    customTo: c.date_to ?? "",
  };
}

export function GroupPushConfigModal({
  open,
  onOpenChange,
  groupId,
  groupDisplayName,
  editing,
}: GroupPushConfigModalProps) {
  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data ?? [];
  const nicknamesQuery = useNicknames();
  const nicknames = nicknamesQuery.data ?? {};
  const saveMutation = useSaveLinePushConfig();
  const [state, setState] = useState<EditorState>(() => blankState());
  const deleteMutation = useDeleteLinePushConfig();

  // Pull all configs for this group so we can find sibling rows
  // (same group, same campaign, different frequency) and pre-fill
  // each frequency tab with its current state.
  const groupConfigsQuery = useLineGroupPushConfigs(open ? groupId : null);
  const groupConfigs = groupConfigsQuery.data ?? [];

  // Sync from editing prop on open. Reset on close.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      const acct = accounts.find((a) => a.id === editing.account_id);
      const editingAdsetIds = editing.adset_ids ?? [];
      const editingCampaignIds = editing.campaign_ids ?? [];
      setState({
        accountId: editing.account_id,
        accountName: acct?.name ?? "",
        campaignId: editing.campaign_id,
        campaignName: editing.campaign_name ?? "",
        byAdset: editingAdsetIds.length > 0,
        adsetIds: [...editingAdsetIds],
        byCampaigns: editingCampaignIds.length > 0,
        campaignIds: [...editingCampaignIds],
        activeFrequency: editing.frequency,
        byFreq: {
          daily: blankFreq(),
          weekly: blankFreq(),
          biweekly: blankFreq(),
          monthly: blankFreq(),
          [editing.frequency]: freqFromConfig(editing),
        },
      });
    } else {
      setState(blankState());
    }
  }, [open, editing, accounts]);

  // Whenever (campaignId, groupConfigs) change, populate any other
  // frequency tabs that already have a saved sibling config. This
  // handles two cases:
  //   1. Edit mode (single freq pre-filled by the effect above), then
  //      sibling fetch resolves → populate the other tabs too.
  //   2. New mode where the user picks a campaign that already has
  //      some configs in this group → those tabs auto-populate.
  // We only OVERWRITE tabs that haven't been edited yet (id matches
  // server OR enabled is still false with default values), so user
  // edits aren't clobbered.
  useEffect(() => {
    if (!open) return;
    if (!state.campaignId) return;
    const siblings = groupConfigs.filter((c) => c.campaign_id === state.campaignId);
    if (siblings.length === 0) return;
    setState((prev) => {
      const next = { ...prev, byFreq: { ...prev.byFreq } };
      for (const c of siblings) {
        const cur = next.byFreq[c.frequency];
        // Only hydrate if this tab hasn't been touched (no id and
        // still default-disabled). A tab that the user already edited
        // will have either an id or enabled=true, both of which we
        // preserve.
        if (!cur.id && !cur.enabled) {
          next.byFreq[c.frequency] = freqFromConfig(c);
        }
      }
      return next;
    });
  }, [open, state.campaignId, groupConfigs]);

  const active = state.byFreq[state.activeFrequency];
  const updateActive = (patch: Partial<PerFreqState>) =>
    setState((prev) => ({
      ...prev,
      byFreq: {
        ...prev.byFreq,
        [prev.activeFrequency]: { ...prev.byFreq[prev.activeFrequency], ...patch },
      },
    }));

  const toggleWeekday = (d: number) => {
    const set = new Set(active.weekdays);
    if (set.has(d)) set.delete(d);
    else set.add(d);
    updateActive({ weekdays: [...set].sort((a, b) => a - b) });
  };

  const save = async () => {
    if (!state.accountId) {
      toast("請選擇廣告帳號", "error");
      return;
    }
    if (!state.campaignId) {
      toast("請選擇行銷活動", "error");
      return;
    }
    const enabledFreqs = FREQS.filter((f) => state.byFreq[f].enabled);
    const toDelete = FREQS.filter((f) => !state.byFreq[f].enabled && state.byFreq[f].id);
    if (enabledFreqs.length === 0 && toDelete.length === 0) {
      toast("至少啟用一個推播頻率", "error");
      return;
    }
    try {
      // 先刪除被取消勾選的舊 config
      for (const f of toDelete) {
        const id = state.byFreq[f].id;
        if (id) await deleteMutation.mutateAsync(id);
      }
      // 自訂區間驗證 — 兩端都必填,且 from ≤ to
      for (const f of enabledFreqs) {
        const s = state.byFreq[f];
        if (s.dateRange === "custom") {
          if (!s.customFrom || !s.customTo) {
            toast(`「${tabLabel(f)}」自訂區間需要起訖日期`, "error");
            return;
          }
          if (s.customFrom > s.customTo) {
            toast(`「${tabLabel(f)}」自訂區間起始日不能晚於結束日`, "error");
            return;
          }
        }
      }
      // 廣告組合模式驗證 — 開啟「以廣告組合播報」就必須至少選一個。
      const effectiveAdsetIds = state.byAdset ? state.adsetIds : [];
      if (state.byAdset && effectiveAdsetIds.length === 0) {
        toast("已勾選「以廣告組合播報」,請至少選一個廣告組合", "error");
        return;
      }
      // 行銷活動模式驗證 — 同上,且與廣告組合模式互斥(UI 已強制)。
      const effectiveCampaignIds = state.byCampaigns ? state.campaignIds : [];
      if (state.byCampaigns && effectiveCampaignIds.length === 0) {
        toast("已勾選「以行銷活動播報」,請至少選一個行銷活動", "error");
        return;
      }
      // 再 upsert 啟用的 config(每個頻率一筆)
      for (const f of enabledFreqs) {
        const s = state.byFreq[f];
        const payload: LinePushConfigInput = {
          id: s.id,
          campaign_id: state.campaignId,
          account_id: state.accountId,
          group_id: groupId,
          frequency: f,
          weekdays: f === "weekly" || f === "biweekly" ? s.weekdays : [],
          month_day: f === "monthly" ? s.monthDay : null,
          hour: s.hour,
          minute: s.minute,
          date_range: s.dateRange,
          enabled: true,
          report_fields: s.reportFields,
          include_report_button: s.includeReportButton,
          include_recommendations: s.includeRecommendations,
          campaign_name: state.campaignName,
          adset_ids: effectiveAdsetIds,
          campaign_ids: effectiveCampaignIds,
          ...(s.dateRange === "custom"
            ? { date_from: s.customFrom, date_to: s.customTo }
            : {}),
        };
        await saveMutation.mutateAsync(payload);
      }
      toast("已儲存推播設定", "success");
      onOpenChange(false);
    } catch (e) {
      toast(`儲存失敗：${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "編輯推播設定" : "新增推播設定"}
      subtitle={`群組:${groupDisplayName}`}
      width={520}
    >
      <div className="flex flex-col gap-3">
        {/* Account picker */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-ink">廣告帳號</span>
          <SearchableCombobox
            items={accounts.map((a) => ({
              value: a.id,
              primary: a.name,
              secondary: a.id,
              raw: a,
            }))}
            value={state.accountId}
            onChange={(v, raw) => {
              setState((prev) => ({
                ...prev,
                accountId: v,
                accountName: raw?.name ?? "",
                // Reset campaign + per-freq state when account changes
                // (avoid orphaned id + stale sibling data).
                campaignId: prev.accountId === v ? prev.campaignId : "",
                byAdset: prev.accountId === v ? prev.byAdset : false,
                adsetIds: prev.accountId === v ? prev.adsetIds : [],
                byCampaigns: prev.accountId === v ? prev.byCampaigns : false,
                campaignIds: prev.accountId === v ? prev.campaignIds : [],
                byFreq:
                  prev.accountId === v
                    ? prev.byFreq
                    : {
                        daily: blankFreq(),
                        weekly: blankFreq(),
                        biweekly: blankFreq(),
                        monthly: blankFreq(),
                      },
              }));
            }}
            placeholder="搜尋廣告帳號名稱或 ID"
            triggerEmpty="請選擇廣告帳號"
          />
        </div>

        {/* Campaign picker */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-ink">行銷活動</span>
          <CampaignPicker
            accountId={state.accountId}
            accountName={state.accountName}
            value={state.campaignId}
            onChange={(v, name) =>
              setState((prev) => ({
                ...prev,
                campaignId: v,
                campaignName: name,
                // Adset selection is campaign-scoped, so reset
                // whenever the user picks a different campaign.
                byAdset: prev.campaignId === v ? prev.byAdset : false,
                adsetIds: prev.campaignId === v ? prev.adsetIds : [],
                // Re-blank per-freq state when campaign changes so the
                // hydration effect can re-populate from the new
                // campaign's siblings.
                byFreq:
                  prev.campaignId === v
                    ? prev.byFreq
                    : {
                        daily: blankFreq(),
                        weekly: blankFreq(),
                        biweekly: blankFreq(),
                        monthly: blankFreq(),
                      },
              }))
            }
            nicknames={nicknames}
          />
        </div>

        {/* Campaign scoping (以行銷活動播報) — one carousel bubble per
            selected campaign. Mutually exclusive with the adset mode
            below: checking one force-unchecks the other (backend
            rejects configs that set both). */}
        {state.campaignId && (
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-[13px] text-ink">
              <input
                type="checkbox"
                className="custom-cb"
                checked={state.byCampaigns}
                onChange={(e) => {
                  const next = e.currentTarget.checked;
                  setState((prev) => ({
                    ...prev,
                    byCampaigns: next,
                    campaignIds: next ? prev.campaignIds : [],
                    byAdset: next ? false : prev.byAdset,
                    adsetIds: next ? [] : prev.adsetIds,
                  }));
                }}
              />
              以行銷活動播報
            </label>
            {state.byCampaigns && (
              <CampaignMultiPicker
                accountId={state.accountId}
                accountName={state.accountName}
                value={state.campaignIds}
                onChange={(ids) => setState((prev) => ({ ...prev, campaignIds: ids }))}
                nicknames={nicknames}
              />
            )}
          </div>
        )}

        {/* Adset scoping — only meaningful after a campaign is picked.
            Checkbox toggles the multi-select; backend emits a Flex
            carousel (one bubble per adset) when adset_ids is non-empty. */}
        {state.campaignId && (
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-[13px] text-ink">
              <input
                type="checkbox"
                className="custom-cb"
                checked={state.byAdset}
                onChange={(e) => {
                  const next = e.currentTarget.checked;
                  setState((prev) => ({
                    ...prev,
                    byAdset: next,
                    // Clear selection when turning off so a follow-up
                    // turn-on starts fresh; preserve on turn-on so the
                    // user can toggle without losing picks.
                    adsetIds: next ? prev.adsetIds : [],
                    byCampaigns: next ? false : prev.byCampaigns,
                    campaignIds: next ? [] : prev.campaignIds,
                  }));
                }}
              />
              以廣告組合播報
            </label>
            {state.byAdset && (
              <AdsetMultiPicker
                campaignId={state.campaignId}
                value={state.adsetIds}
                onChange={(ids) => setState((prev) => ({ ...prev, adsetIds: ids }))}
              />
            )}
          </div>
        )}

        {/* Frequency tabs — each tab carries its own enabled state.
            Active tab gets orange fill; enabled tabs (incl. inactive)
            get a small dot to signal they'll be saved. */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-ink">推播頻率</span>
          <div className="flex gap-1.5">
            {FREQS.map((f) => {
              const tabEnabled = state.byFreq[f].enabled;
              const isActive = state.activeFrequency === f;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setState((prev) => ({ ...prev, activeFrequency: f }))}
                  className={cn(
                    "relative h-8 flex-1 rounded-lg border border-border px-2 text-[12px] font-semibold",
                    isActive
                      ? "border-orange bg-orange-bg text-orange"
                      : tabEnabled
                        ? "border-orange/40 bg-white text-orange"
                        : "bg-white text-gray-500 hover:border-orange",
                  )}
                >
                  {f === "daily"
                    ? "每日"
                    : f === "weekly"
                      ? "每週"
                      : f === "biweekly"
                        ? "雙週"
                        : "每月"}
                  {tabEnabled && (
                    <span
                      aria-hidden="true"
                      className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-orange"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {(state.activeFrequency === "weekly" || state.activeFrequency === "biweekly") && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-ink">星期</span>
            <div className="flex gap-1">
              {WEEKDAY_LABELS.map((lbl, idx) => {
                const isActive = active.weekdays.includes(idx);
                return (
                  <button
                    key={lbl}
                    type="button"
                    onClick={() => toggleWeekday(idx)}
                    className={cn(
                      "h-8 w-8 rounded-lg border border-border text-[12px] font-semibold",
                      isActive
                        ? "border-orange bg-orange-bg text-orange"
                        : "bg-white text-gray-500 hover:border-orange",
                    )}
                  >
                    {lbl}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {state.activeFrequency === "monthly" && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-ink">每月幾號 (1-28)</span>
            <input
              type="number"
              min={1}
              max={28}
              value={active.monthDay}
              onChange={(e) =>
                updateActive({
                  monthDay: Math.max(
                    1,
                    Math.min(28, Number.parseInt(e.currentTarget.value, 10) || 1),
                  ),
                })
              }
              className="h-9 w-24 rounded-lg border border-border px-2.5 text-[13px] outline-none focus:border-orange"
            />
          </label>
        )}

        {/* Time */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-ink">推播時間(台北)</span>
          <div className="flex items-center gap-1.5">
            <select
              value={active.hour}
              onChange={(e) => updateActive({ hour: Number.parseInt(e.currentTarget.value, 10) })}
              className="h-9 rounded-lg border border-border bg-white px-2.5 text-[13px] outline-none focus:border-orange"
            >
              {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}
                </option>
              ))}
            </select>
            <span className="text-[13px] text-gray-500">:</span>
            <select
              value={active.minute}
              onChange={(e) => updateActive({ minute: Number.parseInt(e.currentTarget.value, 10) })}
              className="h-9 rounded-lg border border-border bg-white px-2.5 text-[13px] outline-none focus:border-orange"
            >
              {[0, 15, 30, 45].map((m) => (
                <option key={m} value={m}>
                  {String(m).padStart(2, "0")}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Date range */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-ink">報告資料區間</span>
          <select
            value={active.dateRange}
            onChange={(e) =>
              updateActive({ dateRange: e.currentTarget.value as LinePushDateRange })
            }
            className="h-9 rounded-lg border border-border bg-white px-2.5 text-[13px] outline-none focus:border-orange"
          >
            {DATE_RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {/* Custom date range — only shown when 自訂區間 is selected.
            FB requires both ends; we send YYYY-MM-DD on save. */}
        {active.dateRange === "custom" && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-ink">起始日</span>
              <input
                type="date"
                value={active.customFrom}
                onChange={(e) => updateActive({ customFrom: e.currentTarget.value })}
                className="h-9 rounded-lg border border-border bg-white px-2.5 text-[13px] outline-none focus:border-orange"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-ink">結束日</span>
              <input
                type="date"
                value={active.customTo}
                onChange={(e) => updateActive({ customTo: e.currentTarget.value })}
                className="h-9 rounded-lg border border-border bg-white px-2.5 text-[13px] outline-none focus:border-orange"
              />
            </label>
          </div>
        )}

        {/* Report fields multi-select — per-tab. Each frequency can
            include a different set of KPIs in its flex report. */}
        <ReportFieldsPicker
          value={active.reportFields}
          onChange={(next) => updateActive({ reportFields: next })}
        />

        {/* Footer report-button toggle. Default off so old configs keep
            their "no button" behaviour after migration. */}
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            className="custom-cb"
            checked={active.includeReportButton}
            onChange={(e) => updateActive({ includeReportButton: e.currentTarget.checked })}
          />
          是否出現按鈕
        </label>

        {/* Recommendations toggle. Default off — many recipients are
            external (業主) and only want raw numbers. */}
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            className="custom-cb"
            checked={active.includeRecommendations}
            onChange={(e) => updateActive({ includeRecommendations: e.currentTarget.checked })}
          />
          是否啟用優化建議
        </label>

        {/* Enabled — per-tab. Drives both create-on-save and
            delete-on-save (a tab that was previously enabled but is
            now unchecked → its config gets deleted). */}
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            className="custom-cb"
            checked={active.enabled}
            onChange={(e) => updateActive({ enabled: e.currentTarget.checked })}
          />
          啟用此推播 ({tabLabel(state.activeFrequency)})
        </label>

        {/* Actions */}
        <div className="mt-1 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={saveMutation.isPending || deleteMutation.isPending}
          >
            {saveMutation.isPending || deleteMutation.isPending ? "儲存中..." : "儲存"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CampaignPicker({
  accountId,
  accountName,
  value,
  onChange,
  nicknames,
}: {
  accountId: string;
  accountName: string;
  value: string;
  onChange: (campaignId: string, campaignName: string) => void;
  nicknames: Record<string, { store: string; designer: string }>;
}) {
  // Always last-30d for the picker — we just need the campaign list
  // for selection, not insights for display.
  const campaignsQuery = useCampaigns(
    accountId || undefined,
    accountName || undefined,
    { preset: "last_30d", from: null, to: null },
    { includeArchived: true },
  );
  const campaigns = campaignsQuery.data ?? [];

  const items = useMemo(() => {
    return campaigns.map((c) => {
      const nick = formatNickname(nicknames[c.id]);
      return {
        value: c.id,
        primary: nick ?? c.name ?? c.id,
        secondary: nick ? c.name : c.id,
        badge: <Badge status={c.status} />,
        raw: c,
      };
    });
  }, [campaigns, nicknames]);

  return (
    <SearchableCombobox
      items={items}
      value={value}
      onChange={(v, raw) => {
        // raw is the FbCampaign object — capture name so the modal
        // can persist it to the row at save-time.
        const c = raw as { name?: string } | undefined;
        onChange(v, c?.name ?? "");
      }}
      placeholder="搜尋行銷活動暱稱、名稱或 ID"
      triggerEmpty={accountId ? "請選擇行銷活動" : "請先選擇廣告帳號"}
      disabled={!accountId || campaignsQuery.isLoading}
      loadingText={campaignsQuery.isLoading ? "載入行銷活動中..." : undefined}
    />
  );
}

/** Multi-select picker for campaigns under the account (以行銷活動
 *  播報). Mirrors AdsetMultiPicker: search, per-row status badge,
 *  capped at 10 (LINE carousel limit is 12 — headroom kept). Shows
 *  the team nickname as the primary label when one is set, same as
 *  the single CampaignPicker above. */
function CampaignMultiPicker({
  accountId,
  accountName,
  value,
  onChange,
  nicknames,
}: {
  accountId: string;
  accountName: string;
  value: string[];
  onChange: (ids: string[]) => void;
  nicknames: Record<string, { store: string; designer: string }>;
}) {
  // Same data source as the single CampaignPicker — last-30d, names +
  // status only, archived included.
  const campaignsQuery = useCampaigns(
    accountId || undefined,
    accountName || undefined,
    { preset: "last_30d", from: null, to: null },
    { includeArchived: true },
  );
  const campaigns = campaignsQuery.data ?? [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const t = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  const rows = useMemo(
    () =>
      campaigns.map((c) => {
        const nick = formatNickname(nicknames[c.id]);
        return {
          id: c.id,
          primary: nick ?? c.name ?? c.id,
          secondary: nick ? (c.name ?? c.id) : c.id,
          status: c.status,
        };
      }),
    [campaigns, nicknames],
  );

  const selected = useMemo(() => new Set(value), [value]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.primary.toLowerCase().includes(q) ||
        r.secondary.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const toggle = (id: string) => {
    if (selected.has(id)) {
      onChange(value.filter((v) => v !== id));
      return;
    }
    if (value.length >= 10) {
      toast("最多選 10 個行銷活動(LINE carousel 限制)", "info");
      return;
    }
    onChange([...value, id]);
  };

  const triggerLabel = (() => {
    if (value.length === 0) return "請選擇行銷活動";
    if (value.length === 1) {
      const one = rows.find((r) => r.id === value[0]);
      return one?.primary ?? value[0] ?? "";
    }
    return `已選 ${value.length} 個行銷活動`;
  })();

  const disabled = !accountId || campaignsQuery.isLoading;
  const loadingText = campaignsQuery.isLoading ? "載入行銷活動中..." : undefined;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-white px-2.5 text-left text-[13px] outline-none focus:border-orange disabled:bg-bg disabled:text-gray-300",
            value.length === 0 && !disabled && "text-gray-300",
          )}
        >
          <span className="truncate">{loadingText ?? triggerLabel}</span>
          <span className="shrink-0 text-gray-300">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-[1100] w-[var(--radix-popover-trigger-width)] rounded-xl border border-border bg-white p-2 shadow-md"
        >
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="搜尋行銷活動名稱或 ID"
            className="mb-2 h-9 w-full rounded-lg border border-border px-2.5 text-[13px] outline-none focus:border-orange"
          />
          <div className="flex items-center justify-between px-1 pb-1 text-[11px] text-gray-300">
            <span>
              {filtered.length} / {rows.length}
            </span>
            <span>已選 {value.length} / 10</span>
          </div>
          <div
            className="max-h-[260px] overflow-y-auto overscroll-contain"
            style={{ touchAction: "pan-y", WebkitOverflowScrolling: "touch" }}
            onWheel={(e) => {
              const el = e.currentTarget;
              const max = el.scrollHeight - el.clientHeight;
              const next = Math.max(0, Math.min(max, el.scrollTop + e.deltaY));
              if (next !== el.scrollTop) {
                el.scrollTop = next;
                e.stopPropagation();
              }
            }}
          >
            {campaignsQuery.isLoading ? (
              <div className="px-2 py-3 text-center text-[12px] text-gray-300">載入中...</div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-[12px] text-gray-300">
                {rows.length === 0 ? "此帳戶沒有行銷活動" : "無符合的項目"}
              </div>
            ) : (
              filtered.map((r) => {
                const checked = selected.has(r.id);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => toggle(r.id)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left",
                      checked ? "bg-orange-bg text-orange" : "text-ink hover:bg-orange-bg",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="custom-cb mt-0.5 pointer-events-none"
                      checked={checked}
                      readOnly
                      tabIndex={-1}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex w-full items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                          {r.primary}
                        </span>
                        <Badge status={r.status} />
                      </span>
                      <span className="w-full truncate font-mono text-[10px] text-gray-300">
                        {r.secondary}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Multi-select picker for the adsets under a campaign. Capped at 10
 *  (server enforces; LINE carousel limit is 12 — we leave headroom).
 *  Status badge per adset so operators can avoid binding to paused
 *  rows, mirroring `CampaignPicker`'s combobox decoration. */
function AdsetMultiPicker({
  campaignId,
  value,
  onChange,
}: {
  campaignId: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  // Always last-30d for the picker — we only need names + status
  // metadata; spend / insights aren't surfaced here, so we don't pay
  // the FB cost of richer queries.
  const adsetsQuery = useAdsets(
    campaignId || null,
    { preset: "last_30d", from: null, to: null },
    !!campaignId,
    { source: "line-push-adset-picker", budgetOnly: true },
  );
  const adsets = adsetsQuery.data ?? [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const t = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  const selected = useMemo(() => new Set(value), [value]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return adsets;
    return adsets.filter(
      (a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q),
    );
  }, [adsets, query]);

  const toggle = (id: string) => {
    if (selected.has(id)) {
      onChange(value.filter((v) => v !== id));
      return;
    }
    if (value.length >= 10) {
      toast("最多選 10 個廣告組合(LINE carousel 限制)", "info");
      return;
    }
    onChange([...value, id]);
  };

  const triggerLabel = (() => {
    if (value.length === 0) return "請選擇廣告組合";
    if (value.length === 1) {
      const one = adsets.find((a) => a.id === value[0]);
      return one?.name ?? value[0] ?? "";
    }
    return `已選 ${value.length} 個廣告組合`;
  })();

  const disabled = !campaignId || adsetsQuery.isLoading;
  const loadingText = adsetsQuery.isLoading ? "載入廣告組合中..." : undefined;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-white px-2.5 text-left text-[13px] outline-none focus:border-orange disabled:bg-bg disabled:text-gray-300",
            value.length === 0 && !disabled && "text-gray-300",
          )}
        >
          <span className="truncate">{loadingText ?? triggerLabel}</span>
          <span className="shrink-0 text-gray-300">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-[1100] w-[var(--radix-popover-trigger-width)] rounded-xl border border-border bg-white p-2 shadow-md"
        >
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="搜尋廣告組合名稱或 ID"
            className="mb-2 h-9 w-full rounded-lg border border-border px-2.5 text-[13px] outline-none focus:border-orange"
          />
          <div className="flex items-center justify-between px-1 pb-1 text-[11px] text-gray-300">
            <span>
              {filtered.length} / {adsets.length}
            </span>
            <span>已選 {value.length} / 10</span>
          </div>
          <div
            // Same touch/wheel handling as SearchableCombobox so the
            // picker scrolls smoothly inside a mobile Modal.
            className="max-h-[260px] overflow-y-auto overscroll-contain"
            style={{ touchAction: "pan-y", WebkitOverflowScrolling: "touch" }}
            onWheel={(e) => {
              const el = e.currentTarget;
              const max = el.scrollHeight - el.clientHeight;
              const next = Math.max(0, Math.min(max, el.scrollTop + e.deltaY));
              if (next !== el.scrollTop) {
                el.scrollTop = next;
                e.stopPropagation();
              }
            }}
          >
            {adsetsQuery.isLoading ? (
              <div className="px-2 py-3 text-center text-[12px] text-gray-300">
                載入中...
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-[12px] text-gray-300">
                {adsets.length === 0 ? "此活動沒有廣告組合" : "無符合的項目"}
              </div>
            ) : (
              filtered.map((a) => {
                const checked = selected.has(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggle(a.id)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left",
                      checked ? "bg-orange-bg text-orange" : "text-ink hover:bg-orange-bg",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="custom-cb mt-0.5 pointer-events-none"
                      checked={checked}
                      readOnly
                      tabIndex={-1}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex w-full items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                          {a.name}
                        </span>
                        <Badge status={a.status} />
                      </span>
                      <span className="w-full truncate font-mono text-[10px] text-gray-300">
                        {a.id}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function tabLabel(f: LinePushFrequency): string {
  return f === "daily" ? "每日" : f === "weekly" ? "每週" : f === "biweekly" ? "雙週" : "每月";
}

interface ComboItem<T = unknown> {
  value: string;
  primary: string;
  secondary?: string;
  badge?: React.ReactNode;
  raw?: T;
}

function SearchableCombobox<T>({
  items,
  value,
  onChange,
  placeholder,
  triggerEmpty,
  disabled = false,
  loadingText,
}: {
  items: ComboItem<T>[];
  value: string;
  onChange: (v: string, raw: T | undefined) => void;
  placeholder: string;
  triggerEmpty: string;
  disabled?: boolean;
  loadingText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const t = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      return (
        it.primary.toLowerCase().includes(q) ||
        (it.secondary ?? "").toLowerCase().includes(q) ||
        it.value.toLowerCase().includes(q)
      );
    });
  }, [items, query]);

  const selected = items.find((it) => it.value === value) ?? null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-white px-2.5 text-left text-[13px] outline-none focus:border-orange disabled:bg-bg disabled:text-gray-300",
            !selected && !disabled && "text-gray-300",
          )}
        >
          <span className="truncate">{loadingText ?? selected?.primary ?? triggerEmpty}</span>
          <span className="shrink-0 text-gray-300">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-[1100] w-[var(--radix-popover-trigger-width)] rounded-xl border border-border bg-white p-2 shadow-md"
        >
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={placeholder}
            className="mb-2 h-9 w-full rounded-lg border border-border px-2.5 text-[13px] outline-none focus:border-orange"
          />
          <div className="px-1 pb-1 text-[11px] text-gray-300">
            {filtered.length} / {items.length}
          </div>
          <div
            // 行動裝置:Popover 開在 bottom-sheet Modal 內時,沒設
            // touch-action / overscroll-behavior 會讓內部捲動被外層
            // modal 攔截,使用者捲不動清單。`pan-y` 明確告訴瀏覽器
            // 此區允許垂直手勢;`contain` 讓捲動到頂/底時不再傳播
            // 給外層,避免 Modal 跟著上下滑。
            //
            // 桌面:某些情況下 Radix Dialog 會把 wheel 事件擋下,
            // 我們直接接管 wheel 事件、手動更新 scrollTop,並
            // stopPropagation 確保事件不會冒泡到外層 modal。
            className="max-h-[260px] overflow-y-auto overscroll-contain"
            style={{ touchAction: "pan-y", WebkitOverflowScrolling: "touch" }}
            onWheel={(e) => {
              const el = e.currentTarget;
              const max = el.scrollHeight - el.clientHeight;
              const next = Math.max(0, Math.min(max, el.scrollTop + e.deltaY));
              if (next !== el.scrollTop) {
                el.scrollTop = next;
                e.stopPropagation();
              }
            }}
          >
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-[12px] text-gray-300">無符合的項目</div>
            ) : (
              filtered.map((it) => {
                const active = it.value === value;
                return (
                  <button
                    key={it.value}
                    type="button"
                    onClick={() => {
                      onChange(it.value, it.raw);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left",
                      active ? "bg-orange-bg text-orange" : "text-ink hover:bg-orange-bg",
                    )}
                  >
                    <span className="flex w-full items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                        {it.primary}
                      </span>
                      {it.badge}
                    </span>
                    {it.secondary && (
                      <span className="w-full truncate font-mono text-[10px] text-gray-300">
                        {it.secondary}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
