import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useClaimLineChannel,
  useCreateLineChannel,
  useDeleteLineChannel,
  useLineChannelQuota,
  useLineChannels,
  useUpdateLineChannel,
} from "@/api/hooks/useLinePush";
import { useBillingUsage } from "@/api/hooks/useSubscription";
import { Button } from "@/components/Button";
import { confirm } from "@/components/ConfirmDialog";
import { GraceBanner } from "@/components/GraceBanner";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toast";
import { UpgradeModal, type UpgradeModalState } from "@/components/UpgradeModal";
import { cn } from "@/lib/cn";
import { useEffect, useState } from "react";

interface ChannelRow {
  id: string;
  name: string;
  channel_secret_masked: string;
  access_token_masked: string;
  enabled: boolean;
  is_default: boolean;
  is_orphan: boolean;
  is_owner: boolean;
  is_shared: boolean;
  editable: boolean;
  bound_groups_count: number;
  shared_count: number;
  pending_count: number;
  last_webhook_at: string | null;
  webhook_url: string;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "從未接收";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "從未接收";
  const diff = Date.now() - t;
  if (diff < 60_000) return "剛剛";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小時前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/**
 * 「LINE 官方帳號設定」 — manages multiple OAs we can push from.
 * Renders above the group table on the LINE 推播設定 page.
 *
 * Tokens are masked server-side; the edit modal accepts empty
 * secret/token fields meaning "keep existing", so we never have to
 * show or transit the real values once saved. Each row shows the
 * webhook URL the user must paste into LINE Developers Console
 * when adding a new OA.
 */
export function LineChannelsContent() {
  const channelsQuery = useLineChannels();
  const channels = channelsQuery.data ?? [];
  const [editing, setEditing] = useState<ChannelRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState<ChannelRow | null>(null);
  const usageQuery = useBillingUsage();
  const channelCap = usageQuery.data?.limits.line_channels ?? -1;
  const isUnlimited = channelCap < 0 || channelCap >= 999_000;
  // Count user-owned (non-orphan, editable) channels — that's what
  // the backend's _count_line_channels join returns.
  const ownedCount = channels.filter((c) => c.editable).length;
  const atLimit = !isUnlimited && ownedCount >= channelCap;
  const [upgradeState, setUpgradeState] = useState<UpgradeModalState | null>(null);

  const handleAddClick = () => {
    if (atLimit) {
      setUpgradeState({
        resource: "line_channels",
        tier: usageQuery.data?.tier ?? "free",
        limit: channelCap,
      });
      return;
    }
    setCreating(true);
  };

  return (
    <>
      <GraceBanner usage={usageQuery.data} resource="line_channels" />
      <div className="rounded-xl border border-border bg-white">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-bold text-ink">LINE 官方帳號</span>
          {!isUnlimited && (
            <span
              className={cn(
                "text-[11px]",
                atLimit ? "font-semibold text-orange" : "text-gray-400",
              )}
            >
              {ownedCount} / {channelCap}
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={handleAddClick}>
          + 新增官方帳號
        </Button>
      </div>
      <UpgradeModal state={upgradeState} onClose={() => setUpgradeState(null)} />

      {channelsQuery.isLoading ? (
        <div className="px-3 py-4 text-center text-[12px] text-gray-500">載入中...</div>
      ) : channels.length === 0 ? (
        <div className="px-3 py-4 text-center text-[12px] text-gray-500">
          尚未設定官方帳號 — 請先新增至少一個
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {channels.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              onEdit={() => setEditing(c)}
              onShare={() => setSharing(c)}
            />
          ))}
        </ul>
      )}

      {creating && <ChannelEditModal mode="create" onClose={() => setCreating(false)} />}
      {editing && (
        <ChannelEditModal mode="edit" channel={editing} onClose={() => setEditing(null)} />
      )}
      {sharing && <ChannelShareModal channel={sharing} onClose={() => setSharing(null)} />}
      </div>
    </>
  );
}

function ChannelRow({
  channel,
  onEdit,
  onShare,
}: {
  channel: ChannelRow;
  onEdit: () => void;
  onShare: () => void;
}) {
  const deleteMutation = useDeleteLineChannel();
  const claimMutation = useClaimLineChannel();
  const quotaQuery = useLineChannelQuota(channel.id);

  const onCheckQuota = async () => {
    try {
      await quotaQuery.refetch({ throwOnError: true });
    } catch (e) {
      toast(`查詢失敗:${e instanceof Error ? e.message : String(e)}`, "error", 5000);
    }
  };

  const onCopyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(channel.webhook_url);
      toast("已複製 Webhook URL", "success", 2000);
    } catch {
      toast("複製失敗,請手動選取", "error", 3000);
    }
  };

  const onDelete = async () => {
    const n = channel.bound_groups_count;
    if (n > 0) {
      // Surface the constraint upfront via toast — server would 409
      // anyway. The user needs to break the bindings first.
      toast(
        `「${channel.name}」仍綁定 ${n} 個群組,無法刪除。請先讓 LINE bot 退出這些群組或解除全部推播。`,
        "error",
        6000,
      );
      return;
    }
    const ok = await confirm(`確定刪除官方帳號「${channel.name}」？此操作無法復原。`);
    if (!ok) return;
    try {
      await deleteMutation.mutateAsync(channel.id);
      toast("已刪除", "success");
    } catch (e) {
      toast(`刪除失敗:${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    }
  };

  const onClaim = async () => {
    const ok = await confirm(`認領「${channel.name}」這個官方帳號?認領後它會歸屬於你的 FB 帳號。`);
    if (!ok) return;
    try {
      await claimMutation.mutateAsync(channel.id);
      toast("已認領", "success");
    } catch (e) {
      toast(`認領失敗:${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    }
  };

  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      {/* Top row: name + chips on left, action buttons on right */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "truncate text-[13px] font-bold",
              (!channel.enabled || channel.is_orphan) && "text-gray-300",
            )}
          >
            {channel.name}
          </span>
          {channel.is_orphan && (
            <span
              className="shrink-0 whitespace-nowrap rounded-full bg-bg px-1.5 py-[1px] text-[10px] font-semibold text-gray-500"
              title="此官方帳號目前沒有擁有者(舊資料);點認領變成你的"
            >
              未指派
            </span>
          )}
          {!channel.enabled && (
            <span className="shrink-0 whitespace-nowrap rounded-full bg-red-bg px-1.5 py-[1px] text-[10px] font-semibold text-red">
              已停用
            </span>
          )}
          {channel.bound_groups_count > 0 && (
            <span
              className="shrink-0 whitespace-nowrap rounded-full bg-orange-bg px-1.5 py-[1px] text-[10px] font-semibold text-orange"
              title="此官方帳號目前綁定的 LINE 群組數;有綁定就不能刪除"
            >
              綁定 {channel.bound_groups_count} 群組
            </span>
          )}
          {channel.is_shared && (
            <span
              className="shrink-0 whitespace-nowrap rounded-full bg-emerald-50 px-1.5 py-[1px] text-[10px] font-semibold text-emerald-600"
              title="此官方帳號是別的使用者邀請你共同管理的"
            >
              共享中
            </span>
          )}
          {channel.is_owner && channel.shared_count > 0 && (
            <span
              className="shrink-0 whitespace-nowrap rounded-full bg-blue-50 px-1.5 py-[1px] text-[10px] font-semibold text-blue-600"
              title="此官方帳號已共享給其他使用者"
            >
              已共享 {channel.shared_count} 人
            </span>
          )}
          {channel.is_owner && channel.pending_count > 0 && (
            <span
              className="shrink-0 whitespace-nowrap rounded-full bg-amber-50 px-1.5 py-[1px] text-[10px] font-semibold text-amber-600"
              title="尚有受邀者未確認加入"
            >
              {channel.pending_count} 待確認
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {channel.is_orphan ? (
            <button
              type="button"
              onClick={onClaim}
              disabled={claimMutation.isPending}
              className="rounded border border-orange px-1.5 py-0.5 text-[10px] font-semibold text-orange hover:bg-orange-bg disabled:opacity-50"
            >
              {claimMutation.isPending ? "認領中..." : "認領"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onCheckQuota}
                disabled={quotaQuery.isFetching}
                title="向 LINE 即時查詢本月推播用量(LINE Manager 畫面隔天才更新)"
                className="rounded border border-border px-1.5 py-0.5 text-[10px] text-gray-500 hover:border-orange hover:text-orange disabled:opacity-50"
              >
                {quotaQuery.isFetching ? "查詢中..." : "本月用量"}
              </button>
              {channel.is_owner && (
                <button
                  type="button"
                  onClick={onShare}
                  title="共享此官方帳號給其他使用者(他們可以一起管理底下的群組與推播設定)"
                  className="rounded border border-border px-1.5 py-0.5 text-[10px] text-gray-500 hover:border-orange hover:text-orange"
                >
                  共享
                </button>
              )}
              {channel.is_owner && (
                <button
                  type="button"
                  onClick={onEdit}
                  className="rounded border border-border px-1.5 py-0.5 text-[10px] text-gray-500 hover:border-orange hover:text-orange"
                >
                  編輯
                </button>
              )}
              {channel.is_owner && (
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={deleteMutation.isPending}
                  title={
                    channel.bound_groups_count > 0
                      ? "尚有群組綁定,無法刪除"
                      : "刪除此官方帳號"
                  }
                  className={cn(
                    "rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-50",
                    channel.bound_groups_count > 0
                      ? "border-border text-gray-300 hover:border-gray-300"
                      : "border-border text-red hover:border-red hover:bg-red-bg",
                  )}
                >
                  {deleteMutation.isPending ? "刪除中" : "刪除"}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Quota row — only rendered after the user clicks 「本月用量」.
          Shows real-time LINE quota; the 「N 人群組計 N 則」 hint is
          repeated here so operators don't get fooled by 「我才推幾次
          怎麼會吃這麼多」 again. */}
      {quotaQuery.data && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded bg-orange-bg/40 px-2 py-1 text-[11px]">
          <span className="font-semibold text-orange">本月用量</span>
          {quotaQuery.data.type === "none" ? (
            <span className="text-ink">{quotaQuery.data.used.toLocaleString()} 則(無上限)</span>
          ) : (
            <>
              <span className="text-ink">
                <span className="font-bold tabular-nums">
                  {quotaQuery.data.used.toLocaleString()}
                </span>
                {" / "}
                <span className="tabular-nums">
                  {(quotaQuery.data.limit ?? 0).toLocaleString()}
                </span>
              </span>
              <span
                className={cn(
                  "tabular-nums",
                  (quotaQuery.data.remaining ?? 0) <= 0
                    ? "font-semibold text-red"
                    : (quotaQuery.data.remaining ?? 0) < 50
                      ? "font-semibold text-orange"
                      : "text-gray-500",
                )}
              >
                剩 {Math.max(0, quotaQuery.data.remaining ?? 0).toLocaleString()} 則
              </span>
            </>
          )}
          <span className="text-gray-300">
            (LINE 計費:推 N 人群組 = N 則,非 1 則)
          </span>
        </div>
      )}

      {/* Webhook URL row — truncate, with copy button */}
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[10px] text-gray-300">Webhook</span>
        <code
          className="min-w-0 flex-1 truncate rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-gray-500"
          title={channel.webhook_url}
        >
          {channel.webhook_url}
        </code>
        <button
          type="button"
          onClick={onCopyWebhook}
          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-gray-500 hover:border-orange hover:text-orange"
        >
          複製
        </button>
      </div>

      {/* Secret + token masked — short preview only (4 dots + last 4 chars) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-gray-300">
        <span className="whitespace-nowrap">
          secret: <span className="font-mono">{channel.channel_secret_masked || "—"}</span>
        </span>
        <span className="whitespace-nowrap">
          token: <span className="font-mono">{channel.access_token_masked || "—"}</span>
        </span>
        <span
          className={cn(
            "whitespace-nowrap",
            channel.last_webhook_at ? "text-gray-500" : "text-red",
          )}
          title={
            channel.last_webhook_at
              ? `LINE 上次打到我們:${new Date(channel.last_webhook_at).toLocaleString()}`
              : "LINE 從未送 webhook 過來;檢查 LINE Console 的 webhook URL / Use webhook 開關 / 允許加入群組設定"
          }
        >
          webhook: {formatRelative(channel.last_webhook_at)}
        </span>
      </div>
    </li>
  );
}

function ChannelEditModal({
  mode,
  channel,
  onClose,
}: {
  mode: "create" | "edit";
  channel?: ChannelRow;
  onClose: () => void;
}) {
  const createMutation = useCreateLineChannel();
  const updateMutation = useUpdateLineChannel();
  const [name, setName] = useState(channel?.name ?? "");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);

  useEffect(() => {
    if (channel) {
      setName(channel.name);
      setEnabled(channel.enabled);
    }
  }, [channel]);

  const pending = createMutation.isPending || updateMutation.isPending;

  const onSave = async () => {
    if (!name.trim()) {
      toast("請填寫名稱", "error");
      return;
    }
    if (mode === "create" && (!secret.trim() || !token.trim())) {
      toast("新增時 channel secret 與 access token 都必填", "error");
      return;
    }
    try {
      if (mode === "create") {
        await createMutation.mutateAsync({
          name: name.trim(),
          channel_secret: secret.trim(),
          access_token: token.trim(),
          enabled,
          is_default: false,
        });
        toast("已新增官方帳號", "success");
      } else if (channel) {
        await updateMutation.mutateAsync({
          id: channel.id,
          body: {
            name: name.trim(),
            channel_secret: secret.trim(),
            access_token: token.trim(),
            enabled,
            is_default: false,
          },
        });
        toast("已更新", "success");
      }
      onClose();
    } catch (e) {
      toast(`儲存失敗:${e instanceof Error ? e.message : String(e)}`, "error", 4500);
    }
  };

  return (
    <Modal
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={mode === "create" ? "新增 LINE 官方帳號" : `編輯「${channel?.name ?? ""}」`}
      subtitle={
        mode === "edit"
          ? "secret / token 留空代表沿用既有值,只有要換才填"
          : "新增後會產生 webhook URL,請貼到 LINE Developers Console"
      }
    >
      <div className="flex flex-col gap-3 py-1">
        <Field label="名稱">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="例:LURE 主帳號"
            className="h-9 w-full rounded-lg border border-border bg-white px-2.5 text-[13px] outline-none focus:border-orange"
          />
        </Field>
        <Field label="Channel Secret">
          <input
            type="text"
            value={secret}
            onChange={(e) => setSecret(e.currentTarget.value)}
            placeholder={mode === "edit" ? "（保留不變）" : "從 LINE Developers Console 複製"}
            className="h-9 w-full rounded-lg border border-border bg-white px-2.5 font-mono text-[12px] outline-none focus:border-orange"
          />
        </Field>
        <Field label="Channel Access Token">
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
            placeholder={mode === "edit" ? "（保留不變）" : "Long-lived channel access token"}
            className="h-9 w-full rounded-lg border border-border bg-white px-2.5 font-mono text-[12px] outline-none focus:border-orange"
          />
        </Field>
        <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-ink">
          <input
            type="checkbox"
            className="custom-cb"
            checked={enabled}
            onChange={(e) => setEnabled(e.currentTarget.checked)}
          />
          啟用
        </label>
        <div className="mt-1 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={onSave} disabled={pending}>
            {pending ? "儲存中..." : "儲存"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold text-gray-500">{label}</span>
      {children}
    </label>
  );
}

function ChannelShareModal({
  channel,
  onClose,
}: {
  channel: ChannelRow;
  onClose: () => void;
}) {
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  const qc = useQueryClient();
  const grantsQuery = useQuery({
    queryKey: ["lineChannelGrants", uid, channel.id] as const,
    queryFn: async () => (await api.lineChannels.listGrants(uid, channel.id)).data,
    enabled: !!uid,
    staleTime: 30_000,
  });
  const inviteMutation = useMutation({
    mutationFn: (invitee: string) => api.lineChannels.invite(uid, channel.id, invitee),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lineChannelGrants", uid, channel.id] });
      qc.invalidateQueries({ queryKey: ["lineChannels"] });
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (granteeUid: string) =>
      api.lineChannels.revokeGrant(uid, channel.id, granteeUid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lineChannelGrants", uid, channel.id] });
      qc.invalidateQueries({ queryKey: ["lineChannels"] });
    },
  });
  const [inviteId, setInviteId] = useState("");

  const onInvite = async () => {
    const v = inviteId.trim();
    if (!v) {
      toast("請輸入受邀者的 FB User ID", "error");
      return;
    }
    try {
      await inviteMutation.mutateAsync(v);
      setInviteId("");
      toast("已送出邀請,等對方確認", "success");
    } catch (e) {
      toast(`邀請失敗:${e instanceof Error ? e.message : String(e)}`, "error", 5000);
    }
  };

  const onRevoke = async (granteeUid: string) => {
    const ok = await confirm("確定要移除這個共享?對方將立刻失去存取權限");
    if (!ok) return;
    try {
      await revokeMutation.mutateAsync(granteeUid);
      toast("已移除", "success");
    } catch (e) {
      toast(`移除失敗:${e instanceof Error ? e.message : String(e)}`, "error", 5000);
    }
  };

  const grants = grantsQuery.data ?? [];

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title={`共享「${channel.name}」`}
      subtitle="輸入對方的 Facebook User ID 邀請共同管理此 OA。對方確認後即可看到底下的群組與推播設定。"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-gray-500">邀請新使用者</span>
          <div className="flex items-stretch gap-1.5">
            <input
              type="text"
              value={inviteId}
              onChange={(e) => setInviteId(e.currentTarget.value)}
              placeholder="Facebook User ID(對方登入後可在右上角頭像取得)"
              className="flex-1 rounded border border-border bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-orange focus:bg-white"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => void onInvite()}
              disabled={inviteMutation.isPending}
            >
              {inviteMutation.isPending ? "送出中..." : "邀請"}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-gray-500">
            目前共享名單({grants.length})
          </span>
          {grantsQuery.isLoading ? (
            <div className="text-[12px] text-gray-300">載入中...</div>
          ) : grants.length === 0 ? (
            <div className="rounded border border-dashed border-border bg-bg px-3 py-3 text-[12px] text-gray-300">
              尚未邀請任何使用者
            </div>
          ) : (
            <ul className="m-0 flex flex-col gap-1 p-0">
              {grants.map((g) => (
                <li
                  key={g.fb_user_id}
                  className="flex items-center justify-between gap-2 rounded border border-border px-2.5 py-1.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[12px] font-mono text-ink">{g.fb_user_id}</span>
                    <span
                      className={cn(
                        "shrink-0 whitespace-nowrap rounded-full px-1.5 py-[1px] text-[10px] font-semibold",
                        g.status === "accepted"
                          ? "bg-emerald-50 text-emerald-600"
                          : g.status === "pending"
                            ? "bg-amber-50 text-amber-600"
                            : "bg-gray-100 text-gray-500",
                      )}
                    >
                      {g.status === "accepted"
                        ? "已加入"
                        : g.status === "pending"
                          ? "待確認"
                          : "已拒絕"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void onRevoke(g.fb_user_id)}
                    disabled={revokeMutation.isPending}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-red hover:border-red hover:bg-red-bg disabled:opacity-50"
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            關閉
          </Button>
        </div>
      </div>
    </Modal>
  );
}
