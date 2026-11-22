"use client";

import { useState } from "react";
import type { QueryResult } from "@/lib/analytics/engine";
import type { ChartChoice } from "@/lib/analytics/present";
import type { ForecastResult } from "@/lib/forecast/forecast";
import { formatMetric } from "@/lib/analytics/semantic";

type Tab = "plan" | "scope" | "data";

function downloadCsv(name: string, header: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => (v === null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Tabs({ tab, setTab, labels }: { tab: Tab; setTab: (t: Tab) => void; labels: Record<Tab, string> }) {
  return (
    <div className="flex gap-1 border-b border-line text-xs" role="tablist">
      {(Object.keys(labels) as Tab[]).map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={tab === t}
          onClick={() => setTab(t)}
          className={`-mb-px border-b-2 px-3 py-2 font-medium ${tab === t ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2"}`}
        >
          {labels[t]}
        </button>
      ))}
    </div>
  );
}

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[140px_1fr] gap-3 py-1.5 text-xs">
    <div className="text-ink-3">{k}</div>
    <div className="text-ink-2">{children}</div>
  </div>
);

export function QueryExplain({ result, chart, tool = "query_analytics" }: { result: QueryResult; chart: ChartChoice; tool?: string }) {
  const [tab, setTab] = useState<Tab>("scope");
  const r = result.resolved;
  const header = [result.dimension.label, ...result.columns.flatMap((c) => [c.label, `${c.label} n`])];
  const body = result.rows.map((row) => [row.label, ...result.columns.flatMap((c) => [row.values[c.key] ?? null, row.n[c.key] ?? null])]);

  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-2/40">
      <Tabs tab={tab} setTab={setTab} labels={{ scope: "Filters & metrics", plan: "Query plan", data: `Data (${result.rows.length} rows)` }} />
      <div className="p-3">
        {tab === "scope" && (
          <div className="divide-y divide-line">
            {result.spec.intent_summary && <Row k="Interpretation">{result.spec.intent_summary}</Row>}
            <Row k="Time range">
              {r.timeRange.description}
              {(r.timeRange.start || r.timeRange.end) && ` · ${r.timeRange.start ?? "…"} → ${r.timeRange.end ?? "…"}`} · applied to <code>{r.dateField}</code>
            </Row>
            <Row k="Filters">
              {r.filters.length ? r.filters.map((f) => `${f.dimension} ∈ {${f.values.join(", ")}}`).join(" AND ") : "None"}
              {r.promoOnly !== null && ` · promo = ${r.promoOnly}`}
            </Row>
            <Row k="Dimension">{result.dimension.label}</Row>
            {result.columns.map((c) => (
              <Row key={c.key} k={`Metric: ${c.label}`}>
                {c.definition}
              </Row>
            ))}
            <Row k="Rows used">
              {r.rowsMatched} of {r.rowsInDataset} orders{r.truncatedTo ? ` · showing top ${r.truncatedTo}` : ""}
            </Row>
            <Row k="Relative dates">Resolved against the dataset as-of date {r.asOfDate} (latest order), not today.</Row>
            <Row k="Chart">
              <span className="font-medium">{chart.type.replace("_", " ")}</span> — {chart.reason}
            </Row>
          </div>
        )}
        {tab === "plan" && (
          <div>
            <p className="mb-2 text-xs text-ink-3">
              Tool <code className="text-ink-2">{tool}</code> called with this validated structured input. The engine executes it in code; no SQL or free-form code is generated.
            </p>
            <pre className="max-h-72 overflow-auto rounded-md bg-surface p-3 font-mono text-[11px] leading-relaxed text-ink-2">{JSON.stringify(result.spec, null, 2)}</pre>
          </div>
        )}
        {tab === "data" && (
          <div>
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-xs tabular">
                <thead className="sticky top-0 bg-surface text-left text-ink-3">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">{result.dimension.label}</th>
                    {result.columns.map((c) => (
                      <th key={c.key} className="py-1.5 pr-3 text-right font-medium">
                        {c.label}
                      </th>
                    ))}
                    <th className="py-1.5 text-right font-medium" title="Population size of the first metric">
                      n
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.rows.map((row) => (
                    <tr key={row.key}>
                      <td className="py-1.5 pr-3 text-ink-2">{row.label}</td>
                      {result.columns.map((c) => (
                        <td key={c.key} className="py-1.5 pr-3 text-right">
                          {formatMetric(row.values[c.key] ?? null, c.format)}
                        </td>
                      ))}
                      <td className="py-1.5 text-right text-ink-3">{row.n[result.columns[0].key]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button onClick={() => downloadCsv("query-result", header, body)} className="mt-2 text-xs font-medium text-accent hover:underline">
              Download CSV
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ForecastExplain({ result }: { result: ForecastResult }) {
  const [tab, setTab] = useState<Tab>("scope");
  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-2/40">
      <Tabs tab={tab} setTab={setTab} labels={{ scope: "Methodology", plan: "Query plan", data: "Data" }} />
      <div className="p-3">
        {tab === "scope" && (
          <div className="space-y-3">
            <ol className="list-decimal space-y-1.5 pl-5 text-xs text-ink-2">
              {result.methodology.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ol>
            <table className="w-full text-xs tabular">
              <thead className="text-left text-ink-3">
                <tr>
                  <th className="py-1 font-medium">Method</th>
                  <th className="py-1 text-right font-medium">Backtest MAE</th>
                  <th className="py-1 text-right font-medium">RMSE</th>
                  <th className="py-1 pl-3 font-medium">Parameters</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.methodsCompared.map((m) => (
                  <tr key={m.method} className={m.selected ? "font-semibold text-ink" : "text-ink-2"}>
                    <td className="py-1">
                      {m.label}
                      {m.selected && " ✓"}
                    </td>
                    <td className="py-1 text-right">{m.mae}</td>
                    <td className="py-1 text-right">{m.rmse}</td>
                    <td className="py-1 pl-3 font-mono text-[11px]">{Object.entries(m.params).map(([k, v]) => `${k}=${v}`).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tab === "plan" && (
          <pre className="max-h-72 overflow-auto rounded-md bg-surface p-3 font-mono text-[11px] leading-relaxed text-ink-2">
            {JSON.stringify({ tool: "forecast_demand", input: result.spec }, null, 2)}
          </pre>
        )}
        {tab === "data" && (
          <div>
            <table className="w-full text-xs tabular">
              <thead className="text-left text-ink-3">
                <tr>
                  <th className="py-1 font-medium">Month</th>
                  <th className="py-1 text-right font-medium">Actual units</th>
                  <th className="py-1 text-right font-medium">Forecast</th>
                  <th className="py-1 text-right font-medium">Band</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.history.map((h) => (
                  <tr key={h.month} className="text-ink-2">
                    <td className="py-1">{h.label}</td>
                    <td className="py-1 text-right">{h.units}</td>
                    <td />
                    <td />
                  </tr>
                ))}
                {result.forecast.map((f) => (
                  <tr key={f.month} className="text-ink">
                    <td className="py-1">{f.label}</td>
                    <td />
                    <td className="py-1 text-right font-medium">{f.units}</td>
                    <td className="py-1 text-right text-ink-3">
                      {f.lower} – {f.upper}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              onClick={() =>
                downloadCsv(
                  "forecast",
                  ["month", "actual_units", "forecast_units", "lower", "upper"],
                  [...result.history.map((h) => [h.month, h.units, null, null, null]), ...result.forecast.map((f) => [f.month, null, f.units, f.lower ?? null, f.upper ?? null])],
                )
              }
              className="mt-2 text-xs font-medium text-accent hover:underline"
            >
              Download CSV
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
