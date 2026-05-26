import { api } from "@/api/client";
import { useSetUserSetting, useUserSettings } from "@/api/hooks/useSettings";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { cn } from "@/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/**
 * Topbar 右側的 BUCU% 即時指示器(可由工程模式 toggle 開關)。
 *
 * 預設關閉。打開後在每個 view 的 Topbar 右上顯示當下的 peak BUCU,
 * 讓 operator 隨時看到 FB rate-limit 用量,不必每次都打開工程模式
 * 滑下去看「FB API 節流狀態」。
 *
 * 顏色配:
 *   < 50%  灰
 *   50-69% 琥珀
 *   70-89% 橘
 *   ≥ 90%  紅 + 閃動
 *
 * 共用既有的 ["fb-usage"] React Query key,跟 FbUsagePanel /
 * FbUsageBanner 共享同一份資料,不會重複打 API。
 */

const STORAGE_KEY = "show_bucu_in_header";
const SETTING_KEY = "show_bucu_in_header";

/** Read the toggle. PostgreSQL is the source of truth once the FB user
 *  is known; localStorage is kept as the instant fallback and migration
 *  path for older browsers that already had the box checked. */
export function useShowBucuInHeader(): [boolean, (next: boolean) => void] {
  const { user } = useFbAuth();
  const settingsQuery = useUserSettings(user?.id);
  const setUserSetting = useSetUserSetting();
  const [localEnabled, setLocalEnabled] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const rawStored = settingsQuery.data?.[SETTING_KEY];
  const hasStoredSetting =
    settingsQuery.data != null && Object.prototype.hasOwnProperty.call(settingsQuery.data, SETTING_KEY);
  const enabled = hasStoredSetting
    ? rawStored === true || rawStored === "1"
    : localEnabled;

  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key && e.key !== STORAGE_KEY) return;
      try {
        setLocalEnabled(localStorage.getItem(STORAGE_KEY) === "1");
      } catch {
        setLocalEnabled(false);
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useEffect(() => {
    if (!hasStoredSetting) return;
    try {
      if (enabled) localStorage.setItem(STORAGE_KEY, "1");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* private mode / quota — DB still has the value */
    }
  }, [enabled, hasStoredSetting]);

  useEffect(() => {
    if (!user?.id || !settingsQuery.isSuccess || hasStoredSetting || !localEnabled) return;
    setUserSetting.mutate({
      fbUserId: user.id,
      key: SETTING_KEY,
      value: true,
    });
  }, [hasStoredSetting, localEnabled, settingsQuery.isSuccess, setUserSetting, user?.id]);

  const setEnabled = (next: boolean) => {
    try {
      if (next) localStorage.setItem(STORAGE_KEY, "1");
      else localStorage.removeItem(STORAGE_KEY);
      // Manual event for same-tab subscribers(localStorage's native
      // 'storage' event only fires across tabs).
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    } catch {
      /* private mode / quota — silently ignore */
    }
    setLocalEnabled(next);
    if (user?.id) {
      setUserSetting.mutate({
        fbUserId: user.id,
        key: SETTING_KEY,
        value: next,
      });
    }
  };
  return [enabled, setEnabled];
}

export function BucuHeaderChip() {
  const [enabled] = useShowBucuInHeader();
  const { status } = useFbAuth();
  const query = useQuery({
    queryKey: ["fb-usage"],
    queryFn: () => api.engineering.fbUsage(),
    refetchInterval: enabled ? 15_000 : false,
    staleTime: 10_000,
    enabled: enabled && status === "auth",
  });

  if (!enabled) return null;

  const data = query.data?.data ?? {};
  let peak = 0;
  for (const u of Object.values(data)) {
    const m = Math.max(
      u.call_count ?? 0,
      u.total_cputime ?? 0,
      u.total_time ?? 0,
    );
    if (m > peak) peak = m;
  }

  const tone =
    peak >= 90
      ? "border-red-200 bg-red-100 text-red-700 animate-pulse"
      : peak >= 70
        ? "border-orange-border bg-orange-bg text-orange"
        : peak >= 50
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "border-border bg-bg text-gray-500";

  return (
    <span
      className={cn(
        "inline-flex select-none items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-[1px] text-[9px] font-bold uppercase leading-none tracking-wider",
        tone,
      )}
      title={`FB BUCU 當下峰值。任一帳戶任一 metric(呼叫次數 / CPU / 處理時間)取最大值。背景任務 ≥ 80% 自動暫停。`}
    >
      <span className="opacity-70">BUCU</span>
      <span className="font-mono tabular-nums">{peak}%</span>
    </span>
  );
}
