import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { Button } from "@/components/Button";
import { toast } from "@/components/Toast";
import { Topbar } from "@/layout/Topbar";
import { cn } from "@/lib/cn";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { LineChannelsContent } from "./LineChannelsContent";
import { LineGroupsContent } from "./LineGroupsContent";

/**
 * LINE 推播設定 — standalone page version of `LineGroupsModal`.
 *
 * Sidebar entry under 工具. Lets operators tidy LINE group labels
 * without first opening Settings or a campaign's push dialog.
 */
export function LinePushSettingsView() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      // Run the two refresh endpoints in parallel:
      //   - groups: re-pulls each group's display name + auto-marks
      //     groups the bot can't see anymore (kicked / 404) as left
      //   - channels: re-pulls each OA's displayName from LINE's
      //     /v2/bot/info so renames in LINE Manager surface here
      // Then refetch all three local queries (channels need it for
      // the「綁定 N 群組」 count + last_webhook_at relative time too).
      const uid = user?.id ?? "";
      const [groupsResult, channelsResult] = await Promise.all([
        api.linePush.refreshAllGroups(uid),
        api.lineChannels.refreshAll(uid),
      ]);
      await Promise.all([
        qc.refetchQueries({ queryKey: ["lineGroups"] }),
        qc.refetchQueries({ queryKey: ["lineGroupConfigs"] }),
        qc.refetchQueries({ queryKey: ["lineChannels"] }),
      ]);
      const parts = [`已更新 ${groupsResult.refreshed} 個群組名稱`];
      if (groupsResult.marked_left > 0)
        parts.push(`移除 ${groupsResult.marked_left} 個已退出群組`);
      if (channelsResult.refreshed > 0)
        parts.push(`更新 ${channelsResult.refreshed} 個官方帳號名稱`);
      toast(parts.join("、"), "success");
    } catch (e) {
      toast(`重新整理失敗:${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <Topbar title="LINE 推播設定">
        <Button
          variant="ghost"
          size="sm"
          title="重新整理"
          aria-label="重新整理"
          onClick={onRefresh}
          disabled={refreshing}
          className="h-10 w-10 justify-center px-0 md:h-[30px] md:w-[30px]"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={cn("block", refreshing && "animate-spin")}
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </Button>
      </Topbar>
      <div className="flex-1 overflow-y-auto bg-bg">
        <div className="mx-auto w-full max-w-[1100px] px-4 py-5 md:px-6 md:py-6">
          <PendingInvitationsBanner />
          {/* LINE 計費規則備註 — 提醒操作者推播額度由 LINE 自己管,
              不是 LURE 方案,避免「我是 Max 為什麼還會被擋」的困惑。 */}
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-orange-border bg-orange-bg/50 px-3 py-2.5 text-[12px] leading-relaxed text-gray-500 md:text-[13px]">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mt-0.5 shrink-0 text-orange"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <div className="flex-1">
              <span className="font-semibold text-ink">推播額度由 LINE 官方計算</span>
              <span className="text-gray-500">
                ,與 LURE 方案無關。LINE 計費規則:**每次推送依收訊人數計則**(推到 30
                人群組 = 30 則),免費方案每月 200 則。如有需要,請至{" "}
              </span>
              <a
                href="https://manager.line.biz/"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-orange hover:underline"
              >
                LINE Official Account Manager
              </a>
              <span className="text-gray-500">調整方案。詳細規則請參考</span>{" "}
              <a
                href="https://tw.linebiz.com/faq/oa-price/message-price-list/"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-orange hover:underline"
              >
                LINE 官方說明
              </a>
              <span className="text-gray-500">。</span>
            </div>
          </div>

          <div className="mb-4">
            <div className="text-[15px] font-bold text-ink">LINE 官方帳號設定</div>
            <div className="mt-0.5 text-[12px] text-gray-500">
              管理可用來推播的 LINE Official Account;每個 OA 各自的 Webhook URL 請貼到 LINE
              Developers Console
            </div>
          </div>
          <LineChannelsContent />

          <div className="mb-4 mt-8">
            <div className="text-[15px] font-bold text-ink">LINE 群組管理</div>
            <div className="mt-0.5 text-[12px] text-gray-500">
              群組由 LINE bot 加入時自動登錄,每個群組屬於收到 join 事件的那個 OA
            </div>
          </div>
          <LineGroupsContent />
        </div>
      </div>
    </>
  );
}

/**
 * Top-of-page banner that surfaces any LINE-OA share invitations the
 * caller has been sent but not yet responded to. Renders nothing when
 * there are no pending invitations, so the page stays clean for the
 * common case. Each row has Accept / Reject buttons that hit the
 * grants accept/reject endpoints and refetch the channel list (so
 * an accepted channel becomes immediately visible below).
 */
function PendingInvitationsBanner() {
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  const qc = useQueryClient();
  const pendingQuery = useQuery({
    queryKey: ["lineChannelPendingInvitations", uid] as const,
    queryFn: async () => (await api.lineChannels.pendingInvitations(uid)).data,
    enabled: !!uid,
    staleTime: 30_000,
  });
  const acceptMutation = useMutation({
    mutationFn: (channelId: string) => api.lineChannels.acceptInvitation(uid, channelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lineChannelPendingInvitations"] });
      qc.invalidateQueries({ queryKey: ["lineChannels"] });
      qc.invalidateQueries({ queryKey: ["lineGroups"] });
    },
  });
  const rejectMutation = useMutation({
    mutationFn: (channelId: string) => api.lineChannels.rejectInvitation(uid, channelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lineChannelPendingInvitations"] });
    },
  });

  const onAccept = async (channelId: string, channelName: string) => {
    try {
      await acceptMutation.mutateAsync(channelId);
      toast(`已加入「${channelName}」`, "success");
    } catch (e) {
      toast(`加入失敗:${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    }
  };
  const onReject = async (channelId: string) => {
    try {
      await rejectMutation.mutateAsync(channelId);
      toast("已拒絕邀請", "info");
    } catch (e) {
      toast(`拒絕失敗:${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    }
  };

  const invites = pendingQuery.data ?? [];
  if (invites.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-orange bg-orange-bg/40 p-3">
      <div className="mb-2 text-[13px] font-bold text-orange">
        你有 {invites.length} 個待確認的官方帳號邀請
      </div>
      <ul className="m-0 flex flex-col gap-1.5 p-0">
        {invites.map((inv) => (
          <li
            key={inv.channel_id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-white px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-ink">
                {inv.channel_name}
              </div>
              <div className="text-[11px] text-gray-500">
                邀請者:<span className="font-mono">{inv.granted_by_fb_user_id}</span>
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onAccept(inv.channel_id, inv.channel_name)}
                disabled={acceptMutation.isPending}
              >
                接受
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onReject(inv.channel_id)}
                disabled={rejectMutation.isPending}
              >
                拒絕
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
