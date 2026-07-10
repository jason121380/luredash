import { useAdsets } from "@/api/hooks/useAdsets";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { ReportFieldsPicker } from "@/components/ReportFieldsPicker";
import { toast } from "@/components/Toast";
import type { DateConfig } from "@/lib/datePicker";
import { toLabel } from "@/lib/datePicker";
import { DEFAULT_REPORT_FIELDS } from "@/lib/reportFields";
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
  const [variant, setVariant] = useState<ReportVariant>("chooser");
  // Metric selection is per-campaign + team-wide (ordered, drag-to-
  // reorder), persisted to shared_settings via the finance store.
  const reportFieldsByCampaign = useFinanceStore((s) => s.reportFieldsByCampaign);
  const setReportFieldsStore = useFinanceStore((s) => s.setReportFields);
  // 成效報告 per-creative card metrics — also per-campaign + team-wide.
  const creativeFieldsByCampaign = useFinanceStore((s) => s.creativeFieldsByCampaign);
  const setCreativeFieldsStore = useFinanceStore((s) => s.setCreativeFields);

  // Reopen on the chooser step each time (version is picked per open).
  useEffect(() => {
    if (open) setVariant("chooser");
  }, [open]);

  if (!campaign) return null;

  // The picker is always shown; a campaign with no saved selection
  // displays the default set (not persisted until the user edits it).
  const savedFields = reportFieldsByCampaign[campaign.id] ?? null;
  const effectiveFields = savedFields ?? [...DEFAULT_REPORT_FIELDS];
  const updateFields = (next: string[]) => setReportFieldsStore(campaign.id, next);
  // 花費 vs 花費+% is chosen via the 花費 / 花費+% chips in the picker
  // (mutex) — no separate toggle.
  const useSpendPlus = effectiveFields.includes("spend_plus");
  const markupPercent = markupFor(campaign.id, rowMarkups, defaultMarkup);

  // Per-creative card metrics — null (unedited) → the component's own
  // DEFAULT_CREATIVE_FIELDS. Only threaded into the share URL for perf.
  const savedCreativeFields = creativeFieldsByCampaign[campaign.id] ?? null;
  const updateCreativeFields = (next: string[]) => setCreativeFieldsStore(campaign.id, next);

  const shareUrl = (opts?: { print?: boolean; shot?: boolean }) =>
    buildShareUrl({
      campaignId: campaign.id,
      accountId: campaign._accountId ?? "",
      hideMoney: false,
      datePreset: date.preset !== "custom" ? date.preset : undefined,
      useSpendPlus,
      markupPercent,
      variant: variant === "perf" ? "perf" : "standard",
      selectedFields: effectiveFields,
      creativeFields: variant === "perf" ? (savedCreativeFields ?? undefined) : undefined,
      print: opts?.print,
      shot: opts?.shot,
    });

  const onShare = async () => {
    const url = shareUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast("已複製分享連結", "success", 2500);
    } catch {
      /* clipboard write can fail on insecure contexts / iframes */
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  // 下載 JPG: open the clean share page with ?shot=1 — it auto-captures
  // itself to a high-DPI JPEG (long screenshot) and downloads it. FB
  // thumbnails render through the same-origin proxy so the canvas isn't
  // tainted.
  const onDownloadJpg = () => {
    window.open(shareUrl({ shot: true }), "_blank", "noopener,noreferrer");
    toast("已開啟報告,長截圖 JPG 產生後會自動下載", "success", 4000);
  };

  const isChooser = variant === "chooser";
  const reportTitle = variant === "perf" ? "以廣告報告" : "以廣告組合報告";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isChooser ? "行銷活動報告" : reportTitle}
      subtitle={isChooser ? "選擇報告版本" : toLabel(date)}
      titleAction={
        isChooser ? undefined : (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onDownloadJpg}>
              下載 JPG
            </Button>
            <Button variant="primary" size="sm" onClick={onShare}>
              複製分享連結
            </Button>
          </div>
        )
      }
      width={780}
    >
      {isChooser ? (
        <VersionChooser onPick={setVariant} campaignName={campaign.name} />
      ) : (
        <>
          {/* Metric picker — always expanded. 花費 / 花費+% is chosen
              here too (mutex chips), so there's no separate toggle. */}
          <div className="mb-4 rounded-xl border border-border bg-bg/50 p-3">
            <ReportFieldsPicker value={effectiveFields} onChange={updateFields} reorderable />
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
              selectedFields={effectiveFields}
              creativeFields={savedCreativeFields}
              onCreativeFieldsChange={updateCreativeFields}
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
              selectedFields={effectiveFields}
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
