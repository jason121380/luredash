import { api } from "@/api/client";
import { useSecurityPushConfigs } from "@/api/hooks/useSecurityPush";
import { useSharedSettings } from "@/api/hooks/useSettings";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { cn } from "@/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

// `readScanHistory` / `appendScanHistory` (the previous localStorage
// API) were removed once we cut over to backend-stored
// `security_scan_records`. If anything still imports them after this
// migration it'd be a callsite we missed — failing fast at the type
// layer is the right behavior.

/**
 * 掃描紀錄 panel — reads from PG `security_scan_records` via
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

function hiddenRecordsKey(uid: string): string {
  return `security_hidden_scan_records:${uid || "anon"}`;
}

function readHiddenRecordIds(uid: string): Set<string> {
  try {
    const raw = localStorage.getItem(hiddenRecordsKey(uid));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeHiddenRecordIds(uid: string, ids: Set<string>): void {
  try {
    localStorage.setItem(hiddenRecordsKey(uid), JSON.stringify([...ids]));
  } catch {
    /* localStorage unavailable — ignore */
  }
}

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

function formatNextScanTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function ScanHistoryPanel() {
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => readHiddenRecordIds(uid));
  const sharedQuery = useSharedSettings();
  const masterEnabled = sharedQuery.data?.security_push_master_enabled === true;
  const configsQuery = useSecurityPushConfigs();
  const nextScanAt = useMemo(() => {
    if (!masterEnabled) return null;
    const times = (configsQuery.data ?? [])
      .filter((cfg) => cfg.enabled && cfg.next_run_at)
      .map((cfg) => new Date(cfg.next_run_at as string).getTime())
      .filter((ts) => Number.isFinite(ts));
    if (times.length === 0) return null;
    return new Date(Math.min(...times)).toISOString();
  }, [configsQuery.data, masterEnabled]);

  useEffect(() => {
    setHiddenIds(readHiddenRecordIds(uid));
  }, [uid]);

  const query = useQuery({
    queryKey: ["security-scan-records", uid],
    queryFn: async () => {
      if (!uid) return [];
      const resp = await api.securityScan.listRecords(uid, 20);
      return resp.data ?? [];
    },
    enabled: !!uid,
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
  const hideRecord = (id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      writeHiddenRecordIds(uid, next);
      return next;
    });
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const records = useMemo(
    () => (query.data ?? []).filter((r) => !hiddenIds.has(r.id)),
    [query.data, hiddenIds],
  );

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-bold text-ink">掃描紀錄</h2>
          <p className="mt-0.5 text-[11px] text-gray-400">
            跨裝置同步 · 最近 20 筆
            {nextScanAt ? (
              <>
                {" · "}下次安全掃描 {formatNextScanTime(nextScanAt)}
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="shrink-0 rounded-md border border-border bg-white px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-orange-bg hover:text-orange disabled:opacity-50"
        >
          {query.isFetching ? "更新中" : "更新"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {query.isLoading ? (
          <div className="py-8 text-center text-[12px] text-gray-500">載入中…</div>
        ) : records.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-gray-500">
            尚無紀錄。點「立即掃描」開始累積。
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {records.map((r) => {
              const isOpen = expanded.has(r.id);
              return (
                <li
                  key={r.id}
                  className="rounded-lg border border-border bg-bg text-[12px]"
                >
                  <div className="flex items-start gap-1 px-3 py-2 hover:bg-orange-bg/30">
                    <button
                      type="button"
                      onClick={() => toggle(r.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="flex items-center gap-1.5">
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
                            "ml-auto shrink-0 text-gray-400 transition-transform",
                            isOpen ? "rotate-90" : "rotate-0",
                          )}
                          aria-hidden="true"
                        >
                          <title>{isOpen ? "收合" : "展開"}</title>
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </span>
                      <span className="mt-1 block font-mono text-[10px] text-gray-400">
                        {formatExact(r.scanned_at)}
                      </span>
                      <span className="mt-1 block text-[11px] text-gray-500">
                        {r.account_ids.length} 帳戶 · {r.matches_count} 異常 ·{" "}
                        {(r.duration_ms / 1000).toFixed(1)}s
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => hideRecord(r.id)}
                      title="從畫面隱藏(不刪除資料庫)"
                      aria-label="隱藏掃描紀錄"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-300 hover:bg-red-50 hover:text-red-600"
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <title>hide</title>
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  </div>
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
                              <div className="flex flex-col gap-0.5">
                                <span className="break-words font-semibold text-ink">
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
      </div>
    </aside>
  );
}
