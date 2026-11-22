import { describe, expect, it } from "vitest";
import { resolveTimeRange, startOfWeek, enumerateBuckets } from "@/lib/analytics/time";

const r = (preset: Parameters<typeof resolveTimeRange>[0]["preset"], n: number | null = null) =>
  resolveTimeRange({ preset, n, start: null, end: null }, "2025-12-30");

describe("time presets (as-of 2025-12-30)", () => {
  it("previous_month", () => expect(r("previous_month")).toMatchObject({ start: "2025-11-01", end: "2025-11-30" }));
  it("last_n_months", () => expect(r("last_n_months", 3)).toMatchObject({ start: "2025-10-01", end: "2025-12-31" }));
  it("last_n_days", () => expect(r("last_n_days", 30)).toMatchObject({ start: "2025-12-01", end: "2025-12-30" }));
  it("previous_quarter", () => expect(r("previous_quarter")).toMatchObject({ start: "2025-07-01", end: "2025-09-30" }));
  it("last_n_weeks", () => expect(r("last_n_weeks", 2)).toMatchObject({ start: "2025-12-22", end: "2026-01-04" }));
  it("ISO week starts Monday", () => {
    expect(startOfWeek("2025-12-30")).toBe("2025-12-29");
    expect(startOfWeek("2025-12-28")).toBe("2025-12-22"); // Sunday
  });
  it("enumerates months across year end", () => {
    expect(enumerateBuckets("2025-11-15", "2026-01-02", "month")).toEqual(["2025-11-01", "2025-12-01", "2026-01-01"]);
  });
});
