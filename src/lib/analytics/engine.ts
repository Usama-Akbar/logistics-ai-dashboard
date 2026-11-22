import type { Dataset, Order } from "@/lib/data/orders";
import type { QuerySpec } from "./querySpec";
import {
  CATEGORICAL_DIMENSIONS,
  type CategoricalDimension,
  DIMENSION_LABELS,
  isTimeGrain,
  METRIC_DEFS,
  type Metric,
  type MetricFormat,
  MIN_RELIABLE_SAMPLE,
} from "./semantic";
import { bucketLabel, bucketStart, enumerateBuckets, resolveTimeRange } from "./time";

export class QueryValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join(" "));
  }
}

export interface ResultRow {
  key: string;
  label: string;
  values: Partial<Record<Metric, number | null>>;
  /** Size of each metric's population in this row (e.g. completed shipments for a rate). */
  n: Partial<Record<Metric, number>>;
}

export interface QueryResult {
  kind: "query";
  spec: QuerySpec;
  columns: { key: Metric; label: string; format: MetricFormat; definition: string }[];
  dimension: { key: string; label: string };
  rows: ResultRow[];
  /** Metrics over the whole filtered population (not per group). */
  totals: ResultRow;
  resolved: {
    timeRange: { start: string | null; end: string | null; description: string };
    dateField: string;
    filters: { dimension: string; values: string[] }[];
    promoOnly: boolean | null;
    asOfDate: string;
    rowsInDataset: number;
    rowsMatched: number;
    rowsWithoutDateField: number;
    truncatedTo: number | null;
  };
  warnings: string[];
}

/** Case-insensitive lookup of user/AI-provided values against values that really exist. */
export function canonicalizeValue(dim: CategoricalDimension, value: string, orders: readonly Order[]): string | null {
  const known = Array.from(new Set(orders.map((o) => o[dim])));
  const v = value.trim().toLowerCase();
  const exact = known.find((k) => k.toLowerCase() === v);
  if (exact) return exact;
  // City names without state/country suffix: "Leeds" -> "Leeds, UK" (only if unambiguous).
  if (dim === "destination_city" || dim === "origin_city") {
    const hits = known.filter((k) => k.toLowerCase().split(",")[0].trim() === v);
    if (hits.length === 1) return hits[0];
  }
  return null;
}

export function knownValues(dim: CategoricalDimension, orders: readonly Order[]): string[] {
  return Array.from(new Set(orders.map((o) => o[dim]))).sort();
}

export function executeQuery(spec: QuerySpec, ds: Dataset): QueryResult {
  const { orders, asOfDate } = ds;
  const issues: string[] = [];

  // 1. Validate filter values against the data (never trust the interpreter's spelling).
  const filters = spec.filters.map((f) => {
    if (!(CATEGORICAL_DIMENSIONS as readonly string[]).includes(f.dimension)) issues.push(`Unknown dimension '${f.dimension}'.`);
    const values: string[] = [];
    for (const raw of f.values) {
      const c = canonicalizeValue(f.dimension, raw, orders);
      if (c) values.push(c);
      else {
        const sample = knownValues(f.dimension, orders);
        issues.push(
          `'${raw}' is not a known ${DIMENSION_LABELS[f.dimension].toLowerCase()}. Known values: ${sample.slice(0, 20).join(", ")}${sample.length > 20 ? ", …" : ""}.`,
        );
      }
    }
    return { dimension: f.dimension, values };
  });

  const range = resolveTimeRange(spec.time_range, asOfDate);
  if (spec.time_range.preset === "custom" && !spec.time_range.start && !spec.time_range.end)
    issues.push("A custom time range needs a start and/or end date.");
  if (range.start && range.end && range.start > range.end) issues.push(`Time range start ${range.start} is after end ${range.end}.`);
  if (issues.length) throw new QueryValidationError(issues);

  // 2. Filter (pure, read-only).
  const dateOf = (o: Order) => (spec.date_field === "delivery_date" ? o.delivery_date : o.order_date);
  const timeBound = range.start !== null || range.end !== null || isTimeGrain(spec.group_by);
  let rowsWithoutDateField = 0;
  const matched = orders.filter((o) => {
    for (const f of filters) if (!f.values.includes(o[f.dimension])) return false;
    if (spec.promo_only !== null && o.is_promo !== spec.promo_only) return false;
    const d = dateOf(o);
    if (d === null) {
      if (timeBound) {
        rowsWithoutDateField++;
        return false;
      }
      return true;
    }
    if (range.start && d < range.start) return false;
    if (range.end && d > range.end) return false;
    return true;
  });

  const metrics = spec.metrics as Metric[];
  const evaluate = (key: string, label: string, rows: readonly Order[]): ResultRow => {
    const values: ResultRow["values"] = {};
    const n: ResultRow["n"] = {};
    for (const m of metrics) {
      const def = METRIC_DEFS[m];
      values[m] = def.compute(rows);
      n[m] = rows.filter(def.population).length;
    }
    return { key, label, values, n };
  };

  // 3. Group.
  let rows: ResultRow[];
  const g = spec.group_by;
  if (g === "none") {
    rows = [evaluate("total", "Total", matched)];
  } else if (isTimeGrain(g)) {
    const groups = new Map<string, Order[]>();
    for (const o of matched) {
      const b = bucketStart(dateOf(o)!, g);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b)!.push(o);
    }
    const dates = matched.map((o) => dateOf(o)!).sort();
    const from = range.start ?? dates[0];
    const to = range.end ?? dates[dates.length - 1];
    const keys = from && to ? enumerateBuckets(from, to, g) : [];
    rows = keys.map((k) => evaluate(k, bucketLabel(k, g), groups.get(k) ?? []));
  } else {
    const groups = new Map<string, Order[]>();
    for (const o of matched) {
      const k = o[g];
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(o);
    }
    rows = Array.from(groups, ([k, rs]) => evaluate(k, k, rs));
  }

  // 4. Sort + limit.
  const primary = metrics[0];
  const timeSeries = isTimeGrain(g);
  const dir = spec.sort === "auto" ? (timeSeries ? "chrono" : "desc") : spec.sort;
  if (dir !== "chrono" && g !== "none") {
    const sign = dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const av = a.values[primary];
      const bv = b.values[primary];
      if (av == null && bv == null) return a.label.localeCompare(b.label);
      if (av == null) return 1; // nulls last regardless of direction
      if (bv == null) return -1;
      return av === bv ? a.label.localeCompare(b.label) : sign * (av - bv);
    });
  }
  let truncatedTo: number | null = null;
  if (spec.limit && !timeSeries && rows.length > spec.limit) {
    rows = rows.slice(0, spec.limit);
    truncatedTo = spec.limit;
  }

  // 5. Warnings that a careful analyst would mention.
  const warnings: string[] = [];
  if (matched.length === 0) warnings.push("No orders match these filters.");
  if (rowsWithoutDateField > 0 && spec.date_field === "delivery_date")
    warnings.push(`${rowsWithoutDateField} matching order(s) have no delivery date yet (in transit or canceled) and are excluded because the range is applied to delivery_date.`);
  const rateMetrics = metrics.filter((m) => METRIC_DEFS[m].format === "percent" || m === "avg_delivery_days");
  if (g !== "none" && rateMetrics.length) {
    const small = rows.filter((r) => (r.n[rateMetrics[0]] ?? 0) > 0 && (r.n[rateMetrics[0]] ?? 0) < MIN_RELIABLE_SAMPLE);
    if (small.length)
      warnings.push(
        `Small samples (< ${MIN_RELIABLE_SAMPLE} shipments): ${small
          .slice(0, 8)
          .map((r) => `${r.label} (n=${r.n[rateMetrics[0]]})`)
          .join(", ")}${small.length > 8 ? ", …" : ""}. Treat their rates as indicative only.`,
      );
  }
  if (range.end && range.end > asOfDate && spec.date_field === "order_date")
    warnings.push(`Data ends on ${asOfDate}; the last period may be incomplete.`);

  return {
    kind: "query",
    spec,
    columns: metrics.map((m) => ({ key: m, label: METRIC_DEFS[m].label, format: METRIC_DEFS[m].format, definition: METRIC_DEFS[m].definition })),
    dimension: { key: g, label: DIMENSION_LABELS[g] },
    rows,
    totals: evaluate("total", "Total", matched),
    resolved: {
      timeRange: range,
      dateField: spec.date_field,
      filters,
      promoOnly: spec.promo_only,
      asOfDate,
      rowsInDataset: orders.length,
      rowsMatched: matched.length,
      rowsWithoutDateField,
      truncatedTo,
    },
    warnings,
  };
}

/** Convenience for building specs in code (dashboard, tests). */
export function spec(partial: Partial<QuerySpec> & Pick<QuerySpec, "metrics">): QuerySpec {
  return {
    intent_summary: "",
    group_by: "none",
    date_field: "order_date",
    time_range: { preset: "all_time", n: null, start: null, end: null },
    filters: [],
    promo_only: null,
    sort: "auto",
    limit: null,
    ...partial,
  };
}
