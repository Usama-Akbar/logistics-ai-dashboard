import { describe, expect, it } from "vitest";
import { getDataset } from "@/lib/data/orders";
import { backtest, exponentialSmoothing, linearRegression, movingAverage, zScore } from "@/lib/forecast/methods";
import { runForecast } from "@/lib/forecast/forecast";

const ds = getDataset();
const base = { intent_summary: "", sku: null, product_category: null, horizon_months: 4, method: "auto" as const, service_level: null };

describe("methods", () => {
  it("moving average is the mean of the last 3", () => expect(movingAverage([1, 2, 3, 4, 5], 2).forecast).toEqual([4, 4]));
  it("linear regression recovers an exact line", () => {
    const f = linearRegression([2, 4, 6, 8], 2);
    expect(f.params.slope).toBeCloseTo(2);
    expect(f.forecast).toEqual([10, 12]);
  });
  it("SES on a constant series forecasts the constant", () => expect(exponentialSmoothing([5, 5, 5, 5], 3).forecast).toEqual([5, 5, 5]));
  it("z-scores", () => {
    expect(zScore(0.95)).toBeCloseTo(1.6449, 3);
    expect(zScore(0.5)).toBeCloseTo(0, 6);
  });
  it("backtest is out-of-sample", () => {
    const bt = backtest([10, 10, 10, 10, 10, 10, 10, 10, 20], "moving_average");
    expect(bt.folds).toBe(3);
    expect(bt.mae).toBeCloseTo(10 / 3);
  });
});

describe("demand forecast on the dataset", () => {
  it("uses monthly units excluding canceled orders", () => {
    const f = runForecast(base, ds);
    expect(f.history.map((h) => h.units)).toEqual([233, 86, 147, 55, 115, 64, 126, 98, 94, 79, 113, 93]);
    expect(f.forecast.map((p) => p.month)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
    expect(f.methodsCompared.filter((m) => m.selected)).toHaveLength(1);
    const chosen = f.methodsCompared.find((m) => m.selected)!;
    expect(chosen.mae).toBe(Math.min(...f.methodsCompared.map((m) => m.mae)));
    expect(f.recommendation.recommendedInventory).toBeGreaterThanOrEqual(Math.ceil(f.recommendation.horizonDemand));
  });
  it("falls back from a sparse SKU to its category and allocates by share", () => {
    const f = runForecast({ ...base, sku: "pencil-0076" }, ds);
    expect(f.target.level).toBe("category");
    expect(f.skuAllocation?.sku).toBe("PENCIL-0076");
    expect(f.skuAllocation?.category).toBe("PENCIL");
    expect(f.warnings[0]).toMatch(/too sparse/);
  });
  it("rejects unknown SKUs", () => expect(() => runForecast({ ...base, sku: "PENCIL-9999" }, ds)).toThrow(/does not exist/));
});
