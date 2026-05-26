import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { Modal } from "@/components/Modal";
import { cn } from "@/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

// `readScanHistory` / `appendScanHistory` (the previous localStorage
// API) were removed once we cut over to backend-stored
// `security_scan_records`. If anything still imports them after this
// migration it'd be a callsite we missed — failing fast at the type
// layer is the right behavior.

/**
 * 掃描紀錄 modal — reads from PG `security_scan_records` via
 * `/api/security-scan/records`. Cross-device:同一個 FB 帳號從任何
 * 裝置登入都看到一樣的紀錄。
 *
 * Two trigger types displayed:
 *   - 自動 (auto):scheduler tick 跑出的(來自 security_push_tick)
 *   - 手動 (manual):user 按「立即掃描」(SecurityMonitorView POST)
 *
 * Cards are sorted newest-first; expanding a card shows the actual
 * match list (campaign names + anomaly tags + creator info if stored).
 */

const ANOMALY_LABEL: Record<string, string> = {
  deep_night: "深夜創建",
  weekend: "週末創建",
  high_budget: "日預算>$2k",
  burst: "短時間多筆",
  abnormal_language: "異常語言",
};

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${Math.max(0, sec)} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  return new Date(ts).toLocaleDateString("zh-TW");
}

function formatExact(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function ScanHistoryModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  const [filter, setFilter] = useState<"all" | "auto" | "manual">("all");

  const query = useQuery({
    queryKey: ["security-scan-records", uid, filter],
    queryFn: async () => {
      if (!uid) return [];
      const resp = await api.securityScan.listRecords(
        uid,
        50,
        filter === "all" ? undefined : filter,
      );
      return resp.data ?? [];
    },
    enabled: !!uid && open,
    staleTime: 30_000,
  });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const records = useMemo(() => query.data ?? [], [query.data]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="掃描紀錄"
      subtitle="跨裝置同步 · 同一個 FB 帳號登入哪台機器都看得到。最多 50 筆。"
      width={640}
    >
      <div className="mb-3 flex items-center gap-1">
        {(["all", "manual", "auto"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setFilter(t)}
            className={cn(
              "rounded-full px-3 py-1 text-[12px] font-medium",
              filter === t
                ? "bg-orange text-white"
                : "bg-bg text-gray-500 hover:bg-orange-bg hover:text-orange",
            )}
          >
            {t === "all" ? "全部" : t === "manual" ? "手動立即掃描" : "自動排程"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="ml-auto rounded-full bg-bg px-3 py-1 text-[12px] text-gray-500 hover:bg-orange-bg hover:text-orange disabled:opacity-50"
        >
          {query.isFetching ? "更新中…" : "重新整理"}
        </button>
      </div>

      {query.isLoading ? (
        <div className="py-8 text-center text-[13px] text-gray-500">載入中…</div>
      ) : records.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-gray-500">
          尚無紀錄。點安全監控頁面的「立即掃描」開始累積。
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {records.map((r) => {
            const isOpen = expanded.has(r.id);
            return (
              <li
                key={r.id}
                className="rounded-lg border border-border bg-bg text-[12px]"
              >
                <button
                  type="button"
                  onClick={() => toggle(r.id)}
                  className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2 text-left hover:bg-orange-bg/30"
                >
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-[1px] text-[10px] font-semibold",
                      r.trigger_type === "manual"
                        ? "bg-orange-bg text-orange"
                        : "bg-cyan-50 text-cyan-700",
                    )}
                  >
                    {r.trigger_type === "manual" ? "手動" : "自動"}
                  </span>
                  <span className="font-semibold text-ink" title={formatExact(r.scanned_at)}>
                    {formatRelative(r.scanned_at)}
                  </span>
                  <span className="font-mono text-[10px] text-gray-400">
                    {formatExact(r.scanned_at)}
                  </span>
                  <span className="ml-auto text-gray-500">
                    {r.account_ids.length} 帳戶 · {r.matches_count} 異常 ·{" "}
                    {(r.duration_ms / 1000).toFixed(1)}s
                  </span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={cn(
                      "shrink-0 text-gray-400 transition-transform",
                      isOpen ? "rotate-90" : "rotate-0",
                    )}
                    aria-hidden="true"
                  >
                    <title>{isOpen ? "收合" : "展開"}</title>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
                {isOpen && (
                  <div className="border-t border-border px-3 py-2">
                    {r.matches.length === 0 ? (
                      <div className="text-[12px] text-gray-400">該次掃描無異常活動</div>
                    ) : (
                      <ul className="flex flex-col gap-1.5">
                        {r.matches.map((m) => (
                          <li
                            key={m.campaign_id}
                            className="rounded border border-border bg-white px-2 py-1.5"
                          >
                            <div className="flex flex-wrap items-baseline gap-1.5">
                              <span className="font-semibold text-ink">
                                {m.name || m.campaign_id}
                              </span>
                              {m.account_name ? (
                                <span className="text-[11px] text-gray-500">
                                  {m.account_name}
                                </span>
                              ) : null}
                              {m.creator ? (
                                <span className="text-[11px] text-gray-500">
                                  by {m.creator}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {(m.anomalies ?? []).map((a) => (
                                <span
                                  key={a}
                                  className="rounded-full bg-red-100 px-1.5 py-[1px] text-[10px] font-semibold text-red-700"
                                >
                                  {ANOMALY_LABEL[a] ?? a}
                                </span>
                              ))}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
