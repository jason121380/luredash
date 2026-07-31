import { ApiError, api } from "@/api/client";
import type { FbEntityStatus } from "@/types/fb";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Mutation hooks for entity status + budget changes.
 *
 * Each mutation invalidates the relevant query keys on success so the
 * tree refetches the affected row. On error we leave the cache alone
 * and surface the ApiError for the caller (usually via toast/alert).
 *
 * CLAUDE.md requires a confirm() dialog BEFORE these fire — the tree
 * row UI handles that and only calls mutate() after the user clicks OK.
 */

export type EntityKind = "campaign" | "adset" | "creative";

export interface StatusMutationInput {
  kind: EntityKind;
  id: string;
  status: FbEntityStatus;
  accountId?: string;
}

function overviewKeyContainsAccount(queryKey: readonly unknown[], accountId: string): boolean {
  const idsKey = queryKey[1];
  if (typeof idsKey !== "string") return false;
  return idsKey.split(",").includes(accountId);
}

function invalidateAffectedOverview(
  qc: ReturnType<typeof useQueryClient>,
  accountId?: string,
): void {
  if (!accountId) {
    qc.invalidateQueries({ queryKey: ["overview"] });
    qc.invalidateQueries({ queryKey: ["overview-lite"] });
    return;
  }
  const predicate = (q: { queryKey: readonly unknown[] }) => {
    const root = q.queryKey[0];
    return (
      (root === "overview" || root === "overview-lite") &&
      overviewKeyContainsAccount(q.queryKey, accountId)
    );
  };
  qc.invalidateQueries({ predicate });
}

export function useEntityStatusMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: StatusMutationInput) => {
      if (input.kind === "campaign") {
        return api.campaigns.setStatus(input.id, input.status);
      }
      if (input.kind === "adset") {
        return api.adsets.setStatus(input.id, input.status);
      }
      return api.creatives.setStatus(input.id, input.status);
    },
    onSuccess: (_data, input) => {
      // Invalidate BOTH the per-entity cache keys AND the batch
      // overview keys. Dashboard, Alerts, Finance, and Analytics all
      // fetch data via useMultiAccountOverview (keyed on "overview" /
      // "overview-lite"), so invalidating only ["campaigns"] would
      // leave the batch cache stale — the user would see the old
      // status/budget until a manual refresh.
      if (input.kind === "campaign") {
        qc.invalidateQueries({ queryKey: ["campaigns"] });
      } else if (input.kind === "adset") {
        qc.invalidateQueries({ queryKey: ["adsets"] });
      } else {
        qc.invalidateQueries({ queryKey: ["creatives"] });
      }
      invalidateAffectedOverview(qc, input.accountId);
    },
  });
}

export interface BudgetMutationInput {
  kind: "campaign" | "adset";
  id: string;
  dailyBudget: number;
  accountId?: string;
}

export function useEntityBudgetMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BudgetMutationInput) => {
      if (input.kind === "campaign") {
        return api.campaigns.setBudget(input.id, input.dailyBudget);
      }
      return api.adsets.setBudget(input.id, input.dailyBudget);
    },
    onSuccess: (_data, input) => {
      if (input.kind === "campaign") {
        qc.invalidateQueries({ queryKey: ["campaigns"] });
      } else {
        qc.invalidateQueries({ queryKey: ["adsets"] });
      }
      invalidateAffectedOverview(qc, input.accountId);
    },
  });
}

/** Extract a user-friendly error message from a thrown ApiError. */
export function mutationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.detail;
  if (error instanceof Error) return error.message;
  return String(error);
}
