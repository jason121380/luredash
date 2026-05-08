import type { LimitResource, TierId } from "@/api/client";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { useNavigate } from "react-router-dom";

/**
 * Tier-limit reached modal. Surfaced in two situations:
 *
 *   1. Frontend pre-check: a settings / add action would push the
 *      user past their cap → we open this modal instead of issuing
 *      the request that would 403.
 *   2. Backend rejection: a tier-gated endpoint returned a 403 with
 *      `body.code === "tier_limit_exceeded"` (stale tab raced past
 *      the local cap). The catch-block opens the same modal.
 *
 * The CTA routes to `/pricing` so the user can pick the next tier
 * up. We keep the message backend-driven so the wording matches
 * exactly what the API decided was the cap.
 */

const RESOURCE_LABEL: Record<LimitResource, string> = {
  ad_accounts: "廣告帳戶",
  line_channels: "可串接 Line 官方帳號數",
  line_groups: "可被加入 Line 群組數量",
  monthly_push: "本月推播次數",
  agent_advice: "AI 幕僚分析",
};

export interface UpgradeModalState {
  resource: LimitResource;
  tier: TierId;
  limit: number;
  message?: string;
}

export interface UpgradeModalProps {
  state: UpgradeModalState | null;
  onClose: () => void;
}

export function UpgradeModal({ state, onClose }: UpgradeModalProps) {
  const navigate = useNavigate();
  const open = state !== null;
  const label = state ? RESOURCE_LABEL[state.resource] : "";
  // Default copy if the caller didn't supply a backend message
  // (i.e. pre-check path).
  const message =
    state?.message ??
    (state ? `目前 ${tierName(state.tier)} 方案的「${label}」上限為 ${state.limit},請升級方案以繼續新增。` : "");

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="已達方案上限"
      width={420}
    >
      {state && (
        <div className="flex flex-col gap-4">
          <p className="text-[14px] leading-relaxed text-ink">{message}</p>

          <div className="flex flex-col gap-2 md:flex-row md:justify-end">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                navigate("/pricing");
              }}
            >
              升級方案 →
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
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

/** Type-narrowing helper for the catch block of an await — turns
 *  an unknown error into UpgradeModalState if it's a tier-limit 403,
 *  otherwise returns null so the caller can surface its own toast. */
export function tierLimitFromError(err: unknown): UpgradeModalState | null {
  if (!err || typeof err !== "object") return null;
  const body = (err as { body?: unknown }).body;
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.code !== "tier_limit_exceeded") return null;
  const resource = b.resource as LimitResource | undefined;
  const tier = b.tier as TierId | undefined;
  const limit = typeof b.limit === "number" ? b.limit : 0;
  const message = typeof b.message === "string" ? b.message : undefined;
  if (!resource || !tier) return null;
  return { resource, tier, limit, message };
}
