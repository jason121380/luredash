import type { FbAccount } from "@/types/fb";
import { useState } from "react";

/**
 * Confirm-before-load gate for pages that fan out a FULL overview across
 * ALL of a user's accounts (店家花費 / 優化中心 / 電子發票). Opening such a
 * page with 80+ accounts fires one account-level `/insights` call per
 * account in a single burst — the top trigger of the Ads Insights
 * app-level throttle (code=4·1504022).
 *
 * When the account count exceeds `max`, we hold back the auto-fetch and
 * hand the caller an EMPTY account list (so `useMultiAccountOverview`'s
 * own `accounts.length > 0` gate keeps it disabled) plus a `confirm()` to
 * opt in. Below the threshold the page loads immediately as before.
 *
 * `confirmed` is component-local, so navigating away and back re-arms the
 * gate — each visit to a heavy page requires an explicit "載入全部".
 */

export const ACCOUNT_LOAD_GATE_MAX = 8;

// Stable empty array so a gated render doesn't churn the query key.
const EMPTY_ACCOUNTS: FbAccount[] = [];

export interface AccountLoadGate {
  /** Accounts to actually query — empty (no FB fetch) while gated. */
  queryAccounts: FbAccount[];
  /** True while holding back the auto-fetch pending confirmation. */
  gated: boolean;
  /** Total accounts the page would load. */
  count: number;
  /** Opt in — load all accounts now. */
  confirm: () => void;
}

export function useAccountLoadGate(
  accounts: FbAccount[],
  max: number = ACCOUNT_LOAD_GATE_MAX,
): AccountLoadGate {
  const [confirmed, setConfirmed] = useState(false);
  const gated = accounts.length > max && !confirmed;
  return {
    queryAccounts: gated ? EMPTY_ACCOUNTS : accounts,
    gated,
    count: accounts.length,
    confirm: () => setConfirmed(true),
  };
}
