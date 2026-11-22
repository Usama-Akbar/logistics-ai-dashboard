"use client";

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { QueryResult } from "@/lib/analytics/engine";
import type { ChartChoice } from "@/lib/analytics/present";
import type { ForecastResult } from "@/lib/forecast/forecast";
import { formatMetric, METRIC_DEFS, type Metric, type MetricFormat } from "@/lib/analytics/semantic";

/** Fixed colour per entity: status metrics wear status colours, others take categorical slots in order. */
const METRIC_COLORS: Partial<Record<Metric, string>> = {
  delivered_count: "var(--good)",
  delayed_count: "var(--critical)",
  exception_count: "var(--serious)",
  in_transit_count: "var(--series-1)",
  canceled_count: "var(--text-3)",
};
const SLOTS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
const colorFor = (m: Metric, i: number) => METRIC_COLORS[m] ?? SLOTS[i % SLOTS.length];

const axisTick = { fill: "var(--text-3)", fontSize: 11 };
const tooltipStyle = {
  contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--text)" },
  labelStyle: { color: "var(--text)", fontWeight: 600, marginBottom: 4 },
  itemStyle: { color: "var(--text-2)", padding: 0 },
  cursor: { fill: "var(--surface-2)", stroke: "var(--border)" },
};

/** Round percent axes to clean 5% / 10% steps instead of Recharts' raw-fraction ticks. */
function percentTicks(values: (number | null | undefined)[]): number[] | undefined {
  const max = Math.max(0, ...values.filter((v): v is number => typeof v === "number"));
  if (!max) return undefined;
  const step = max > 0.5 ? 0.1 : max > 0.2 ? 0.05 : 0.025;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Math.round(i * step * 1000) / 1000);
}

const legendProps = {
  wrapperStyle: { fontSize: 12 },
  formatter: (value: string) => <span style={{ color: "var(--text-2)" }}>{value}</span>,
};

const shortFmt = (v: number, f: MetricFormat) => {
  if (f === "percent") return `${Math.round(v * 1000) / 10}%`;
  if (f === "usd") return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`;
  if (f === "days") return `${v.toFixed(1)}d`;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v * 10) / 10}`;
};

export function KpiTiles({ result }: { result: QueryResult }) {
  const row = result.rows[0];
  return (
    <div className="flex flex-wrap gap-6 py-2">
      {result.columns.map((c) => (
        <div key={c.key}>
          <div className="text-xs text-ink-3">{c.label}</div>
          <div className="text-3xl font-semibold tabular">{formatMetric(row.values[c.key] ?? null, c.format)}</div>
          {c.format === "percent" && <div className="text-xs text-ink-3 tabular">n = {row.n[c.key]} completed shipments</div>}
        </div>
      ))}
    </div>
  );
}

export function ResultChart({ result, chart, height = 260 }: { result: QueryResult; chart: ChartChoice; height?: number }) {
  if (chart.type === "kpi") return <KpiTiles result={result} />;
  const format = METRIC_DEFS[chart.series[0]].format;
  const data = result.rows.map((r) => ({ label: r.label, ...Object.fromEntries(chart.series.map((m) => [m, r.values[m]])), _n: r.n }));
  const name = (m: Metric) => METRIC_DEFS[m].label;
  const tip = (v: unknown, n: unknown) => [formatMetric(typeof v === "number" ? v : null, format), String(n)] as [string, string];
  const multi = chart.series.length > 1;
  const ticks = format === "percent" ? percentTicks(result.rows.flatMap((r) => chart.series.map((m) => r.values[m]))) : undefined;
  const domain: [number, number | "auto"] = ticks ? [0, ticks[ticks.length - 1]] : [0, "auto"];

  if (chart.type === "bar") {
    const h = Math.max(height, data.length * 28 + 40);
    return (
      <ResponsiveContainer width="100%" height={h}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }} barCategoryGap={6}>
          <CartesianGrid horizontal={false} stroke="var(--grid)" />
          <XAxis type="number" ticks={ticks} domain={domain} tick={axisTick} tickFormatter={(v) => shortFmt(v, format)} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" tick={axisTick} width={120} axisLine={false} tickLine={false} interval={0} />
          <Tooltip {...tooltipStyle} formatter={tip} />
          {multi && <Legend {...legendProps} />}
          {chart.series.map((m, i) => (
            <Bar key={m} dataKey={m} name={name(m)} fill={colorFor(m, i)} radius={[0, 4, 4, 0]} maxBarSize={22} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (chart.type === "line") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="label" tick={axisTick} axisLine={false} tickLine={false} minTickGap={16} />
          <YAxis ticks={ticks} domain={domain} tick={axisTick} tickFormatter={(v) => shortFmt(v, format)} axisLine={false} tickLine={false} width={44} />
          <Tooltip {...tooltipStyle} formatter={tip} cursor={{ stroke: "var(--text-3)" }} />
          {multi && <Legend {...legendProps} />}
          {chart.series.map((m, i) => (
            <Line key={m} dataKey={m} name={name(m)} stroke={colorFor(m, i)} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // column / stacked_column
  const stacked = chart.type === "stacked_column";
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} barCategoryGap="20%">
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="label" tick={axisTick} axisLine={false} tickLine={false} minTickGap={8} />
        <YAxis tick={axisTick} tickFormatter={(v) => shortFmt(v, format)} axisLine={false} tickLine={false} width={44} allowDecimals={false} />
        <Tooltip {...tooltipStyle} formatter={tip} />
        {multi && <Legend {...legendProps} />}
        {chart.series.map((m, i) => (
          <Bar
            key={m}
            dataKey={m}
            name={name(m)}
            stackId={stacked ? "s" : undefined}
            fill={colorFor(m, i)}
            stroke="var(--surface)"
            strokeWidth={stacked ? 1 : 0}
            radius={stacked ? (i === chart.series.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]}
            maxBarSize={36}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ForecastChart({ result, height = 280 }: { result: ForecastResult; height?: number }) {
  type Point = { label: string; actual?: number; forecast?: number; band?: [number, number] };
  const lastIdx = result.history.length - 1;
  const data: Point[] = [
    // The last actual month also carries the forecast value so the dashed line starts where history ends.
    ...result.history.map((h, i): Point => (i === lastIdx ? { label: h.label, actual: h.units, forecast: h.units, band: [h.units, h.units] } : { label: h.label, actual: h.units })),
    ...result.forecast.map((f): Point => ({ label: f.label, forecast: f.units, band: [f.lower ?? f.units, f.upper ?? f.units] })),
  ];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="label" tick={axisTick} axisLine={false} tickLine={false} minTickGap={12} />
        <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} />
        <Tooltip
          {...tooltipStyle}
          cursor={{ stroke: "var(--text-3)" }}
          formatter={(v, n) => [Array.isArray(v) ? `${v[0]} – ${v[1]}` : `${v} units`, String(n)]}
        />
        <Legend {...legendProps} />
        <Area dataKey="band" name="Uncertainty band" fill="var(--series-2)" fillOpacity={0.12} stroke="none" isAnimationActive={false} />
        <Line dataKey="actual" name="Actual units" stroke="var(--series-1)" strokeWidth={2} dot={{ r: 3 }} />
        <Line dataKey="forecast" name="Forecast" stroke="var(--series-2)" strokeWidth={2} strokeDasharray="6 4" dot={{ r: 3 }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
