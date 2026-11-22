"use client";

import { useEffect, useMemo, useState } from "react";
import type { QueryResult } from "@/lib/analytics/engine";
import type { ChartChoice } from "@/lib/analytics/present";
import type { QuerySpec } from "@/lib/analytics/querySpec";
import { formatMetric, METRIC_DEFS, type Metric } from "@/lib/analytics/semantic";
import type { TimePreset } from "@/lib/analytics/time";
import { ResultChart } from "./charts";
import { QueryExplain } from "./Explain";
import { Warnings } from "./Cards";

interface Item {
  result: QueryResult;
  chart: ChartChoice;
  answer: string;
}

export interface Meta {
  asOfDate: string;
  dimensions: Record<string, string[]>;
  ai: { configured: boolean; model: string };
  quality: { rows: number; orderDateRange: { min: string; max: string }; missingDeliveryDateByStatus: Record<string, number> };
}

const RANGES: { label: string; preset: TimePreset; n: number | null }[] = [
  { label: "All time", preset: "all_time", n: null },
  { label: "Last 3 months", preset: "last_n_months", n: 3 },
  { label: "Last 6 months", preset: "last_n_months", n: 6 },
  { label: "Previous quarter", preset: "previous_quarter", n: null },
  { label: "Previous month", preset: "previous_month", n: null },
];

const KPI_METRICS: Metric[] = ["order_count", "delivered_count", "delayed_count", "on_time_rate", "avg_delivery_days"];

const CHARTS: { title: string; subtitle: string; spec: Partial<QuerySpec> & { metrics: QuerySpec["metrics"] } }[] = [
  { title: "Order volume", subtitle: "Orders placed per month", spec: { metrics: ["order_count"], group_by: "month" } },
  {
    title: "Delivery performance",
    subtitle: "Outcome of shipments by order month",
    spec: { metrics: ["delivered_count", "delayed_count", "exception_count"], group_by: "month" },
  },
  { title: "Delay rate by carrier", subtitle: "Delayed ÷ completed shipments", spec: { metrics: ["delay_rate"], group_by: "carrier", sort: "desc" } },
  { title: "Orders by destination region", subtitle: "Share of volume per region", spec: { metrics: ["order_count"], group_by: "region", sort: "desc" } },
];

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="flex items-center gap-2 text-xs text-ink-3">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function Dashboard({ meta }: { meta: Meta | null }) {
  const [range, setRange] = useState(0);
  const [carrier, setCarrier] = useState("");
  const [region, setRegion] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const base = useMemo(() => {
    const filters: QuerySpec["filters"] = [];
    if (carrier) filters.push({ dimension: "carrier", values: [carrier] });
    if (region) filters.push({ dimension: "region", values: [region] });
    const r = RANGES[range];
    return {
      intent_summary: "",
      date_field: "order_date" as const,
      time_range: { preset: r.preset, n: r.n, start: null, end: null },
      filters,
      promo_only: null,
      sort: "auto" as const,
      limit: null,
      group_by: "none" as const,
    };
  }, [range, carrier, region]);

  useEffect(() => {
    const ctrl = new AbortController();
    const specs: QuerySpec[] = [
      { ...base, metrics: KPI_METRICS.slice(0, 3), intent_summary: "Dashboard KPIs (counts)" },
      { ...base, metrics: KPI_METRICS.slice(3), intent_summary: "Dashboard KPIs (rates)" },
      ...CHARTS.map((c) => ({ ...base, ...c.spec, intent_summary: `Dashboard chart: ${c.title}` })),
    ];
    fetch("/api/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ specs }), signal: ctrl.signal })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Query failed");
        setError(null);
        setItems(j.results);
      })
      .catch((e) => e.name !== "AbortError" && setError(e.message));
    return () => ctrl.abort();
  }, [base]);

  const kpiRows = items ? [items[0], items[1]] : null;
  const kpi = (m: Metric) => {
    const it = kpiRows?.find((k) => k.result.columns.some((c) => c.key === m));
    return it ? { v: it.result.rows[0].values[m] ?? null, n: it.result.rows[0].n[m] } : null;
  };
  const kpiSub: Partial<Record<Metric, (n?: number) => string>> = {
    order_count: () => "all statuses",
    delivered_count: () => "status = delivered",
    delayed_count: () => "status = delayed",
    on_time_rate: (n) => `of ${n ?? "—"} completed shipments`,
    avg_delivery_days: (n) => `order → delivery, ${n ?? "—"} orders`,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4">
        <Select label="Period" value={String(range)} onChange={(v) => setRange(Number(v))} options={RANGES.map((r, i) => ({ value: String(i), label: r.label }))} />
        <Select
          label="Carrier"
          value={carrier}
          onChange={setCarrier}
          options={[{ value: "", label: "All carriers" }, ...(meta?.dimensions.carrier ?? []).map((c) => ({ value: c, label: c }))]}
        />
        <Select
          label="Region"
          value={region}
          onChange={setRegion}
          options={[{ value: "", label: "All regions" }, ...(meta?.dimensions.region ?? []).map((c) => ({ value: c, label: c }))]}
        />
        {meta && <span className="ml-auto text-xs text-ink-3">Data through {meta.asOfDate} · relative periods count back from this date</span>}
      </div>

      {error && <div className="card p-4 text-sm text-[var(--critical)]">{error}</div>}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="Key metrics">
        {KPI_METRICS.map((m) => {
          const k = kpi(m);
          return (
            <div key={m} className="card px-4 py-3" title={METRIC_DEFS[m].definition}>
              <div className="text-xs text-ink-3">{METRIC_DEFS[m].label}</div>
              <div className="mt-1 text-2xl font-semibold tabular">{k ? formatMetric(k.v, METRIC_DEFS[m].format) : <span className="text-ink-3">…</span>}</div>
              <div className="mt-0.5 text-[11px] text-ink-3">{kpiSub[m]?.(k?.n)}</div>
            </div>
          );
        })}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {CHARTS.map((c, i) => {
          const it = items?.[i + 2];
          return (
            <div key={c.title} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">{c.title}</h3>
                  <p className="text-xs text-ink-3">{c.subtitle}</p>
                </div>
                <button onClick={() => setOpen(open === i ? null : i)} className="shrink-0 text-xs font-medium text-accent hover:underline" aria-expanded={open === i}>
                  {open === i ? "Hide details" : "How is this computed?"}
                </button>
              </div>
              <div className="mt-3 min-h-[260px]">{it ? <ResultChart result={it.result} chart={it.chart} /> : <div className="h-[260px] animate-pulse rounded-lg bg-surface-2" />}</div>
              {it && <Warnings items={it.result.warnings} />}
              {it && open === i && <QueryExplain result={it.result} chart={it.chart} tool="dashboard (direct structured query)" />}
            </div>
          );
        })}
      </section>
    </div>
  );
}
