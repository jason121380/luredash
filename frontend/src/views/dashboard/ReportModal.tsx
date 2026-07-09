import { useAdsets } from "@/api/hooks/useAdsets";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { ReportFieldsPicker } from "@/components/ReportFieldsPicker";
import { toast } from "@/components/Toast";
import { cn } from "@/lib/cn";
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

// Persist the operator's metric selection across opens / reloads
// (per-browser UI preference, like the other dashboard prefs). null →
// each report's built-in default layout.
const FIELDS_STORAGE_KEY = "report_selected_fields";

function loadStoredFields(): string[] | null {
  try {
    const raw = localStorage.getItem(FIELDS_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function saveStoredFields(v: string[] | null): void {
  try {
    if (v === null) localStorage.removeItem(FIELDS_STORAGE_KEY);
    else localStorage.setItem(FIELDS_STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* private-mode / quota — non-fatal, selection just won't persist */
  }
}

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
  // null → each report's built-in KPI layout; non-null → only these
  // KPI codes (metric selector, same catalog as the LINE push picker).
  // Seeded from localStorage so the operator's pick persists.
  const [selectedFields, setSelectedFields] = useState<string[] | null>(() => loadStoredFields());

  // Reopen on the chooser step each time (version is picked per open);
  // re-hydrate the saved metric selection so it survives across opens.
  useEffect(() => {
    if (open) {
      setVariant("chooser");
      setSelectedFields(loadStoredFields());
    }
  }, [open]);

  // Wrap the setter so every user change is persisted.
  const updateFields = (next: string[] | null) => {
    setSelectedFields(next);
    saveStoredFields(next);
  };

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
      selectedFields,
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
  const showFieldPicker = selectedFields !== null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="行銷活動報告"
      subtitle={isChooser ? "選擇報告版本" : toLabel(date)}
      width={780}
    >
      {isChooser ? (
        <VersionChooser onPick={setVariant} campaignName={campaign.name} />
      ) : (
        <>
          {/* Top action row (moved out of the modal footer). */}
          <div className="mb-3 flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setVariant("chooser")}>
              ← 換版本
            </Button>
            <Button variant="primary" size="sm" onClick={onShare}>
              複製分享連結
            </Button>
          </div>

          {/* Controls: 花費顯示 mutex toggle + 指標選擇 disclosure. */}
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
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
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-gray-500">顯示指標</span>
              <button
                type="button"
                onClick={() =>
                  updateFields(selectedFields === null ? [...DEFAULT_REPORT_FIELDS] : null)
                }
                aria-pressed={showFieldPicker}
                className={cn(
                  "h-7 rounded-full border px-3 text-[11px] font-semibold transition",
                  showFieldPicker
                    ? "border-orange bg-orange-bg text-orange"
                    : "border-border bg-white text-gray-500 hover:border-orange",
                )}
              >
                {showFieldPicker ? "自訂中" : "預設"}
              </button>
            </div>
          </div>

          {/* Metric picker — same catalog as the LINE push report. */}
          {showFieldPicker && (
            <div className="mb-4 rounded-xl border border-border bg-bg/50 p-3">
              <ReportFieldsPicker value={selectedFields ?? []} onChange={updateFields} />
            </div>
          )}

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
              selectedFields={selectedFields}
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
              selectedFields={selectedFields}
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
