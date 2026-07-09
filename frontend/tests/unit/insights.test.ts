import { getAct, getIns, getMsgCount, spendOf, sumAction } from "@/lib/insights";
import type { FbBaseEntity } from "@/types/fb";
import { describe, expect, it } from "vitest";

const mkEntity = (
  actions: { action_type: string; value: string }[] = [],
  spend = "0",
): FbBaseEntity => ({
  id: "1",
  name: "test",
  status: "ACTIVE",
  insights: {
    data: [{ spend, actions }],
  },
});

describe("getIns", () => {
  it("returns insights.data[0]", () => {
    const entity = mkEntity([], "1000");
    expect(getIns(entity).spend).toBe("1000");
  });
  it("returns empty object when insights missing", () => {
    const entity: FbBaseEntity = { id: "1", name: "x", status: "ACTIVE" };
    expect(getIns(entity)).toEqual({});
  });
});

describe("getAct", () => {
  it("returns action value when action_type matches", () => {
    const entity = mkEntity([{ action_type: "purchase", value: "42" }]);
    expect(getAct(entity, "purchase")).toBe("42");
  });
  it("returns null when action_type not found", () => {
    const entity = mkEntity([{ action_type: "purchase", value: "42" }]);
    expect(getAct(entity, "lead")).toBeNull();
  });
});

describe("getMsgCount (CRITICAL — see CLAUDE.md)", () => {
  it("reads onsite_conversion.messaging_conversation_started_7d first", () => {
    const entity = mkEntity([
      { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "7" },
      { action_type: "messaging_conversation_started_7d", value: "99" },
    ]);
    // First-found wins — should NOT sum to 106, NOT return 99.
    expect(getMsgCount(entity)).toBe(7);
  });
  it("falls back to messaging_conversation_started_7d when onsite_conversion absent", () => {
    const entity = mkEntity([{ action_type: "messaging_conversation_started_7d", value: "5" }]);
    expect(getMsgCount(entity)).toBe(5);
  });
  it("returns 0 when no message actions present", () => {
    const entity = mkEntity([{ action_type: "purchase", value: "10" }]);
    expect(getMsgCount(entity)).toBe(0);
  });
  it("NEVER uses total_messaging_connection (blocklisted by CLAUDE.md)", () => {
    // Ensure this action_type is ignored entirely
    const entity = mkEntity([
      { action_type: "onsite_conversion.total_messaging_connection", value: "1000" },
    ]);
    expect(getMsgCount(entity)).toBe(0);
  });
  it("returns 0 when insights missing", () => {
    const entity: FbBaseEntity = { id: "1", name: "x", status: "ACTIVE" };
    expect(getMsgCount(entity)).toBe(0);
  });
});

describe("sumAction / spendOf", () => {
  it("sumAction returns numeric action value", () => {
    const entity = mkEntity([{ action_type: "lead", value: "12" }]);
    expect(sumAction(entity, "lead")).toBe(12);
  });
  it("sumAction returns 0 when action missing", () => {
    const entity = mkEntity([]);
    expect(sumAction(entity, "lead")).toBe(0);
  });
  it("spendOf returns numeric spend", () => {
    const entity = mkEntity([], "1234.56");
    expect(spendOf(entity)).toBe(1234.56);
  });
});

describe("getPostReactions / getShares (成效報告)", () => {
  it("reads post_reaction as 按讚", async () => {
    const { getPostReactions } = await import("@/lib/insights");
    const e = mkEntity([{ action_type: "post_reaction", value: "38" }]);
    expect(getPostReactions(e)).toBe(38);
  });
  it("reads post as 分享", async () => {
    const { getShares } = await import("@/lib/insights");
    const e = mkEntity([{ action_type: "post", value: "5" }]);
    expect(getShares(e)).toBe(5);
  });
  it("returns 0 when the action type is absent", async () => {
    const { getPostReactions, getShares } = await import("@/lib/insights");
    const e = mkEntity([{ action_type: "link_click", value: "9" }]);
    expect(getPostReactions(e)).toBe(0);
    expect(getShares(e)).toBe(0);
  });
});

describe("getAvgWatchSeconds (成效報告)", () => {
  it("reads the first positive video_avg_time_watched value", async () => {
    const { getAvgWatchSeconds } = await import("@/lib/insights");
    const e: FbBaseEntity = {
      id: "1",
      name: "v",
      status: "ACTIVE",
      insights: {
        data: [{ video_avg_time_watched_actions: [{ action_type: "video_view", value: "15" }] }],
      },
    };
    expect(getAvgWatchSeconds(e)).toBe(15);
  });
  it("returns 0 for non-video creatives (field absent)", async () => {
    const { getAvgWatchSeconds } = await import("@/lib/insights");
    expect(getAvgWatchSeconds(mkEntity())).toBe(0);
  });
});

describe("getPostSaves (成效報告 收藏)", () => {
  it("reads onsite_conversion.post_save first, falls back to post_save", async () => {
    const { getPostSaves } = await import("@/lib/insights");
    expect(
      getPostSaves(mkEntity([{ action_type: "onsite_conversion.post_save", value: "12" }])),
    ).toBe(12);
    expect(getPostSaves(mkEntity([{ action_type: "post_save", value: "4" }]))).toBe(4);
    expect(getPostSaves(mkEntity([{ action_type: "post", value: "9" }]))).toBe(0);
  });
});
