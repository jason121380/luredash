import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { Button } from "@/components/Button";
import { toast } from "@/components/Toast";
import { Topbar } from "@/layout/Topbar";
import { cn } from "@/lib/cn";
import { useQueryClient } from "@tanstack/react-query";
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
      // Bulk refresh first — re-pulls each group's display name from
      // LINE AND auto-marks groups the bot can't see anymore (kicked
      // / 404) as left, so they drop out of the next GET. Then
      // refetch the local queries to reflect the new DB state.
      const result = await api.linePush.refreshAllGroups(user?.id ?? "");
      await Promise.all([
        qc.refetchQueries({ queryKey: ["lineGroups"] }),
        qc.refetchQueries({ queryKey: ["lineGroupConfigs"] }),
      ]);
      const parts = [`已更新 ${result.refreshed} 個群組名稱`];
      if (result.marked_left > 0) parts.push(`移除 ${result.marked_left} 個已退出群組`);
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
                href="https://www.linebiz.com/tw/service/line-official-account/plan/"
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
