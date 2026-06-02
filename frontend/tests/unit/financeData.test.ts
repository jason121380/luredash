import { describe, expect, it } from "vitest";
import {
  accountSpend,
  buildAccountRows,
  buildFinanceCsv,
  filterFinanceRows,
  markupFor,
  sortFinanceRows,
  spendPlus,
} from "@/views/finance/financeData";
import type { FbAccount, FbCampaign, FbInsights } from "@/types/fb";

function campaign(
  id: string,
  accountId: string,
  name: string,
  spend: number,
  status: FbCampaign["status"] = "ACTIVE",
): FbCampaign {
  return {
    id,
    name,
    status,
    _accountId: accountId,
    _accountName: `Account ${accountId}`,
    insights: { data: [{ spend: String(spend), actions: [] }] },
  };
}

const accA: FbAccount = { id: "act_1", name: "Alpha", account_status: 1 };
const accB: FbAccount = { id: "act_2", name: "Bravo", account_status: 1 };

describe("markupFor / spendPlus", () => {
  it("uses row override when present", () => {
    expect(markupFor("cmp_1", { cmp_1: 12 }, 5)).toBe(12);
  });
  it("falls back to default when no override", () => {
    expect(markupFor("cmp_1", {}, 5)).toBe(5);
  });
  it("honors explicit 0 override (not replaced by default)", () => {
    expect(markupFor("cmp_1", { cmp_1: 0 }, 5)).toBe(0);
  });
  it("spendPlus ceils to integer", () => {
    expect(spendPlus(1000, 5)).toBe(1050);
    expect(spendPlus(1000, 5.5)).toBe(1055);
    expect(spendPlus(100, 0.1)).toBe(101); // 100.1 → 101
  });
});

describe("accountSpend", () => {
  it("prefers account-level insights when present", () => {
    const ins: Record<string, FbInsights | null> = { act_1: { spend: "5000" } };
    const camps = [campaign("1", "act_1", "A", 999)];
    expect(accountSpend("act_1", ins, camps)).toBe(5000);
  });
  it("falls back to summing campaigns when insights missing", () => {
    const ins: Record<string, FbInsights | null> = { act_1: null };
    const camps = [
      campaign("1", "act_1", "A", 300),
      campaign("2", "act_1", "B", 700),
      campaign("3", "act_2", "C", 10000), // different account
    ];
    expect(accountSpend("act_1", ins, camps)).toBe(1000);
  });
});

describe("sortFinanceRows", () => {
  const camps = [
    campaign("1", "act_1", "Zeta", 1000),
    campaign("2", "act_1", "Alpha", 3000),
    campaign("3", "act_1", "Beta", 2000),
  ];

  it("sorts by spend desc", () => {
    const sorted = sortFinanceRows(camps, { key: "spend", dir: "desc" }, [], {}, 5);
    expect(sorted.map((c) => c.id)).toEqual(["2", "3", "1"]);
  });

  it("sorts by name asc", () => {
    const sorted = sortFinanceRows(camps, { key: "name", dir: "asc" }, [], {}, 5);
    expect(sorted.map((c) => c.name)).toEqual(["Alpha", "Beta", "Zeta"]);
  });

  it("pins by id first, then sorts within each group", () => {
    // pin cmp_1 (Zeta) — pinned sorted alone, unpinned [2,3] sorted by name desc
    const sorted = sortFinanceRows(
      camps,
      { key: "name", dir: "desc" },
      ["1"],
      {},
      5,
    );
    expect(sorted.map((c) => c.id)).toEqual(["1", "3", "2"]); // Zeta (pinned), Beta, Alpha
  });

  it("sort by plus uses row markup override", () => {
    // cmp_1 spend 1000 @ 50% → 1500
    // cmp_2 spend 3000 @ 5% default → 3150
    // cmp_3 spend 2000 @ 0% override → 2000
    const sorted = sortFinanceRows(
      camps,
      { key: "plus", dir: "desc" },
      [],
      { cmp_1: 50, cmp_3: 0 },
      5,
    );
    expect(sorted.map((c) => c.id)).toEqual(["2", "3", "1"]); // Wait: plus(cmp_1)=1500, plus(cmp_2)=3150, plus(cmp_3)=2000 → desc: 2,3,1
  });
});

describe("filterFinanceRows", () => {
  const camps = [
    campaign("1", "act_1", "Spend", 1000),
    campaign("2", "act_1", "Zero", 0),
    campaign("3", "act_1", "私訊 A", 500),
  ];

  it("hideZero removes 0-spend rows", () => {
    const filtered = filterFinanceRows(camps, true, "");
    expect(filtered.map((c) => c.id)).toEqual(["1", "3"]);
  });

  it("search matches campaign name case-insensitively", () => {
    const filtered = filterFinanceRows(camps, false, "spend");
    expect(filtered.map((c) => c.id)).toEqual(["1"]);
  });

  it("search matches account name too", () => {
    const filtered = filterFinanceRows(camps, false, "Account act_1");
    expect(filtered).toHaveLength(3);
  });
});

describe("buildFinanceCsv", () => {
  const camps = [campaign("1", "act_1", "First", 1000), campaign("2", "act_2", "Second", 2000)];

  it("produces a 2-row CSV with header when includeAccountColumn=false", () => {
    const csv = buildFinanceCsv({
      rows: camps,
      defaultMarkup: 10,
      rowMarkups: {},
      includeAccountColumn: false,
    });
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toContain('"行銷活動名稱"');
    expect(lines[1]).toContain('"First"');
    expect(lines[1]).toContain('"1100"'); // 1000 * 1.1
  });

  it("inserts 廣告帳號 column when includeAccountColumn=true", () => {
    const csv = buildFinanceCsv({
      rows: camps,
      defaultMarkup: 5,
      rowMarkups: {},
      includeAccountColumn: true,
    });
    const lines = csv.split("\n");
    expect(lines[0]).toContain('"廣告帳號"');
    expect(lines[1]).toContain('"Account act_1"');
  });

  it("escapes double quotes in campaign names", () => {
    const csv = buildFinanceCsv({
      rows: [campaign("1", "act_1", 'Quoted "name"', 100)],
      defaultMarkup: 0,
      rowMarkups: {},
      includeAccountColumn: false,
    });
    expect(csv).toContain('"Quoted ""name"""');
  });
});

describe("buildAccountRows", () => {
  it("adds a 全部帳戶 header row with totals", () => {
    const insights = {
      act_1: { spend: "1000" },
      act_2: { spend: "500" },
    };
    const rows = buildAccountRows([accA, accB], insights, [], {}, 10);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.id).toBe("__all__");
    expect(rows[0]?.spend).toBe(1500);
    expect(rows[0]?.plus).toBe(1650); // (1000+500) * 1.1
  });

  it("sums campaign-level 花費+% so row markup overrides affect account totals", () => {
    const insights = {
      act_1: { spend: "3000" },
      act_2: { spend: "500" },
    };
    const camps = [
      campaign("1", "act_1", "A", 1000),
      campaign("2", "act_1", "B", 2000),
      campaign("3", "act_2", "C", 500),
    ];
    const rows = buildAccountRows([accA, accB], insights, camps, { "2": 20 }, 10);

    expect(rows[1]?.spend).toBe(3000);
    expect(rows[1]?.plus).toBe(3500); // 1000*1.1 + 2000*1.2
    expect(rows[0]?.plus).toBe(4050); // account totals sum campaign-level plus
  });

  it("falls back to campaign sum when insights missing", () => {
    const insights: Record<string, FbInsights | null> = { act_1: null };
    const camps = [campaign("1", "act_1", "A", 300), campaign("2", "act_1", "B", 200)];
    const rows = buildAccountRows([accA], insights, camps, {}, 0);
    expect(rows[1]?.spend).toBe(500);
  });
});
