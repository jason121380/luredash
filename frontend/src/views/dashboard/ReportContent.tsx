import { api } from "@/api/client";
import { useNicknames } from "@/api/hooks/useNicknames";
import { useReportAds } from "@/api/hooks/useReportCampaign";
import { Badge } from "@/components/Badge";
import { CreativePreviewModal } from "@/components/CreativePreviewModal";
import { type DateConfig, resolveRange } from "@/lib/datePicker";
import { fF, fM, fN, fP } from "@/lib/format";
import {
  getAtcCount,
  getCostPerAtc,
  getCostPerLinkClick,
  getCostPerPurchase,
  getIns,
  getLinkClicks,
  getMsgCount,
  getPurchaseCount,
  getRoas,
} from "@/lib/insights";
import { translateObjective } from "@/lib/objective";
import { proxyImage } from "@/lib/proxyImage";
import { buildCampaignRecommendations, isTrafficObjective } from "@/lib/recommendations";
import type { FbAdset, FbBaseEntity, FbCampaign, FbCreativeEntity } from "@/types/fb";
import { formatNickname } from "@/views/finance/financeData";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { BreakdownInsightStrip } from "./BreakdownInsightStrip";

/** When true (public share page), ad cards are view-only — no click-to-
 *  preview modal. Read by `AdCard` deep in the adset tree so we don't
 *  thread the flag through every level. */
const PreviewDisabledContext = createContext(false);

/** When true (下載 JPG capture), ad thumbnails load through the same-
 *  origin proxy + eager so html-to-image can rasterise them without
 *  tainting the canvas. Read by `AdCard` deep in the tree, same as
 *  PreviewDisabledContext. */
const CaptureModeContext = createContext(false);

/** When true (public share link), clicking an ad card opens a media-only
 *  preview (video autoplays / image), no page header / download / body.
 *  The in-app report keeps the full preview. Read by `AdCard`. */
const PreviewMediaOnlyContext = createContext(false);

/**
 * Insight-oriented campaign report. Designed to answer the operator's
 * three questions at a glance:
 *   1. 我的花費換到了什麼結果？
 *   2. 哪些受眾表現最好？
 *   3. 哪個素材表現最好？
 *
 * Layout:
 *   [Header]            big concrete date range + status + objective
 *   [KPI grid]          12 KPIs (msg cells suppressed for traffic
 *                       objectives — they're noise there)
 *   [Recommendations]   bullet narrative (mirrors the LINE flex push)
 *   [Adset section ×N]  auto-expanded
 *     - mini KPI row
 *     - 4-card audience insight strip (best per dim)
 *     - ad cards: thumbnail + KPIs + 「★ 表現最佳」 badge
 *
 * Type sizes have been bumped one step across the board (per design
 * feedback 2026-04-26): KPI 17px, adset name 16px, ad name 14px.
 *
 * `hideMoney` masks $ values with em-dashes for share-link recipients
 * who should see performance but not cost.
 */

const num = (v: string | number | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Per-cell descriptor used by the campaign / adset / ad KPI layouts.
 * `value` is already formatted (with hideMoney / markup applied) so
 * the renderer just drops it into a Stat / Cell / inline span.
 */
export interface KpiCell {
  code: string;
  label: string;
  value: string;
  highlight?: boolean;
}

export interface KpiOpts {
  hideMoney: boolean;
  spendLabel: string;
  applyMarkup: (n: number) => number;
  trafficMode: boolean;
}

/**
 * Build the full superset of KPI cells for an entity (campaign / adset
 * / ad). The campaign / adset / ad renderers each pick a subset of
 * this list:
 *   - With `selectedFields`, render only those codes in that order.
 *   - Without, use the legacy hard-coded order at each level.
 *
 * `spend_plus` is treated as an alias for `spend` since the cell's
 * value already reflects useSpendPlus / markup; the LINE push config's
 * mutex pair means at most one of them appears in selectedFields.
 */
export function buildKpiCells(entity: FbBaseEntity, opts: KpiOpts): KpiCell[] {
  const ins = getIns(entity);
  const msgs = getMsgCount(entity);
  const spend = num(ins.spend);
  const msgCost = msgs > 0 ? spend / msgs : 0;
  const linkClicks = getLinkClicks(entity);
  const cplc = getCostPerLinkClick(entity);
  const atc = getAtcCount(entity);
  const cpAtc = getCostPerAtc(entity);
  const purchases = getPurchaseCount(entity);
  const cpPurchase = getCostPerPurchase(entity);
  const roas = getRoas(entity);

  const money = (v: number | string | null | undefined): string =>
    opts.hideMoney ? "—" : v !== null && v !== undefined && v !== "" ? `$${fM(v)}` : "—";
  const spendValue = (() => {
    const raw = num(ins.spend);
    if (!Number.isFinite(raw) || raw === 0) return money(ins.spend);
    return money(opts.applyMarkup(raw));
  })();

  return [
    { code: "spend", label: opts.spendLabel, value: spendValue, highlight: true },
    // Mutex alias — backend ships either "spend" or "spend_plus" in
    // selectedFields; useSpendPlus already drives the label/value.
    { code: "spend_plus", label: opts.spendLabel, value: spendValue, highlight: true },
    { code: "impressions", label: "曝光", value: fN(ins.impressions) },
    { code: "clicks", label: "點擊", value: fN(ins.clicks) },
    { code: "ctr", label: "CTR", value: fP(ins.ctr), highlight: opts.trafficMode },
    { code: "cpc", label: "CPC", value: money(ins.cpc), highlight: opts.trafficMode },
    { code: "cpm", label: "CPM", value: money(ins.cpm) },
    { code: "frequency", label: "頻次", value: fF(ins.frequency) },
    { code: "reach", label: "觸及", value: fN(ins.reach) },
    {
      code: "msgs",
      label: "私訊數",
      value: msgs > 0 ? fN(msgs) : "—",
      highlight: msgs > 0,
    },
    {
      code: "msg_cost",
      label: "私訊成本",
      value: msgs > 0 ? money(msgCost) : "—",
      highlight: msgs > 0,
    },
    {
      code: "link_clicks",
      label: "連結點擊",
      value: linkClicks > 0 ? fN(linkClicks) : "—",
    },
    {
      code: "cost_per_link_click",
      label: "連結點擊成本",
      value: cplc > 0 ? money(cplc) : "—",
    },
    { code: "add_to_cart", label: "加入購物車", value: atc > 0 ? fN(atc) : "—" },
    {
      code: "cost_per_add_to_cart",
      label: "加入購物車成本",
      value: cpAtc > 0 ? money(cpAtc) : "—",
    },
    { code: "purchases", label: "購買數", value: purchases > 0 ? fN(purchases) : "—" },
    {
      code: "cost_per_purchase",
      label: "購買成本",
      value: cpPurchase > 0 ? money(cpPurchase) : "—",
    },
    { code: "roas", label: "ROAS", value: roas > 0 ? roas.toFixed(2) : "—" },
  ];
}

/** Filter and reorder cells to match selectedFields (when supplied).
 * Returns the input untouched when selectedFields is null/undefined,
 * preserving the existing layout for legacy share links. */
export function pickCells(all: KpiCell[], selectedFields: string[] | null | undefined): KpiCell[] {
  if (!selectedFields?.length) return all;
  const map = new Map(all.map((c) => [c.code, c] as const));
  const out: KpiCell[] = [];
  for (const code of selectedFields) {
    const cell = map.get(code);
    if (cell) out.push(cell);
  }
  return out;
}

export interface ReportContentProps {
  campaign: FbCampaign;
  adsets: FbAdset[] | null;
  adsetsLoading?: boolean;
  adsetsError?: string | null;
  hideMoney: boolean;
  /** Preset name like "本月" — kept as a small caption next to the
   *  big concrete-date headline so users see both at a glance. */
  dateLabel?: ReactNode;
  date: DateConfig;
  /** When true, every 花費 cell renders as 花費* using the marked-up
   *  amount (spend × (1 + markupPercent/100), ceiled). Other money
   *  cells (CPC / CPM / 私訊成本) stay raw — only the spend total
   *  reflects the operator's billing markup. */
  useSpendPlus?: boolean;
  /** Markup percent applied when useSpendPlus is true. Comes from
   *  finance_row_markups[campaignId] or finance_default_markup at the
   *  time the modal/share-link was created. */
  markupPercent?: number;
  /** When false the「優化建議」block is hidden. Mirrors the LINE
   *  push config's `include_recommendations` so a share link sent
   *  from a config that opted out doesn't surface advice the
   *  operator deliberately suppressed. Default true preserves the
   *  legacy share-page behaviour for links generated outside the
   *  push flow (dashboard report modal). */
  showRecommendations?: boolean;
  /** KPI codes (e.g. ["spend", "msgs", "msg_cost"]) the LINE push
   *  config picked. When provided the campaign / adset / ad KPI
   *  layouts only render those cells, in the supplied order, so the
   *  share page mirrors exactly what the LINE flex showed. null /
   *  undefined → fall back to the legacy 12-cell layout (preserves
   *  the dashboard report-modal share flow). */
  selectedFields?: string[] | null;
  /** When true, ad cards are not clickable (no preview modal). */
  disablePreview?: boolean;
  /** When true (public share link), clicking an ad opens a media-only
   *  preview (video autoplays / image) — no header / download / body. */
  previewMediaOnly?: boolean;
  /** Capture mode (下載 JPG): thumbnails via same-origin proxy + eager
   *  so html-to-image can rasterise without tainting the canvas. */
  captureMode?: boolean;
}

export function ReportContent({
  campaign,
  adsets,
  adsetsLoading,
  adsetsError,
  hideMoney,
  dateLabel,
  date,
  useSpendPlus = false,
  markupPercent = 0,
  showRecommendations = true,
  selectedFields = null,
  disablePreview = false,
  previewMediaOnly = false,
  captureMode = false,
}: ReportContentProps) {
  const ins = getIns(campaign);
  const msgs = getMsgCount(campaign);
  const spend = num(ins.spend);
  const cpc = num(ins.cpc);
  const frequency = num(ins.frequency);
  const msgCost = msgs > 0 ? spend / msgs : 0;
  const trafficMode = isTrafficObjective(campaign.objective);
  // Prefer the 店家 · 設計師 nickname: campaign.nickname (share page,
  // server-resolved) → cached useNicknames map (dashboard) → raw name.
  const nicknames = useNicknames();
  const displayName =
    campaign.nickname?.trim() || formatNickname(nicknames.data?.[campaign.id]) || campaign.name;

  const recommendations = buildCampaignRecommendations({
    spend,
    msgs,
    msgCost,
    cpc,
    frequency,
    objective: campaign.objective,
  });

  const money = (v: number | string | null | undefined): string =>
    hideMoney ? "—" : v !== null && v !== undefined && v !== "" ? `$${fM(v)}` : "—";

  // 「花費」相關格式化:啟用 spend_plus 時對 raw spend 套用 markup
  // 並把 label 從「花費」改為「花費*」(星號代表加成,不洩漏實際%)。
  // 只影響 spend 自身,CPC / CPM / 私訊成本維持 FB 原始值,以免雙重
  // 加成造成數字脫離真實表現。
  const spendLabel = useSpendPlus ? "花費*" : "花費";
  const applyMarkup = (raw: number): number =>
    useSpendPlus ? Math.ceil(raw * (1 + markupPercent / 100)) : raw;
  const spendMoney = (raw: number | string | null | undefined): string => {
    if (raw === null || raw === undefined || raw === "") return money(raw);
    return money(applyMarkup(num(raw)));
  };

  return (
    <PreviewDisabledContext.Provider value={disablePreview}>
      <PreviewMediaOnlyContext.Provider value={previewMediaOnly}>
        <CaptureModeContext.Provider value={captureMode}>
          <div className="flex flex-col gap-5">
            {/* Header — concrete date range top-left, big + orange so the
          reader anchors on the period before reading numbers. */}
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

            {/* Campaign-wide KPIs — single-row table. */}
            <KpiTable
              cells={
                selectedFields?.length
                  ? pickCells(
                      buildKpiCells(campaign, { hideMoney, spendLabel, applyMarkup, trafficMode }),
                      selectedFields,
                    )
                  : [
                      { label: spendLabel, value: spendMoney(ins.spend) },
                      { label: "曝光", value: fN(ins.impressions) },
                      { label: "點擊", value: fN(ins.clicks) },
                      { label: "CTR", value: fP(ins.ctr) },
                      { label: "CPC", value: money(ins.cpc) },
                      { label: "CPM", value: money(ins.cpm) },
                      { label: "頻次", value: fF(ins.frequency) },
                      { label: "觸及", value: fN(ins.reach) },
                      ...(!trafficMode
                        ? [
                            { label: "私訊數", value: msgs > 0 ? fN(msgs) : "—" },
                            { label: "私訊成本", value: msgs > 0 ? money(msgCost) : "—" },
                          ]
                        : []),
                      {
                        label: "預算",
                        value: hideMoney
                          ? "—"
                          : campaign.daily_budget
                            ? `日 $${fM(campaign.daily_budget)}`
                            : campaign.lifetime_budget
                              ? `總 $${fM(campaign.lifetime_budget)}`
                              : "組合層級",
                      },
                    ]
              }
            />

            {/* Recommendations narrative */}
            {showRecommendations && recommendations.length > 0 && (
              <div className="rounded-xl border border-orange/30 bg-orange-bg/40 px-4 py-3.5">
                <div className="mb-2 text-[13px] font-bold text-orange">優化建議</div>
                <ul className="flex flex-col gap-1.5">
                  {recommendations.map((r, i) => (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: stable bullet list
                      key={i}
                      className="flex items-start gap-2 text-[14px] text-ink"
                    >
                      <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-orange" />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Adsets — top 3 by spend auto-expand to keep the first paint
          insight-rich; the rest collapse to a header-only row that
          can be expanded on demand. Hides FB-call burst by default
          since each expanded adset fires a breakdown strip + ads
          list (~5 calls per adset). */}
            <AdsetSection
              adsets={adsets}
              adsetsLoading={adsetsLoading}
              adsetsError={adsetsError}
              date={date}
              hideMoney={hideMoney}
              money={money}
              spendMoney={spendMoney}
              spendLabel={spendLabel}
              trafficMode={trafficMode}
              campaignName={campaign.name}
              applyMarkup={applyMarkup}
              selectedFields={selectedFields}
            />
          </div>
        </CaptureModeContext.Provider>
      </PreviewMediaOnlyContext.Provider>
    </PreviewDisabledContext.Provider>
  );
}

const DEFAULT_EXPAND_TOP_N = 3;

function AdsetSection({
  adsets,
  adsetsLoading,
  adsetsError,
  date,
  hideMoney,
  money,
  spendMoney,
  spendLabel,
  trafficMode,
  campaignName,
  applyMarkup,
  selectedFields,
}: {
  adsets: FbAdset[] | null;
  adsetsLoading?: boolean;
  adsetsError?: string | null;
  date: DateConfig;
  hideMoney: boolean;
  money: (v: number | string | null | undefined) => string;
  spendMoney: (v: number | string | null | undefined) => string;
  spendLabel: string;
  trafficMode: boolean;
  campaignName: string;
  applyMarkup: (n: number) => number;
  selectedFields: string[] | null;
}) {
  // Sort by spend desc so the top spenders surface first; default-
  // expand the top N because that's where the operator's eye lands
  // first and which adsets they'll usually need details on.
  const visible = (adsets ?? [])
    .filter((a) => num(getIns(a).spend) > 0)
    .sort((a, b) => num(getIns(b).spend) - num(getIns(a).spend));
  const defaultExpandedIds = new Set(visible.slice(0, DEFAULT_EXPAND_TOP_N).map((a) => a.id));
  const [expandedIds, setExpandedIds] = useState<Set<string>>(defaultExpandedIds);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild the default set when the visible adsets list itself changes (e.g. date toggle re-fetches a different set)
  useEffect(() => {
    setExpandedIds(new Set(visible.slice(0, DEFAULT_EXPAND_TOP_N).map((a) => a.id)));
  }, [adsets]);

  const toggle = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandAll = () => setExpandedIds(new Set(visible.map((a) => a.id)));
  const collapseAll = () => setExpandedIds(new Set());

  const hiddenCount = visible.length - expandedIds.size;
  const allExpanded = hiddenCount === 0 && visible.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[15px] font-bold text-ink">廣告組合表現</div>
        {visible.length > DEFAULT_EXPAND_TOP_N && (
          <button
            type="button"
            onClick={allExpanded ? collapseAll : expandAll}
            className="text-[12px] text-orange hover:underline"
          >
            {allExpanded ? "收合全部" : `展開全部 (${visible.length})`}
          </button>
        )}
      </div>
      {adsetsLoading ? (
        <div className="rounded-xl border border-border bg-white px-3 py-4 text-[13px] text-gray-300">
          載入中...
        </div>
      ) : adsetsError ? (
        <div className="rounded-xl border border-border bg-white px-3 py-4 text-[13px] text-red">
          載入失敗:{adsetsError}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-border bg-white px-3 py-4 text-[13px] text-gray-300">
          此區間無花費的廣告組合
        </div>
      ) : (
        visible.map((a) => (
          <AdsetCard
            key={a.id}
            adset={a}
            date={date}
            hideMoney={hideMoney}
            money={money}
            spendMoney={spendMoney}
            spendLabel={spendLabel}
            trafficMode={trafficMode}
            campaignName={campaignName}
            applyMarkup={applyMarkup}
            selectedFields={selectedFields}
            expanded={expandedIds.has(a.id)}
            onToggle={() => toggle(a.id)}
          />
        ))
      )}
    </div>
  );
}

function AdsetCard({
  adset,
  date,
  hideMoney,
  money,
  spendMoney,
  spendLabel,
  trafficMode,
  campaignName,
  applyMarkup,
  selectedFields,
  expanded,
  onToggle,
}: {
  adset: FbAdset;
  date: DateConfig;
  hideMoney: boolean;
  money: (v: number | string | null | undefined) => string;
  spendMoney: (v: number | string | null | undefined) => string;
  spendLabel: string;
  trafficMode: boolean;
  campaignName: string;
  applyMarkup: (n: number) => number;
  selectedFields: string[] | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ai = getIns(adset);
  const am = getMsgCount(adset);
  const adsetCells = selectedFields?.length
    ? pickCells(
        buildKpiCells(adset, { hideMoney, spendLabel, applyMarkup, trafficMode }),
        selectedFields,
      )
    : null;

  return (
    <section className="rounded-xl border border-border bg-white p-4 md:p-5">
      {/* Adset header + mini KPIs — clickable to toggle expansion.
          Collapsed = header only (no breakdown / ads fetch fires);
          expanded = full insight panel below. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`-m-1 flex w-[calc(100%+8px)] flex-col gap-1.5 rounded-lg p-1 text-left transition-colors hover:bg-bg ${expanded ? "mb-3" : ""}`}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[10px] text-gray-500"
            aria-hidden="true"
          >
            {expanded ? "▼" : "▶"}
          </span>
          <Badge status={adset.status} />
          <span className="truncate text-[16px] font-bold text-ink" title={adset.name}>
            {adset.name}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-gray-500">
          {adsetCells ? (
            adsetCells.map((c) => (
              <span key={c.code}>
                {c.label} <span className="font-semibold text-ink">{c.value}</span>
              </span>
            ))
          ) : (
            <>
              <span>
                {spendLabel} <span className="font-semibold text-ink">{spendMoney(ai.spend)}</span>
              </span>
              <span>
                曝光 <span className="font-semibold text-ink">{fN(ai.impressions)}</span>
              </span>
              <span>
                CTR <span className="font-semibold text-ink">{fP(ai.ctr)}</span>
              </span>
              <span>
                CPC <span className="font-semibold text-ink">{money(ai.cpc)}</span>
              </span>
              {!trafficMode && am > 0 && (
                <span>
                  私訊 <span className="font-semibold text-ink">{fN(am)}</span>
                </span>
              )}
            </>
          )}
        </div>
      </button>

      {expanded && (
        <>
          {/* 4-dim audience insight strip */}
          <div className="mb-4">
            <div className="mb-2 text-[12px] font-semibold text-gray-500">受眾洞察</div>
            <BreakdownInsightStrip
              level="adset"
              id={adset.id}
              date={date}
              hideMoney={hideMoney}
              ignoreMsgs={trafficMode}
            />
          </div>

          {/* Ads list */}
          <AdCards
            adsetId={adset.id}
            date={date}
            money={money}
            spendMoney={spendMoney}
            spendLabel={spendLabel}
            trafficMode={trafficMode}
            campaignName={campaignName}
            hideMoney={hideMoney}
            applyMarkup={applyMarkup}
            selectedFields={selectedFields}
          />
        </>
      )}
    </section>
  );
}

interface ScoredAd {
  ad: FbCreativeEntity;
  spend: number;
  msgs: number;
  msgCost: number;
  ctr: number;
}

function AdCards({
  adsetId,
  date,
  money,
  spendMoney,
  spendLabel,
  trafficMode,
  campaignName,
  hideMoney,
  applyMarkup,
  selectedFields,
}: {
  adsetId: string;
  date: DateConfig;
  money: (v: number | string | null | undefined) => string;
  spendMoney: (v: number | string | null | undefined) => string;
  spendLabel: string;
  trafficMode: boolean;
  campaignName: string;
  hideMoney: boolean;
  applyMarkup: (n: number) => number;
  selectedFields: string[] | null;
}) {
  const adsQuery = useReportAds(adsetId, date, true);
  const ads = adsQuery.data ?? [];

  // Rank ads within this adset:
  //   - traffic mode → CTR (higher is better)
  //   - else: msgCost (lower) when any has messages, fallback to CTR
  // Zero-spend ads are filtered out — they'd be a row of em-dashes
  // contributing no information to the report.
  const scored: ScoredAd[] = ads
    .map((ad) => {
      const ains = getIns(ad);
      const m = getMsgCount(ad);
      const sp = num(ains.spend);
      return {
        ad,
        spend: sp,
        msgs: m,
        msgCost: m > 0 ? sp / m : Number.POSITIVE_INFINITY,
        ctr: num(ains.ctr),
      };
    })
    .filter((s) => s.spend > 0);

  const hasMsgPool = !trafficMode && scored.some((s) => s.msgs > 0);
  let bestId: string | null = null;
  if (hasMsgPool) {
    const pool = scored.filter((s) => s.msgs > 0);
    if (pool.length > 0) {
      const best = pool.reduce((b, s) => (s.msgCost < b.msgCost ? s : b), pool[0] as ScoredAd);
      bestId = best.ad.id;
    }
  } else if (scored.length > 0) {
    const best = scored.reduce((b, s) => (s.ctr > b.ctr ? s : b), scored[0] as ScoredAd);
    if (best.ctr > 0) bestId = best.ad.id;
  }

  return (
    <div>
      <div className="mb-2 text-[12px] font-semibold text-gray-500">素材表現</div>
      {adsQuery.isLoading ? (
        <div className="rounded-lg border border-border bg-bg px-3 py-3 text-[13px] text-gray-300">
          載入中...
        </div>
      ) : adsQuery.isError ? (
        <div className="rounded-lg border border-border bg-bg px-3 py-3 text-[13px] text-red">
          載入失敗:
          {adsQuery.error instanceof Error ? adsQuery.error.message : "未知錯誤"}
        </div>
      ) : scored.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg px-3 py-3 text-[13px] text-gray-300">
          此區間無花費的素材
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {scored.map((s) => (
            <AdCard
              key={s.ad.id}
              ad={s.ad}
              isBest={bestId === s.ad.id}
              money={money}
              spendMoney={spendMoney}
              spendLabel={spendLabel}
              trafficMode={trafficMode}
              campaignName={campaignName}
              hideMoney={hideMoney}
              applyMarkup={applyMarkup}
              selectedFields={selectedFields}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AdCard({
  ad,
  isBest,
  money,
  spendMoney,
  spendLabel,
  trafficMode,
  campaignName,
  hideMoney,
  applyMarkup,
  selectedFields,
}: {
  ad: FbCreativeEntity;
  isBest: boolean;
  money: (v: number | string | null | undefined) => string;
  spendMoney: (v: number | string | null | undefined) => string;
  spendLabel: string;
  trafficMode: boolean;
  campaignName: string;
  hideMoney: boolean;
  applyMarkup: (n: number) => number;
  selectedFields: string[] | null;
}) {
  const ai = getIns(ad);
  const m = getMsgCount(ad);
  const spend = num(ai.spend);
  const msgCost = m > 0 ? spend / m : null;
  const previewDisabled = useContext(PreviewDisabledContext);
  const previewMediaOnly = useContext(PreviewMediaOnlyContext);
  const captureMode = useContext(CaptureModeContext);
  // Sharp thumbnail: image_url (image creatives) → 600px server
  // thumbnail (videos have no image_url; the ~64px field-expanded
  // thumbnail_url is blurry) → raw thumbnail_url. Shares the preview
  // modal's cache key; no auth gate so it works on the /r/ share page.
  const creativeId = ad.creative?.id;
  const needsHires = !ad.creative?.image_url && !!creativeId;
  const hiresQuery = useQuery({
    queryKey: ["hires-thumbnail", creativeId, 600] as const,
    queryFn: async () => (creativeId ? api.creatives.hiresThumbnail(creativeId, 600) : null),
    enabled: needsHires,
    staleTime: 30 * 60_000,
  });
  const rawThumb =
    ad.creative?.image_url || hiresQuery.data?.thumbnail_url || ad.creative?.thumbnail_url;
  // 下載 JPG:同源代理 + eager,避免 canvas taint。
  const thumb = captureMode ? proxyImage(rawThumb) : rawThumb;
  const [previewOpen, setPreviewOpen] = useState(false);
  const showMsg = !trafficMode && m > 0;
  const adCells = selectedFields?.length
    ? pickCells(
        buildKpiCells(ad, { hideMoney, spendLabel, applyMarkup, trafficMode }),
        selectedFields,
      )
    : null;
  // View-only on the share page: no click-to-enlarge for clients.
  const canPreview = Boolean(ad.creative?.thumbnail_url) && !previewDisabled;
  const openPreview = () => {
    if (canPreview) setPreviewOpen(true);
  };

  return (
    <div
      className={`relative rounded-lg border bg-bg p-3.5 ${
        canPreview ? "cursor-zoom-in" : ""
      } ${isBest ? "border-orange" : "border-border"}`}
      onClick={openPreview}
      onKeyDown={
        canPreview
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openPreview();
              }
            }
          : undefined
      }
      role={canPreview ? "button" : undefined}
      tabIndex={canPreview ? 0 : undefined}
      aria-label={canPreview ? "放大預覽" : undefined}
    >
      {isBest && (
        <span className="absolute -top-2 left-3 rounded-full bg-orange px-2.5 py-[3px] text-[11px] font-bold text-white">
          ★ 表現最佳
        </span>
      )}
      <div className="flex items-start gap-3">
        {thumb ? (
          <img
            src={thumb}
            alt=""
            loading={captureMode ? "eager" : "lazy"}
            decoding="async"
            className="h-[64px] w-[64px] shrink-0 rounded border border-border object-cover"
          />
        ) : (
          <div className="h-[64px] w-[64px] shrink-0 rounded border border-border bg-white" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-ink" title={ad.name}>
            {ad.name}
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-gray-500">
            {adCells ? (
              adCells.map((c) => <Cell key={c.code} label={c.label} value={c.value} />)
            ) : (
              <>
                <Cell label={spendLabel} value={spendMoney(ai.spend)} />
                <Cell label="曝光" value={fN(ai.impressions)} />
                <Cell label="CTR" value={fP(ai.ctr)} />
                <Cell label="CPC" value={money(ai.cpc)} />
                {showMsg && <Cell label="私訊" value={fN(m)} />}
                {showMsg && msgCost !== null && <Cell label="私訊成本" value={money(msgCost)} />}
              </>
            )}
          </div>
        </div>
      </div>
      {previewOpen && (
        <CreativePreviewModal
          creative={ad}
          campaignName={campaignName}
          mediaOnly={previewMediaOnly}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label} <span className="font-semibold tabular-nums text-ink">{value}</span>
    </span>
  );
}

/** Resolve the report's date config into a "M/D - M/D" string. Falls
 *  back to a single "M/D" when start == end (e.g. yesterday-only). */
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

/** Campaign KPI presented as a single-row table (labels in the header,
 *  one row of values). Scrolls horizontally when the selection is wide.
 *  Shared with `PerformanceReportContent`. */
export function KpiTable({ cells }: { cells: { label: string; value: ReactNode }[] }) {
  if (cells.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-white">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border">
            {cells.map((c, i) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: labels can repeat; index is stable here
                key={i}
                className="whitespace-nowrap px-3 py-2 text-[12px] font-medium text-gray-500"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {cells.map((c, i) => (
              <td
                // biome-ignore lint/suspicious/noArrayIndexKey: pairs with the header cell above
                key={i}
                className="whitespace-nowrap px-3 py-2.5 text-[16px] font-bold tabular-nums text-ink md:text-[18px]"
              >
                {c.value}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
