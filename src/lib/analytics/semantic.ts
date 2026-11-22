import type { Order } from "@/lib/data/orders";

/**
 * Semantic layer: the ONLY place metric and dimension definitions live.
 * The dashboard, the AI query tool and the tests all go through these, so a
 * KPI can never mean two different things in two places.
 */

export const METRICS = [
  "order_count",
  "delivered_count",
  "delayed_count",
  "exception_count",
  "in_transit_count",
  "canceled_count",
  "on_time_rate",
  "delay_rate",
  "avg_delivery_days",
  "units",
  "order_value",
] as const;
export type Metric = (typeof METRICS)[number];

export type MetricFormat = "count" | "percent" | "days" | "usd";

export interface MetricDef {
  label: string;
  format: MetricFormat;
  definition: string;
  /** Rows that form the denominator / population of the metric (for "n="). */
  population: (o: Order) => boolean;
  compute: (rows: readonly Order[]) => number | null;
}

/** A shipment has a known outcome once it has a delivery date. */
export const isCompleted = (o: Order) => o.status === "delivered" || o.status === "delayed" || o.status === "exception";

const count = (pred: (o: Order) => boolean) => (rows: readonly Order[]) => rows.filter(pred).length;
const ratio = (num: (o: Order) => boolean) => (rows: readonly Order[]) => {
  const pop = rows.filter(isCompleted);
  return pop.length ? pop.filter(num).length / pop.length : null;
};
const all = () => true;

export const METRIC_DEFS: Record<Metric, MetricDef> = {
  order_count: { label: "Orders", format: "count", definition: "Count of all orders (every status).", population: all, compute: (r) => r.length },
  delivered_count: {
    label: "Delivered (on time)",
    format: "count",
    definition: "Orders with status = 'delivered' (arrived without a delay flag).",
    population: all,
    compute: count((o) => o.status === "delivered"),
  },
  delayed_count: {
    label: "Delayed",
    format: "count",
    definition: "Orders with status = 'delayed' (delivered late).",
    population: all,
    compute: count((o) => o.status === "delayed"),
  },
  exception_count: {
    label: "Exceptions",
    format: "count",
    definition: "Orders with status = 'exception'.",
    population: all,
    compute: count((o) => o.status === "exception"),
  },
  in_transit_count: {
    label: "In transit",
    format: "count",
    definition: "Orders with status = 'in_transit' (no outcome yet).",
    population: all,
    compute: count((o) => o.status === "in_transit"),
  },
  canceled_count: {
    label: "Canceled",
    format: "count",
    definition: "Orders with status = 'canceled'.",
    population: all,
    compute: count((o) => o.status === "canceled"),
  },
  on_time_rate: {
    label: "On-time rate",
    format: "percent",
    definition:
      "delivered ÷ completed shipments, where completed = delivered + delayed + exception. In-transit and canceled orders have no outcome and are excluded from the denominator.",
    population: isCompleted,
    compute: ratio((o) => o.status === "delivered"),
  },
  delay_rate: {
    label: "Delay rate",
    format: "percent",
    definition: "delayed ÷ completed shipments (delivered + delayed + exception).",
    population: isCompleted,
    compute: ratio((o) => o.status === "delayed"),
  },
  avg_delivery_days: {
    label: "Avg delivery time",
    format: "days",
    definition: "Mean of (delivery_date − order_date) in days, over orders that have a delivery date.",
    population: (o) => o.delivery_days !== null,
    compute: (rows) => {
      const d = rows.filter((o) => o.delivery_days !== null).map((o) => o.delivery_days as number);
      return d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
    },
  },
  units: {
    label: "Units ordered",
    format: "count",
    definition: "Sum of quantity across orders.",
    population: all,
    compute: (rows) => rows.reduce((a, o) => a + o.quantity, 0),
  },
  order_value: {
    label: "Order value (USD)",
    format: "usd",
    definition: "Sum of order_value_usd (quantity × unit price).",
    population: all,
    compute: (rows) => Math.round(rows.reduce((a, o) => a + o.order_value_usd, 0) * 100) / 100,
  },
};

export const CATEGORICAL_DIMENSIONS = [
  "carrier",
  "region",
  "warehouse",
  "destination_city",
  "origin_city",
  "product_category",
  "status",
  "client_id",
  "sku",
] as const;
export type CategoricalDimension = (typeof CATEGORICAL_DIMENSIONS)[number];

export const TIME_GRAINS = ["day", "week", "month", "quarter"] as const;
export type TimeGrain = (typeof TIME_GRAINS)[number];

export const GROUP_BYS = ["none", ...TIME_GRAINS, ...CATEGORICAL_DIMENSIONS] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

export const isTimeGrain = (g: string): g is TimeGrain => (TIME_GRAINS as readonly string[]).includes(g);

export const DIMENSION_LABELS: Record<GroupBy, string> = {
  none: "Total",
  day: "Day",
  week: "Week (starting Monday)",
  month: "Month",
  quarter: "Quarter",
  carrier: "Carrier",
  region: "Region",
  warehouse: "Warehouse",
  destination_city: "Destination city",
  origin_city: "Origin city",
  product_category: "Product category",
  status: "Status",
  client_id: "Client",
  sku: "SKU",
};

/** Groups smaller than this get a "small sample" warning on rate metrics. */
export const MIN_RELIABLE_SAMPLE = 15;

export function formatMetric(value: number | null, format: MetricFormat): string {
  if (value === null || Number.isNaN(value)) return "—";
  switch (format) {
    case "percent":
      return `${(value * 100).toFixed(1)}%`;
    case "days":
      return `${value.toFixed(2)} days`;
    case "usd":
      return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    default:
      return Math.round(value).toLocaleString("en-US");
  }
}
