import { describe, expect, it } from "vitest";
import {
  buildSecurityDays,
  formatDayLabel,
  parseFbTime,
  summariseExtraData,
} from "@/views/security/securityData";
import type { FbCampaign } from "@/types/fb";
import type { DateConfig } from "@/lib/datePicker";

function campaign(
  id: string,
  name: string,
  createdLocal: string,
  overrides: Partial<FbCampaign> = {},
): FbCampaign {
  // createdLocal: "YYYY-MM-DDTHH:MM" (local time, no timezone)
  const local = new Date(createdLocal);
  return {
    id,
    name,
    status: "ACTIVE",
    _accountId: "act_1",
    _accountName: "Test",
    created_time: local.toISOString(),
    ...overrides,
  };
}

const customRange = (from: string, to: string): DateConfig => ({
  preset: "custom",
  from,
  to,
});

describe("buildSecurityDays — date range filtering", () => {
  it("filters out campaigns created outside the range", () => {
    const camps = [
      campaign("1", "in", "2026-05-22T10:00"),
      campaign("2", "before", "2026-04-01T10:00"),
      campaign("3", "after", "2026-06-01T10:00"),
    ];
    const days = buildSecurityDays(camps, customRange("2026-05-01", "2026-05-31"));
    const ids = days.flatMap((d) => d.rows.map((r) => r.campaign.id));
    expect(ids).toEqual(["1"]);
  });

  it("includes the entire end day (until 23:59:59)", () => {
    const camps = [campaign("late", "x", "2026-05-31T23:30")];
    const days = buildSecurityDays(camps, customRange("2026-05-01", "2026-05-31"));
    expect(days[0]?.rows[0]?.campaign.id).toBe("late");
  });

  it("groups by local creation day, newest day first", () => {
    const camps = [
      campaign("a", "a", "2026-05-22T10:00"),
      campaign("b", "b", "2026-05-22T15:00"),
      campaign("c", "c", "2026-05-20T12:00"),
    ];
    const days = buildSecurityDays(camps, customRange("2026-05-01", "2026-05-31"));
    expect(days.map((d) => d.dateKey)).toEqual(["2026-05-22", "2026-05-20"]);
    expect(days[0]?.rows.map((r) => r.campaign.id)).toEqual(["b", "a"]);
  });

  it("ignores campaigns missing created_time", () => {
    const camps = [
      campaign("1", "ok", "2026-05-22T10:00"),
      { id: "2", name: "no time", status: "ACTIVE", _accountId: "act_1" } as FbCampaign,
    ];
    const days = buildSecurityDays(camps, customRange("2026-05-01", "2026-05-31"));
    expect(days.flatMap((d) => d.rows.map((r) => r.campaign.id))).toEqual(["1"]);
  });
});

describe("buildSecurityDays — anomaly tagging", () => {
  it("tags deep_night for created hour < 6", () => {
    const camps = [
      campaign("night", "n", "2026-05-22T03:00"),
      campaign("morning", "m", "2026-05-22T08:00"),
    ];
    const days = buildSecurityDays(camps, customRange("2026-05-01", "2026-05-31"));
    const rows = days.flatMap((d) => d.rows);
    const byId = Object.fromEntries(rows.map((r) => [r.campaign.id, r.anomalies]));
    expect(byId.night).toContain("deep_night");
    expect(byId.morning).not.toContain("deep_night");
  });

  it("tags weekend for Sat/Sun creation", () => {
    // 2026-05-23 is Saturday, 2026-05-24 is Sunday, 2026-05-25 is Monday
    const camps = [
      campaign("sat", "s", "2026-05-23T10:00"),
      campaign("sun", "u", "2026-05-24T10:00"),
      campaign("mon", "m", "2026-05-25T10:00"),
    ];
    const days = buildSecurityDays(camps, customRange("2026-05-23", "2026-05-25"));
    const byId = Object.fromEntries(
      days.flatMap((d) => d.rows).map((r) => [r.campaign.id, r.anomalies]),
    );
    expect(byId.sat).toContain("weekend");
    expect(byId.sun).toContain("weekend");
    expect(byId.mon).not.toContain("weekend");
  });

  it("tags burst when 5+ campaigns created within 2h in same account", () => {
    const camps = [
      campaign("a", "1", "2026-05-22T10:00"),
      campaign("b", "2", "2026-05-22T10:20"),
      campaign("c", "3", "2026-05-22T10:40"),
      campaign("d", "4", "2026-05-22T11:00"),
      campaign("e", "5", "2026-05-22T11:30"),
      // unrelated, far apart
      campaign("z", "z", "2026-05-22T20:00"),
    ];
    const days = buildSecurityDays(camps, customRange("2026-05-01", "2026-05-31"));
    const byId = Object.fromEntries(
      days.flatMap((d) => d.rows).map((r) => [r.campaign.id, r.anomalies]),
    );
    for (const id of ["a", "b", "c", "d", "e"]) {
      expect(byId[id]).toContain("burst");
    }
    expect(byId.z).not.toContain("burst");
  });

  it("tags high_budget when daily_budget > 2000 (raw FB value, no /100)", () => {
    const camps = [
      campaign("low", "1", "2026-05-22T10:00", { daily_budget: "1500" }),
      campaign("at", "2", "2026-05-22T10:00", { daily_budget: "2000" }), // exactly threshold, NOT flagged
      campaign("high", "3", "2026-05-22T10:00", { daily_budget: "2500" }),
      campaign("missing", "4", "2026-05-22T10:00"),
    ];
    const days = buildSecurityDays(camps, customRange("2026-05-01", "2026-05-31"));
    const byId = Object.fromEntries(
      days.flatMap((d) => d.rows).map((r) => [r.campaign.id, r.anomalies]),
    );
    expect(byId.low).not.toContain("high_budget");
    expect(byId.at).not.toContain("high_budget");
    expect(byId.high).toContain("high_budget");
    expect(byId.missing).not.toContain("high_budget");
  });

  it("tags high_budget when CBO is off and summed ACTIVE adset budgets exceed threshold", () => {
    const cbosOff = (
      id: string,
      adsets: Array<{ daily?: string; status?: "ACTIVE" | "PAUSED" | "ARCHIVED" }>,
    ): FbCampaign => ({
      id,
      name: id,
      status: "ACTIVE",
      _accountId: "act_1",
      created_time: new Date("2026-05-22T10:00").toISOString(),
      adsets: {
        data: adsets.map((a) => ({ daily_budget: a.daily, status: a.status ?? "ACTIVE" })),
      },
    });
    const camps = [
      // CBO off, 3 active adsets summing to 2400 > 2000 → flagged
      cbosOff("over", [
        { daily: "800", status: "ACTIVE" },
        { daily: "800", status: "ACTIVE" },
        { daily: "800", status: "ACTIVE" },
      ]),
      // CBO off, 3 active adsets summing to 1500 → NOT flagged
      cbosOff("under", [
        { daily: "500", status: "ACTIVE" },
        { daily: "500", status: "ACTIVE" },
        { daily: "500", status: "ACTIVE" },
      ]),
      // CBO off, the big adsets are ARCHIVED → only 500 counts → NOT flagged
      cbosOff("ignore-archived", [
        { daily: "100000", status: "ARCHIVED" },
        { daily: "500", status: "ACTIVE" },
      ]),
    ];
    const days = buildSecurityDays(camps, customRange("2026-05-01", "2026-05-31"));
    const byId = Object.fromEntries(
      days.flatMap((d) => d.rows).map((r) => [r.campaign.id, r.anomalies]),
    );
    expect(byId.over).toContain("high_budget");
    expect(byId.under).not.toContain("high_budget");
    expect(byId["ignore-archived"]).not.toContain("high_budget");
  });

  it("does NOT tag burst across different accounts", () => {
    const camps = [
      campaign("a", "1", "2026-05-22T10:00", { _accountId: "act_1" }),
      campaign("b", "2", "2026-05-22T10:10", { _accountId: "act_2" }),
      campaign("c", "3", "2026-05-22T10:20", { _accountId: "act_3" }),
      campaign("d", "4", "2026-05-22T10:30", { _accountId: "act_4" }),
      campaign("e", "5", "2026-05-22T10:40", { _accountId: "act_5" }),
    ];
    const days = buildSecurityDays(camps, customRange("2026-05-01", "2026-05-31"));
    const rows = days.flatMap((d) => d.rows);
    for (const r of rows) {
      expect(r.anomalies).not.toContain("burst");
    }
  });
});

describe("parseFbTime + formatDayLabel", () => {
  it("parses FB-style ISO with +0000 offset", () => {
    const d = parseFbTime("2026-05-22T15:30:00+0000");
    expect(d).not.toBeNull();
    expect(d?.getUTCHours()).toBe(15);
  });

  it("returns null for missing or invalid input", () => {
    expect(parseFbTime(undefined)).toBeNull();
    expect(parseFbTime("")).toBeNull();
    expect(parseFbTime("garbage")).toBeNull();
  });

  it("formats day label as M月D日 (週X)", () => {
    // 2026-05-23 is Saturday
    expect(formatDayLabel("2026-05-23")).toBe("5月23日 (週六)");
  });
});

describe("summariseExtraData — FB Activity Log plain-Chinese", () => {
  it("formats a status change with type + translated values", () => {
    const raw = JSON.stringify({
      type: "run_status",
      old_value: "進行中",
      new_value: "暫停",
      run_status: { old_value: 1, new_value: 15 },
    });
    expect(summariseExtraData(raw)).toBe("狀態:進行中 → 暫停");
  });

  it("formats a daily_budget change with cents → dollars", () => {
    const raw = JSON.stringify({
      type: "daily_budget",
      old_value: "10000",
      new_value: "20000",
    });
    expect(summariseExtraData(raw)).toBe("日預算:$100 → $200");
  });

  it("appends a plain-Chinese hint for with_issue_code", () => {
    const raw = JSON.stringify({
      old_value: "進行中",
      new_value: "必須更新",
      with_issue_code: 4134001,
      run_status: { old_value: 1, new_value: 18 },
    });
    const out = summariseExtraData(raw);
    expect(out).toContain("變更:進行中 → 必須更新");
    expect(out).toContain("Meta 政策審查");
    expect(out).toContain("4134001");
  });

  it("recurses into composite_data with a payment_amount payload", () => {
    const raw = JSON.stringify({
      type: "composite_data",
      new_value: {
        type: "payment_amount",
        currency: "TWD",
        new_value: 692,
        additional_value: "單日",
      },
    });
    expect(summariseExtraData(raw)).toBe("預算 單日 $7 TWD");
  });

  it("returns null for unrecognisable / empty payloads", () => {
    expect(summariseExtraData(undefined)).toBeNull();
    expect(summariseExtraData("")).toBeNull();
    expect(summariseExtraData("garbage")).toBeNull();
    expect(summariseExtraData("{}")).toBeNull();
  });

  it("infers a change sentence when type is missing but old/new present", () => {
    const raw = JSON.stringify({ old_value: "舊名稱", new_value: "新名稱" });
    expect(summariseExtraData(raw)).toBe("變更:舊名稱 → 新名稱");
  });
});
