import type { QueryResult, ResultRow } from "./engine";
import { formatMetric, isTimeGrain, METRIC_DEFS, type Metric, type MetricFormat } from "./semantic";

/**
 * Presentation logic: deterministic chart selection and answer text.
 * Every number in an answer comes from the QueryResult — the language model
 * never writes the answer, so it cannot invent figures.
 */

export type ChartType = "kpi" | "line" | "column" | "stacked_column" | "bar" | "forecast";

export interface ChartChoice {
  type: ChartType;
  /** Metrics that are plotted (one unit per chart — never a dual axis). */
  series: Metric[];
  reason: string;
}

const STATUS_PARTS: Metric[] = ["delivered_count", "delayed_count", "exception_count", "in_transit_count", "canceled_count"];

export function chooseChart(r: QueryResult): ChartChoice {
  const metrics = r.columns.map((c) => c.key);
  const unit: MetricFormat = METRIC_DEFS[metrics[0]].format;
  const series = metrics.filter((m) => METRIC_DEFS[m].format === unit);
  const dropped = metrics.length - series.length;
  const dropNote = dropped ? ` ${dropped} metric(s) with a different unit are shown in the table only (no dual axes).` : "";
  const g = r.spec.group_by;

  if (g === "none") return { type: "kpi", series: metrics, reason: "A single aggregate has no dimension to plot, so it is shown as a stat tile." };

  if (isTimeGrain(g)) {
    if (series.length > 1 && series.every((m) => STATUS_PARTS.includes(m)))
      return { type: "stacked_column", series, reason: `Status counts are parts of a whole per ${g}, so a stacked column shows both the total and the mix.${dropNote}` };
    if ((unit === "count" || unit === "usd") && r.rows.length <= 16 && series.length === 1)
      return { type: "column", series, reason: `A count over ${r.rows.length} ${g}s reads best as columns (each bar is a discrete period total).${dropNote}` };
    return { type: "line", series, reason: `${unit === "count" || unit === "usd" ? "Many periods" : "A rate/average over time"} reads best as a line showing the trend.${dropNote}` };
  }

  return {
    type: "bar",
    series,
    reason: `Comparing ${r.dimension.label.toLowerCase()} values is a ranking, so horizontal bars sorted by ${METRIC_DEFS[metrics[0]].label.toLowerCase()} make the order obvious and keep long labels readable.${dropNote}`,
  };
}

function scope(r: QueryResult): string {
  const parts: string[] = [];
  const { timeRange, dateField, filters, promoOnly } = r.resolved;
  if (timeRange.start || timeRange.end) {
    const verb = dateField === "delivery_date" ? "delivered" : "placed";
    parts.push(`orders ${verb} ${timeRange.start ?? "…"} → ${timeRange.end ?? "…"}`);
  } else parts.push("all orders");
  for (const f of filters) parts.push(`${f.dimension.replace("_", " ")} = ${f.values.join(" or ")}`);
  if (promoOnly !== null) parts.push(promoOnly ? "promo orders only" : "non-promo orders only");
  return parts.join(", ");
}

/** "8 of 54 completed shipments" for rates, empty for plain counts. */
function fraction(row: ResultRow, m: Metric): string {
  const def = METRIC_DEFS[m];
  const v = row.values[m];
  const n = row.n[m] ?? 0;
  if (def.format === "percent" && v != null) return ` (${Math.round(v * n)} of ${n} completed shipment${n === 1 ? "" : "s"})`;
  if (m === "avg_delivery_days" && v != null) return ` (over ${n} delivered order${n === 1 ? "" : "s"})`;
  return "";
}

const fm = (row: ResultRow, m: Metric) => formatMetric(row.values[m] ?? null, METRIC_DEFS[m].format);

export function composeAnswer(r: QueryResult): string {
  const metrics = r.columns.map((c) => c.key);
  const primary = metrics[0];
  const pdef = METRIC_DEFS[primary];
  const g = r.spec.group_by;
  const sc = scope(r);

  if (r.resolved.rowsMatched === 0) return `No orders match (${sc}), so there is nothing to compute.`;

  if (g === "none") {
    const row = r.rows[0];
    const lines = metrics.map((m) => `${METRIC_DEFS[m].label}: **${fm(row, m)}**${fraction(row, m)}`);
    return `${lines.join(" · ")} — for ${sc}.`;
  }

  const valued = r.rows.filter((x) => x.values[primary] != null);

  if (isTimeGrain(g)) {
    const isAdditive = pdef.format === "count" || pdef.format === "usd";
    const head = isAdditive
      ? `${pdef.label} totalled **${fm(r.totals, primary)}** across ${r.rows.length} ${g}s`
      : `Overall ${pdef.label.toLowerCase()} was **${fm(r.totals, primary)}**${fraction(r.totals, primary)} across ${r.rows.length} ${g}s`;
    if (!valued.length) return `${head} (${sc}).`;
    const max = valued.reduce((a, b) => ((b.values[primary] as number) > (a.values[primary] as number) ? b : a));
    const min = valued.reduce((a, b) => ((b.values[primary] as number) < (a.values[primary] as number) ? b : a));
    const last = r.rows[r.rows.length - 1];
    return `${head} (${sc}). Highest: ${max.label} at ${fm(max, primary)}; lowest: ${min.label} at ${fm(min, primary)}. Most recent ${g} (${last.label}): ${fm(last, primary)}.`;
  }

  if (!valued.length) return `No ${r.dimension.label.toLowerCase()} has a value for ${pdef.label.toLowerCase()} (${sc}).`;
  const top = valued[0];
  const word = r.spec.sort === "asc" ? "lowest" : "highest";
  let text = `**${top.label}** has the ${word} ${pdef.label.toLowerCase()} at **${fm(top, primary)}**${fraction(top, primary)}`;
  const rest = valued.slice(1, 3).map((x) => `${x.label} (${fm(x, primary)})`);
  if (rest.length) text += `, followed by ${rest.join(" and ")}`;
  if (valued.length > 3 && !r.resolved.truncatedTo) {
    const bottom = valued[valued.length - 1];
    text += `. ${r.spec.sort === "asc" ? "Highest" : "Lowest"}: ${bottom.label} (${fm(bottom, primary)})`;
  }
  text += `. Overall ${pdef.label.toLowerCase()}: ${fm(r.totals, primary)} — ${sc}.`;
  return text;
}
