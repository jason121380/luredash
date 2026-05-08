import { type PricingTier, type TierId, api } from "@/api/client";
import { usePricingConfig, useSubscription } from "@/api/hooks/useSubscription";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { Button } from "@/components/Button";
import { LoadingState } from "@/components/LoadingState";
import { PolarLanguageNotice } from "@/components/PolarLanguageNotice";
import { toast } from "@/components/Toast";
import { fM } from "@/lib/format";
import { useState } from "react";

/**
 * Public /pricing comparison page — accessible WITHOUT login.
 *
 * - Visitors who aren't authenticated see a "先登入再訂閱" CTA
 *   that triggers the FB login flow; after login the page can call
 *   /api/billing/checkout directly.
 * - Authenticated visitors get an "立即試用 30 天" CTA that POSTs
 *   straight to /api/billing/checkout, then window.location replaces
 *   into the Polar checkout URL.
 *
 * Layout: hero strip, 3 plan cards (Basic / Plus / Max with the
 * middle one highlighted), FAQ section, footer note. Free tier is
 * NOT shown as a card — it's the implicit fallback for users who
 * skip the page entirely.
 */
export function PricingView() {
  const cfgQuery = usePricingConfig();
  const { status, user, login } = useFbAuth();
  const subQuery = useSubscription();
  const [busyTier, setBusyTier] = useState<TierId | null>(null);

  const cfg = cfgQuery.data;
  const tiers = (cfg?.tiers ?? []).filter((t) => t.tier !== "free");
  const trialDays = cfg?.trial_days ?? 30;
  const currency = cfg?.currency ?? "TWD";
  const isAuthed = status === "auth";
  const fbUserId = user?.id ?? "";
  const currentTier = subQuery.data?.tier ?? "free";
  const currentStatus = subQuery.data?.status ?? "free";

  const handleSubscribe = async (tier: TierId) => {
    if (!isAuthed || !fbUserId) {
      // Trigger FB login. After it resolves successfully the parent
      // <AuthGate/> will re-render with status === "auth" and the
      // user can click again. Auto-resume is flaky given FB SDK
      // callback timing, so an explicit second click is the cleanest UX.
      try {
        login();
        toast("登入後再點選訂閱", "info");
      } catch {
        toast("登入失敗,請稍後再試", "error");
      }
      return;
    }
    setBusyTier(tier);
    try {
      const resp = await api.billing.checkout({ tier, fbUserId });
      window.location.assign(resp.url);
    } catch (err) {
      console.error("[pricing] checkout failed", err);
      toast("無法建立訂閱,請稍後再試", "error");
      setBusyTier(null);
    }
  };

  if (cfgQuery.isLoading) {
    return <LoadingState title="載入方案中..." />;
  }

  return (
    <div className="min-h-screen bg-bg">
      <PricingHero trialDays={trialDays} />

      {/* Plan cards */}
      <div className="mx-auto w-full max-w-[1100px] px-4 pb-6 md:px-6 md:pb-10">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-5">
          {tiers.map((tier) => (
            <PlanCard
              key={tier.tier}
              tier={tier}
              currency={currency}
              trialDays={trialDays}
              highlighted={tier.tier === "plus"}
              currentTier={currentTier}
              currentStatus={currentStatus}
              isBusy={busyTier === tier.tier}
              onSubscribe={() => void handleSubscribe(tier.tier)}
            />
          ))}
        </div>
        <div className="mx-auto mt-5 max-w-[800px] md:mt-6">
          <PolarLanguageNotice context="checkout" />
        </div>
      </div>

      <FaqSection trialDays={trialDays} />
      <PricingFooter />
    </div>
  );
}

// ── Hero ─────────────────────────────────────────────────────

function PricingHero({ trialDays }: { trialDays: number }) {
  return (
    <header className="mx-auto w-full max-w-[1100px] px-4 pb-6 pt-10 text-center md:px-6 md:pb-10 md:pt-16">
      <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-orange-bg px-3 py-1 text-[12px] font-semibold text-orange">
        開站半價
      </div>
      <h1 className="text-[26px] font-bold leading-tight tracking-tight text-ink md:text-[36px]">
        為廣告代理商而生的
        <br className="md:hidden" />
        成效監控平台
      </h1>
      <p className="mt-3 text-[14px] leading-relaxed text-gray-500 md:text-[16px]">
        即時 LINE 推播 · AI 優化建議 · 跨 Business Manager 統一管理
        <br className="hidden md:block" />
        所有方案皆享 {trialDays} 天免費試用,30 天內取消不收費
      </p>
    </header>
  );
}

// ── Plan card ────────────────────────────────────────────────

function PlanCard({
  tier,
  currency,
  trialDays,
  highlighted,
  currentTier,
  currentStatus,
  isBusy,
  onSubscribe,
}: {
  tier: PricingTier;
  currency: string;
  trialDays: number;
  highlighted: boolean;
  currentTier: TierId;
  currentStatus: string;
  isBusy: boolean;
  onSubscribe: () => void;
}) {
  const isCurrent = currentTier === tier.tier && currentStatus !== "canceled";
  const savings = tier.price_monthly_full - tier.price_monthly;
  // AI 幕僚 quota copy. Free is a LIFETIME trial allowance ("試用 N
  // 次"), paid tiers are monthly ("每月 N 次"), Max is unlimited.
  // adviceLimit === 0 only happens if a tier was deliberately set
  // to exclude the feature (shouldn't currently — Free starts at 3).
  const adviceLimit = tier.agent_advice_limit;
  const adviceLine =
    adviceLimit === -1
      ? "AI 幕僚:無限分析次數"
      : adviceLimit === 0
        ? "AI 幕僚:✗ 不包含"
        : tier.tier === "free"
          ? `AI 幕僚:免費試用 ${adviceLimit} 次`
          : `AI 幕僚:每月 ${adviceLimit} 次分析`;

  const features = [
    `${tier.ad_accounts_limit === -1 ? "無限" : tier.ad_accounts_limit} 個廣告帳戶`,
    `可串接 ${tier.line_channels_limit === -1 ? "無限" : tier.line_channels_limit} 個 LINE 官方帳號`,
    `可被加入 ${tier.line_groups_limit === -1 ? "無限" : tier.line_groups_limit} 個 LINE 群組`,
    "推播次數依 LINE 官方計費(與本系統方案無關)",
    "即時警示列表",
    adviceLine,
    "AI 即時對話顧問",
    "公開分享報告",
  ];

  return (
    <div
      className={`relative flex flex-col gap-4 rounded-2xl border bg-white p-5 md:p-6 ${
        highlighted
          ? "border-orange shadow-[0_8px_24px_-12px_rgba(255,107,44,0.4)] md:scale-[1.04]"
          : "border-border"
      }`}
    >
      {highlighted && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-orange px-3 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-white">
          最受歡迎
        </div>
      )}

      <div className="flex items-baseline gap-2">
        <h2 className="text-[20px] font-bold text-ink">{tier.name}</h2>
        {isCurrent && (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-600">
            目前方案
          </span>
        )}
      </div>

      {/* Price block */}
      <div className="flex flex-col gap-1">
        <div className="text-[13px] text-gray-300 line-through tabular-nums">
          原價 {currency} ${fM(tier.price_monthly_full)}/月
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[14px] text-gray-500">{currency}</span>
          <span
            className={`text-[34px] font-bold tabular-nums ${highlighted ? "text-orange" : "text-ink"}`}
          >
            ${fM(tier.price_monthly)}
          </span>
          <span className="text-[14px] text-gray-500">/月</span>
        </div>
        {savings > 0 && (
          <div className="text-[12px] font-semibold text-emerald-600">
            每月省 {currency} ${fM(savings)} (50% off)
          </div>
        )}
      </div>

      {/* Features */}
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px] text-ink">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <CheckIcon highlighted={highlighted} />
            <span className="flex-1">{f}</span>
          </li>
        ))}
      </ul>

      {/* CTA */}
      <div className="mt-auto pt-2">
        <Button
          className="w-full !h-11 !text-[14px]"
          variant={highlighted ? "primary" : "ghost"}
          disabled={isCurrent || isBusy}
          onClick={onSubscribe}
        >
          {isCurrent ? "目前方案" : isBusy ? "前往付款..." : `免費試用 ${trialDays} 天`}
        </Button>
        <p className="mt-2 text-center text-[11px] text-gray-300">
          試用期內可隨時取消,不收任何費用
        </p>
      </div>
    </div>
  );
}

function CheckIcon({ highlighted }: { highlighted: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`mt-0.5 shrink-0 ${highlighted ? "text-orange" : "text-emerald-500"}`}
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ── FAQ ──────────────────────────────────────────────────────

function FaqSection({ trialDays }: { trialDays: number }) {
  const items = [
    {
      q: "可以隨時升降級或取消嗎?",
      a: "可以。在「我的訂閱」頁可進入 Polar 自助管理頁,隨時切換方案、更新付款方式或取消訂閱。",
    },
    {
      q: "「廣告帳戶數」怎麼計算?",
      a: "以 Facebook 廣告帳戶 id (act_xxx) 為單位。新增帳戶時若超過方案上限,系統會跳出升級提示。",
    },
    {
      q: `試用期 ${trialDays} 天內取消會被扣款嗎?`,
      a: "不會。試用期內取消完全免費,系統會立即停止計費。試用結束才會自動進行第一次扣款。",
    },
    {
      q: "如果中斷訂閱,我的資料會被刪除嗎?",
      a: "不會。所有設定 / 暱稱 / 推播 config 永久保留,變成唯讀模式。隨時重新訂閱即可恢復寫入。",
    },
    {
      q: "支援哪些付款方式?",
      a: "信用卡 (Visa / Mastercard / JCB)、Apple Pay、Google Pay。所有金流由 Polar.sh + Stripe 處理,我們不會接觸到您的卡片資料。",
    },
  ];
  return (
    <section className="mx-auto w-full max-w-[800px] px-4 py-10 md:px-6 md:py-16">
      <h2 className="mb-6 text-center text-[22px] font-bold text-ink md:text-[28px]">常見問題</h2>
      <div className="flex flex-col gap-3">
        {items.map((it) => (
          <details
            key={it.q}
            className="group rounded-xl border border-border bg-white px-4 py-3 md:px-5 md:py-4"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between text-[14px] font-semibold text-ink md:text-[15px]">
              {it.q}
              <span className="text-gray-300 transition-transform group-open:rotate-45">+</span>
            </summary>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-500 md:text-[14px]">{it.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

// ── Footer ────────────────────────────────────────────────────

function PricingFooter() {
  return (
    <footer className="border-t border-border bg-white py-6 text-center text-[12px] text-gray-300">
      <div className="mb-1">
        金流由 <span className="font-semibold">Polar.sh</span> +{" "}
        <span className="font-semibold">Stripe</span> 處理 · 全程 SSL 加密
      </div>
      <div>© LURE Meta Platform · METADASH</div>
    </footer>
  );
}
