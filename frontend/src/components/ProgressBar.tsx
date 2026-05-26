import { cn } from "@/lib/cn";

/**
 * 統一的進度條樣式 — 漸層橘色 + 流動效果。所有 loading / 進度
 * 顯示都改用這個元件,避免「同一個 app 三種高度三種顏色」的視
 * 覺不一致。
 *
 * Visual:
 *   - 漸層:`#FFB388 → #FF6B2C → #E55A1C`(淺橘 → 主橘 → 深橘)
 *   - 高度:size="sm" 6px / "md" 10px / "lg" 14px
 *   - 進度條上有 subtle shimmer 動畫,讓「跑」起來明顯
 *   - 100% 時 shimmer 收起,避免完成後還在動
 *
 * Variants:
 *   - tone="warm"  橘色(default,符合品牌)
 *   - tone="amber" 琥珀(預警 50-80%)
 *   - tone="danger" 紅(80%+ 危險)
 *   - tone="ok"    綠(成功 / 健康)
 *
 * Usage:
 *   <ProgressBar value={75} />
 *   <ProgressBar value={pct} size="lg" />
 *   <ProgressBar value={bucu} tone={bucu >= 80 ? "danger" : "warm"} />
 */

export type ProgressTone = "warm" | "amber" | "danger" | "ok";

export interface ProgressBarProps {
  /** 0-100. Values outside range are clamped. */
  value: number;
  /** Visual height. md = default(10px),適合大部分 loading state。 */
  size?: "sm" | "md" | "lg";
  /** 配色:warm=橘 / amber=琥珀 / danger=紅 / ok=綠 */
  tone?: ProgressTone;
  /** Override container className(e.g. `w-[220px]` to constrain width). */
  className?: string;
  /** Accessibility label,讀屏會讀。 */
  ariaLabel?: string;
}

const HEIGHT_CLS = {
  sm: "h-1.5",
  md: "h-2.5",
  lg: "h-3.5",
} as const;

// 漸層用 inline style 才能精準控顏色 + 配 background-size 動畫。
// Tailwind 的 from-/via-/to- 顏色關鍵字不接 hex token,如果要走那
// 條路要在 tailwind config 加 keyframe + safelist,反而更繞。
const TONE_GRADIENT: Record<ProgressTone, string> = {
  warm: "linear-gradient(90deg, #FFB388 0%, #FF6B2C 55%, #E55A1C 100%)",
  amber: "linear-gradient(90deg, #FCD34D 0%, #F59E0B 100%)",
  danger: "linear-gradient(90deg, #F87171 0%, #DC2626 100%)",
  ok: "linear-gradient(90deg, #6EE7B7 0%, #10B981 100%)",
};

export function ProgressBar({
  value,
  size = "md",
  tone = "warm",
  className,
  ariaLabel,
}: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, value));
  const running = pct > 0 && pct < 100;
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-full bg-border",
        HEIGHT_CLS[size],
        className,
      )}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300 ease-out",
          // background-size 200% 比 100% 大,搭配 keyframe 動 position
          // 就會看到「漸層在前進」的視覺效果。100% 時關掉動畫。
          running && "animate-progress-shimmer",
        )}
        style={{
          width: `${pct}%`,
          background: TONE_GRADIENT[tone],
          backgroundSize: running ? "200% 100%" : "100% 100%",
        }}
      />
    </div>
  );
}
