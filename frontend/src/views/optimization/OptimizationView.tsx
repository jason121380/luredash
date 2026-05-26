import { ApiError, type AgentCampaignDigest, type AgentMeta, api } from "@/api/client";
import { useAccounts } from "@/api/hooks/useAccounts";
import { useBillingUsage } from "@/api/hooks/useSubscription";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { Button } from "@/components/Button";
import { DatePicker } from "@/components/DatePicker";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
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
import type { FbCampaign } from "@/types/fb";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown";

/** localStorage key + payload contract for "last successful run".
 *  Bumped to 3 → wipe on schema change so old global-priority output
 *  don't show up as half-rendered cards. */
const LAST_RUN_STORAGE_KEY = "ai-staff-last-run";
const LAST_RUN_VERSION = 3;
interface StoredLastRun {
  version: number;
  generatedAt: string;
  dateLabel: string;
  cards: Record<string, { advice_md: string | null; error: string | null } | null>;
}

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
 *   - always analyzes all enabled accounts so the per-account to-do
 *     list cannot accidentally be generated from a partial scope
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

  const digests = useMemo(() => {
    return buildDigests(overview.campaigns, allAccounts);
  }, [overview.campaigns, allAccounts]);
  const dateLabel = toLabel(date);

  // Per-card state, plus a top-level "isStreaming" flag separate
  // from per-card spinners. The backend currently returns one
  // synthesized action-plan card.
  type CardState = { advice_md: string | null; error: string | null } | null;
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
      const parsed = JSON.parse(raw) as StoredLastRun | null;
      if (!parsed || parsed.version !== LAST_RUN_VERSION) return;
      setCards(parsed.cards);
      setGeneratedAt(new Date(parsed.generatedAt));
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
        if (row.payload.version !== LAST_RUN_VERSION) return;
        const nextCards: Record<string, CardState> = {};
        for (const a of row.payload.advice) {
          nextCards[a.agent_id] = { advice_md: a.advice_md, error: a.error };
        }
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

      <div className="min-w-0 flex-1 p-3 md:p-5">
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
              generatedAt={generatedAt}
              isOverviewLoading={overview.isLoading || overview.insightsPending}
              onGenerate={runStream}
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
  generatedAt: Date | null;
  /** True while useMultiAccountOverview is still pulling live FB
   *  campaign data. Cached cards render immediately, but the
   *  Generate button has to wait — no point shipping an empty
   *  digest to Gemini. */
  isOverviewLoading: boolean;
  onGenerate: () => void;
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
  generatedAt,
  isOverviewLoading,
  onGenerate,
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
          將整理全部啟用帳戶下的 {campaignsCount} 個進行中活動,依帳戶輸出嚴重程度分級 to-do。
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
    <section className="flex min-w-0 flex-col rounded-lg border border-border bg-white p-4 md:p-5">
      <header className="mb-3 flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[18px] font-bold shadow-sm"
          style={{ backgroundColor: `${agent.color}1a`, color: agent.color }}
          aria-hidden="true"
        >
          {agent.emoji}
        </div>
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

// ── Helpers ──────────────────────────────────────────────────

function buildDigests(
  campaigns: FbCampaign[],
  accounts: Array<{ id: string; name: string }>,
): AgentCampaignDigest[] {
  const acctName = new Map(accounts.map((a) => [a.id, a.name]));
  const out: AgentCampaignDigest[] = [];
  for (const c of campaigns) {
    const ins = getIns(c);
    const spend = Number(ins.spend) || 0;
    const isActive = c.status === "ACTIVE";
    const isPausedWithSpend = c.status === "PAUSED" && spend > 0;
    if (!isActive && !isPausedWithSpend) continue;
    const msgs = getMsgCount(c);
    out.push({
      name: c.name,
      account_name: c._accountId ? (acctName.get(c._accountId) ?? c._accountName ?? "") : "",
      objective: c.objective ?? undefined,
      status: c.status,
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
