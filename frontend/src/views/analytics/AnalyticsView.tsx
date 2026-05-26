import { useAccounts } from "@/api/hooks/useAccounts";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import { DatePicker } from "@/components/DatePicker";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { Topbar } from "@/layout/Topbar";
import { toLabel } from "@/lib/datePicker";
import { fM } from "@/lib/format";
import { useAccountsStore } from "@/stores/accountsStore";
import { useFiltersStore } from "@/stores/filtersStore";
import { useUiStore } from "@/stores/uiStore";
import type { FbAccount } from "@/types/fb";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnalyticsKpisRow } from "./AnalyticsKpis";
import { ChartCard } from "./ChartCard";
import { type AnalyticsData, computeAnalyticsData } from "./analyticsData";
import { DoughnutChartCard } from "./charts/DoughnutChartCard";
import { HBarChart } from "./charts/HBarChart";
import { ScatterChartCard } from "./charts/ScatterChartCard";
import { VBarDistChart } from "./charts/VBarDistChart";

/**
 * Analytics view — 6 KPI cards + 14 charts laid out in a responsive
 * grid (3 cols desktop, 2 at ≤1200px, 1 at ≤768px).
 *
 * Data pipeline:
 *   1. useAccounts → visible accounts (filtered by Settings selection)
 *   2. useMultiAccountCampaigns → flattened FbCampaign[] across all
 *      visible accounts
 *   3. useMultiAccountInsights → per-account insights (for accurate
 *      total spend)
 *   4. computeAnalyticsData() → a single pure aggregation pass
 *   5. Chart components consume the already-computed slices
 *
 * The chart registration (react-chartjs-2 + ChartDataLabels) is
 * idempotent via the module-level `import "../chartSetup"` in each
 * chart component.
 */

const ORANGE = "#FF6B2C";

// Chart color palettes — module-level constants so they keep stable
// references across renders. Previously defined inside AnalyticsBody,
// which created new array refs every render and forced all 14 Chart.js
// instances to destroy + re-create their canvases unnecessarily.
const PALETTE_CTR = ["#FFB899", "#FF9A62", ORANGE, "#2E7D32", "#1B5E20"];
const PALETTE_COST = ["#1B5E20", "#2E7D32", ORANGE, "#FF9A62", "#FF6B2C"];
const PALETTE_SPEND = ["#E0E0E0", "#FFB899", "#FF9A62", ORANGE, "#CC4400"];
const PALETTE_DOUGHNUT = [
  "#1B5E20",
  "#2E7D32",
  "#388E3C",
  "#43A047",
  ORANGE,
  "#FF9A62",
  "#FF6B2C",
  "#CC4400",
];

export function AnalyticsView() {
  const accountsQuery = useAccounts();
  const allAccounts = accountsQuery.data ?? [];
  const visible = useAccountsStore((s) => s.visibleAccounts)(allAccounts);

  const date = useFiltersStore((s) => s.date.shared);
  const setDate = useFiltersStore((s) => s.setDate);
  const settingsReady = useUiStore((s) => s.settingsReady);

  // Single batch request for campaigns + per-account insights —
  // replaces the old `useMultiAccountCampaigns` + `useMultiAccountInsights`
  // pair so we only hit the backend once instead of 2 × N times.
  const overview = useMultiAccountOverview(visible, date, { includeArchived: true });

  const data = useMemo(
    () => computeAnalyticsData(overview.campaigns, overview.insights, visible),
    [overview.campaigns, overview.insights, visible],
  );

  const isLoading = overview.isLoading || overview.insightsPending;

  return (
    <>
      <Topbar title="數據圖表">
        <div className="flex items-center gap-3">
          <DatePicker value={date} onChange={(cfg) => setDate("shared", cfg)} />
        </div>
      </Topbar>

      <div className="flex-1 p-3 md:p-6">
        {!settingsReady ? (
          <LoadingState
            title="分析資料中..."
            loaded={overview.loadedCount}
            total={overview.totalCount}
          />
        ) : visible.length === 0 ? (
          <EmptyState>請先在設定中啟用廣告帳戶</EmptyState>
        ) : isLoading ? (
          <LoadingState
            title="分析資料中..."
            loaded={overview.loadedCount}
            total={overview.totalCount}
          />
        ) : (
          <AnalyticsBody data={data} visible={visible} periodLabel={toLabel(date)} />
        )}
      </div>
    </>
  );
}

/**
 * Lazy chart wrapper — uses IntersectionObserver to defer rendering
 * of below-fold charts. The first 3 charts (visible in the initial
 * viewport) use plain `<ChartCard>`; the remaining 11 use this wrapper
 * so Chart.js only initialises when the card scrolls into view.
 *
 * `rootMargin: "200px"` starts rendering ~200px before the card enters
 * the viewport so the chart is ready by the time the user scrolls to it.
 */
function LazyChartCard({
  title,
  emptyMessage,
  children,
  height = 220,
}: {
  title: string;
  emptyMessage?: string | null;
  children: React.ReactNode;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref}>
      <ChartCard title={title} emptyMessage={emptyMessage} height={height}>
        {visible ? children : null}
      </ChartCard>
    </div>
  );
}

interface AnalyticsBodyProps {
  data: AnalyticsData;
  visible: FbAccount[];
  periodLabel: string;
}

function AnalyticsBody({ data, visible, periodLabel }: AnalyticsBodyProps) {
  return (
    <>
      <AnalyticsKpisRow kpis={data.kpis} accountCount={visible.length} periodLabel={periodLabel} />

      <div
        className="ai-chart-grid grid gap-3 md:gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
      >
        {/* 1. Spend by account */}
        <ChartCard
          title="各帳戶花費分布"
          emptyMessage={data.spendByAccount.length === 0 ? "無花費資料" : null}
        >
          <HBarChart
            labels={data.spendByAccount.map((a) => a.name)}
            data={data.spendByAccount.map((a) => a.value)}
            color={ORANGE}
            formatLabel={(v) => `$${fM(v)}`}
            formatTick={(v) => `$${fM(v)}`}
            padRight={60}
          />
        </ChartCard>

        {/* 2. Msg by account */}
        <ChartCard
          title="各帳戶私訊數"
          emptyMessage={data.msgByAccount.length === 0 ? "無私訊數據（可能未追蹤私訊轉換）" : null}
        >
          <HBarChart
            labels={data.msgByAccount.map((a) => a.name)}
            data={data.msgByAccount.map((a) => a.value)}
            color="#2E7D32"
            formatLabel={(v) => fM(v)}
            formatTick={(v) => fM(v)}
            padRight={50}
          />
        </ChartCard>

        {/* 3. CTR distribution */}
        <ChartCard title="CTR 分布區間">
          <VBarDistChart
            labels={data.ctrDist.labels}
            values={data.ctrDist.values}
            colors={PALETTE_CTR}
          />
        </ChartCard>

        {/* 4. Scatter */}
        <LazyChartCard
          title={data.scatterIsMsgCost ? "花費 vs 私訊成本（各活動）" : "花費 vs CTR（各活動）"}
          emptyMessage={data.scatter.length === 0 ? "無散點資料" : null}
        >
          <ScatterChartCard
            points={data.scatter}
            isMsgCost={data.scatterIsMsgCost}
            formatMoney={fM}
          />
        </LazyChartCard>

        {/* 5. Msg cost distribution */}
        <LazyChartCard
          title="私訊成本分布"
          emptyMessage={data.msgCostDist.values.every((v) => v === 0) ? "無私訊成本數據" : null}
        >
          <VBarDistChart
            labels={data.msgCostDist.labels}
            values={data.msgCostDist.values}
            colors={PALETTE_COST}
          />
        </LazyChartCard>

        {/* 6. Top 10 msg */}
        <LazyChartCard
          title="私訊數 Top 10 活動"
          emptyMessage={data.topMsg.length === 0 ? "無私訊數據" : null}
        >
          <HBarChart
            labels={data.topMsg.map((r) => shortName(r.campaign.name))}
            data={data.topMsg.map((r) => r.metric)}
            color="#2E7D32"
            formatLabel={(v) => fM(v)}
            formatTick={(v) => fM(v)}
            padRight={45}
          />
        </LazyChartCard>

        {/* 7. Best CPM (lowest msg cost) */}
        <LazyChartCard
          title="最低私訊成本 Top 10 活動"
          emptyMessage={data.bestCpm.length === 0 ? "無私訊數據" : null}
        >
          <HBarChart
            labels={data.bestCpm.map((r) => shortName(r.campaign.name))}
            data={data.bestCpm.map((r) => Number(r.cost.toFixed(0)))}
            color="#1B5E20"
            formatLabel={(v) => `$${fM(v)}`}
            formatTick={(v) => `$${fM(v)}`}
            padRight={55}
          />
        </LazyChartCard>

        {/* 8. Account msg cost */}
        <LazyChartCard
          title="各帳戶平均私訊成本"
          emptyMessage={data.acctMsgCost.length === 0 ? "無私訊數據" : null}
        >
          <HBarChart
            labels={data.acctMsgCost.map((a) => a.name)}
            data={data.acctMsgCost.map((a) => a.value)}
            color={ORANGE}
            formatLabel={(v) => `$${fM(v)}`}
            formatTick={(v) => `$${fM(v)}`}
            padRight={55}
          />
        </LazyChartCard>

        {/* 9. Account CTR */}
        <LazyChartCard
          title="各帳戶 CTR 比較"
          emptyMessage={data.acctCtr.length === 0 ? "無數據" : null}
        >
          <HBarChart
            labels={data.acctCtr.map((a) => a.name)}
            data={data.acctCtr.map((a) => a.value)}
            color="#1565C0"
            formatLabel={(v) => `${v}%`}
            formatTick={(v) => `${v}%`}
            padRight={40}
          />
        </LazyChartCard>

        {/* 10. CPC distribution */}
        <LazyChartCard title="CPC 分布區間">
          <VBarDistChart
            labels={data.cpcDist.labels}
            values={data.cpcDist.values}
            colors={PALETTE_COST}
          />
        </LazyChartCard>

        {/* 11. Spend distribution */}
        <LazyChartCard title="花費規模分布（各活動）">
          <VBarDistChart
            labels={data.spendDist.labels}
            values={data.spendDist.values}
            colors={PALETTE_SPEND}
          />
        </LazyChartCard>

        {/* 12. Msg ratio doughnut */}
        <LazyChartCard title="有 / 無私訊活動比例">
          <DoughnutChartCard
            labels={["有私訊數據", "無私訊數據"]}
            data={[data.msgRatio.withMsg, data.msgRatio.withoutMsg]}
            colors={["#2E7D32", "#E0E0E0"]}
            legendPosition="bottom"
            cutout="60%"
            formatTooltip={(label, value) => `${label}: ${value} 個`}
          />
        </LazyChartCard>

        {/* 13. Msg share by account */}
        <LazyChartCard
          title="私訊數佔比（各帳戶）"
          emptyMessage={data.msgShare.length === 0 ? "無私訊數據" : null}
        >
          <DoughnutChartCard
            labels={data.msgShare.map((a) => a.name)}
            data={data.msgShare.map((a) => a.value)}
            colors={PALETTE_DOUGHNUT.slice(0, data.msgShare.length)}
            legendPosition="right"
            cutout="55%"
            formatTooltip={(label, value) => `${label}: ${fM(value)} 則`}
          />
        </LazyChartCard>

        {/* 14. Msg ROI */}
        <LazyChartCard
          title="高私訊效益活動 Top 10（私訊/千元花費）"
          emptyMessage={data.msgRoi.length === 0 ? "無私訊數據" : null}
        >
          <HBarChart
            labels={data.msgRoi.map((r) => shortName(r.campaign.name))}
            data={data.msgRoi.map((r) => Number(r.metric.toFixed(1)))}
            color="#1B5E20"
            formatLabel={(v) => `${v} 則`}
            formatTick={(v) => `${v} 則`}
            padRight={50}
          />
        </LazyChartCard>
      </div>
    </>
  );
}

function shortName(s: string): string {
  return s.length > 22 ? `${s.slice(0, 22)}…` : s;
}
