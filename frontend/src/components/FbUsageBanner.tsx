import { api } from "@/api/client";
import { useAccounts } from "@/api/hooks/useAccounts";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { cn } from "@/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

/**
 * Sticky-top warning banner that appears whenever any FB
 * Business-Use-Case-Usage metric (call_count / total_cputime /
 * total_time) crosses 70% on any tracked account or BM.
 *
 * Mounted once at the Shell level so the warning is visible on every
 * view, not just inside the engineering modal. Polls /api/fb-usage
 * every 30s (the engineering panel uses the same queryKey at 10s, so
 * React Query dedupes — only one in-flight at a time).
 *
 * Visibility rules:
 *   - 70-89%: amber tone
 *   - >=90%: red tone (FB throttle imminent)
 *   - dismiss button hides it for the rest of the session; will
 *     re-appear on next page load if usage is still high
 */
const WARN_THRESHOLD = 70;
const CRIT_THRESHOLD = 90;

export function FbUsageBanner() {
  const { status } = useFbAuth();
  const enabled = status === "auth";
  const query = useQuery({
    queryKey: ["fb-usage"],
    queryFn: () => api.engineering.fbUsage(),
    refetchInterval: enabled ? 30_000 : false,
    staleTime: 25_000,
    enabled,
  });
  const accountsQuery = useAccounts();
  const [dismissed, setDismissed] = useState(false);

  // Same lookup as the engineering panel — match bare numeric BUC id
  // against either the ad account (strip `act_`) or the BM.
  const nameByBareId = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accountsQuery.data ?? []) {
      if (a.id && a.name) {
        const bare = a.id.startsWith("act_") ? a.id.slice(4) : a.id;
        if (!m.has(bare)) m.set(bare, a.name);
      }
      const b = a.business;
      if (b?.id && b.name && !m.has(b.id)) m.set(b.id, b.name);
    }
    return m;
  }, [accountsQuery.data]);

  // Find the worst (account, metric) pair across the BUC dict. The
  // banner shows the single highest reading — keeps the message
  // concrete instead of vague "some accounts are throttled".
  const worst = useMemo(() => {
    const data = query.data?.data ?? {};
    let max = 0;
    let key = "";
    let metric: "呼叫次數" | "CPU 用量" | "處理時間" = "處理時間";
    for (const [bareId, u] of Object.entries(data)) {
      const m1 = u.call_count ?? 0;
      const m2 = u.total_cputime ?? 0;
      const m3 = u.total_time ?? 0;
      const localMax = Math.max(m1, m2, m3);
      if (localMax > max) {
        max = localMax;
        key = bareId;
        metric = m3 >= m1 && m3 >= m2 ? "處理時間" : m2 >= m1 ? "CPU 用量" : "呼叫次數";
      }
    }
    return { max, key, metric };
  }, [query.data]);

  if (!enabled || dismissed || worst.max < WARN_THRESHOLD) return null;

  const name = nameByBareId.get(worst.key);
  const tone = worst.max >= CRIT_THRESHOLD ? "crit" : "warn";

  return (
    <div
      role="status"
      className={cn(
        "sticky top-0 z-40 flex items-center gap-3 border-b px-4 py-2 text-[13px] md:px-6",
        tone === "crit"
          ? "border-red-200 bg-red-100 text-red-900"
          : "border-amber-200 bg-amber-100 text-amber-900",
      )}
    >
      <span aria-hidden="true" className="shrink-0 font-bold">
        ⚠
      </span>
      <span className="min-w-0 flex-1 truncate">
        FB API 使用率高
        {name ? (
          <>
            {" — "}
            <b>{name}</b>
            <span className="ml-1 font-mono text-[11px] opacity-70">{worst.key}</span>
          </>
        ) : (
          <>
            {" "}
            (<span className="font-mono">{worst.key}</span>)
          </>
        )}
        {" 的 "}
        <b>{worst.metric}</b>
        {" 已達 "}
        <b>{worst.max}%</b>
        {tone === "crit"
          ? ",FB 即將進入節流,請暫停手動重新整理"
          : ",接近節流上限,留意呼叫頻率"}
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className={cn(
          "shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold",
          tone === "crit" ? "hover:bg-red-200" : "hover:bg-amber-200",
        )}
      >
        關閉
      </button>
    </div>
  );
}
