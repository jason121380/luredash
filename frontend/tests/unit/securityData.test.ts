import { describe, expect, it } from "vitest";
import { buildSecurityDays, formatDayLabel, parseFbTime } from "@/views/security/securityData";
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
