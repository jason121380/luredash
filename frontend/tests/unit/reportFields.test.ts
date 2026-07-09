import { addReportFieldOrdered, moveReportField } from "@/lib/reportFields";
import { describe, expect, it } from "vitest";

describe("addReportFieldOrdered", () => {
  it("appends preserving existing order", () => {
    expect(addReportFieldOrdered(["ctr", "cpc"], "reach")).toEqual(["ctr", "cpc", "reach"]);
  });
  it("drops mutex sibling (spend / spend_plus) then appends", () => {
    expect(addReportFieldOrdered(["spend", "ctr"], "spend_plus")).toEqual(["ctr", "spend_plus"]);
  });
  it("re-adding an existing code moves it to the end", () => {
    expect(addReportFieldOrdered(["ctr", "cpc"], "ctr")).toEqual(["cpc", "ctr"]);
  });
});

describe("moveReportField", () => {
  it("moves an item forward", () => {
    expect(moveReportField(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
  it("moves an item backward", () => {
    expect(moveReportField(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
  it("returns input unchanged on out-of-range / no-op", () => {
    expect(moveReportField(["a", "b"], 0, 0)).toEqual(["a", "b"]);
    expect(moveReportField(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});
