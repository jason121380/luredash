import { Button } from "@/components/Button";

/**
 * Shown in place of a heavy multi-account table when the page would
 * otherwise auto-fetch a full overview across many accounts. Paired with
 * `useAccountLoadGate` — see that file for why (Ads Insights burst).
 */
export function LoadAllAccountsPrompt({
  count,
  onConfirm,
}: {
  count: number;
  onConfirm: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-[60px] text-center">
      <p className="max-w-[420px] text-[13px] leading-relaxed text-gray-500">
        此頁會一次載入 <span className="font-semibold text-ink">{count}</span>{" "}
        個廣告帳戶的數據。帳戶較多時載入較慢,也會增加 FB API 用量,因此改為手動載入。
      </p>
      <Button onClick={onConfirm}>載入全部 {count} 個帳戶</Button>
    </div>
  );
}
