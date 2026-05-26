import { ApiError, type AgentCampaignDigest, type AgentMeta, api } from "@/api/client";
import { useAccounts } from "@/api/hooks/useAccounts";
import { useBillingUsage } from "@/api/hooks/useSubscription";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { Button } from "@/components/Button";
import { DatePicker } from "@/components/DatePicker";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { Modal } from "@/components/Modal";
import { Spinner } from "@/components/Spinner";
import { toast } from "@/components/Toast";
import {
  UpgradeModal,
  type UpgradeModalState,
  tierLimitFromError,
} from "@/components/UpgradeModal";
import { Topbar } from "@/layout/Topbar";
import { toLabel } from "@/lib/datePicker";
import { getIns, getMsgCount } from "@/lib/insights";
import { useAccountsStore } from "@/stores/accountsStore";
import { useFiltersStore } from "@/stores/filtersStore";
import { useUiStore } from "@/stores/uiStore";
import type { FbAccount, FbCampaign } from "@/types/fb";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown";

/** localStorage key + payload contract for "last successful run".
 *  Keep hydration backward-compatible: old successful reports should
 *  still render even when the generation prompt/schema version changes. */
const LAST_RUN_STORAGE_KEY = "ai-staff-last-run";
const LAST_RUN_VERSION = 5;
interface StoredLastRun {
  version: number;
  generatedAt: string;
  dateLabel: string;
  cards: Record<string, { advice_md: string | null; error: string | null } | null>;
}
type CardState = { advice_md: string | null; error: string | null } | null;

/**
 * 優化中心 — action-first advisor board with NDJSON streaming.
 *
 * Each click of 「產生分析」 posts the campaign digest once and fills
 * one synthesized action-plan card. The backend still uses the
 * specialist prompts as hidden reference material, but the UI only
 * shows the decision.
 *
 * Polish stack on top of the basic board:
 *   - generated-at relative timestamp on the action bar (ticks
 *     every 30s)
 *   - per-page account filter modal so the user can narrow the
 *     analysis to a subset of their globally-selected accounts
 *     without changing the dashboard's selection
 *   - localStorage snapshot of the last successful run so a
 *     refresh / tab close doesn't wipe the cards the user just
 *     paid for (restore-on-mount, no Gemini re-call)
 */
export function OptimizationView() {
  const accountsQuery = useAccounts();
  const allAccounts = accountsQuery.data ?? [];
  const visibleAll = useAccountsStore((s) => s.visibleAccounts)(allAccounts);

  const settingsReady = useUiStore((s) => s.settingsReady);
  const date = useFiltersStore((s) => s.date.optimization);
  const setDate = useFiltersStore((s) => s.setDate);

  const overview = useMultiAccountOverview(visibleAll, date, {
    includeArchived: false,
    source: "ai-staff",
  });
  const { user } = useFbAuth();
  const usageQuery = useBillingUsage();

  const agentsQuery = useQuery({
    queryKey: ["optimization", "agents-meta"],
    queryFn: () => api.optimization.agents(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const agents = agentsQuery.data?.data ?? [];

  // Per-page account filter — defaults to "all visible". Stored as
  // a Set of account ids; null = no filter (use everything).
  const [accountFilter, setAccountFilter] = useState<Set<string> | null>(null);
  const [filterModalOpen, setFilterModalOpen] = useState(false);

  // Reset the filter if the global visibleAll list changes (e.g.
  // user toggled accounts in Settings) so we don't carry stale ids.
  const visibleIds = useMemo(() => visibleAll.map((a) => a.id).join("|"), [visibleAll]);
  useEffect(() => {
    setAccountFilter(null);
  }, [visibleIds]);

  const filteredAccounts = useMemo(() => {
    if (!accountFilter) return visibleAll;
    return visibleAll.filter((a) => accountFilter.has(a.id));
  }, [visibleAll, accountFilter]);
  const filteredAccountIds = useMemo(
    () => new Set(filteredAccounts.map((a) => a.id)),
    [filteredAccounts],
  );

  const digests = useMemo(() => {
    const all = buildDigests(overview.campaigns, allAccounts);
    if (!accountFilter) return all;
    // Filter campaigns by their account_id (digest carries the
    // account_name only, so re-look up the id from the campaign list).
    const allowedNames = new Set(filteredAccounts.map((a) => a.name));
    return all.filter((d) => allowedNames.has(d.account_name ?? ""));
  }, [overview.campaigns, allAccounts, accountFilter, filteredAccounts]);
  const dateLabel = toLabel(date);

  // Per-card state, plus a top-level "isStreaming" flag separate
  // from per-card spinners. The backend currently returns one
  // synthesized action-plan card.
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const [isStreaming, setIsStreaming] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<Date | null>(null);
  const [upgradeState, setUpgradeState] = useState<UpgradeModalState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Two-phase hydration so the user always sees something instant
  // AND the result is cross-device consistent:
  //
  //   Phase 1 (sync, ~0ms): pull cached payload from localStorage.
  //     Same-browser refresh / tab reopen shows cards immediately.
  //   Phase 2 (async, ~200ms): fetch the most-recent persisted run
  //     from the backend. If newer than the local cache (or local
  //     is empty), replace the cards. This is what makes "logged
  //     in on phone, see the same report on laptop" work.
  //
  // We don't reconcile during a live stream — once the user clicks
  // 產生分析, that becomes the source of truth and any backend
  // hydration is suppressed.
  const hydrationDoneRef = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAST_RUN_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<StoredLastRun> | null;
      if (!parsed?.cards || !hasHydratableCards(parsed.cards)) return;
      setCards(parsed.cards);
      setGeneratedAt(toValidDate(parsed.generatedAt) ?? new Date());
    } catch {
      localStorage.removeItem(LAST_RUN_STORAGE_KEY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const uid = user?.id;
    if (!uid || hydrationDoneRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.optimization.lastRun(uid);
        if (cancelled) return;
        const row = resp.data;
        if (!row?.payload) return;
        const serverAt = new Date(row.created_at);
        // If we already have a local copy that's newer (e.g. user
        // is mid-flow on this same browser), don't overwrite.
        if (generatedAt && generatedAt.getTime() >= serverAt.getTime()) return;
        const nextCards = cardsFromAdvice(row.payload.advice);
        if (!hasHydratableCards(nextCards)) return;
        setCards(nextCards);
        setGeneratedAt(serverAt);
        // Sync the local cache so the next sync-phase load matches.
        try {
          const payload: StoredLastRun = {
            version: LAST_RUN_VERSION,
            generatedAt: serverAt.toISOString(),
            dateLabel: row.payload.date_label,
            cards: nextCards,
          };
          localStorage.setItem(LAST_RUN_STORAGE_KEY, JSON.stringify(payload));
        } catch {
          /* ignore quota-exceeded etc */
        }
      } catch {
        // Network / 5xx — fall back silently to whatever
        // localStorage gave us in phase 1.
      } finally {
        hydrationDoneRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, generatedAt]);

  // Tick the relative-time label every 30s. Cheap because the
  // formatter is just date math; cleared when no timestamp.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!generatedAt) return;
    const t = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [generatedAt]);

  // Cancel any in-flight stream when the view unmounts (or the
  // user re-clicks Generate before the first run finishes).
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Are there any cards on screen (cached, hydrated, or freshly
  // streamed)? Derived from the cards object — any agent with a
  // non-null state counts. Used to short-circuit the
  // overview-loading gate so users with persisted runs don't see a
  // progress bar on every page open.
  const hasAnyCards = useMemo(
    () => agents.some((a) => cards[a.id] != null),
    [agents, cards],
  );
  const usage = usageQuery.data;
  const adviceLimit = usage?.limits.agent_advice ?? 0;
  const adviceUsed = usage?.usage.agent_advice ?? 0;
  const isUnlimited = adviceLimit < 0 || adviceLimit >= 999_000;
  const remaining = isUnlimited ? Number.POSITIVE_INFINITY : Math.max(0, adviceLimit - adviceUsed);
  const blockedByTier = adviceLimit === 0;
  const quotaExhausted = !isUnlimited && remaining <= 0;
  const overviewLoading = overview.isLoading || overview.insightsPending;
  // Generate is gated on having loaded campaign data — no point
  // calling Gemini with an empty digest.
  const canGenerate =
    agents.length > 0 && !overviewLoading && digests.length > 0 && !isStreaming && !quotaExhausted;
  const isFirstRun = Object.keys(cards).length === 0 && !isStreaming;
  const isLifetime = usage?.agent_advice_period === "lifetime";
  const completedCount = Math.max(0, agents.length - streamingIds.size);

  async function runStream() {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Reset card state and seed the streaming set with all known
    // agent ids so each card shows its own spinner immediately.
    setCards({});
    setStreamingIds(new Set(agents.map((a) => a.id)));
    setIsStreaming(true);
    setGeneratedAt(null);

    try {
      await api.optimization.runAgentsStream(
        {
          fbUserId: user?.id ?? "",
          dateLabel,
          campaigns: digests,
        },
        {
          signal: ctrl.signal,
          onAgent: (msg) => {
            setCards((prev) => ({
              ...prev,
              [msg.agent_id]: { advice_md: msg.advice_md, error: msg.error },
            }));
            setStreamingIds((prev) => {
              const next = new Set(prev);
              next.delete(msg.agent_id);
              return next;
            });
          },
          onDone: () => {
            const at = new Date();
            setGeneratedAt(at);
            usageQuery.refetch();
            // Snapshot the freshest card state into localStorage so
            // the user can refresh / close / reopen the tab and
            // still see what they just paid for. Read from a state
            // setter to capture the very latest cards (the parent
            // closure's `cards` would be stale here).
            setCards((latest) => {
              try {
                const payload: StoredLastRun = {
                  version: LAST_RUN_VERSION,
                  generatedAt: at.toISOString(),
                  dateLabel,
                  cards: latest,
                };
                localStorage.setItem(LAST_RUN_STORAGE_KEY, JSON.stringify(payload));
              } catch {
                /* quota exceeded / private mode — silently ignore */
              }
              return latest;
            });
          },
        },
      );
    } catch (err) {
      if (ctrl.signal.aborted) return;
      const tierLimit = err instanceof ApiError ? tierLimitFromError(err) : null;
      if (tierLimit) {
        setUpgradeState(tierLimit);
      } else {
        toast(`分析失敗:${(err as Error).message}`, "error");
      }
    } finally {
      if (!ctrl.signal.aborted) {
        setIsStreaming(false);
        setStreamingIds(new Set());
      }
    }
  }

  return (
    <>
      <Topbar title="優化中心">
        <DatePicker value={date} onChange={(cfg) => setDate("optimization", cfg)} />
      </Topbar>
      <UpgradeModal state={upgradeState} onClose={() => setUpgradeState(null)} />
      {/* PDF export handler — defined as a closure here so it can
          reach `cards`, `dateLabel`, `generatedAt`, etc. without
          prop-drilling through ActionBar. */}
      {/* (no-op JSX — actual function below) */}
      <AccountFilterModal
        open={filterModalOpen}
        accounts={visibleAll}
        selectedIds={filteredAccountIds}
        onApply={(ids) => {
          // null = "match the visibleAll" (no actual filter).
          setAccountFilter(ids.size === visibleAll.length ? null : ids);
          setFilterModalOpen(false);
        }}
        onClose={() => setFilterModalOpen(false)}
      />

      <div className="min-w-0 flex-1 p-3 pb-8 md:p-5 md:pb-10">
        {!settingsReady ? (
          <LoadingState
            title="載入優化資料中..."
            loaded={overview.loadedCount}
            total={overview.totalCount}
          />
        ) : visibleAll.length === 0 ? (
          <EmptyState>請先在設定中啟用廣告帳戶</EmptyState>
        ) : !hasAnyCards && (overview.isLoading || overview.insightsPending) ? (
          // Only block the entire UI on the FB-API campaign fetch
          // when we have NOTHING to show — i.e. user has never run
          // analysis before, or has no cached / persisted run. Once
          // cached cards exist, render them immediately and let the
          // overview load in the background; the action bar will
          // surface "等待活動資料載入..." on the Generate button.
          <LoadingState
            title="分析所有行銷活動中..."
            loaded={overview.loadedCount}
            total={overview.totalCount}
          />
        ) : !hasAnyCards && digests.length === 0 ? (
          <EmptyState>目前沒有正在進行中的行銷活動</EmptyState>
        ) : (
          <div className="flex flex-col gap-3 md:gap-4">
            <ActionBar
              isFirstRun={isFirstRun}
              isStreaming={isStreaming}
              completedCount={completedCount}
              totalAgents={agents.length}
              canGenerate={canGenerate}
              blockedByTier={blockedByTier}
              quotaExhausted={quotaExhausted}
              adviceLimit={adviceLimit}
              adviceUsed={adviceUsed}
              isUnlimited={isUnlimited}
              isLifetime={isLifetime}
              campaignsCount={digests.length}
              accountsCount={filteredAccounts.length}
              filterActive={accountFilter !== null}
              generatedAt={generatedAt}
              isOverviewLoading={overview.isLoading || overview.insightsPending}
              onGenerate={runStream}
              onOpenFilter={() => setFilterModalOpen(true)}
            />

            <div className="grid grid-cols-1 gap-3 md:gap-4">
              {agents.map((agent) => (
                <AgentAdviceCard
                  key={agent.id}
                  agent={agent}
                  state={cards[agent.id] ?? null}
                  isLoading={streamingIds.has(agent.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Action bar ───────────────────────────────────────────────

interface ActionBarProps {
  isFirstRun: boolean;
  isStreaming: boolean;
  completedCount: number;
  totalAgents: number;
  canGenerate: boolean;
  blockedByTier: boolean;
  quotaExhausted: boolean;
  adviceLimit: number;
  adviceUsed: number;
  isUnlimited: boolean;
  isLifetime: boolean;
  campaignsCount: number;
  accountsCount: number;
  filterActive: boolean;
  generatedAt: Date | null;
  /** True while useMultiAccountOverview is still pulling live FB
   *  campaign data. Cached cards render immediately, but the
   *  Generate button has to wait — no point shipping an empty
   *  digest to Gemini. */
  isOverviewLoading: boolean;
  onGenerate: () => void;
  onOpenFilter: () => void;
}

function ActionBar({
  isFirstRun,
  isStreaming,
  completedCount,
  totalAgents,
  canGenerate,
  blockedByTier,
  quotaExhausted,
  adviceLimit,
  adviceUsed,
  isUnlimited,
  isLifetime,
  campaignsCount,
  accountsCount,
  filterActive,
  generatedAt,
  isOverviewLoading,
  onGenerate,
  onOpenFilter,
}: ActionBarProps) {
  const quotaLabel = isUnlimited
    ? "無限次"
    : isLifetime
      ? `免費試用已用 ${adviceUsed} / ${adviceLimit} 次`
      : `本月已用 ${adviceUsed} / ${adviceLimit} 次`;
  const exhaustedLabel = isLifetime ? "試用次數已用完" : "本月已用完";
  const hasResults = generatedAt !== null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-white p-4 md:flex-row md:items-center md:justify-between md:p-5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-[14px] font-bold text-ink">
          {isStreaming
            ? `正在產生行動建議(${completedCount} / ${totalAgents} 完成)`
            : isFirstRun
              ? "產生優化行動建議"
              : "已產生分析"}
          {hasResults && !isStreaming && (
            <span className="rounded-pill bg-bg px-2 py-0.5 text-[11px] font-normal text-gray-500">
              {formatRelative(generatedAt)}
            </span>
          )}
        </div>
        <div className="text-[12px] text-gray-500">
          將整理{" "}
          <button
            type="button"
            onClick={onOpenFilter}
            className="cursor-pointer font-semibold text-orange underline-offset-2 hover:underline"
          >
            {accountsCount} 個帳戶{filterActive ? " (已篩選)" : ""}
          </button>{" "}
          下的 {campaignsCount} 個進行中活動,依帳戶輸出嚴重程度分級 to-do。
          {!blockedByTier && (
            <span className="ml-1 text-gray-400">每次點擊扣 1 次配額。</span>
          )}
        </div>
      </div>

      <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
        <span
          className={
            quotaExhausted || blockedByTier
              ? "text-[12px] font-semibold text-red-500"
              : "text-[12px] text-gray-500"
          }
        >
          {blockedByTier ? "目前方案不含此功能" : quotaLabel}
        </span>
        <Button
          variant="primary"
          size="sm"
          disabled={!canGenerate}
          onClick={onGenerate}
        >
          {isStreaming
            ? "分析中..."
            : isOverviewLoading
              ? "等活動資料載入..."
              : isFirstRun
                ? blockedByTier
                  ? "升級以使用 →"
                  : "產生分析"
                : quotaExhausted
                  ? exhaustedLabel
                  : "重新產生"}
        </Button>
      </div>
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────

interface AgentAdviceCardProps {
  agent: AgentMeta;
  state: { advice_md: string | null; error: string | null } | null;
  isLoading: boolean;
}

function AgentAdviceCard({ agent, state, isLoading }: AgentAdviceCardProps) {
  return (
    <section className="flex min-w-0 flex-col">
      <header className="mb-3 flex items-start">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-bold text-ink">{agent.name_zh}</h2>
          <div className="truncate text-[11px] text-gray-400">{agent.role_zh}</div>
        </div>
      </header>

      <div className="min-w-0 flex-1 overflow-visible">
        {isLoading ? (
          <div className="flex h-[220px] items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-[12px] text-gray-400">
              <Spinner size={20} />
              <span>正在整理各帳戶 to-do...</span>
            </div>
          </div>
        ) : state == null ? (
          <div className="flex h-[220px] items-center justify-center text-[12px] text-gray-400">
            點擊上方「產生分析」開始
          </div>
        ) : state.error ? (
          <div className="text-[12px] text-red-600">分析失敗:{state.error}</div>
        ) : state.advice_md ? (
          <Markdown>{state.advice_md}</Markdown>
        ) : null}
      </div>
    </section>
  );
}

// ── Account filter modal ─────────────────────────────────────

interface AccountFilterModalProps {
  open: boolean;
  accounts: FbAccount[];
  selectedIds: Set<string>;
  onApply: (ids: Set<string>) => void;
  onClose: () => void;
}

function AccountFilterModal({
  open,
  accounts,
  selectedIds,
  onApply,
  onClose,
}: AccountFilterModalProps) {
  const [pending, setPending] = useState<Set<string>>(selectedIds);
  const [search, setSearch] = useState("");

  // Sync pending state every time the modal opens — without this
  // the set persists across opens and shows stale checkmarks.
  useEffect(() => {
    if (open) {
      setPending(new Set(selectedIds));
      setSearch("");
    }
  }, [open, selectedIds]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => a.name.toLowerCase().includes(q));
  }, [accounts, search]);

  const toggle = (id: string) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="選擇要分析的帳戶"
      subtitle={`已選 ${pending.size} / ${accounts.length} 個`}
      width={460}
    >
      <div className="flex flex-col gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="搜尋帳戶..."
          className="h-9 w-full rounded-lg border border-border bg-white px-3 text-[13px] focus:border-orange focus:outline-none"
        />
        <div className="flex items-center gap-2 text-[12px]">
          <button
            type="button"
            onClick={() => setPending(new Set(accounts.map((a) => a.id)))}
            className="text-orange hover:underline"
          >
            全選
          </button>
          <span className="text-gray-300">·</span>
          <button
            type="button"
            onClick={() => setPending(new Set())}
            className="text-gray-500 hover:underline"
          >
            清除
          </button>
        </div>
        <ul className="max-h-[40vh] overflow-y-auto divide-y divide-border rounded-lg border border-border">
          {filtered.map((a) => (
            <li key={a.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-bg">
                <input
                  type="checkbox"
                  className="custom-cb"
                  checked={pending.has(a.id)}
                  onChange={() => toggle(a.id)}
                />
                <span className="text-[13px] text-ink">{a.name}</span>
              </label>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-4 text-center text-[12px] text-gray-400">
              沒有符合的帳戶
            </li>
          )}
        </ul>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pending.size === 0}
            onClick={() => onApply(pending)}
          >
            套用
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Helpers ──────────────────────────────────────────────────

function cardsFromAdvice(
  advice: Array<{ agent_id: string; advice_md: string | null; error: string | null }> | undefined,
): Record<string, CardState> {
  const out: Record<string, CardState> = {};
  for (const a of advice ?? []) {
    out[a.agent_id] = { advice_md: a.advice_md, error: a.error };
  }
  return out;
}

function hasHydratableCards(cards: Record<string, CardState>): boolean {
  return Object.values(cards).some((card) => Boolean(card?.advice_md || card?.error));
}

function toValidDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildDigests(
  campaigns: FbCampaign[],
  accounts: Array<{ id: string; name: string }>,
): AgentCampaignDigest[] {
  const acctName = new Map(accounts.map((a) => [a.id, a.name]));
  const out: AgentCampaignDigest[] = [];
  for (const c of campaigns) {
    const ins = getIns(c);
    const spend = Number(ins.spend) || 0;
    const status = normalizeCampaignStatus(c);
    const isActive = status === "ACTIVE";
    const isPausedWithSpend = status === "PAUSED" && spend > 0;
    if (!isActive && !isPausedWithSpend) continue;
    const msgs = getMsgCount(c);
    out.push({
      name: c.name,
      account_name: c._accountId ? (acctName.get(c._accountId) ?? c._accountName ?? "") : "",
      objective: c.objective ?? undefined,
      status,
      spend,
      impressions: Number(ins.impressions) || 0,
      clicks: Number(ins.clicks) || 0,
      ctr: Number(ins.ctr) || 0,
      cpc: Number(ins.cpc) || 0,
      frequency: Number(ins.frequency) || 0,
      msgs,
      msg_cost: msgs > 0 && spend > 0 ? spend / msgs : 0,
    });
  }
  return out;
}

function normalizeCampaignStatus(c: FbCampaign): string {
  return String(c.status || c.effective_status || c.configured_status || "").toUpperCase();
}

/** Compact relative-time formatter — "剛剛" / "X 分鐘前" / "X 小時
 *  前" / "X 天前". Re-evaluated on every render via the parent's
 *  30s tick state, no dependency on Intl.RelativeTimeFormat
 *  (bundle-size-conscious; Intl pulls in CLDR data on some
 *  polyfills). */
function formatRelative(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 30) return "剛剛產生";
  if (sec < 60) return "不到 1 分鐘前";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分鐘前產生`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前產生`;
  const day = Math.floor(hr / 24);
  return `${day} 天前產生`;
}
