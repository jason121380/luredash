import { api } from "@/api/client";
import { useNicknames } from "@/api/hooks/useNicknames";
import { Badge } from "@/components/Badge";
import { CreativePreviewModal } from "@/components/CreativePreviewModal";
import { ReportFieldsPicker } from "@/components/ReportFieldsPicker";
import { type DateConfig, resolveRange } from "@/lib/datePicker";
import { fF, fM, fN, fP } from "@/lib/format";
import {
  getAvgWatchSeconds,
  getCostPerLinkClick,
  getIns,
  getLinkClicks,
  getMsgCount,
  getPostReactions,
  getPostSaves,
  getShares,
} from "@/lib/insights";
import { translateObjective } from "@/lib/objective";
import { isTrafficObjective } from "@/lib/recommendations";
import { CREATIVE_FIELDS, DEFAULT_CREATIVE_FIELDS } from "@/lib/reportFields";
import type { FbAdset, FbCampaign, FbCreativeEntity } from "@/types/fb";
import { formatNickname } from "@/views/finance/financeData";
import { useQueries, useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { KpiTable, buildKpiCells, pickCells } from "./ReportContent";

/**
 * 成效報告 — creative-performance view of a single campaign, modelled on
 * the team's manual Google-Sheet report:
 *   [Header]  campaign name + date range + campaign KPIs
 *             (花費 / 曝光 / 觸及 / CPC / CTR)
 *   [素材成效]  every ad that spent, ranked by CTR desc, each a vertical
 *             creative card (thumbnail + 點擊率 / 點擊成本 / 曝光 /
 *             平均播放時間 / 按讚 / 分享).
 *
 * Shows only FB-auto-available metrics. 按讚 (post_reaction) / 分享
 * (post) come from `actions[]`; 平均播放時間 from
 * `video_avg_time_watched_actions` (video creatives only). The manual
 * sheet's IG 追蹤 / 收藏 / 觀看率 are NOT in the Marketing API and are
 * intentionally omitted.
 *
 * Ads are fetched per-adset (reusing the same `["report-ads", ...]`
 * query cache as the standard report) via `useQueries`, then flattened
 * and ranked across the whole campaign.
 */

const num = (v: string | number | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

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
  /** KPI codes to show in the campaign header. null → the built-in
   *  花費 / 曝光 / 觸及 / CPC / CTR set. Per-creative card metrics are
   *  unaffected (they're the report's fixed core). */
  selectedFields?: string[] | null;
  /** When true (public share link), creative cards are view-only — no
   *  click-to-enlarge preview modal. */
  disablePreview?: boolean;
  /** Which metrics each 素材卡 shows (ordered). null → the default card
   *  set (DEFAULT_CREATIVE_FIELDS). */
  creativeFields?: string[] | null;
  /** When provided, an editable 素材成效 field picker renders under the
   *  section heading (dashboard modal). Omit on the share page. */
  onCreativeFieldsChange?: (next: string[]) => void;
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
  selectedFields = null,
  disablePreview = false,
  creativeFields = null,
  onCreativeFieldsChange,
}: PerformanceReportContentProps) {
  const ins = getIns(campaign);
  const cardFields = creativeFields?.length ? creativeFields : DEFAULT_CREATIVE_FIELDS;
  // 店家 · 設計師 nickname: campaign.nickname (share page) → cached
  // useNicknames map (dashboard) → raw campaign name.
  const nicknames = useNicknames();
  const displayName =
    campaign.nickname?.trim() || formatNickname(nicknames.data?.[campaign.id]) || campaign.name;

  const money = (v: number | string | null | undefined): string =>
    hideMoney ? "—" : v !== null && v !== undefined && v !== "" ? `$${fM(v)}` : "—";
  const spendLabel = useSpendPlus ? "花費*" : "花費";
  const spendValue = (() => {
    const raw = num(ins.spend);
    if (hideMoney) return "—";
    if (!Number.isFinite(raw) || raw === 0) return money(ins.spend);
    return `$${fM(useSpendPlus ? Math.ceil(raw * (1 + markupPercent / 100)) : raw)}`;
  })();

  // When the user picked specific KPI fields, render exactly those in
  // the campaign header (shared catalog with the standard report).
  const headerCells = selectedFields?.length
    ? pickCells(
        buildKpiCells(campaign, {
          hideMoney,
          spendLabel,
          applyMarkup: (raw: number) =>
            useSpendPlus ? Math.ceil(raw * (1 + markupPercent / 100)) : raw,
          trafficMode: isTrafficObjective(campaign.objective),
        }),
        selectedFields,
      )
    : null;

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

  // Flatten → keep every ad that spent → rank by CTR desc (zero-CTR
  // ads keep their slot at the bottom; zero-spend ads are dropped).
  const allAds = adQueries.flatMap((q) => q.data ?? []);
  const rankedAds = allAds
    .map((ad) => ({ ad, ctr: num(getIns(ad).ctr), spend: num(getIns(ad).spend) }))
    .filter((s) => s.spend > 0)
    .sort((a, b) => b.ctr - a.ctr);

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
        <div className="text-[17px] font-bold text-ink md:text-[18px]">{displayName}</div>
      </div>

      {/* Campaign KPIs — single-row table. */}
      <KpiTable
        cells={
          headerCells ?? [
            { label: spendLabel, value: spendValue },
            { label: "曝光", value: fN(ins.impressions) },
            { label: "觸及", value: fN(ins.reach) },
            { label: "CPC", value: money(ins.cpc) },
            { label: "CTR", value: fP(ins.ctr) },
          ]
        }
      />

      {/* All spending ads, ranked by CTR */}
      <div className="flex flex-col gap-3">
        <div className="text-[15px] font-bold text-ink">
          素材成效(依點擊率排序)
          {rankedAds.length > 0 && (
            <span className="ml-1.5 text-[12px] font-normal text-gray-400">
              共 {rankedAds.length} 則
            </span>
          )}
        </div>
        {/* Per-creative metric picker — dashboard modal only (omitted on
            the read-only share page). Controls which metrics each card
            shows + their order. */}
        {onCreativeFieldsChange && (
          <div className="rounded-xl border border-border bg-bg/50 p-3">
            <ReportFieldsPicker
              value={[...cardFields]}
              onChange={onCreativeFieldsChange}
              reorderable
              catalog={CREATIVE_FIELDS}
              defaults={DEFAULT_CREATIVE_FIELDS}
            />
          </div>
        )}
        {adsLoading ? (
          <div className="rounded-xl border border-border bg-white px-3 py-4 text-[13px] text-gray-300">
            載入中...
          </div>
        ) : adsError ? (
          <div className="rounded-xl border border-border bg-white px-3 py-4 text-[13px] text-red">
            載入失敗:{adsError}
          </div>
        ) : rankedAds.length === 0 ? (
          <div className="rounded-xl border border-border bg-white px-3 py-4 text-[13px] text-gray-300">
            此區間無有花費的素材
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
            {rankedAds.map((s, i) => (
              <CreativeCard
                key={s.ad.id}
                rank={i + 1}
                ad={s.ad}
                campaignName={campaign.name}
                money={money}
                disablePreview={disablePreview}
                fields={cardFields}
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
  disablePreview,
  fields,
}: {
  rank: number;
  ad: FbCreativeEntity;
  campaignName: string;
  money: (v: number | string | null | undefined) => string;
  disablePreview: boolean;
  fields: string[];
}) {
  const rows = fields.map((code) => creativeCell(ad, code, money)).filter(Boolean) as {
    label: string;
    value: string;
  }[];
  // Image priority for a sharp card:
  //   image_url (full-res still, image creatives) →
  //   600px server thumbnail (video creatives have no image_url; the
  //     field-expanded thumbnail_url is only ~64px → blurry when
  //     stretched to card size) →
  //   raw thumbnail_url (last resort).
  // The hires query shares the same key as `useHiresThumbnail` so the
  // preview modal's fetch is reused. No auth gate here on purpose: the
  // endpoint uses the backend's shared token, so it also works on the
  // logged-out /r/ share page.
  const creativeId = ad.creative?.id;
  const needsHires = !ad.creative?.image_url && !!creativeId;
  const hiresQuery = useQuery({
    queryKey: ["hires-thumbnail", creativeId, 600] as const,
    queryFn: async () => (creativeId ? api.creatives.hiresThumbnail(creativeId, 600) : null),
    enabled: needsHires,
    staleTime: 30 * 60_000,
  });
  const img =
    ad.creative?.image_url || hiresQuery.data?.thumbnail_url || ad.creative?.thumbnail_url;
  const [previewOpen, setPreviewOpen] = useState(false);
  const canPreview = Boolean(ad.creative?.thumbnail_url) && !disablePreview;

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
        // object-contain on a black bg so a square (or any non-3:4)
        // creative shows in full — letterbox bars are fine per feedback.
        <img
          src={img}
          alt=""
          loading="lazy"
          decoding="async"
          className="aspect-[3/4] w-full bg-black object-contain"
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
          {rows.map((r) => (
            <Row key={r.label} label={r.label} value={r.value} />
          ))}
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

/**
 * Resolve one 素材卡 metric code → {label, value}. Codes mirror
 * CREATIVE_FIELDS. Returns null when the metric doesn't apply to this ad
 * (avg_watch on a non-video creative) so the caller's `.filter(Boolean)`
 * drops the row entirely rather than showing "0:00" / "—".
 */
function creativeCell(
  ad: FbCreativeEntity,
  code: string,
  money: (v: number | string | null | undefined) => string,
): { label: string; value: string } | null {
  const ins = getIns(ad);
  switch (code) {
    case "ctr":
      return { label: "點擊率", value: fP(ins.ctr) };
    case "cpc":
      return { label: "點擊成本", value: money(ins.cpc) };
    case "impressions":
      return { label: "曝光", value: fN(ins.impressions) };
    case "reach":
      return { label: "觸及", value: fN(ins.reach) };
    case "clicks":
      return { label: "點擊", value: fN(ins.clicks) };
    case "cpm":
      return { label: "CPM", value: money(ins.cpm) };
    case "frequency":
      return { label: "頻次", value: fF(ins.frequency) };
    case "spend":
      return { label: "花費", value: money(ins.spend) };
    case "avg_watch": {
      const sec = getAvgWatchSeconds(ad);
      return sec > 0 ? { label: "平均播放時間", value: formatWatch(sec) } : null;
    }
    case "reactions":
      return { label: "按讚", value: fN(getPostReactions(ad)) };
    case "saves":
      return { label: "收藏", value: fN(getPostSaves(ad)) };
    case "shares":
      return { label: "分享", value: fN(getShares(ad)) };
    case "link_clicks":
      return { label: "連結點擊", value: fN(getLinkClicks(ad)) };
    case "cost_per_link_click":
      return { label: "連結點擊成本", value: money(getCostPerLinkClick(ad)) };
    case "msgs":
      return { label: "私訊數", value: fN(getMsgCount(ad)) };
    case "msg_cost": {
      const msgs = getMsgCount(ad);
      const spend = num(ins.spend);
      return { label: "私訊成本", value: msgs > 0 ? money(spend / msgs) : "—" };
    }
    default:
      return null;
  }
}

/** Seconds → "m:ss" (e.g. 15 → "0:15"), matching the manual report. */
function formatWatch(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
