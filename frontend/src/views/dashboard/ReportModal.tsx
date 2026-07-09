import { useAdsets } from "@/api/hooks/useAdsets";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toast";
import { cn } from "@/lib/cn";
import type { DateConfig } from "@/lib/datePicker";
import { toLabel } from "@/lib/datePicker";
import { buildShareUrl } from "@/lib/shareReport";
import { useFinanceStore } from "@/stores/financeStore";
import type { FbCampaign } from "@/types/fb";
import { markupFor } from "@/views/finance/financeData";
import { useEffect, useState } from "react";
import { PerformanceReportContent } from "./PerformanceReportContent";
import { ReportContent } from "./ReportContent";

/**
 * Campaign report modal — two report versions selected via a chooser
 * step:
 *   - 標準報告 (standard) → ReportContent: KPI grid + adset breakdown.
 *   - 成效報告 (perf)     → PerformanceReportContent: Top 5 ads by CTR.
 *
 * Footer has a 複製分享連結 button that copies a /r/:campaignId URL
 * (carrying `report=perf` for the 成效報告) and opens it in a new tab.
 *
 * 花費/花費+% mutex toggle applies to both versions:
 *   - 花費   → raw FB spend (default)
 *   - 花費+% → spend × (1 + markup/100), label rendered as 花費*
 *   Markup percent is read live from financeStore (per-row override
 *   wins over the team-wide default).
 */

type ReportVariant = "chooser" | "standard" | "perf";

export function ReportModal({
  open,
  onOpenChange,
  campaign,
  date,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  campaign: FbCampaign | null;
  date: DateConfig;
}) {
  const adsetsQuery = useAdsets(campaign?.id ?? null, date, open && !!campaign);
  const rowMarkups = useFinanceStore((s) => s.rowMarkups);
  const defaultMarkup = useFinanceStore((s) => s.defaultMarkup);
  const [useSpendPlus, setUseSpendPlus] = useState(false);
  const [variant, setVariant] = useState<ReportVariant>("chooser");

  // Always reopen on the chooser step so the user picks a version each
  // time (matches the "先跳彈窗選格式" flow).
  useEffect(() => {
    if (open) setVariant("chooser");
  }, [open]);

  if (!campaign) return null;

  const markupPercent = markupFor(campaign.id, rowMarkups, defaultMarkup);

  const onShare = async () => {
    const url = buildShareUrl({
      campaignId: campaign.id,
      accountId: campaign._accountId ?? "",
      hideMoney: false,
      datePreset: date.preset !== "custom" ? date.preset : undefined,
      useSpendPlus,
      markupPercent,
      variant: variant === "perf" ? "perf" : "standard",
    });
    try {
      await navigator.clipboard.writeText(url);
      toast("已複製分享連結", "success", 2500);
    } catch {
      /* clipboard write can fail on insecure contexts / iframes */
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const isChooser = variant === "chooser";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="行銷活動報告"
      subtitle={isChooser ? "選擇報告版本" : toLabel(date)}
      width={780}
      footer={
        isChooser ? null : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setVariant("chooser")}>
              ← 換版本
            </Button>
            <Button variant="primary" size="sm" onClick={onShare}>
              複製分享連結
            </Button>
          </>
        )
      }
    >
      {isChooser ? (
        <VersionChooser onPick={setVariant} campaignName={campaign.name} />
      ) : (
        <>
          {/* 花費 / 花費+% mutex toggle — affects every 花費 cell in
              both report versions (and the share page). */}
          <div className="mb-4 flex items-center gap-2">
            <span className="text-[12px] font-semibold text-gray-500">花費顯示</span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setUseSpendPlus(false)}
                aria-pressed={!useSpendPlus}
                className={cn(
                  "h-7 rounded-full border px-3 text-[11px] font-semibold transition",
                  !useSpendPlus
                    ? "border-orange bg-orange-bg text-orange"
                    : "border-border bg-white text-gray-500 hover:border-orange",
                )}
              >
                花費
              </button>
              <button
                type="button"
                onClick={() => setUseSpendPlus(true)}
                aria-pressed={useSpendPlus}
                className={cn(
                  "h-7 rounded-full border px-3 text-[11px] font-semibold transition",
                  useSpendPlus
                    ? "border-orange bg-orange-bg text-orange"
                    : "border-border bg-white text-gray-500 hover:border-orange",
                )}
              >
                花費+{markupPercent}%
              </button>
            </div>
          </div>

          {variant === "perf" ? (
            <PerformanceReportContent
              campaign={campaign}
              adsets={adsetsQuery.data ?? null}
              adsetsLoading={adsetsQuery.isLoading || adsetsQuery.isPending}
              adsetsError={adsetsQuery.error instanceof Error ? adsetsQuery.error.message : null}
              hideMoney={false}
              dateLabel={toLabel(date)}
              date={date}
              useSpendPlus={useSpendPlus}
              markupPercent={markupPercent}
            />
          ) : (
            <ReportContent
              campaign={campaign}
              adsets={adsetsQuery.data ?? null}
              adsetsLoading={adsetsQuery.isLoading || adsetsQuery.isPending}
              adsetsError={adsetsQuery.error instanceof Error ? adsetsQuery.error.message : null}
              hideMoney={false}
              dateLabel={toLabel(date)}
              date={date}
              useSpendPlus={useSpendPlus}
              markupPercent={markupPercent}
            />
          )}
        </>
      )}
    </Modal>
  );
}

function VersionChooser({
  onPick,
  campaignName,
}: {
  onPick: (v: ReportVariant) => void;
  campaignName: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12px] text-gray-500">{campaignName} — 請選擇要產生的報告版本</div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <ChooserCard
          title="以廣告組合報告"
          desc="完整 KPI 總覽 + 廣告組合 / 受眾洞察 / 素材表現 + 優化建議。"
          onClick={() => onPick("standard")}
        />
        <ChooserCard
          title="以廣告報告"
          desc="活動 KPI 摘要 + 所有有花費素材依點擊率排序(縮圖 + 點擊率 / 點擊成本 / 曝光 / 平均播放時間 / 按讚 / 分享)。"
          onClick={() => onPick("perf")}
        />
      </div>
    </div>
  );
}

function ChooserCard({
  title,
  desc,
  onClick,
}: {
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-1.5 rounded-xl border-[1.5px] border-border bg-white px-4 py-3.5 text-left transition hover:border-orange hover:bg-orange-bg/40"
    >
      <div className="text-[15px] font-bold text-ink">{title}</div>
      <div className="text-[12px] leading-relaxed text-gray-500">{desc}</div>
    </button>
  );
}
