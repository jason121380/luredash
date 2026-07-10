import { useReportCampaign } from "@/api/hooks/useReportCampaign";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { downloadElementAsJpeg, waitForStableDom } from "@/lib/captureImage";
import type { DateConfig, DatePreset } from "@/lib/datePicker";
import { toLabel } from "@/lib/datePicker";
import { PerformanceReportContent } from "@/views/dashboard/PerformanceReportContent";
import { ReportContent } from "@/views/dashboard/ReportContent";
import { SnapshotReportPage } from "@/views/report/SnapshotReportPage";
import { useEffect, useMemo, useRef } from "react";

/** `/r/s/:id` → a frozen snapshot id, else null (live share link). */
function parseSnapshotIdFromPath(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(/^\/r\/s\/([^/]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * Public share-report route dispatcher. Two flavours:
 *   - `/r/s/:id`      → frozen snapshot (SnapshotReportPage), zero FB calls.
 *   - `/r/:campaignId`→ live report (LiveShareReportPage), fetches FB via
 *                       the server's shared token.
 *
 * The branch is decided BEFORE any hooks (path is stable per page load),
 * so each child owns its own hook order.
 */
export function ShareReportPage() {
  const snapshotId = parseSnapshotIdFromPath();
  if (snapshotId) return <SnapshotReportPage snapshotId={snapshotId} />;
  return <LiveShareReportPage />;
}

/**
 * Live share-report page. Mounted for `/r/:campaignId` — no FB login
 * required; the backend fetches live data with its shared runtime token.
 *
 * Reads campaign_id from the pathname segment and `acct` / `hide` /
 * `date` from the query string.
 */
function LiveShareReportPage() {
  const {
    campaignId,
    accountId,
    initialHide,
    datePreset,
    customFrom,
    customTo,
    useSpendPlus,
    markupPercent,
    showRecommendations,
    selectedFields,
    creativeFields,
    reportVariant,
    autoPrint,
    autoShot,
  } = useMemo(() => parseUrl(), []);

  // Element captured by the 下載 JPG flow (header + report card).
  const captureRef = useRef<HTMLDivElement>(null);

  // When the LINE push sent us explicit `from` / `to` query params
  // (the new behaviour as of 2026-05-05) we render the exact custom
  // range the push covered. Otherwise fall back to the legacy
  // `?date=preset` form so existing share links keep working.
  const date: DateConfig = useMemo(
    () =>
      customFrom && customTo
        ? { preset: "custom", from: customFrom, to: customTo }
        : { preset: datePreset, from: null, to: null },
    [datePreset, customFrom, customTo],
  );

  // `hideMoney` is now read-only from the URL (?hide=1) — the in-page
  // toggle was removed per design feedback. Keeps backwards compat
  // with shared links that already include the param.
  const hideMoney = initialHide;

  const { campaignQuery, adsetsQuery } = useReportCampaign(campaignId, accountId, date);

  const campaign = campaignQuery.data ?? null;

  // 下載 PDF flow: when opened with `?print=1`, auto-open the browser
  // print dialog once the campaign has loaded. A short delay lets the
  // KPI table + thumbnails paint first. Native print (unlike a canvas
  // capture) renders the cross-origin FB CDN images correctly.
  useEffect(() => {
    if (!autoPrint || !campaign || campaignQuery.isLoading) return;
    const t = window.setTimeout(() => window.print(), 1500);
    return () => window.clearTimeout(t);
  }, [autoPrint, campaign, campaignQuery.isLoading]);

  // 下載 JPG flow: when opened with `?shot=1`, rasterise the report to a
  // high-DPI JPEG and download it. `waitForStableDom` holds until the
  // perf report's per-adset ad queries + hires-thumbnail fetches stop
  // adding creative cards; `downloadElementAsJpeg` then waits on fonts +
  // <img> decode before the shot. Thumbnails render through the same-
  // origin proxy (captureMode) so the canvas isn't tainted.
  useEffect(() => {
    if (!autoShot || !campaign || campaignQuery.isLoading) return;
    let cancelled = false;
    (async () => {
      const el = captureRef.current;
      if (!el) return;
      await waitForStableDom(el);
      if (cancelled) return;
      try {
        await downloadElementAsJpeg(el, `report_${campaignId ?? "campaign"}`);
      } catch (err) {
        console.error("[share] JPG capture failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoShot, campaign, campaignQuery.isLoading, campaignId]);

  // `globals.css` locks `html, body` to `overflow: hidden` so the
  // authenticated Shell can manage its own scroll containers. The
  // share page has no Shell wrapping, so we install our own
  // scroll-root via `fixed inset-0 overflow-y-auto`. Without this,
  // any content past the viewport is unreachable on mobile.
  return (
    // print overrides: `fixed`+`overflow` would clip to one viewport
    // page — force static/visible so the whole report flows onto pages.
    <div className="fixed inset-0 overflow-y-auto bg-bg py-6 md:py-10 print:static print:overflow-visible print:bg-white print:py-0">
      <div
        ref={captureRef}
        className="mx-auto flex w-full max-w-[960px] flex-col gap-4 px-3 md:px-6"
      >
        <header className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-[12px] font-semibold uppercase tracking-[0.6px] text-orange">
              LURE META PLATFORM
            </div>
            <div className="text-[11px] text-gray-500">行銷活動報告 · {toLabel(date)}</div>
          </div>
        </header>

        <div className="rounded-2xl border border-border bg-white p-4 md:p-6">
          {!campaignId || !accountId ? (
            <EmptyState>報告連結參數不正確</EmptyState>
          ) : campaignQuery.isLoading ? (
            <LoadingState title="載入報告中..." />
          ) : campaignQuery.isError ? (
            <EmptyState>
              無法載入報告：
              {campaignQuery.error instanceof Error ? campaignQuery.error.message : "未知錯誤"}
            </EmptyState>
          ) : !campaign ? (
            <EmptyState>找不到此行銷活動</EmptyState>
          ) : reportVariant === "perf" ? (
            <PerformanceReportContent
              campaign={campaign}
              adsets={adsetsQuery.data ?? null}
              adsetsLoading={adsetsQuery.isLoading}
              adsetsError={adsetsQuery.error instanceof Error ? adsetsQuery.error.message : null}
              hideMoney={hideMoney}
              dateLabel={toLabel(date)}
              date={date}
              useSpendPlus={useSpendPlus}
              markupPercent={markupPercent}
              selectedFields={selectedFields}
              creativeFields={creativeFields}
              disablePreview
              captureMode={autoShot}
            />
          ) : (
            <ReportContent
              campaign={campaign}
              adsets={adsetsQuery.data ?? null}
              adsetsLoading={adsetsQuery.isLoading}
              adsetsError={adsetsQuery.error instanceof Error ? adsetsQuery.error.message : null}
              hideMoney={hideMoney}
              dateLabel={toLabel(date)}
              date={date}
              useSpendPlus={useSpendPlus}
              markupPercent={markupPercent}
              showRecommendations={showRecommendations}
              selectedFields={selectedFields}
              disablePreview
              captureMode={autoShot}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function parseUrl(): {
  campaignId: string | null;
  accountId: string | null;
  initialHide: boolean;
  datePreset: DatePreset;
  /** ISO YYYY-MM-DD when the link includes an explicit ?from=. */
  customFrom: string | null;
  /** ISO YYYY-MM-DD when the link includes an explicit ?to=. */
  customTo: string | null;
  useSpendPlus: boolean;
  markupPercent: number;
  /** ?advice=0 explicitly hides the「優化建議」 block. Default true
   *  so legacy share links and dashboard-modal links keep the
   *  recommendations visible. */
  showRecommendations: boolean;
  /** Comma-separated KPI codes from `?fields=`. null = no filter
   *  (legacy share-link / dashboard-modal links keep their full
   *  12-cell layout). */
  selectedFields: string[] | null;
  /** Comma-separated 素材卡 metric codes from `?cfields=`. null = the
   *  card's built-in default set. Only used by the perf variant. */
  creativeFields: string[] | null;
  /** `?report=perf` → render the 成效報告 (Top 5 by CTR). Anything
   *  else (incl. absent) → the standard report. */
  reportVariant: "standard" | "perf";
  /** `?print=1` → auto-open the print dialog once loaded (legacy 下載 PDF). */
  autoPrint: boolean;
  /** `?shot=1` → auto-capture the report to a JPEG and download it (下載 JPG). */
  autoShot: boolean;
} {
  if (typeof window === "undefined") {
    return {
      campaignId: null,
      accountId: null,
      initialHide: true,
      datePreset: "this_month",
      customFrom: null,
      customTo: null,
      useSpendPlus: false,
      markupPercent: 0,
      showRecommendations: true,
      selectedFields: null,
      creativeFields: null,
      reportVariant: "standard",
      autoPrint: false,
      autoShot: false,
    };
  }
  const path = window.location.pathname;
  const match = path.match(/^\/r\/([^/]+)/);
  const campaignId = match?.[1] ? decodeURIComponent(match[1]) : null;
  const params = new URLSearchParams(window.location.search);
  const accountId = params.get("acct");
  const initialHide = params.get("hide") === "1";
  const rawDate = params.get("date") ?? "this_month";
  const datePreset = isValidPreset(rawDate) ? rawDate : "this_month";
  // Explicit custom range — take precedence over `date=preset` so the
  // exact reporting window from the LINE push is preserved end-to-end.
  // Both must be valid ISO YYYY-MM-DD; if either is malformed we
  // ignore both and fall back to the preset.
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  const customFrom = isValidIsoDate(rawFrom) ? rawFrom : null;
  const customTo = isValidIsoDate(rawTo) ? rawTo : null;
  // 花費 / 花費+% — 由產生連結的操作者決定,接收者看到同一份視圖。
  const useSpendPlus = params.get("plus") === "1";
  const rawMkp = Number.parseFloat(params.get("mkp") ?? "");
  const markupPercent = Number.isFinite(rawMkp) && rawMkp > 0 ? rawMkp : 0;
  // Default true — only an explicit `?advice=0` hides recommendations.
  const showRecommendations = params.get("advice") !== "0";
  const rawFields = params.get("fields");
  const selectedFields = rawFields
    ? rawFields
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  const rawCFields = params.get("cfields");
  const creativeFields = rawCFields
    ? rawCFields
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  const reportVariant = params.get("report") === "perf" ? "perf" : "standard";
  const autoPrint = params.get("print") === "1";
  const autoShot = params.get("shot") === "1";
  return {
    campaignId,
    accountId,
    initialHide,
    datePreset,
    customFrom,
    customTo,
    useSpendPlus,
    markupPercent,
    showRecommendations,
    selectedFields,
    creativeFields,
    reportVariant,
    autoPrint,
    autoShot,
  };
}

function isValidIsoDate(s: string | null): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidPreset(s: string): s is DatePreset {
  return (
    s === "today" ||
    s === "yesterday" ||
    s === "last_7d" ||
    s === "last_30d" ||
    s === "last_90d" ||
    s === "this_month" ||
    s === "last_month"
  );
}
