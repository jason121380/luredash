import { Modal } from "@/components/Modal";
import { useEffect, useState } from "react";

/**
 * 「立即掃描」按下後的本地紀錄(localStorage,每瀏覽器各自)。
 *
 * 為什麼是 localStorage 而非後端表:
 *   - 「立即掃描」純前端動作,沒走 _security_push_run_one,沒寫
 *     security_push_logs。要在後端記就得新增 endpoint + DB 寫入,
 *     反而引入額外的 PG 流量
 *   - 個人操作紀錄本來就 per-device,不需要 team-wide 共享
 *   - 換瀏覽器就沒了,但符合直覺(「我這台電腦上按了什麼」)
 *
 * 排程器自動跑的 tick 已經有 security_push_configs.last_run_at
 * 在「推播設定」modal 露出;這個 modal 只顯示 user 手動按的紀錄。
 */
export interface ScanHistoryEntry {
  /** epoch ms — 開始 + 結束都用同一個 ts(掃描結束時間)*/
  ts: number;
  /** 本次掃描耗時(ms)*/
  durationMs: number;
  /** 該次掃描共看到幾個 campaigns(overview.campaigns.length)*/
  totalCampaigns: number;
  /** 「待查看」tab 的數字 — 沒被標記安全的新建立 campaigns */
  pendingCount: number;
  /** 是否有任何 account 在 fetch 中報錯 */
  hasError: boolean;
}

const HISTORY_KEY = "security_scan_history";
const MAX_HISTORY = 30;

export function readScanHistory(): ScanHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendScanHistory(entry: ScanHistoryEntry): ScanHistoryEntry[] {
  const history = readScanHistory();
  const next = [entry, ...history].slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    // Cross-component subscribers (the modal) listen for this storage
    // event to re-render. localStorage's native 'storage' event only
    // fires across tabs, so we dispatch a manual one for same-tab sync.
    window.dispatchEvent(new StorageEvent("storage", { key: HISTORY_KEY }));
  } catch {
    // quota / privacy mode — silently drop
  }
  return next;
}

function formatRelative(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  return new Date(ts).toLocaleDateString("zh-TW");
}

function formatExact(ts: number): string {
  return new Date(ts).toLocaleString("zh-TW", {
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
  const [history, setHistory] = useState<ScanHistoryEntry[]>(() => readScanHistory());

  // Re-read when our manual storage event fires (same tab) or a
  // different tab writes (real storage event).
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key && e.key !== HISTORY_KEY) return;
      setHistory(readScanHistory());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  // Re-read when modal opens so stale state doesn't show
  useEffect(() => {
    if (open) setHistory(readScanHistory());
  }, [open]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="掃描紀錄"
      subtitle="這台瀏覽器上按過「立即掃描」的歷史(最近 30 筆,換瀏覽器不通用)"
      width={520}
    >
      {history.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-gray-500">
          尚無紀錄。點右上「立即掃描」開始檢查。
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {history.map((h) => (
            <li
              key={h.ts}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-border bg-bg px-3 py-2 text-[12px]"
            >
              <span className="font-semibold text-ink" title={formatExact(h.ts)}>
                {formatRelative(h.ts)}
              </span>
              <span className="font-mono text-[10px] text-gray-400">
                {formatExact(h.ts)}
              </span>
              <span className="text-gray-500">
                耗時 {(h.durationMs / 1000).toFixed(1)}s
              </span>
              <span className="text-gray-500">
                掃描 {h.totalCampaigns} 個 campaigns
              </span>
              {h.pendingCount > 0 && (
                <span className="rounded-full bg-orange-bg px-1.5 py-[1px] font-semibold text-orange">
                  待查看 {h.pendingCount}
                </span>
              )}
              {h.hasError && (
                <span className="rounded-full bg-red-100 px-1.5 py-[1px] font-semibold text-red-700">
                  部分失敗
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
