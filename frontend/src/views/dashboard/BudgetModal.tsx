import type { EntityKind } from "@/api/hooks/useEntityMutations";
import { mutationErrorMessage, useEntityBudgetMutation } from "@/api/hooks/useEntityMutations";
import { Button } from "@/components/Button";
import { confirm } from "@/components/ConfirmDialog";
import { Modal } from "@/components/Modal";
import { fM } from "@/lib/format";
import { useEffect, useState } from "react";

/**
 * Budget edit dialog — open via `open` prop with a target entity.
 * Ported from the original design `#budgetModal` + `openBudget()` +
 * `saveBudget()`.
 *
 * Flow:
 *  1. User types new daily budget (TWD)
 *  2. Click 儲存 → confirm() dialog shows the formatted amount
 *  3. On confirm → useEntityBudgetMutation fires the POST
 *  4. On success → modal closes, TanStack Query refetches the row
 *  5. On error   → keeps modal open, shows error text
 */

export interface BudgetModalTarget {
  kind: Extract<EntityKind, "campaign" | "adset">;
  id: string;
  name: string;
  accountId?: string;
}

export interface BudgetModalProps {
  open: boolean;
  target: BudgetModalTarget | null;
  onClose: () => void;
}

export function BudgetModal({ open, target, onClose }: BudgetModalProps) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useEntityBudgetMutation();

  useEffect(() => {
    if (!open) {
      setAmount("");
      setError(null);
    }
  }, [open]);

  const save = async () => {
    const val = Number.parseInt(amount, 10);
    if (!val || val <= 0) {
      setError("請輸入有效金額");
      return;
    }
    if (!target) return;
    const ok = await confirm(`確定將每日預算更改為 $${fM(val)}？`);
    if (!ok) return;
    try {
      await mutation.mutateAsync({
        kind: target.kind,
        id: target.id,
        dailyBudget: val,
        accountId: target.accountId,
      });
      onClose();
    } catch (err) {
      setError(mutationErrorMessage(err));
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="調整預算"
      subtitle={target?.name}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={mutation.isPending}>
            {mutation.isPending ? "儲存中..." : "儲存"}
          </Button>
        </>
      }
    >
      <label className="mb-1 block text-xs font-semibold text-ink">
        日預算（TWD）
        <input
          type="number"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setError(null);
          }}
          placeholder="例：500"
          className="mt-1 mb-3 block h-9 w-full rounded-lg border border-border px-2.5 text-sm font-normal outline-none focus:border-orange"
        />
      </label>
      {error && (
        <div className="mb-2 rounded-md bg-red-bg px-2.5 py-1.5 text-xs text-red">{error}</div>
      )}
    </Modal>
  );
}
