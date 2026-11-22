"use client";

import { useEffect, useState } from "react";
import type { ForecastResult } from "@/lib/forecast/forecast";
import type { ForecastSpec } from "@/lib/analytics/querySpec";
import { ResultCard } from "./Cards";

/** Direct access to the forecasting tool (same code path the AI calls), usable without the AI layer. */
export default function ForecastPanel({ categories }: { categories: string[] }) {
  const [category, setCategory] = useState("");
  const [sku, setSku] = useState("");
  const [horizon, setHorizon] = useState(3);
  const [method, setMethod] = useState<ForecastSpec["method"]>("auto");
  const [service, setService] = useState(0.95);
  const [data, setData] = useState<{ result: ForecastResult; answer: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      const spec: ForecastSpec = {
        intent_summary: "Forecast panel",
        sku: sku.trim() || null,
        product_category: category || null,
        horizon_months: horizon,
        method,
        service_level: service,
      };
      fetch("/api/forecast", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec), signal: ctrl.signal })
        .then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error);
          setError(null);
          setData(j);
        })
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [category, sku, horizon, method, service]);

  const field = "rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink";
  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-4 p-4 text-xs text-ink-3">
        <label className="flex flex-col gap-1">
          Category
          <select className={field} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All products</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          SKU (optional)
          <input className={`${field} w-36`} value={sku} onChange={(e) => setSku(e.target.value)} placeholder="e.g. PENCIL-0076" />
        </label>
        <label className="flex flex-col gap-1">
          Horizon
          <select className={field} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
            {[1, 2, 3, 4, 6, 9, 12].map((h) => (
              <option key={h} value={h}>
                {h} month{h > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Method
          <select className={field} value={method} onChange={(e) => setMethod(e.target.value as ForecastSpec["method"])}>
            <option value="auto">Auto (lowest backtest error)</option>
            <option value="moving_average">3-month moving average</option>
            <option value="linear_regression">Linear trend</option>
            <option value="exponential_smoothing">Exponential smoothing</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Service level
          <select className={field} value={service} onChange={(e) => setService(Number(e.target.value))}>
            {[0.9, 0.95, 0.99].map((s) => (
              <option key={s} value={s}>
                {s * 100}%
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="card p-4 text-sm text-[var(--critical)]">{error}</div>}
      {data && (
        <div className="card p-5">
          <ResultCard card={{ type: "forecast", ...data }} onPick={() => {}} />
        </div>
      )}
    </div>
  );
}
