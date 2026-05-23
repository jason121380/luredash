import { type SubscriptionState, api } from "@/api/client";
import { useBillingUsage, usePricingConfig, useSubscription } from "@/api/hooks/useSubscription";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { Button } from "@/components/Button";
import { GraceBanner } from "@/components/GraceBanner";
import { LoadingState } from "@/components/LoadingState";
import { PolarLanguageNotice } from "@/components/PolarLanguageNotice";
import { toast } from "@/components/Toast";
import { Topbar } from "@/layout/Topbar";
import { fN } from "@/lib/format";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

/**
 * /billing — self-serve subscription management for the logged-in user.
 *
 * Shows: current plan + status banner + usage bars + CTA to either
 * upgrade (anchor to /pricing) or open the Polar customer portal
 * (change plan / update card / cancel).
 *
 * Honours `?success=true` in the URL after a Polar checkout to show
 * a success toast — Polar redirects here on a successful purchase.
 */
export function BillingView() {
  const subQuery = useSubscription();
  const cfgQuery = usePricingConfig();
  const usageQuery = useBillingUsage();
  const { user } = useFbAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [openingPortal, setOpeningPortal] = useState(false);

  const sub = subQuery.data;
  const tiers = cfgQuery.data?.tiers ?? [];

  // Show success toast once and clear the query string so a refresh
  // doesn't re-fire it.
  const successFlag = searchParams.get("success");
  if (successFlag && !openingPortal) {
    toast("訂閱成功!感謝您的支持", "success", 4000);
    searchParams.delete("success");
    searchParams.delete("checkout_id");
    setSearchParams(searchParams, { replace: true });
  }

  const handleManage = async () => {
    if (!user?.id) return;
    // Pre-open the tab synchronously inside the click handler so
    // popup blockers don't intercept the post-await window.open.
    // We point it at about:blank and rewrite location.href once the
    // signed Polar URL comes back. We cannot pass noopener here —
    // the new window has to remain reachable by reference so we can
    // set its location after the await.
    const popup = window.open("about:blank", "_blank");
    setOpeningPortal(true);
    try {
      const resp = await api.billing.portal(user.id);
      // Defence-in-depth: the URL comes from our backend (Polar API
      // proxy), but if anything upstream is compromised we don't want
      // to forward the user to an arbitrary host.
      let parsed: URL | null = null;
      try {
        parsed = new URL(resp.url);
      } catch {
        parsed = null;
      }
      const host = parsed?.host ?? "";
      const allowed = host === "polar.sh" || host.endsWith(".polar.sh");
      if (!allowed) {
        if (import.meta.env.DEV) {
          console.error("[billing] unexpected portal host", host);
        }
        if (popup && !popup.closed) popup.close();
        toast("無法開啟管理頁,請稍後再試", "error");
        return;
      }
      if (popup && !popup.closed) {
        popup.location.replace(resp.url);
      } else {
        // Popup blocked — fall back to in-tab navigation.
        window.location.assign(resp.url);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error("[billing] portal failed", err);
      if (popup && !popup.closed) popup.close();
      toast("無法開啟管理頁,請稍後再試", "error");
    } finally {
      setOpeningPortal(false);
    }
  };

  if (subQuery.isLoading || cfgQuery.isLoading) {
    return (
      <>
        <Topbar title="我的訂閱" />
        <div className="p-3 md:p-5">
          <LoadingState title="載入訂閱資料中..." />
        </div>
      </>
    );
  }

  if (!sub) {
    return (
      <>
        <Topbar title="我的訂閱" />
        <div className="p-3 md:p-5">
          <p className="text-sm text-gray-500">無法取得訂閱資料</p>
        </div>
      </>
    );
  }

  const tierName = tiers.find((t) => t.tier === sub.tier)?.name ?? sub.tier;

  return (
    <>
      <Topbar title="我的訂閱" />
      <div className="mx-auto flex w-full max-w-[800px] flex-col gap-4 p-3 md:p-5">
        <GraceBanner usage={usageQuery.data} />
        <CurrentPlanCard sub={sub} tierName={tierName} />
        <UsageCard sub={sub} />

        <div className="flex flex-col gap-2 md:flex-row">
          {sub.polar_customer_id && sub.tier !== "free" ? (
            <Button
              variant="primary"
              disabled={openingPortal}
              onClick={() => void handleManage()}
              className="!h-10"
            >
              {openingPortal ? "開啟中..." : "管理訂閱(改方案 / 取消)"}
            </Button>
          ) : null}
          <Link to="/pricing">
            <Button variant="ghost" className="!h-10 w-full md:w-auto">
              {sub.tier === "free" ? "查看方案 →" : "升級方案 →"}
            </Button>
          </Link>
        </div>

        {sub.polar_customer_id && sub.tier !== "free" ? (
          <PolarLanguageNotice context="portal" />
        ) : null}
      </div>
    </>
  );
}

// ── Current plan card ────────────────────────────────────────

function CurrentPlanCard({ sub, tierName }: { sub: SubscriptionState; tierName: string }) {
  const statusBadge = useMemo(() => statusBadgeFor(sub), [sub]);
  return (
    <section className="rounded-2xl border border-border bg-white p-5 md:p-6">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[16px] font-bold text-ink">目前方案</h2>
        {statusBadge}
      </div>
      <div className="mt-2 text-[28px] font-bold text-orange">{tierName}</div>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
        {sub.trial_ends_at && sub.status === "trialing" ? (
          <DateRow label="試用結束" iso={sub.trial_ends_at} />
        ) : null}
        {sub.current_period_end ? (
          <DateRow
            label={sub.cancel_at_period_end ? "結束日期" : "下次扣款"}
            iso={sub.current_period_end}
          />
        ) : null}
        {sub.cancel_at_period_end && (
          <>
            <dt className="text-gray-300">狀態</dt>
            <dd className="text-amber-600">已排程取消,期末停止扣款</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function DateRow({ label, iso }: { label: string; iso: string }) {
  let display = iso;
  try {
    const d = new Date(iso);
    display = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    /* keep raw */
  }
  return (
    <>
      <dt className="text-gray-300">{label}</dt>
      <dd className="font-semibold text-ink tabular-nums">{display}</dd>
    </>
  );
}

function statusBadgeFor(sub: SubscriptionState) {
  const s = sub.status;
  const map: Record<string, { label: string; tone: string }> = {
    free: { label: "免費方案", tone: "bg-gray-100 text-gray-500" },
    trialing: { label: "試用中", tone: "bg-orange-bg text-orange" },
    active: { label: "進行中", tone: "bg-emerald-50 text-emerald-600" },
    past_due: { label: "扣款失敗", tone: "bg-amber-50 text-amber-600" },
    canceled: { label: "已取消", tone: "bg-red-50 text-red-600" },
    inactive: { label: "未啟用", tone: "bg-gray-100 text-gray-500" },
  };
  const cfg = map[s] ?? map.inactive;
  if (!cfg) return null;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${cfg.tone}`}>
      {cfg.label}
    </span>
  );
}

// ── Usage card ───────────────────────────────────────────────

function UsageCard({ sub }: { sub: SubscriptionState }) {
  // We don't have live usage counts in this Phase yet — show the
  // configured limits as the source of truth. Phase 5 will add a
  // /api/billing/usage endpoint that joins the real counts.
  // monthly_push intentionally not surfaced — actual push budget is
  // bounded by the LINE Official Account's own monthly quota (LINE
  // bills `messages × recipients`), not by our subscription tier.
  const rows: Array<{ label: string; limit: number | null }> = [
    { label: "廣告帳戶", limit: sub.ad_accounts_limit },
    { label: "可串接 Line 官方帳號數", limit: sub.line_channels_limit },
    { label: "可被加入 Line 群組數量", limit: sub.line_groups_limit },
  ];
  return (
    <section className="rounded-2xl border border-border bg-white p-5 md:p-6">
      <h2 className="text-[16px] font-bold text-ink">方案上限</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col gap-0.5">
            <dt className="text-[11px] uppercase tracking-wider text-gray-300">{r.label}</dt>
            <dd className="text-[18px] font-bold text-ink tabular-nums">{formatLimit(r.limit)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function formatLimit(limit: number | null): string {
  if (limit === null) return "無限";
  if (limit < 0 || limit >= 999999) return "無限";
  return fN(limit);
}
