import { describe, expect, it } from "vitest";
import { getDataset } from "@/lib/data/orders";
import { executeQuery, QueryValidationError, spec } from "@/lib/analytics/engine";
import { chooseChart, composeAnswer } from "@/lib/analytics/present";

// Expected values were computed independently with a Python script over the raw CSV.
const ds = getDataset();

describe("dataset", () => {
  it("loads every row and reports quality facts", () => {
    expect(ds.quality.rows).toBe(400);
    expect(ds.quality.rejected).toHaveLength(0);
    expect(ds.quality.duplicateOrderIds).toBe(0);
    expect(ds.quality.missingDeliveryDateByStatus).toEqual({ in_transit: 27, canceled: 3 });
    expect(ds.asOfDate).toBe("2025-12-30");
  });
});

describe("KPIs", () => {
  const r = executeQuery(spec({ metrics: ["order_count", "delivered_count", "delayed_count"] }), ds).rows[0];
  it("counts by status", () => {
    expect(r.values).toEqual({ order_count: 400, delivered_count: 304, delayed_count: 55 });
  });
  it("on-time rate uses completed shipments as denominator", () => {
    const k = executeQuery(spec({ metrics: ["on_time_rate", "delay_rate"] }), ds).rows[0];
    expect(k.n.on_time_rate).toBe(370);
    expect(k.values.on_time_rate).toBeCloseTo(304 / 370, 10);
    expect(k.values.delay_rate).toBeCloseTo(55 / 370, 10);
  });
  it("average delivery time covers orders with a delivery date", () => {
    const k = executeQuery(spec({ metrics: ["avg_delivery_days"] }), ds).rows[0];
    expect(k.n.avg_delivery_days).toBe(370);
    expect(k.values.avg_delivery_days).toBeCloseTo(3.8297297, 6);
  });
});

describe("assignment example questions", () => {
  it("Which carrier has the highest delay rate? -> GLS, flagged as small sample", () => {
    const r = executeQuery(spec({ metrics: ["delay_rate"], group_by: "carrier", sort: "desc" }), ds);
    expect(r.rows.map((x) => x.key).slice(0, 3)).toEqual(["GLS", "USPS", "UPS"]);
    expect(r.rows[0].values.delay_rate).toBeCloseTo(0.25, 10);
    expect(r.rows[0].n.delay_rate).toBe(8);
    expect(r.rows.at(-1)!.key).toBe("DPD");
    expect(r.warnings.join(" ")).toMatch(/GLS \(n=8\)/);
    expect(chooseChart(r).type).toBe("bar");
    expect(composeAnswer(r)).toMatch(/\*\*GLS\*\* has the highest delay rate at \*\*25\.0%\*\* \(2 of 8/);
  });

  it("How many orders were delivered late last month? -> 3 (by delivery date, Nov 2025)", () => {
    const r = executeQuery(
      spec({ metrics: ["delayed_count"], date_field: "delivery_date", time_range: { preset: "previous_month", n: null, start: null, end: null } }),
      ds,
    );
    expect(r.resolved.timeRange).toMatchObject({ start: "2025-11-01", end: "2025-11-30" });
    expect(r.rows[0].values.delayed_count).toBe(3);
    expect(chooseChart(r).type).toBe("kpi");
  });

  it("Show delayed orders by week for the last 3 months -> Oct–Dec, zero-filled weeks", () => {
    const r = executeQuery(
      spec({ metrics: ["delayed_count"], group_by: "week", time_range: { preset: "last_n_months", n: 3, start: null, end: null } }),
      ds,
    );
    expect(r.resolved.timeRange).toMatchObject({ start: "2025-10-01", end: "2025-12-31" });
    expect(r.rows[0].key).toBe("2025-09-29"); // Monday of the week containing Oct 1
    expect(r.rows.length).toBe(14);
    expect(r.rows.reduce((a, x) => a + (x.values.delayed_count ?? 0), 0)).toBe(10);
    expect(r.rows.some((x) => x.values.delayed_count === 0)).toBe(true);
    expect(chooseChart(r).type).toBe("column");
  });
});

describe("validation", () => {
  it("rejects values that do not exist, listing real ones", () => {
    expect(() => executeQuery(spec({ metrics: ["order_count"], filters: [{ dimension: "carrier", values: ["Fedx"] }] }), ds)).toThrow(QueryValidationError);
  });
  it("canonicalises case and city suffixes", () => {
    const r = executeQuery(
      spec({ metrics: ["order_count"], filters: [{ dimension: "carrier", values: ["fedex"] }, { dimension: "destination_city", values: ["leeds"] }] }),
      ds,
    );
    expect(r.resolved.filters).toEqual([
      { dimension: "carrier", values: ["FedEx"] },
      { dimension: "destination_city", values: ["Leeds, UK"] },
    ]);
  });
  it("rejects inverted custom ranges", () => {
    expect(() => executeQuery(spec({ metrics: ["order_count"], time_range: { preset: "custom", n: null, start: "2025-05-01", end: "2025-04-01" } }), ds)).toThrow(/after end/);
  });
});

describe("grouping invariants", () => {
  it("group counts sum to the total", () => {
    for (const g of ["carrier", "region", "month", "status"] as const) {
      const r = executeQuery(spec({ metrics: ["order_count"], group_by: g }), ds);
      expect(r.rows.reduce((a, x) => a + (x.values.order_count ?? 0), 0)).toBe(400);
    }
  });
  it("status counts stack into a stacked column chart", () => {
    const r = executeQuery(spec({ metrics: ["delivered_count", "delayed_count", "exception_count"], group_by: "month" }), ds);
    expect(chooseChart(r).type).toBe("stacked_column");
  });
});
