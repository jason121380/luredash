import { type ReportSnapshotPayload, api } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import type { DateConfig, DatePreset } from "@/lib/datePicker";
import { toLabel } from "@/lib/datePicker";
import { PerformanceReportContent } from "@/views/dashboard/PerformanceReportContent";
import { ReportContent } from "@/views/dashboard/ReportContent";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * Frozen-snapshot share page (`/r/s/:id`). Loads a report snapshot the
 * operator generated earlier — a one-time freeze of the whole report
 * tree (campaign + adsets + ads + breakdowns) with thumbnails stored on
 * our server — and renders it with ZERO Facebook calls.
 *
 * How the "zero FB calls" guarantee works: the same report components
 * (`ReportContent` / `PerformanceReportContent`) that the live page uses
 * fetch their per-adset ads + breakdowns via React Query. Here we mount
 * them inside a DEDICATED QueryClient that we pre-seed with the frozen
 * data (and configure to never refetch), so every `useQuery` inside the
 * tree reads from cache and no queryFn ever runs. Thumbnail URLs in the
 * payload already point at same-origin stored assets.
 */

const BREAKDOWN_DIMS = ["publisher_platform", "gender", "age", "region"] as const;

export function SnapshotReportPage({ snapshotId }: { snapshotId: string }) {
  const q = useQuery({
    queryKey: ["report-snapshot", snapshotId],
    queryFn: () => api.reportSnapshots.get(snapshotId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

  const headerDate = q.data?.date_label || q.data?.data?.meta?.date_label || "";

  return (
    <div className="fixed inset-0 overflow-y-auto bg-bg py-6 md:py-10 print:static print:overflow-visible print:bg-white print:py-0">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4 px-3 md:px-6">
        <header className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-[12px] font-semibold uppercase tracking-[0.6px] text-orange">
              LURE META PLATFORM
            </div>
            <div className="text-[11px] text-gray-500">
              行銷活動報告{headerDate ? ` · ${headerDate}` : ""}
            </div>
          </div>
        </header>

        <div className="rounded-2xl border border-border bg-white p-4 md:p-6">
          {q.isLoading ? (
            <LoadingState title="載入報告中..." />
          ) : q.isError ? (
            <EmptyState>
              無法載入報告:{q.error instanceof Error ? q.error.message : "未知錯誤"}
            </EmptyState>
          ) : !q.data?.data?.campaign ? (
            <EmptyState>找不到此報告快照</EmptyState>
          ) : (
            <FrozenReport payload={q.data.data} />
          )}
        </div>
      </div>
    </div>
  );
}

function FrozenReport({ payload }: { payload: ReportSnapshotPayload }) {
  const meta = payload.meta;

  // Build the isolated, pre-seeded client + reconstruct the exact
  // DateConfig used at generation time (its VALUE, not identity, is what
  // React Query hashes into the query keys — so the components' keys will
  // match the seeded ones).
  const { client, date } = useMemo(() => {
    const m = payload.meta;
    const d: DateConfig =
      m.time_range && m.from && m.to
        ? { preset: "custom", from: m.from, to: m.to }
        : {
            preset: (m.date_preset as DatePreset | undefined) ?? "this_month",
            from: null,
            to: null,
          };
    const c = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: Number.POSITIVE_INFINITY,
          gcTime: Number.POSITIVE_INFINITY,
          refetchOnWindowFocus: false,
          refetchOnMount: false,
          refetchOnReconnect: false,
          retry: false,
        },
      },
    });
    for (const adset of payload.adsets ?? []) {
      const aid = (adset as { id?: string }).id;
      if (!aid) continue;
      c.setQueryData(["report-ads", aid, d], payload.adsByAdset?.[aid] ?? []);
      const bd = payload.breakdownsByAdset?.[aid];
      for (const dim of BREAKDOWN_DIMS) {
        c.setQueryData(["breakdown", "adset", aid, dim, d], bd?.[dim] ?? []);
      }
    }
    return { client: c, date: d };
  }, [payload]);

  const markupPercent = typeof meta.markup_percent === "number" ? meta.markup_percent : 0;

  return (
    <QueryClientProvider client={client}>
      {meta.variant === "perf" ? (
        <PerformanceReportContent
          campaign={payload.campaign}
          adsets={payload.adsets ?? []}
          adsetsLoading={false}
          adsetsError={null}
          hideMoney={Boolean(meta.hide_money)}
          dateLabel={toLabel(date)}
          date={date}
          useSpendPlus={Boolean(meta.use_spend_plus)}
          markupPercent={markupPercent}
          selectedFields={meta.selected_fields ?? null}
          creativeFields={meta.creative_fields ?? null}
          previewMediaOnly
        />
      ) : (
        <ReportContent
          campaign={payload.campaign}
          adsets={payload.adsets ?? []}
          adsetsLoading={false}
          adsetsError={null}
          hideMoney={Boolean(meta.hide_money)}
          dateLabel={toLabel(date)}
          date={date}
          useSpendPlus={Boolean(meta.use_spend_plus)}
          markupPercent={markupPercent}
          selectedFields={meta.selected_fields ?? null}
          previewMediaOnly
        />
      )}
    </QueryClientProvider>
  );
}
