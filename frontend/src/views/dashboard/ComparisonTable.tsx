import { api } from "@/api/client";
import { adsetsQueryKey } from "@/api/hooks/useAdsets";
import { creativesQueryKey } from "@/api/hooks/useCreatives";
import { cn } from "@/lib/cn";
import type { DateConfig } from "@/lib/datePicker";
import { isFrontPostCreative } from "@/lib/fbLinks";
import { fM, fN } from "@/lib/format";
import { getIns, getMsgCount } from "@/lib/insights";
import { useFinanceStore } from "@/stores/financeStore";
import { useUiStore } from "@/stores/uiStore";
import type { FbAdset, FbCreativeEntity } from "@/types/fb";
import { spendPlus } from "@/views/finance/financeData";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { CreativeRow } from "./CreativeRow";
import { type TreeCol, buildTreeCols } from "./treeCols";

/**
 * "素材比較" (creative comparison) flat view for the Dashboard.
 *
 * When the user ticks the 素材比較 checkbox in the search row, the
 * normal 3-level tree collapses into a flat list containing ONLY the
 * 3rd-level ad creatives from adsets the user currently has expanded.
 * Campaign / adset rows are omitted so the user can compare creatives
 * side-by-side without the hierarchy noise.
 *
 * Data comes from the react-query cache: the creatives for every
 * expanded adset were already fetched when the user opened them, so
 * in the normal case this component's `useQueries` call resolves
 * instantly from cache. If the user toggles comparison mode before
 * any adset is expanded, the view shows a hint telling them to
 * expand an adset first — we deliberately don't auto-fetch every
 * adset in every campaign because that would explode API usage.
 */
export interface ComparisonTableProps {
  multiAcct: boolean;
  date: DateConfig;
  searchTerm: string;
  /** Only show 進行中 (ACTIVE) creatives. */
  activeOnly?: boolean;
  /** Filter by post type: front-stage (前台貼文) / back-stage (後台貼文)
   *  / all. */
  postFilter?: "all" | "front" | "back";
}

export function ComparisonTable({
  multiAcct,
  date,
  searchTerm,
  activeOnly = false,
  postFilter = "all",
}: ComparisonTableProps) {
  const expandedCamps = useUiStore((s) => s.expandedCamps);
  const expandedAdsets = useUiStore((s) => s.expandedAdsets);
  const treeSort = useUiStore((s) => s.treeSort);
  const setTreeSort = useUiStore((s) => s.setTreeSort);

  const extraTreeCols = useUiStore((s) => s.extraTreeCols);
  const defaultMarkup = useFinanceStore((s) => s.defaultMarkup);
  const showSpendPlus = extraTreeCols.includes("spend_plus");
  const cols = useMemo(() => buildTreeCols(multiAcct, extraTreeCols), [multiAcct, extraTreeCols]);

  // Subscribe to the adsets queries for every currently-expanded
  // campaign. Purely read-only from this view's perspective — the
  // fetches were already triggered by the tree's `AdsetRow` when
  // the user expanded the campaigns. We use useQueries here only
  // so the components re-render when the cache changes.
  const adsetsQueries = useQueries({
    queries: expandedCamps.map((campId) => ({
      queryKey: adsetsQueryKey(campId, date),
      queryFn: async (): Promise<FbAdset[]> => {
        const res = await api.campaigns.adsets(campId, date);
        return res.data ?? [];
      },
      // Fetch when the cache is cold. Bounded to EXPANDED campaigns (the
      // tree already fetched most of these, so this is normally a cache
      // hit within staleTime). Was `enabled: false` (read-only), but that
      // showed an empty view whenever the tree hadn't populated the cache
      // yet — e.g. entering 素材比較 before expanding, or after gc.
      enabled: !!campId,
      staleTime: 5 * 60_000,
    })),
  });

  // Build the set of "adsets the user can currently SEE in the
  // tree right now". An adset qualifies only if BOTH:
  //   1. its parent campaign is in expandedCamps, AND
  //   2. the adset itself is in expandedAdsets
  // This drops stale adsets from comparison when:
  //   - the user collapsed the adset directly, OR
  //   - the user collapsed its parent campaign (which hides the
  //     adset visually in the tree but doesn't remove it from
  //     expandedAdsets — so the old code leaked those creatives
  //     into comparison mode, which the user reported as a bug).
  const visibleAdsetIds = useMemo(() => {
    const expandedSet = new Set(expandedAdsets);
    const visible: string[] = [];
    for (const q of adsetsQueries) {
      for (const adset of q.data ?? []) {
        if (expandedSet.has(adset.id)) {
          visible.push(adset.id);
        }
      }
    }
    return visible;
    // adsetsQueries is a new array every render; depend on its
    // derived data shape instead. React's Object.is equality on
    // the expandedAdsets array handles the rest.
  }, [adsetsQueries, expandedAdsets]);

  // React Query shares cache by `queryKey`, so hitting the same
  // ["creatives", adsetId, date] tuple that `useCreatives` already
  // populated in `AdsetRow` means this useQueries call is almost
  // always a cache hit rather than a fresh FB round-trip.
  const queries = useQueries({
    queries: visibleAdsetIds.map((adsetId) => ({
      queryKey: creativesQueryKey(adsetId, date),
      queryFn: async (): Promise<FbCreativeEntity[]> => {
        const res = await api.adsets.creatives(adsetId, date);
        return res.data ?? [];
      },
      // Fetch when cold. Bounded to VISIBLE (expanded) adsets, so this
      // stays a small, user-driven set — the tree usually populated these
      // already (cache hit). Previously `enabled: false`, which left the
      // comparison empty whenever the cache wasn't warm.
      enabled: !!adsetId,
      staleTime: 5 * 60_000,
    })),
  });

  const allCreatives = useMemo(() => {
    const out: FbCreativeEntity[] = [];
    for (const q of queries) {
      if (q.data) out.push(...q.data);
    }
    return out;
  }, [queries]);

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    let list = allCreatives;
    if (term) list = list.filter((c) => c.name.toLowerCase().includes(term));
    if (activeOnly) list = list.filter((c) => c.status === "ACTIVE");
    if (postFilter !== "all") {
      list = list.filter((c) => {
        const front = c.creative ? isFrontPostCreative(c.creative) : false;
        return postFilter === "front" ? front : !front;
      });
    }
    return list;
  }, [allCreatives, searchTerm, activeOnly, postFilter]);

  // Default sort = CTR descending. User can override by clicking a
  // column header, which sets treeSort in the uiStore. The same
  // treeSort is shared with the tree view, but when treeSort.key is
  // null (user hasn't clicked anything) we force CTR desc here so
  // the comparison view never starts unsorted — per the product
  // decision that "CTR desc is the most useful default for
  // side-by-side creative evaluation".
  const effectiveSort = useMemo(
    () => (treeSort.key ? treeSort : { key: "ctr" as const, dir: "desc" as const }),
    [treeSort],
  );

  const sorted = useMemo(() => {
    const col = cols.find((c) => c.key === effectiveSort.key);
    if (!col?.sortKey) return filtered;
    const sortKey = col.sortKey;
    const dir = effectiveSort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = sortKey(a);
      const vb = sortKey(b);
      if (va === vb) return 0;
      return va > vb ? dir : -dir;
    });
  }, [filtered, cols, effectiveSort]);

  if (visibleAdsetIds.length === 0) {
    return (
      <div className="p-[60px] text-center text-[13px] text-gray-300">
        請先展開任一行銷活動與廣告組合,再啟用素材比較
      </div>
    );
  }

  const isLoading = queries.some((q) => q.isLoading);

  if (isLoading && sorted.length === 0) {
    return <div className="p-[60px] text-center text-[13px] text-gray-300">載入素材中…</div>;
  }

  if (sorted.length === 0) {
    return <div className="p-[60px] text-center text-gray-300">無符合條件的素材</div>;
  }

  // Totals — spend across all visible creatives, plus message-cost
  // using the denominator-sanity rule from MEMORY.md (only sum spend
  // from creatives that HAVE msg data).
  const totalSpend = sorted.reduce((s, c) => s + (Number(getIns(c).spend) || 0), 0);
  const totalMsgs = sorted.reduce((s, c) => s + getMsgCount(c), 0);
  const totalMsgSpend = sorted
    .filter((c) => getMsgCount(c) > 0)
    .reduce((s, c) => s + (Number(getIns(c).spend) || 0), 0);
  // Flat view has no per-creative campaign context → apply the team
  // default markup uniformly (same fallback the rows use).
  const totalSpendPlus = sorted.reduce(
    (s, c) => s + spendPlus(Number(getIns(c).spend) || 0, defaultMarkup),
    0,
  );

  return (
    <table className="tree w-full border-collapse text-[13px]">
      <thead>
        <tr>
          {cols.map((c) => (
            <ComparisonHeaderCell
              key={c.key}
              col={c}
              treeSort={effectiveSort}
              onSort={setTreeSort}
            />
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((creative) => (
          <CreativeRow
            key={creative.id}
            creative={creative}
            multiAcct={multiAcct}
            extras={extraTreeCols}
            spendPlusMarkup={defaultMarkup}
          />
        ))}
        <tr className="border-t border-border bg-bg">
          <td colSpan={multiAcct ? 3 : 2} className="px-3.5 py-2.5 text-[13px] font-bold text-ink">
            合計 ({sorted.length})
          </td>
          <td />
          <td className="num text-[13px] font-bold">${fM(totalSpend)}</td>
          {showSpendPlus && (
            <td className="tabular-nums text-[13px] font-bold text-orange">
              ${fM(totalSpendPlus)}
            </td>
          )}
          <td />
          <td />
          <td />
          <td />
          <td className="num text-[13px] font-bold">{totalMsgs > 0 ? fN(totalMsgs) : "—"}</td>
          <td className="num text-[13px] font-bold">
            {totalMsgs > 0 ? `$${fM(totalMsgSpend / totalMsgs)}` : "—"}
          </td>
          <td colSpan={2} />
        </tr>
      </tbody>
    </table>
  );
}

function ComparisonHeaderCell({
  col,
  treeSort,
  onSort,
}: {
  col: TreeCol;
  treeSort: { key: string | null; dir: "asc" | "desc" };
  onSort: (key: string | null) => void;
}) {
  const sortable = !!col.sortKey;
  const isSorted = sortable && treeSort.key === col.key;
  return (
    <th
      onClick={sortable ? () => onSort(col.key) : undefined}
      className={cn(
        "sticky top-0 z-[1] whitespace-nowrap border-b border-border bg-bg px-3.5 py-2.5",
        "text-left text-[11px] font-semibold uppercase tracking-[0.5px]",
        col.emphasize
          ? "font-bold text-orange"
          : isSorted
            ? "text-orange"
            : "text-gray-300",
        sortable && "cursor-pointer select-none hover:text-orange",
      )}
    >
      {col.label}
      {isSorted && (treeSort.dir === "asc" ? " ↑" : " ↓")}
    </th>
  );
}
