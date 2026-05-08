import type { BillingGrace, BillingUsage, LimitResource, TierId } from "@/api/client";
import { cn } from "@/lib/cn";
import { useNavigate } from "react-router-dom";

/**
 * Downgrade grace-period banner. Surfaces in two states:
 *
 *  - **Active (countdown)**: usage is over one or more caps but the
 *    grace window hasn't expired yet → orange tone, "N 天後將自動停用
 *    超額項目" + 升級方案 CTA. Everything still works.
 *  - **Expired**: grace window passed → red tone, "已停用 N 個超額項目
 *    " language. Excess push configs are now skipped by the scheduler;
 *    other resources stay visible but the user is over their plan.
 *
 * Hidden entirely when the user isn't over any cap (the common case).
 *
 * The optional `resource` prop scopes the banner to one resource —
 * use it on a specific settings page so the banner only appears when
 * that page's resource is the one that's over.
 */
export interface GraceBannerProps {
  usage: BillingUsage | undefined;
  /** When set, only render when THIS specific resource is over the
   *  cap. When undefined, render whenever any resource is over. */
  resource?: LimitResource;
  className?: string;
}

const RESOURCE_LABEL: Record<LimitResource, string> = {
  ad_accounts: "廣告帳戶",
  line_channels: "可串接 Line 官方帳號數",
  line_groups: "可被加入 Line 群組數量",
  monthly_push: "本月推播次數",
  agent_advice: "AI 幕僚分析",
};

export function GraceBanner({ usage, resource, className }: GraceBannerProps) {
  const navigate = useNavigate();
  if (!usage) return null;
  const overItems = computeOverList(usage);
  if (overItems.length === 0) return null;
  if (resource && !overItems.some((o) => o.resource === resource)) return null;

  const grace: BillingGrace = usage.grace;
  const expiresAt = grace.expires_at ? new Date(grace.expires_at) : null;
  const daysLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400000)) : null;
  const expired = grace.expired;

  // Pick the relevant rows to summarise. When scoped to one resource
  // we only mention that one; otherwise list all over-limit resources.
  const rows = resource ? overItems.filter((o) => o.resource === resource) : overItems;
  const summary = rows
    .map((r) => `${RESOURCE_LABEL[r.resource]}(${r.usage} / ${r.limit})`)
    .join("、");

  return (
    <div
      className={cn(
        "mb-3 flex flex-col gap-2 rounded-xl border px-4 py-3 text-[13px] md:flex-row md:items-center md:justify-between",
        expired ? "border-red-300 bg-red-50 text-red-700" : "border-orange bg-orange-bg text-orange",
        className,
      )}
    >
      <div className="flex flex-col gap-0.5">
        <div className="font-semibold">
          {expired ? "已超過方案上限,寬限期結束" : `寬限期剩 ${daysLeft} 天`}
        </div>
        <div className={cn("text-[12px]", expired ? "text-red-600" : "text-ink/70")}>
          {expired
            ? `超額項目:${summary}。${tierName(usage.tier)} 方案的部分推播已自動暫停,請刪除多餘項目或升級方案以恢復。`
            : `超額項目:${summary}。請於 ${expiresAt?.toLocaleDateString("zh-TW") ?? ""} 前刪除多餘項目或升級方案,否則系統會自動停用超出部分。`}
        </div>
      </div>
      <button
        type="button"
        onClick={() => navigate("/pricing")}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 self-start rounded-pill border-[1.5px] bg-white px-3 py-1 text-[12px] font-semibold transition active:scale-[0.98] md:self-center",
          expired
            ? "border-red-500 text-red-600 hover:bg-red-50"
            : "border-orange text-orange hover:bg-orange-bg",
        )}
      >
        升級方案 →
      </button>
    </div>
  );
}

function computeOverList(usage: BillingUsage): Array<{ resource: LimitResource; usage: number; limit: number }> {
  const out: Array<{ resource: LimitResource; usage: number; limit: number }> = [];
  for (const r of ["ad_accounts", "line_channels", "line_groups"] as const) {
    const limit = usage.limits[r];
    const used = usage.usage[r];
    if (limit < 0 || limit >= 999_000) continue;
    if (used > limit) out.push({ resource: r, usage: used, limit });
  }
  return out;
}

function tierName(tier: TierId): string {
  switch (tier) {
    case "free":
      return "Free";
    case "basic":
      return "Basic";
    case "plus":
      return "Plus";
    case "max":
      return "Max";
    default:
      return tier;
  }
}
