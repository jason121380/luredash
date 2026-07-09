import { api } from "@/api/client";
import { Badge } from "@/components/Badge";
import { CreativePreviewModal } from "@/components/CreativePreviewModal";
import { type DateConfig, resolveRange } from "@/lib/datePicker";
import { fM, fN, fP } from "@/lib/format";
import { getIns } from "@/lib/insights";
import { translateObjective } from "@/lib/objective";
import type { FbAdset, FbCampaign, FbCreativeEntity } from "@/types/fb";
import { useQueries } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

/**
 * 成效報告 — creative-performance view of a single campaign, modelled on
 * the team's manual Google-Sheet report:
 *   [Header]  campaign name + date range + campaign KPIs
 *             (花費 / 曝光 / 觸及 / CPC / CTR)
 *   [點擊率前 5]  the campaign's top 5 ads by CTR, each a vertical
 *             creative card (thumbnail + 點擊率 / 點擊成本 / 曝光).
 *
 * Only FB-auto-available metrics are shown — organic figures the manual
 * sheet carried (IG 追蹤 / 收藏 / 按讚 / 分享 / 觀看率 / 平均播放時間)
 * are not exposed by the Marketing API and are intentionally omitted.
 *
 * Ads are fetched per-adset (reusing the same `["report-ads", ...]`
 * query cache as the standard report) via `useQueries`, then flattened
 * and ranked across the whole campaign.
 */

const num = (v: string | number | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const TOP_N = 5;

export interface PerformanceReportContentProps {
  campaign: FbCampaign;
  adsets: FbAdset[] | null;
  adsetsLoading?: boolean;
  adsetsError?: string | null;
  hideMoney: boolean;
  dateLabel?: ReactNode;
  date: DateConfig;
  /** When true, 花費 renders as 花費* using the marked-up amount. */
  useSpendPlus?: boolean;
  markupPercent?: number;
}

export function PerformanceReportContent({
  campaign,
  adsets,
  adsetsLoading,
  adsetsError,
  hideMoney,
  dateLabel,
  date,
  useSpendPlus = false,
  markupPercent = 0,
}: PerformanceReportContentProps) {
  const ins = getIns(campaign);

  const money = (v: number | string | null | undefined): string =>
    hideMoney ? "—" : v !== null && v !== undefined && v !== "" ? `$${fM(v)}` : "—";
  const spendLabel = useSpendPlus ? "花費*" : "花費";
  const spendValue = (() => {
    const raw = num(ins.spend);
    if (hideMoney) return "—";
    if (!Number.isFinite(raw) || raw === 0) return money(ins.spend);
    return `$${fM(useSpendPlus ? Math.ceil(raw * (1 + markupPercent / 100)) : raw)}`;
  })();

  // Fetch ads for every adset that spent, reusing the shared report-ads
  // cache. Ranking across the whole campaign needs all of them.
  const spendingAdsetIds = (adsets ?? []).filter((a) => num(getIns(a).spend) > 0).map((a) => a.id);

  const adQueries = useQueries({
    queries: spendingAdsetIds.map((adsetId) => ({
      queryKey: ["report-ads", adsetId, date] as const,
      queryFn: async (): Promise<FbCreativeEntity[]> =>
        (await api.adsets.creatives(adsetId, date)).data ?? [],
      staleTime: 5 * 60_000,
      enabled: !!adsetId,
    })),
  });

  const adsLoading = adsetsLoading || adQueries.some((q) => q.isLoading);
  const adsError =
    adsetsError ??
    (adQueries.find((q) => q.isError)?.error instanceof Error
      ? (adQueries.find((q) => q.isError)?.error as Error).message
      : null);

  // Flatten → keep spend>0 & a real CTR → rank by CTR desc → top 5.
  const allAds = adQueries.flatMap((q) => q.data ?? []);
  const topAds = allAds
    .map((ad) => ({ ad, ctr: num(getIns(ad).ctr), spend: num(getIns(ad).spend) }))
    .filter((s) => s.spend > 0 && s.ctr > 0)
    .sort((a, b) => b.ctr - a.ctr)
    .slice(0, TOP_N);

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-gray-500">
          資料區間 {dateLabel ? `(${dateLabel})` : ""}
        </div>
        <div className="text-[24px] font-bold text-orange md:text-[28px]">
          {concreteRangeLabel(date)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge status={campaign.status} />
          {campaign.objective && (
            <span className="rounded-full border border-border px-2.5 py-[3px] text-[12px] text-gray-500">
              {translateObjective(campaign.objective)}
            </span>
          )}
        </div>
        <div className="text-[17px] font-bold text-ink md:text-[18px]">{campaign.name}</div>
        {campaign._accountName && (
          <div className="text-[12px] text-gray-500">{campaign._accountName}</div>
        )}
      </div>

      {/* Campaign KPIs */}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
        <Stat label={spendLabel} value={spendValue} highlight />
        <Stat label="曝光" value={fN(ins.impressions)} />
        <Stat label="觸及" value={fN(ins.reach)} />
        <Stat label="CPC" value={money(ins.cpc)} />
        <Stat label="CTR" value={fP(ins.ctr)} highlight />
      </div>

      {/* Top 5 by CTR */}
      <div className="flex flex-col gap-3">
        <div className="text-[15px] font-bold text-ink">點擊率前 5 素材</div>
        {adsLoading ? (
          <div className="rounded-xl border border-border bg-white px-3 py-4 text-[13px] text-gray-300">
            載入中...
          </div>
        ) : adsError ? (
          <div className="rounded-xl border border-border bg-white px-3 py-4 text-[13px] text-red">
            載入失敗:{adsError}
          </div>
        ) : topAds.length === 0 ? (
          <div className="rounded-xl border border-border bg-white px-3 py-4 text-[13px] text-gray-300">
            此區間無可排名的素材
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
            {topAds.map((s, i) => (
              <CreativeCard
                key={s.ad.id}
                rank={i + 1}
                ad={s.ad}
                campaignName={campaign.name}
                money={money}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CreativeCard({
  rank,
  ad,
  campaignName,
  money,
}: {
  rank: number;
  ad: FbCreativeEntity;
  campaignName: string;
  money: (v: number | string | null | undefined) => string;
}) {
  const ai = getIns(ad);
  // Full-res asset for a sharp card image; fall back to the small
  // thumbnail (video / carousel creatives have no image_url).
  const img = ad.creative?.image_url || ad.creative?.thumbnail_url;
  const [previewOpen, setPreviewOpen] = useState(false);
  const canPreview = Boolean(ad.creative?.thumbnail_url);

  return (
    <div
      className={`relative flex flex-col overflow-hidden rounded-xl border border-border bg-white ${
        canPreview ? "cursor-zoom-in" : ""
      }`}
      onClick={() => canPreview && setPreviewOpen(true)}
      onKeyDown={
        canPreview
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setPreviewOpen(true);
              }
            }
          : undefined
      }
      role={canPreview ? "button" : undefined}
      tabIndex={canPreview ? 0 : undefined}
      aria-label={canPreview ? "放大預覽" : undefined}
    >
      <span className="absolute left-2 top-2 z-[1] flex h-6 w-6 items-center justify-center rounded-full bg-orange text-[12px] font-bold text-white">
        {rank}
      </span>
      {img ? (
        <img
          src={img}
          alt=""
          loading="lazy"
          decoding="async"
          className="aspect-[3/4] w-full object-cover"
        />
      ) : (
        <div className="flex aspect-[3/4] w-full items-center justify-center bg-bg text-[11px] text-gray-300">
          無縮圖
        </div>
      )}
      <div className="flex flex-col gap-1.5 p-2.5">
        <div className="truncate text-[12px] font-semibold text-ink" title={ad.name}>
          {ad.name}
        </div>
        <div className="flex flex-col gap-0.5 text-[11px] text-gray-500">
          <Row label="點擊率" value={fP(ai.ctr)} />
          <Row label="點擊成本" value={money(ai.cpc)} />
          <Row label="曝光" value={fN(ai.impressions)} />
        </div>
      </div>
      {previewOpen && (
        <CreativePreviewModal
          creative={ad}
          campaignName={campaignName}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <span className="font-semibold tabular-nums text-ink">{value}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border bg-white px-3 py-2.5 md:px-3.5 md:py-3 ${
        highlight ? "border-orange" : "border-border"
      }`}
    >
      <div className="text-[12px] text-gray-500">{label}</div>
      <div
        className={`mt-1 text-[16px] font-bold tabular-nums md:text-[18px] ${
          highlight ? "text-orange" : "text-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/** "M/D - M/D" (single "M/D" when start == end). */
function concreteRangeLabel(date: DateConfig): string {
  const { start, end } = resolveRange(date);
  const parse = (iso: string) => {
    const parts = iso.split("-");
    return { m: Number.parseInt(parts[1] ?? "0", 10), d: Number.parseInt(parts[2] ?? "0", 10) };
  };
  const s = parse(start);
  const e = parse(end);
  if (start === end) return `${s.m}/${s.d}`;
  return `${s.m}/${s.d} - ${e.m}/${e.d}`;
}
