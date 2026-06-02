import type { NicknameMap } from "@/api/hooks/useNicknames";
import { spendOf } from "@/lib/insights";
import type { FbAccount, FbCampaign, FbInsights } from "@/types/fb";

/** Join store + designer into the canonical "店家 · 設計師" label.
 *  Either field may be empty; returns `null` when both are empty. */
export function formatNickname(
  nick: { store: string; designer: string } | undefined,
): string | null {
  if (!nick) return null;
  const s = nick.store.trim();
  const d = nick.designer.trim();
  if (!s && !d) return null;
  if (s && d) return `${s} · ${d}`;
  return s || d;
}

/**
 * Pure data helpers for the Finance view. No React, no DOM — all
 * functions take campaigns/insights/state as inputs so they're
 * fully unit-testable.
 *
 * Ported from the original design `renderFinanceTable()` and
 * `renderFinanceAcctList()` lines 3260–3520.
 */

export type FinSortKey = "name" | "acct" | "spend" | "markup" | "plus" | null;
export type FinSortDir = "asc" | "desc";

export interface FinSortState {
  key: FinSortKey;
  dir: FinSortDir;
}

/** The markup for a campaign — either per-row override or default. */
export function markupFor(
  campaignId: string,
  rowMarkups: Record<string, number>,
  defaultMarkup: number,
): number {
  return rowMarkups[campaignId] !== undefined ? rowMarkups[campaignId] : defaultMarkup;
}

/** `spend * (1 + markup/100)`, ceiled to the nearest integer. */
export function spendPlus(spend: number, markup: number): number {
  return Math.ceil(spend * (1 + markup / 100));
}

/**
 * Account-level spend. Prefers the account-level insights value
 * (accurate, includes archived) but falls back to summing campaign
 * spend when insights are missing.
 */
export function accountSpend(
  accountId: string,
  insights: Record<string, FbInsights | null>,
  campaigns: FbCampaign[],
): number {
  const insSpend = insights[accountId]?.spend;
  if (insSpend) return Number(insSpend);
  return campaigns
    .filter((c) => c._accountId === accountId)
    .reduce((sum, c) => sum + spendOf(c), 0);
}

// ── Sorting ────────────────────────────────────────────────

/** Options passed through sortFinanceRows so name-sort can reflect
 *  the displayed label when nicknames are visible. */
export interface SortOptions {
  nicknames?: NicknameMap;
  /** When true AND the campaign has a nickname, sort "name" by the
   *  "店家 · 設計師" label instead of the raw FB campaign name. */
  useNicknameForNameSort?: boolean;
}

/** Value extractor for sort on a given column. */
function sortValueOf(
  c: FbCampaign,
  key: FinSortKey,
  rowMarkups: Record<string, number>,
  defaultMarkup: number,
  opts: SortOptions = {},
): string | number {
  switch (key) {
    case "name": {
      if (opts.useNicknameForNameSort) {
        const label = formatNickname(opts.nicknames?.[c.id]);
        if (label) return label;
      }
      return c.name;
    }
    case "acct":
      return c._accountName ?? "";
    case "spend":
      return spendOf(c);
    case "markup":
      return markupFor(c.id, rowMarkups, defaultMarkup);
    case "plus": {
      const m = markupFor(c.id, rowMarkups, defaultMarkup);
      return spendOf(c) * (1 + m / 100);
    }
    default:
      return 0;
  }
}

/** Sort + pinned-to-top a list of campaigns. Mirrors legacy behavior. */
export function sortFinanceRows(
  campaigns: FbCampaign[],
  sort: FinSortState,
  pinnedIds: string[],
  rowMarkups: Record<string, number>,
  defaultMarkup: number,
  opts: SortOptions = {},
): FbCampaign[] {
  const compare = (a: FbCampaign, b: FbCampaign) => {
    if (!sort.key) return 0;
    const va = sortValueOf(a, sort.key, rowMarkups, defaultMarkup, opts);
    const vb = sortValueOf(b, sort.key, rowMarkups, defaultMarkup, opts);
    const cmp =
      typeof va === "string" && typeof vb === "string"
        ? va.localeCompare(vb, "zh-Hant")
        : (va as number) - (vb as number);
    return sort.dir === "asc" ? cmp : -cmp;
  };
  const pinned = campaigns.filter((c) => pinnedIds.includes(c.id)).sort(compare);
  const unpinned = campaigns.filter((c) => !pinnedIds.includes(c.id)).sort(compare);
  return [...pinned, ...unpinned];
}

/**
 * Row-by-row filter: "hide zero spend" + name search. `search` is
 * compared case-insensitively against campaign name, account name,
 * and — when provided — the campaign's store/designer nicknames.
 */
export function filterFinanceRows(
  campaigns: FbCampaign[],
  hideZero: boolean,
  search: string,
  nicknames?: NicknameMap,
): FbCampaign[] {
  const q = search.trim().toLowerCase();
  return campaigns.filter((c) => {
    if (hideZero && spendOf(c) <= 0) return false;
    if (q) {
      const name = c.name.toLowerCase();
      const acct = (c._accountName ?? "").toLowerCase();
      const nick = nicknames?.[c.id];
      const store = (nick?.store ?? "").toLowerCase();
      const designer = (nick?.designer ?? "").toLowerCase();
      if (!name.includes(q) && !acct.includes(q) && !store.includes(q) && !designer.includes(q)) {
        return false;
      }
    }
    return true;
  });
}

// ── CSV export ──────────────────────────────────────────────

export interface CsvExportInput {
  rows: FbCampaign[];
  defaultMarkup: number;
  rowMarkups: Record<string, number>;
  /** Include the "廣告帳號" column (all-accounts mode). */
  includeAccountColumn: boolean;
  nicknames?: NicknameMap;
}

/** Build the CSV text. Caller is responsible for download. */
export function buildFinanceCsv(input: CsvExportInput): string {
  const { rows, defaultMarkup, rowMarkups, includeAccountColumn, nicknames } = input;
  const header = includeAccountColumn
    ? ["No.", "狀態", "廣告帳號", "行銷活動名稱", "店家", "設計師", "花費", "月%", "花費+%"]
    : ["No.", "狀態", "行銷活動名稱", "店家", "設計師", "花費", "月%", "花費+%"];
  const records: Array<Array<string | number>> = [header];
  rows.forEach((camp, i) => {
    const sp = spendOf(camp);
    const m = markupFor(camp.id, rowMarkups, defaultMarkup);
    const nick = nicknames?.[camp.id];
    const cells: Array<string | number> = [
      i + 1,
      camp.status,
      camp.name,
      nick?.store ?? "",
      nick?.designer ?? "",
      sp.toFixed(0),
      `${m}%`,
      spendPlus(sp, m),
    ];
    if (includeAccountColumn) {
      cells.splice(2, 0, camp._accountName ?? "");
    }
    records.push(cells);
  });
  return records
    .map((row) =>
      row
        .map((v) => {
          const s = String(v).replace(/"/g, '""');
          // Prefix formula-trigger characters so Excel/Sheets don't
          // interpret campaign names as formulas (injection prevention).
          const safe = /^[=+@\-]/.test(s) ? `'${s}` : s;
          return `"${safe}"`;
        })
        .join(","),
    )
    .join("\n");
}

/**
 * Account-panel row data: one row per visible account with spend
 * and spend+markup, plus a synthetic "全部帳戶" row at the top.
 *
 * `dotState` mirrors the dashboard sidebar status indicator so the
 * Finance panel can render the same `<StatusDot/>` pattern.
 */
export interface FinAccountRow {
  id: string; // "__all__" for the header row
  label: string;
  spend: number;
  plus: number;
  loaded: boolean;
  isTotal: boolean;
  dotState: "on" | "off";
}

export function buildAccountRows(
  accounts: FbAccount[],
  insights: Record<string, FbInsights | null>,
  campaigns: FbCampaign[],
  rowMarkups: Record<string, number>,
  defaultMarkup: number,
): FinAccountRow[] {
  const perAccount: FinAccountRow[] = accounts.map((acc) => {
    const spend = accountSpend(acc.id, insights, campaigns);
    const accountCampaigns = campaigns.filter((c) => c._accountId === acc.id);
    const plus =
      accountCampaigns.length > 0
        ? accountCampaigns.reduce((sum, c) => {
            const m = markupFor(c.id, rowMarkups, defaultMarkup);
            return sum + spendPlus(spendOf(c), m);
          }, 0)
        : spendPlus(spend, defaultMarkup);
    const loaded = insights[acc.id] !== undefined;
    return {
      id: acc.id,
      label: acc.name,
      spend,
      plus,
      loaded,
      isTotal: false,
      dotState: (acc.account_status === 1 ? "on" : "off") as "on" | "off",
    };
  });

  const totalSpend = perAccount.reduce((s, a) => s + a.spend, 0);
  const totalPlus = perAccount.reduce((s, a) => s + a.plus, 0);
  const allLoaded = perAccount.every((r) => r.loaded);

  return [
    {
      id: "__all__",
      label: "全部帳戶",
      spend: totalSpend,
      plus: totalPlus,
      loaded: allLoaded,
      isTotal: true,
      dotState: "on",
    },
    ...perAccount,
  ];
}
